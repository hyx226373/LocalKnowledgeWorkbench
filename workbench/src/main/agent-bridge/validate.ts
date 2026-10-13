import { isUuidV4 } from './paths';
import {
  CAPABILITIES,
  OPEN_AS,
  type Capability,
  type ConsoleDraftInput,
  type ConsoleDraftItem,
  type ConsoleRef,
  type OpenAs,
  type PlanOpInput,
} from './types';

const PSEUDO = new Set(['approved', 'approve', 'contentHash']);
const OPEN_SET = new Set<string>(OPEN_AS);
const CAP_SET = new Set<string>(CAPABILITIES);

export interface ValidRequest {
  requestId: string;
  type: Capability;
  agentName: string;
  snapshot: boolean;
  query?: { scope?: 'roots'; resourceId?: string; rootId?: string; relPath?: string };
  draft?: ConsoleDraftInput;
  open?: { resourceId: string; openAs: OpenAs; targetPanel?: { itemId?: string; adapterId?: string } };
  /** 归一后的 ActionId。与 commandId 同值。 */
  actionId?: string;
  /** 旧字段。与 actionId 同值，响应里仍回写。 */
  commandId?: string;
  invokeArgs?: Record<string, unknown>;
  title?: string;
  ops?: PlanOpInput[];
  planId?: string;
  sourceRequestId?: string;
  classify?: { action: 'add' | 'remove' | 'move'; resourceId: string; folderId?: string; toRelPath?: string };
  workspaceRef?: { action: 'add' | 'remove'; workspaceId: string; resourceId: string };
  ignoredFields: string[];
}

export type ValidateResult =
  | { ok: true; value: ValidRequest }
  | { ok: false; code: 'incomplete_request' | 'approval_ui_only'; message: string };

export function stripPseudo(value: unknown, ignored: string[] = [], prefix = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item, i) => stripPseudo(item, ignored, prefix ? `${prefix}.${i}` : String(i)));
  }
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (PSEUDO.has(key)) {
      ignored.push(path);
      continue;
    }
    next[key] = stripPseudo(child, ignored, path);
  }
  return next;
}

function fail(code: 'incomplete_request' | 'approval_ui_only', message: string): ValidateResult {
  return { ok: false, code, message };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function refOf(raw: unknown, label: string): ConsoleRef | ValidateResult {
  if (!raw || typeof raw !== 'object') return fail('incomplete_request', `${label} 缺少 ref`);
  const ref = raw as Record<string, unknown>;
  if (ref.type === 'resource') {
    const resourceId = str(ref.resourceId);
    if (!resourceId) return fail('incomplete_request', `${label}.ref 缺少 resourceId`);
    return { type: 'resource', resourceId };
  }
  if (ref.type === 'workspace-ref') {
    const workspaceId = str(ref.workspaceId);
    const resourceId = str(ref.resourceId);
    if (!workspaceId || !resourceId) return fail('incomplete_request', `${label}.ref 缺少 workspaceId 或 resourceId`);
    return { type: 'workspace-ref', workspaceId, resourceId };
  }
  if (ref.type === 'path-hint') {
    const rootId = str(ref.rootId);
    const relPath = str(ref.relPath);
    if (!rootId || !relPath) return fail('incomplete_request', `${label}.ref 缺少 rootId 或 relPath`);
    return { type: 'path-hint', rootId, relPath };
  }
  return fail('incomplete_request', `${label}.ref.type 无法识别`);
}

function itemOf(raw: unknown, index: number): ConsoleDraftItem | ValidateResult {
  if (!raw || typeof raw !== 'object') return fail('incomplete_request', `draft.items[${index}] 不是对象`);
  const item = raw as Record<string, unknown>;
  const id = str(item.id);
  const title = str(item.title);
  const openAs = str(item.openAs);
  if (!id || !title || !openAs) return fail('incomplete_request', `draft.items[${index}] 缺少 id、title 或 openAs`);
  if (!OPEN_SET.has(openAs)) return fail('incomplete_request', `draft.items[${index}].openAs 无法识别`);
  if (typeof item.order !== 'number' || !Number.isFinite(item.order)) {
    return fail('incomplete_request', `draft.items[${index}].order 必须是数字`);
  }
  const ref = refOf(item.ref, `draft.items[${index}]`);
  if ('ok' in ref) return ref;
  const draft: ConsoleDraftItem = { id, title, order: item.order, openAs: openAs as OpenAs, ref };
  if (typeof item.note === 'string') draft.note = item.note;
  if (typeof item.includeInGroupOpen === 'boolean') draft.includeInGroupOpen = item.includeInGroupOpen;
  return draft;
}

function opOf(raw: unknown, index: number): PlanOpInput | ValidateResult {
  if (!raw || typeof raw !== 'object') return fail('incomplete_request', `ops[${index}] 不是对象`);
  const op = raw as Record<string, unknown>;
  const resourceId = str(op.resourceId);
  if (!resourceId) return fail('incomplete_request', `ops[${index}] 缺少 resourceId`);
  if (op.kind === 'write') {
    if (typeof op.content !== 'string') return fail('incomplete_request', `ops[${index}] write 需要字符串 content`);
    if (op.expectedHash != null && typeof op.expectedHash !== 'string') {
      return fail('incomplete_request', `ops[${index}].expectedHash 必须是字符串或 null`);
    }
    const write: PlanOpInput = {
      kind: 'write',
      resourceId,
      content: op.content,
      expectedHash: (op.expectedHash as string | null | undefined) ?? null,
    };
    if (typeof op.expectedFileHash === 'string' && op.expectedFileHash.trim()) write.expectedFileHash = op.expectedFileHash.trim();
    if (typeof op.materialId === 'string' && op.materialId.trim()) write.materialId = op.materialId.trim();
    if (typeof op.absPath === 'string' && op.absPath.trim()) write.absPath = op.absPath.trim();
    return write;
  }
  if (op.kind === 'move') {
    const toRelPath = typeof op.toRelPath === 'string' ? op.toRelPath.replace(/\\/g, '/').trim() : '';
    if (!toRelPath || toRelPath.split('/').some((part) => part === '..' || part.includes('\0'))) {
      return fail('incomplete_request', `ops[${index}] move 需要合法的 toRelPath`);
    }
    return { kind: 'move', resourceId, toRelPath };
  }
  if (op.kind === 'trash') return { kind: 'trash', resourceId };
  return fail('incomplete_request', `ops[${index}].kind 只能是 write、move、trash`);
}

export function validateRequest(raw: unknown, fileRequestId: string): ValidateResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail('incomplete_request', '请求必须是 JSON 对象');
  }
  const body = raw as Record<string, unknown>;
  const requestId = body.requestId;
  if (typeof requestId !== 'string' || !isUuidV4(requestId) || !isUuidV4(fileRequestId)) {
    return fail('incomplete_request', '缺少 UUID v4 requestId');
  }
  if (requestId.toLowerCase() !== fileRequestId.toLowerCase()) {
    return fail('incomplete_request', 'requestId 与文件名不一致');
  }
  const type = body.type;
  if (type === 'approve' || type === 'plan-approve' || type === 'plans.approve' || type === 'plans.apply') {
    return fail('approval_ui_only', '批准只在界面。文件桥没有 approve。');
  }
  if (typeof type !== 'string' || !CAP_SET.has(type)) {
    return fail('incomplete_request', '缺少或无法识别 type');
  }
  const agentName = body.agentName == null ? 'file' : str(body.agentName);
  if (!agentName) return fail('incomplete_request', 'agentName 必须是非空字符串');
  const value: ValidRequest = {
    requestId: fileRequestId,
    type: type as Capability,
    agentName,
    snapshot: body.snapshot !== false,
    ignoredFields: [],
  };

  if (type === 'query') {
    const query = body.query;
    if (!query || typeof query !== 'object' || Array.isArray(query)) return fail('incomplete_request', 'query 缺少 query 对象');
    const q = query as Record<string, unknown>;
    if (q.scope === 'roots') value.query = { scope: 'roots' };
    else if (str(q.resourceId)) value.query = { resourceId: str(q.resourceId)! };
    else if (str(q.rootId)) {
      if (q.relPath != null && typeof q.relPath !== 'string') return fail('incomplete_request', 'query.relPath 必须是字符串');
      value.query = { rootId: str(q.rootId)!, relPath: typeof q.relPath === 'string' ? q.relPath : '' };
    } else return fail('incomplete_request', 'query 需要 scope=roots、resourceId 或 rootId');
  }

  if (type === 'console-draft') {
    const draft = body.draft;
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return fail('incomplete_request', 'console-draft 缺少 draft');
    const d = draft as Record<string, unknown>;
    const title = str(d.title);
    if (!title) return fail('incomplete_request', 'draft.title 不能为空');
    const items: ConsoleDraftItem[] = [];
    if (d.items != null) {
      if (!Array.isArray(d.items)) return fail('incomplete_request', 'draft.items 必须是数组');
      for (let i = 0; i < d.items.length; i++) {
        const item = itemOf(d.items[i], i);
        if ('ok' in item) return item;
        items.push(item);
      }
    }
    value.draft = { title, description: typeof d.description === 'string' ? d.description : undefined, items };
  }

  if (type === 'open') {
    const open = body.open;
    if (!open || typeof open !== 'object' || Array.isArray(open)) return fail('incomplete_request', 'open 缺少 open 对象');
    const o = open as Record<string, unknown>;
    const resourceId = str(o.resourceId);
    const openAs = str(o.openAs);
    if (!resourceId || !openAs) return fail('incomplete_request', 'open 需要 resourceId 与 openAs');
    if (!OPEN_SET.has(openAs)) return fail('incomplete_request', `无法识别的 openAs：${openAs}`);
    let targetPanel: { itemId?: string; adapterId?: string } | undefined;
    if (o.targetPanel != null) {
      if (!o.targetPanel || typeof o.targetPanel !== 'object') return fail('incomplete_request', 'open.targetPanel 必须是对象');
      const t = o.targetPanel as Record<string, unknown>;
      targetPanel = {};
      if (t.itemId != null) {
        if (typeof t.itemId !== 'string') return fail('incomplete_request', 'targetPanel.itemId 必须是字符串');
        targetPanel.itemId = t.itemId;
      }
      if (t.adapterId != null) {
        if (typeof t.adapterId !== 'string') return fail('incomplete_request', 'targetPanel.adapterId 必须是字符串');
        targetPanel.adapterId = t.adapterId;
      }
    }
    value.open = { resourceId, openAs: openAs as OpenAs, targetPanel };
  }

  if (type === 'invoke') {
    const invoke = body.invoke;
    const bag = invoke && typeof invoke === 'object' && !Array.isArray(invoke) ? (invoke as Record<string, unknown>) : null;
    const fromInvokeAction = bag ? str(bag.actionId) : null;
    const fromInvokeCommand = bag ? str(bag.commandId) : null;
    const fromTop = str(body.actionId);
    const ids = [fromInvokeAction, fromInvokeCommand, fromTop].filter((id): id is string => !!id);
    if (!bag && !fromTop) return fail('incomplete_request', 'invoke 缺少 actionId');
    if (ids.length === 0) return fail('incomplete_request', 'invoke 缺少 actionId');
    const actionId = fromInvokeAction || fromTop || fromInvokeCommand;
    if (!actionId) return fail('incomplete_request', 'invoke 缺少 actionId');
    if (ids.some((id) => id !== actionId)) return fail('incomplete_request', 'actionId 与 commandId 不一致');
    value.actionId = actionId;
    value.commandId = actionId;
    const args = bag && 'args' in bag ? bag.args : body.args;
    if (args !== undefined) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail('incomplete_request', 'invoke.args 必须是对象');
      value.invokeArgs = args as Record<string, unknown>;
    }
  }

  if (type === 'plan-submit') {
    const title = str(body.title);
    if (!title) return fail('incomplete_request', 'plan-submit 缺少 title');
    if (!Array.isArray(body.ops) || body.ops.length === 0) return fail('incomplete_request', 'plan-submit 缺少 ops');
    if (body.ops.length > 100) return fail('incomplete_request', 'ops 最多 100 条');
    const ops: PlanOpInput[] = [];
    for (let i = 0; i < body.ops.length; i++) {
      const op = opOf(body.ops[i], i);
      if ('ok' in op) return op;
      ops.push(op);
    }
    value.title = title;
    value.ops = ops;
  }

  if (type === 'plan-status') {
    const planId = str(body.planId);
    const sourceRequestId = str(body.sourceRequestId);
    if (!planId && !sourceRequestId) return fail('incomplete_request', 'plan-status 需要 planId 或 sourceRequestId');
    if (sourceRequestId && !isUuidV4(sourceRequestId)) return fail('incomplete_request', 'sourceRequestId 必须是 UUID v4');
    value.planId = planId ?? undefined;
    value.sourceRequestId = sourceRequestId ?? undefined;
  }

  if (type === 'classify') {
    const classify = body.classify;
    if (!classify || typeof classify !== 'object') return fail('incomplete_request', 'classify 缺少 classify 对象');
    const c = classify as Record<string, unknown>;
    const resourceId = str(c.resourceId);
    if (!resourceId) return fail('incomplete_request', 'classify 缺少 resourceId');
    const toRelPath = typeof c.toRelPath === 'string' ? c.toRelPath.trim() : '';
    if (c.action === 'move' || toRelPath) {
      if (!toRelPath) return fail('incomplete_request', '磁盘移动必须带 toRelPath，并走计划');
      value.classify = { action: 'move', resourceId, toRelPath: toRelPath.replace(/\\/g, '/') };
    } else if (c.action === 'add' || c.action === 'remove') {
      const folderId = str(c.folderId);
      if (!folderId) return fail('incomplete_request', 'classify 缺少 folderId');
      value.classify = { action: c.action, resourceId, folderId };
    } else return fail('incomplete_request', 'classify.action 只能是 add、remove 或 move');
  }

  if (type === 'workspace-ref') {
    const wr = body.workspaceRef;
    if (!wr || typeof wr !== 'object') return fail('incomplete_request', 'workspace-ref 缺少 workspaceRef 对象');
    const w = wr as Record<string, unknown>;
    const workspaceId = str(w.workspaceId);
    const resourceId = str(w.resourceId);
    if ((w.action !== 'add' && w.action !== 'remove') || !workspaceId || !resourceId) {
      return fail('incomplete_request', 'workspaceRef 需要 action=add|remove、workspaceId、resourceId');
    }
    value.workspaceRef = { action: w.action, workspaceId, resourceId };
  }

  return { ok: true, value };
}
