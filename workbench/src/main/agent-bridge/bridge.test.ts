import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createMemoryHost } from '../../../e2e/memoryHost';
import { bridgeInvokableIds } from '../../shared/actions/registry';
import { CAPABILITIES, mountFileAgentBridge, startAgentBridge } from './index';
import type { BridgeResponse } from './types';

const Q = '11111111-1111-4111-8111-111111111111';
const P = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const RID = '22222222-2222-4222-8222-222222222222';

async function boot(hostOpts?: Parameters<typeof createMemoryHost>[0]) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-bridge-'));
  const mem = createMemoryHost(hostOpts);
  const bridge = await startAgentBridge({
    userDataDir: userData,
    host: mem.host,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
    appCommit: '30f956d',
    modulesCommit: 'c391925',
  });
  return { userData, bridge, ...mem, root: bridge.root };
}

function writeReq(root: string, id: string, body: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ requestId: id, ...body }), 'utf8');
}

function readRes(root: string, id: string): BridgeResponse {
  return JSON.parse(fs.readFileSync(path.join(root, 'responses', `${id}.json`), 'utf8')) as BridgeResponse;
}

describe('文件 Agent 桥', () => {
  it('初始化目录、说明和 manifest', async () => {
    const ctx = await boot();
    try {
      for (const name of ['AGENT_START_HERE.md', 'manifest.json', 'schemas', 'snapshots', 'drafts', 'requests', 'responses']) {
        assert.ok(fs.existsSync(path.join(ctx.root, name)), name);
      }
      for (const schema of ['request.schema.json', 'response.schema.json', 'plan-draft.schema.json', 'console-draft.schema.json']) {
        assert.ok(fs.existsSync(path.join(ctx.root, 'schemas', schema)), schema);
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'manifest.json'), 'utf8'));
      assert.equal(manifest.bridgeVersion, 1);
      assert.equal(manifest.appCommit, '30f956d');
      assert.equal(manifest.modulesCommit, 'c391925');
      assert.deepEqual(manifest.capabilities, [...CAPABILITIES]);
      assert.match(manifest.notes, /approved/);
      const details = manifest.capabilityDetails as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(details));
      for (const row of details) {
        for (const field of ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema']) {
          assert.ok(field in row, String(row.name) + ' ' + field);
        }
      }
      const byName = new Map(details.map((row) => [String(row.name), row]));
      assert.equal(byName.get('state-export')?.availability, 'degraded');
      assert.equal(byName.get('workbench.pendingPlans')?.availability, 'available');
      assert.equal(byName.get('index.showHealth')?.availability, 'available');
      assert.equal(byName.get('plan-submit')?.approvalRequired, true);
      assert.equal(details.some((row) => String(row.name).startsWith('view.contentZoom')), false);
      const ids = bridgeInvokableIds();
      assert.deepEqual(ids.filter((id) => id === 'index.showHealth' || id === 'workbench.pendingPlans'), ['index.showHealth', 'workbench.pendingPlans']);
      assert.equal(ids.includes('source.add.folder'), true);
      assert.equal(ids.includes('source.filter.set'), true);
      assert.equal(ids.includes('source.remap.preview'), true);
      assert.equal(ids.includes('catalog.ref.add'), true);
      assert.equal(ids.includes('disk.write'), false);
      const filter = byName.get('source.filter.set');
      assert.equal(filter?.approvalRequired, true);
      assert.notEqual(filter?.availability, 'available');
      assert.notEqual(byName.get('source.add.folder')?.availability, 'available');
      assert.equal(byName.get('source.remap.preview')?.availability, 'available');
      assert.equal(byName.get('catalog.ref.add')?.availability, 'available');
      assert.equal(byName.get('source.remap.preview')?.approvalRequired, false);
      assert.equal(byName.get('catalog.ref.add')?.approvalRequired, false);
      assert.equal(byName.has('disk.write'), false);
      const guide = fs.readFileSync(path.join(ctx.root, 'AGENT_START_HERE.md'), 'utf8');
      assert.match(guide, /不要/);
      assert.match(guide, /plan-submit/);
      assert.match(guide, /批准只在界面/);
      assert.match(guide, /capabilityDetails/);
      assert.match(guide, /approvalRequired/);
      assert.match(guide, /state-export/);
      assert.ok(fs.existsSync(path.join(ctx.root, 'schemas', 'capability.schema.json')));
    } finally {
      await ctx.bridge.close();
    }
  });

  it('query 写成功响应和快照，且不含绝对路径', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, Q, { type: 'query', query: { resourceId: RID }, approved: true });
      await ctx.bridge.pumpOnce();
      const res = readRes(ctx.root, Q);
      assert.equal(res.status, 'success');
      assert.ok(res.ignoredFields?.includes('approved'));
      const snap = fs.readFileSync(path.join(ctx.root, 'snapshots', `${Q}.json`), 'utf8');
      assert.doesNotMatch(snap, /should-not-leak/);
      assert.match(snap, /notes\/a\.md/);
      assert.equal(ctx.stats.proposeCount, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('不完整请求失败且不提案', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, Q, { type: 'plan-submit', title: '缺 ops', approved: true });
      await ctx.bridge.pumpOnce();
      const res = readRes(ctx.root, Q);
      assert.equal(res.status, 'failed');
      assert.equal(res.error?.code, 'incomplete_request');
      assert.equal(ctx.stats.proposeCount, 0);
      assert.equal(ctx.stats.plans.length, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('非法 JSON 与文件名不一致都不执行', async () => {
    const ctx = await boot();
    try {
      fs.writeFileSync(path.join(ctx.root, 'requests', `${Q}.json`), '{', 'utf8');
      writeReq(ctx.root, P, { type: 'query', query: { scope: 'roots' } });
      const raw = JSON.parse(fs.readFileSync(path.join(ctx.root, 'requests', `${P}.json`), 'utf8'));
      raw.requestId = Q;
      fs.writeFileSync(path.join(ctx.root, 'requests', `${P}.json`), JSON.stringify(raw), 'utf8');
      await ctx.bridge.pumpOnce();
      assert.equal(readRes(ctx.root, Q).error?.code, 'incomplete_request');
      assert.equal(readRes(ctx.root, P).status, 'failed');
      assert.equal(ctx.stats.proposeCount, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('plan-submit 忽略 approved，进入待批准，且同 requestId 不二次提案', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        agentName: 'file',
        title: '修正笔记标题',
        approved: true,
        contentHash: 'forged',
        ops: [{ kind: 'write', resourceId: RID, content: '# 标题\n', approve: true }],
      });
      await ctx.bridge.pumpOnce();
      const res = readRes(ctx.root, P);
      assert.equal(res.status, 'awaiting_approval');
      assert.ok(res.planId);
      assert.ok(res.ignoredFields?.includes('approved'));
      assert.ok(res.ignoredFields?.includes('contentHash'));
      assert.ok(res.ignoredFields?.includes('ops.0.approve'));
      assert.equal(ctx.stats.proposeCount, 1);
      assert.equal(ctx.stats.plans[0]?.status, 'draft');
      assert.equal(ctx.stats.plans[0]?.actor, 'agent:file');
      const pending = ctx.host.listPendingPlans();
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.planId, res.planId);
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '再写一次',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      assert.equal(ctx.stats.proposeCount, 1);
      assert.equal(readRes(ctx.root, P).planId, res.planId);
      assert.equal(ctx.stats.plans.length, 1);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('invoke 白名单可查待批准，其它命令不执行', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待批准',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      writeReq(ctx.root, Q, { type: 'invoke', invoke: { commandId: 'workbench.pendingPlans' } });
      writeReq(ctx.root, S, { type: 'invoke', invoke: { commandId: 'powershell' } });
      await ctx.bridge.pumpOnce();
      const listed = readRes(ctx.root, Q);
      assert.equal(listed.status, 'success');
      const plans = (listed.result as { plans: Array<{ planId: string }> }).plans;
      assert.equal(plans.length, 1);
      const denied = readRes(ctx.root, S);
      assert.equal(denied.status, 'failed');
      assert.equal(denied.error?.code, 'command_not_allowed');
    } finally {
      await ctx.bridge.close();
    }
  });

  it('未知 openAs 不打开；classify 真移动只提案；移除引用不执行', async () => {
    const ctx = await boot();
    try {
      const badOpen = '55555555-5555-4555-8555-555555555555';
      const moveId = '66666666-6666-4666-8666-666666666666';
      const addId = '77777777-7777-4777-8777-777777777777';
      const rmId = '88888888-8888-4888-8888-888888888888';
      writeReq(ctx.root, badOpen, { type: 'open', open: { resourceId: RID, openAs: 'desktop' } });
      writeReq(ctx.root, moveId, { type: 'classify', classify: { action: 'move', resourceId: RID, toRelPath: 'archive/a.md' } });
      writeReq(ctx.root, addId, { type: 'classify', classify: { action: 'add', resourceId: RID, folderId: 'folder-1' } });
      writeReq(ctx.root, rmId, {
        type: 'workspace-ref',
        workspaceRef: { action: 'remove', workspaceId: 'ws-1', resourceId: RID },
      });
      await ctx.bridge.pumpOnce();
      assert.equal(readRes(ctx.root, badOpen).status, 'failed');
      assert.equal(ctx.stats.openCount, 0);
      assert.equal(readRes(ctx.root, moveId).status, 'awaiting_approval');
      assert.equal(ctx.stats.plans[0]?.ops[0]?.kind, 'move');
      assert.equal(ctx.stats.classifyCount, 1);
      assert.equal(readRes(ctx.root, addId).status, 'success');
      const removed = readRes(ctx.root, rmId);
      assert.equal(removed.status, 'success');
      assert.equal((removed.result as { executed: boolean }).executed, false);
      assert.equal(ctx.stats.workspaceRemoves, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('类型为 approve 的请求失败；入口上若带 approve 方法则整单拒绝且不调用', async () => {
    const plain = await boot();
    try {
      writeReq(plain.root, Q, { type: 'approve', planId: 'x' });
      await plain.bridge.pumpOnce();
      assert.equal(readRes(plain.root, Q).error?.code, 'approval_ui_only');
      assert.equal(plain.stats.proposeCount, 0);
    } finally {
      await plain.bridge.close();
    }
    const tainted = await boot({ withApprove: true });
    try {
      writeReq(tainted.root, P, {
        type: 'plan-submit',
        title: '仍须界面批',
        ops: [{ kind: 'write', resourceId: RID, content: 'a' }],
      });
      await tainted.bridge.pumpOnce();
      assert.equal(readRes(tainted.root, P).error?.code, 'approval_ui_only');
      assert.equal(tainted.stats.proposeCount, 0);
      assert.equal(tainted.stats.approveCount, 0);
    } finally {
      await tainted.bridge.close();
    }
  });

  it('plan-status 只读，mount 不会把 approve 传给提案', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待查',
        ops: [{ kind: 'write', resourceId: RID, content: 'x' }],
      });
      await ctx.bridge.pumpOnce();
      const planId = readRes(ctx.root, P).planId!;
      writeReq(ctx.root, S, { type: 'plan-status', planId });
      await ctx.bridge.pumpOnce();
      const status = readRes(ctx.root, S);
      assert.equal(status.status, 'success');
      assert.equal(status.planId, planId);
      assert.equal((status.result as { status: string }).status, 'draft');
      assert.equal(ctx.stats.proposeCount, 1);
    } finally {
      await ctx.bridge.close();
    }

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-mount-'));
    let approveCalls = 0;
    const plans: Array<{ planId: string; title: string; status: string; actor: string; contentHash: string; ops: [] }> = [];
    const bridge = await mountFileAgentBridge({
      userDataDir: userData,
      pollMs: 0,
      useChokidar: false,
      stableMs: 0,
      svc: {
        listRoots: () => [{ id: 'root-1', name: '资料', path: 'D:\\secret\\root' }],
        getResource: () => null,
        emit: () => undefined,
      },
      ops: {
        forAgent: () => ({
          propose: async (title) => {
            const plan = { planId: 'abcdefab-abcd-4abc-8abc-abcdefabcdef', title, actor: 'agent:file', status: 'draft', contentHash: 'abc', ops: [] as [] };
            plans.push(plan);
            return { plan };
          },
          get: async (id: string) => plans.find((plan) => plan.planId === id) ?? null,
          approve() { approveCalls += 1; },
        }),
        forUi: () => ({
          pending: () => plans.map((plan) => ({ planId: plan.planId, title: plan.title, status: plan.status, actor: plan.actor, contentHash: plan.contentHash })),
        }),
      },
    });
    try {
      const id = 'bcdefabc-bcde-4bcd-8bcd-bcdefabcdefa';
      writeReq(bridge.root, id, {
        type: 'plan-submit',
        title: '经 wire 挂载',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await bridge.pumpOnce();
      const res = readRes(bridge.root, id);
      assert.equal(res.status, 'awaiting_approval');
      assert.equal(approveCalls, 0);
      assert.equal(bridge.root.endsWith(`${path.sep}agent-bridge`), true);
      const pending = plans.filter((plan) => plan.status === 'draft');
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.planId, res.planId);
    } finally {
      await bridge.close();
    }
  });

  it('控制台草稿落在 drafts，搜索说明为中文', async () => {
    const ctx = await boot();
    try {
      const draftId = '99999999-9999-4999-8999-999999999999';
      const helpId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      writeReq(ctx.root, draftId, {
        type: 'console-draft',
        draft: { title: '论文周复盘', description: '只生成草稿', items: [] },
      });
      writeReq(ctx.root, helpId, { type: 'search-help' });
      await ctx.bridge.pumpOnce();
      assert.equal(readRes(ctx.root, draftId).status, 'success');
      const md = fs.readFileSync(path.join(ctx.root, 'drafts', `${draftId}.kbconsole.md`), 'utf8');
      assert.match(md, /kbConsole: 1/);
      assert.match(md, /kb-console v=1/);
      const help = readRes(ctx.root, helpId);
      assert.match(String((help.result as { text: string }).text), /搜索框/);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('invoke 接受 actionId，旧 commandId 仍返回待批准计划', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待批准',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      const planId = readRes(ctx.root, P).planId;
      writeReq(ctx.root, Q, { type: 'invoke', actionId: 'workbench.pendingPlans', approved: true });
      const healthId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      writeReq(ctx.root, healthId, { type: 'invoke', invoke: { actionId: 'index.showHealth', commandId: 'index.showHealth' } });
      await ctx.bridge.pumpOnce();
      const listed = readRes(ctx.root, Q);
      assert.equal(listed.status, 'success');
      assert.ok(listed.ignoredFields?.includes('approved'));
      const plans = (listed.result as { plans: Array<{ planId: string }>; actionId: string; commandId: string }).plans;
      assert.equal(plans[0]?.planId, planId);
      assert.equal((listed.result as { actionId: string }).actionId, 'workbench.pendingPlans');
      assert.equal((listed.result as { commandId: string }).commandId, 'workbench.pendingPlans');
      const health = readRes(ctx.root, healthId);
      assert.equal(health.status, 'success');
      assert.equal((health.result as { actionId: string }).actionId, 'index.showHealth');
      assert.equal((health.result as { indexHealth: { contentSearch: boolean } }).indexHealth.contentSearch, false);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('actionId 与 commandId 不一致则不执行', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, Q, {
        type: 'invoke',
        invoke: { actionId: 'workbench.pendingPlans', commandId: 'index.showHealth' },
      });
      await ctx.bridge.pumpOnce();
      assert.equal(readRes(ctx.root, Q).error?.code, 'incomplete_request');
      assert.equal(ctx.stats.proposeCount, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('未批准的资料动作返回 awaiting_approval，内存宿主上的编排仍不可用', async () => {
    const ctx = await boot();
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'manifest.json'), 'utf8')) as { capabilityDetails: Array<Record<string, unknown>> };
        const byName = new Map(manifest.capabilityDetails.map((row) => [String(row.name), row]));
        for (const name of ['source.add.folder', 'source.filter.set']) {
          const row = byName.get(name);
          assert.ok(row, name);
          for (const field of ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema']) {
            assert.ok(field in row, name + ' ' + field);
          }
          assert.notEqual(row?.availability, 'available');
        }
        assert.equal(byName.get('source.remap.preview')?.availability, 'available');
        assert.equal(byName.get('catalog.ref.add')?.availability, 'available');
        assert.equal(byName.get('source.filter.set')?.approvalRequired, true);
        assert.equal(byName.get('source.add.folder')?.approvalRequired, true);
        assert.equal(byName.get('source.remap.preview')?.approvalRequired, false);
        assert.equal(byName.has('disk.write'), false);
        writeReq(ctx.root, Q, {
          type: 'invoke',
          invoke: { actionId: 'source.filter.set', args: { sourceId: 's1', extensions: ['md'] } },
          approved: true,
        });
        const addId = '55555555-5555-4555-8555-555555555555';
        writeReq(ctx.root, addId, {
          type: 'invoke',
          invoke: { actionId: 'source.add.folder', args: { name: '笔记', extensions: ['md'] } },
          approved: true,
        });
        writeReq(ctx.root, S, { type: 'invoke', invoke: { actionId: 'source.remap.preview' } });
        const refId = '66666666-6666-4666-8666-666666666666';
        writeReq(ctx.root, refId, {
          type: 'invoke',
          invoke: { actionId: 'catalog.ref.add', args: { catalogId: 'default', folderId: null, resourceId: RID } },
        });
        const zoomId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        writeReq(ctx.root, zoomId, { type: 'invoke', invoke: { commandId: 'view.contentZoomWheel' } });
        await ctx.bridge.pumpOnce();
        const filtered = readRes(ctx.root, Q);
        assert.equal(filtered.status, 'awaiting_approval');
        assert.equal(filtered.error, undefined);
        assert.ok(filtered.ignoredFields?.includes('approved'));
        assert.match(String((filtered.result as { note?: string } | undefined)?.note ?? ''), /批准/);
        const added = readRes(ctx.root, addId);
        assert.equal(added.status, 'awaiting_approval');
        assert.equal(added.error, undefined);
        assert.ok(added.ignoredFields?.includes('approved'));
        assert.equal(readRes(ctx.root, S).error?.code, 'incomplete_request');
        assert.equal(readRes(ctx.root, refId).error?.code, 'not_available');
        assert.equal(readRes(ctx.root, zoomId).error?.code, 'command_not_allowed');
        assert.equal(ctx.stats.proposeCount, 0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('state-export 六键用稳定 id，不写绝对路径', async () => {
    const ctx = await boot();
    try {
      ctx.host.readState = () => ({
        workspace: { workspaceId: 'ws-1', title: '默认' },
        resources: [{ resourceId: RID, title: 'a.md', sourceKind: 'file' }],
        panels: [{ itemId: 'item-1', resourceId: RID, adapterId: 'builtin.md' }],
        unsaved: [],
      });
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待导出',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      const planId = readRes(ctx.root, P).planId!;
      writeReq(ctx.root, Q, { type: 'state-export', snapshot: true });
      await ctx.bridge.pumpOnce();
      const res = readRes(ctx.root, Q);
      assert.equal(res.status, 'success');
      const body = res.result as {
        workspace: { workspaceId: string };
        resources: { resourceId: string }[];
        panels: { itemId: string }[];
        unsaved: unknown[];
        pendingPlans: { planId: string }[];
        results: { requestId: string }[];
      };
      assert.equal(body.workspace.workspaceId, 'ws-1');
      assert.equal(body.resources[0]?.resourceId, RID);
      assert.equal(body.panels[0]?.itemId, 'item-1');
      assert.equal(body.unsaved.length, 0);
      assert.equal(body.pendingPlans[0]?.planId, planId);
      assert.ok(body.results.some((row) => row.requestId === P));
      const snaps = fs.readdirSync(path.join(ctx.root, 'snapshots')).filter((name) => name.startsWith('state-'));
      assert.equal(snaps.length, 1);
      const text = fs.readFileSync(path.join(ctx.root, 'snapshots', snaps[0]!), 'utf8');
      assert.doesNotMatch(text, /should-not-leak/);
      assert.doesNotMatch(text, /[A-Za-z]:\\/);
    } finally {
      await ctx.bridge.close();
    }
  });
});
