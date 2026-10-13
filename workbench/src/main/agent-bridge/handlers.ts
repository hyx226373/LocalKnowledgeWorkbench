import fs from 'node:fs';
import path from 'node:path';
import { actionGate, getInvokeExecutor } from '../../shared/actions/registry';
import { installActionPackages } from '../../shared/actions/install';
import { registerSourceInvokeExecutors } from './sourceInvoke';
import type { StateExport, StateSnapshot } from '../../shared/actions/types';
import { OUT_OF_SCOPE_MESSAGE, OutOfScopeError } from '../../shared/sourceFilter';
import { defaultConsoleDraft } from './consoleDraft';
import { isUuidV4 } from './paths';
import { bindPlanSubmission } from '../agentLive/revision/planGuard';
import { rememberPlanBinding } from '../agentLive/planBindings';
import type { BridgeHost, BridgeResponse, BridgeStatus, ResourceMeta } from './types';
import type { ValidRequest } from './validate';

installActionPackages();
registerSourceInvokeExecutors();

export interface HandlerOutcome {
  status: BridgeStatus;
  result?: unknown;
  error?: { code: string; message: string };
  planId?: string;
}

function scopeDenied(err: unknown): HandlerOutcome | null {
  if (err instanceof OutOfScopeError || (err instanceof Error && err.message === OUT_OF_SCOPE_MESSAGE)) {
    return { status: 'failed', error: { code: 'out_of_scope', message: OUT_OF_SCOPE_MESSAGE } };
  }
  return null;
}

function publicMeta(meta: ResourceMeta): ResourceMeta {
  return {
    resourceId: meta.resourceId,
    rootId: meta.rootId,
    relPath: meta.relPath,
    name: meta.name,
    kind: meta.kind,
    ext: meta.ext ?? '',
  };
}

function searchHelp(host: BridgeHost): HandlerOutcome {
  const health = host.getIndexHealth?.() ?? null;
  const degraded = !health || health.engine !== 'kb-indexer' || health.contentSearch !== true;
  const lines = [
    '在工作台顶部搜索框输入关键词。',
    '文件名和相对路径始终可以搜。',
    degraded
      ? '当前不能确认全文索引可用。请用界面搜索；状态栏若写「全文索引不可用 · 仅文件名搜索」，就只有文件名。'
      : '索引引擎是 kb-indexer，且 contentSearch 为真，正文搜索可用。',
    '本桥的 search-help 不代替全文搜索，也不会抓网页正文。',
  ];
  return { status: 'success', result: { text: lines.join('\n'), indexHealth: health } };
}

async function submitPlan(host: BridgeHost, agentName: string, title: string, ops: NonNullable<ValidRequest['ops']>, requestId: string): Promise<HandlerOutcome> {
  const agent = host.forAgent(agentName);
  if ('approve' in agent) {
    return {
      status: 'failed',
      error: { code: 'approval_ui_only', message: 'AgentOps 不能带 approve。文件桥拒绝使用这个入口。' },
    };
  }
  let proposed: Awaited<ReturnType<typeof agent.propose>>;
  try {
    proposed = await agent.propose(title, ops);
  } catch (err) {
    return { status: 'failed', error: { code: 'propose_failed', message: err instanceof Error ? err.message : String(err) } };
  }
  const plan = proposed.plan;
  if (!plan?.planId) {
    return { status: 'failed', error: { code: 'propose_failed', message: '计划服务没有返回 planId' } };
  }
  const workspaceId = host.currentWorkspaceId?.() || '';
  if (workspaceId && requestId) {
    try {
      rememberPlanBinding(plan.planId, bindPlanSubmission({
        requestId,
        planId: plan.planId,
        workspaceId,
        ops: ops as unknown as Array<Record<string, unknown>>,
        resolvePath: (resourceId) => {
          try { return host.resolveResourcePath?.(resourceId) ?? null; } catch { return null; }
        },
      }));
    } catch (err) {
      console.error('[agent-bridge] 计划绑定没有记下', err);
    }
  }
  if (plan.status !== 'draft') {
    return {
      status: 'conflict',
      planId: plan.planId,
      error: { code: 'unexpected_plan_state', message: `提出后的计划状态是 ${plan.status}，文件桥不会继续执行。请在界面查看。` },
      result: { planId: plan.planId, contentHash: plan.contentHash, actor: plan.actor, status: plan.status },
    };
  }
  return {
    status: 'awaiting_approval',
    planId: plan.planId,
    result: {
      planId: plan.planId,
      contentHash: plan.contentHash,
      actor: plan.actor,
      status: plan.status,
      title: plan.title,
      preview: proposed.preview ?? null,
      note: '计划已进入待批准。请在界面查看差异并批准。文件里的 approved 无效。',
    },
  };
}

function listResultIndex(bridgeRoot: string): StateExport['results'] {
  const dir = path.join(bridgeRoot, 'responses');
  const out: StateExport['results'] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const requestId = name.slice(0, -'.json'.length);
    if (!isUuidV4(requestId)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as BridgeResponse;
      if (!parsed || typeof parsed.status !== 'string' || typeof parsed.updatedAt !== 'string') continue;
      if (parsed.requestId?.toLowerCase() !== requestId.toLowerCase()) continue;
      out.push({ requestId: parsed.requestId, status: parsed.status, updatedAt: parsed.updatedAt });
    } catch {
      continue;
    }
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out.slice(0, 50);
}

export async function handleRequest(req: ValidRequest, host: BridgeHost, bridgeRoot: string, readResponse: (requestId: string) => BridgeResponse | null): Promise<HandlerOutcome> {
  switch (req.type) {
    case 'query': {
      const query = req.query!;
      let result: unknown;
      try {
        if (query.scope === 'roots') result = { roots: host.listRoots().map((root) => ({ id: root.id, name: root.name })) };
        else if (query.resourceId) {
          const meta = host.getResource(query.resourceId);
          if (!meta) return { status: 'failed', error: { code: 'not_found', message: '没有这份资料' } };
          result = { resource: publicMeta(meta) };
        } else {
          if (!host.listDir) return { status: 'failed', error: { code: 'not_available', message: '当前没有目录列举' } };
          const entries = host.listDir(query.rootId!, query.relPath ?? '').map(publicMeta);
          result = { rootId: query.rootId, relPath: query.relPath ?? '', entries };
        }
      } catch (err) {
        const denied = scopeDenied(err);
        if (denied) return denied;
        throw err;
      }
      if (req.snapshot) {
        const file = path.join(bridgeRoot, 'snapshots', `${req.requestId}.json`);
        fs.writeFileSync(file, JSON.stringify({ requestId: req.requestId, result }, null, 2) + '\n', 'utf8');
      }
      return { status: 'success', result };
    }
    case 'search-help':
      return searchHelp(host);
    case 'console-draft': {
      const text = host.buildConsoleDraft ? host.buildConsoleDraft(req.draft!) : defaultConsoleDraft(req.draft!);
      const fileName = `${req.requestId}.kbconsole.md`;
      fs.writeFileSync(path.join(bridgeRoot, 'drafts', fileName), text, 'utf8');
      return { status: 'success', result: { draftFile: `drafts/${fileName}`, executedOpen: false } };
    }
    case 'open': {
      const opened = await host.open(req.open!);
      if (!opened.ok) return { status: 'failed', error: { code: 'open_failed', message: opened.error || '打开失败' } };
      return { status: 'success', result: { resourceId: req.open!.resourceId, openAs: req.open!.openAs, itemId: opened.itemId ?? null } };
    }
    case 'invoke': {
      const id = req.actionId!;
      const gate = actionGate(id);
      if (!gate.bridgeInvokable) {
        return { status: 'failed', error: { code: 'command_not_allowed', message: `不在白名单：${id}` } };
      }
      if (gate.approvalRequired) {
        return {
          status: 'awaiting_approval',
          result: {
            actionId: id,
            commandId: id,
            executed: false,
            note: '该操作需要界面批准。文件桥不会直接执行。批准只在界面。文件里的 approved 无效。',
          },
        };
      }
      const exec = getInvokeExecutor(id);
      if (!exec) {
        return { status: 'failed', error: { code: 'not_available', message: `已登记但没有执行体：${id}` } };
      }
      return exec({ actionId: id, args: req.invokeArgs, host });
    }
    case 'state-export': {
      const empty: StateSnapshot = { workspace: null, resources: [], panels: [], unsaved: [] };
      const saved = host.readState ? await host.readState() : empty;
      const body: StateExport = {
        workspace: saved.workspace,
        resources: saved.resources,
        panels: saved.panels,
        unsaved: saved.unsaved,
        pendingPlans: host.listPendingPlans().map((plan) => ({
          planId: plan.planId,
          title: plan.title,
          ...(plan.contentHash ? { contentHash: plan.contentHash } : {}),
          ...(plan.actor ? { actor: plan.actor } : {}),
        })),
        results: listResultIndex(bridgeRoot),
      };
      if (req.snapshot) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(bridgeRoot, 'snapshots', `state-${stamp}.json`);
        fs.writeFileSync(file, JSON.stringify({ requestId: req.requestId, ...body }, null, 2) + '\n', 'utf8');
      }
      return { status: 'success', result: body };
    }
    case 'plan-submit':
      return submitPlan(host, req.agentName, req.title!, req.ops!, req.requestId);
    case 'plan-status': {
      let planId = req.planId;
      if (!planId && req.sourceRequestId) {
        if (!isUuidV4(req.sourceRequestId)) return { status: 'failed', error: { code: 'incomplete_request', message: 'sourceRequestId 非法' } };
        const prev = readResponse(req.sourceRequestId);
        planId = prev?.planId;
        if (!planId) return { status: 'failed', error: { code: 'not_found', message: '该请求没有 planId' } };
      }
      const plan = await host.forAgent(req.agentName).get(planId!);
      if (!plan) return { status: 'failed', error: { code: 'not_found', message: '计划不存在' } };
      return {
        status: 'success',
        planId: plan.planId,
        result: { planId: plan.planId, title: plan.title, actor: plan.actor, status: plan.status, contentHash: plan.contentHash },
      };
    }
    case 'classify': {
      const c = req.classify!;
      if (c.action === 'move') {
        return submitPlan(host, req.agentName, `移动 ${c.resourceId}`, [{ kind: 'move', resourceId: c.resourceId, toRelPath: c.toRelPath ?? '' }], req.requestId);
      }
      if (!host.classify) {
        return { status: 'failed', error: { code: 'not_available', message: '自建目录服务尚未合入。加入/移出目录这次没有执行。' } };
      }
      await host.classify(c.action, c.resourceId, c.folderId!);
      return { status: 'success', result: { action: c.action, resourceId: c.resourceId, folderId: c.folderId, diskMove: false } };
    }
    case 'workspace-ref': {
      const w = req.workspaceRef!;
      if (w.action === 'remove') {
        return {
          status: 'success',
          result: {
            executed: false,
            action: 'remove',
            workspaceId: w.workspaceId,
            resourceId: w.resourceId,
            note: '从本工作区移除需要在界面确认：会关闭本工作区里该资料已打开的面板（未保存内容先处理），不删除原文件，也不动其它工作区和全局自建目录。本轮文件桥只说明，不执行。',
          },
        };
      }
      if (!host.workspaceRef) {
        return { status: 'failed', error: { code: 'not_available', message: '工作区引用服务尚未合入。这次没有加入引用。' } };
      }
      await host.workspaceRef('add', w.workspaceId, w.resourceId);
      return { status: 'success', result: { executed: true, action: 'add', workspaceId: w.workspaceId, resourceId: w.resourceId, copied: false } };
    }
    default:
      return { status: 'failed', error: { code: 'incomplete_request', message: '无法识别的 type' } };
  }
}
