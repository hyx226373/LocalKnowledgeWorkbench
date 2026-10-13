import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { decidePlanBridge, statusesToWrite, type WatchedPlan } from './conflict';
import { omitAgentBridgeFromLayout } from './layoutPolicy';
import { mountFileAgentBridge } from './index';
import { BRIDGE_BACKUP_POLICY } from './recovery';
import type { BridgeResponse } from './types';

const RID = '22222222-2222-4222-8222-222222222222';

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function createFixture() {
  const plans = new Map<string, WatchedPlan & {
    previewConflicts: string[];
    ops: Array<{ opId: string; kind: string; resourceId?: string; relPath?: string }>;
  }>();
  let proposeCount = 0;
  let applyCount = 0;
  const opLog: string[] = [];
  const ops = {
    forAgent(name: string) {
      return {
        propose: async (title: string, planOps: Array<{ kind: string; resourceId: string; content?: string }>) => {
          proposeCount += 1;
          const plan = {
            planId: randomUUID(),
            title,
            actor: `agent:${name}`,
            status: 'draft',
            contentHash: hashOf(planOps),
            results: [] as { opId: string; ok: boolean; error?: string }[],
            error: null as string | null,
            previewConflicts: [] as string[],
            ops: planOps.map((op, index) => ({ opId: `op${index + 1}`, kind: op.kind, resourceId: op.resourceId, relPath: 'notes/a.md' })),
          };
          plans.set(plan.planId, plan);
          return { plan, preview: { contentHash: plan.contentHash, items: [] } };
        },
        get: async (id: string) => plans.get(id) ?? null,
      };
    },
    forUi() {
      return {
        pending: () => [...plans.values()].filter((plan) => plan.status === 'draft').map((plan) => ({
          planId: plan.planId,
          title: plan.title,
          status: plan.status,
          actor: plan.actor,
          contentHash: plan.contentHash,
        })),
        get: async (id: string) => plans.get(id) ?? null,
        preview: async (id: string) => {
          const plan = plans.get(id);
          if (!plan) return null;
          return { contentHash: plan.contentHash, items: [{ opId: 'op1', summary: '写入', conflicts: [...plan.previewConflicts] }] };
        },
      };
    },
  };
  return {
    ops,
    plans,
    opLog,
    counts: () => ({ proposeCount, applyCount, opLog }),
    uiApprove(planId: string, seenHash: string) {
      const plan = plans.get(planId);
      if (!plan) throw new Error('计划不存在');
      if (plan.contentHash !== seenHash) throw new Error('计划在你查看之后被修改过，请重新查看后再批准');
      if (plan.previewConflicts.length) {
        plan.status = 'failed';
        plan.error = '文件已被修改（冲突），未写入';
        plan.results = [{ opId: 'op1', ok: false, error: plan.error }];
        return plan;
      }
      applyCount += 1;
      plan.status = 'applied';
      plan.results = [{ opId: 'op1', ok: true }];
      opLog.push(plan.actor);
      return plan;
    },
    reject(planId: string) {
      const plan = plans.get(planId);
      if (!plan) throw new Error('计划不存在');
      plan.status = 'discarded';
      plan.error = '用户拒绝';
    },
    updatePlan(planId: string) {
      const plan = plans.get(planId);
      if (!plan) throw new Error('计划不存在');
      plan.contentHash = 'ab'.repeat(32);
      plan.status = 'draft';
      plan.previewConflicts = [];
    },
    markExternal(planId: string) {
      const plan = plans.get(planId);
      if (!plan) throw new Error('计划不存在');
      plan.previewConflicts = ['文件在提出计划后已被修改'];
    },
  };
}

async function boot(userData: string, fx: ReturnType<typeof createFixture>) {
  return mountFileAgentBridge({
    userDataDir: userData,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
    svc: {
      listRoots: () => [{ id: 'root-1', name: '资料' }],
      getResource: (id) => id === RID
        ? { resourceId: id, rootId: 'root-1', relPath: 'notes/a.md', name: 'a.md', kind: 'file', ext: 'md' }
        : null,
      emit: () => undefined,
    },
    ops: fx.ops,
  });
}

function writeReq(root: string, id: string, body: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ requestId: id, agentName: 'file', ...body }), 'utf8');
}

function readRes(root: string, id: string): BridgeResponse {
  return JSON.parse(fs.readFileSync(path.join(root, 'responses', `${id}.json`), 'utf8')) as BridgeResponse;
}

const PLAN = '33333333-3333-4333-8333-333333333333';
const PLAN2 = '55555555-5555-4555-8555-555555555555';
const PLAN3 = '66666666-6666-4666-8666-666666666666';
const PLAN4 = '77777777-7777-4777-8777-777777777777';

describe('冲突映射表', () => {
  const saved = 'aa'.repeat(32);
  const plan = (status: string, hash = saved, extra: Partial<WatchedPlan> = {}): WatchedPlan => ({
    planId: 'p1',
    title: '改笔记',
    actor: 'agent:file',
    status,
    contentHash: hash,
    ...extra,
  });

  const cases: Array<{ name: string; input: Parameters<typeof decidePlanBridge>[0]; status: string; action?: string }> = [
    { name: '草稿且哈希一致仍待批准', input: { mode: 'watch', currentStatus: 'awaiting_approval', savedHash: saved, plan: plan('draft'), previewConflicts: [] }, status: 'awaiting_approval' },
    { name: '已执行且哈希一致为成功', input: { mode: 'watch', currentStatus: 'awaiting_approval', savedHash: saved, plan: plan('applied', saved, { results: [{ opId: 'op1', ok: true }] }), previewConflicts: [] }, status: 'success' },
    { name: '改计划后冲突并建议重提', input: { mode: 'watch', currentStatus: 'awaiting_approval', savedHash: saved, plan: plan('draft', 'bb'.repeat(32)), previewConflicts: [] }, status: 'conflict', action: 're-propose' },
    { name: '预览外改冲突', input: { mode: 'watch', currentStatus: 'awaiting_approval', savedHash: saved, plan: plan('draft'), previewConflicts: ['文件在提出计划后已被修改'] }, status: 'conflict', action: 're-propose' },
    { name: '执行期哈希失败是冲突', input: { mode: 'watch', currentStatus: 'running', savedHash: saved, plan: plan('failed', saved, { error: '文件已被修改（冲突），未写入', results: [{ opId: 'op1', ok: false, error: '文件已被修改（冲突），未写入' }] }), previewConflicts: [] }, status: 'conflict', action: 're-propose' },
    { name: '用户拒绝', input: { mode: 'watch', currentStatus: 'awaiting_approval', savedHash: saved, plan: plan('discarded', saved, { error: '用户拒绝' }), previewConflicts: [] }, status: 'failed' },
    { name: '回滚后去恢复界面', input: { mode: 'recovery', currentStatus: 'running', savedHash: saved, plan: plan('failed-rolled-back'), previewConflicts: [] }, status: 'conflict', action: 'open-restore-ui' },
    { name: '重启找不到计划', input: { mode: 'recovery', currentStatus: 'awaiting_approval', savedHash: saved, plan: null, previewConflicts: [] }, status: 'conflict', action: 'inspect-plan' },
    { name: '重启仍是草稿不执行', input: { mode: 'recovery', currentStatus: 'running', savedHash: saved, plan: plan('draft'), previewConflicts: [] }, status: 'awaiting_approval' },
    { name: '终态不再改写', input: { mode: 'watch', currentStatus: 'success', savedHash: saved, plan: plan('draft', 'bb'.repeat(32)), previewConflicts: ['文件已被修改'] }, status: 'success' },
  ];

  for (const row of cases) {
    it(row.name, () => {
      const decision = decidePlanBridge(row.input);
      assert.equal(decision.status, row.status);
      assert.equal(decision.suggestedAction, row.action);
      if (row.status === 'conflict' && row.action === 're-propose') {
        assert.match(JSON.stringify(decision), /请重新查看计划/);
      }
      if (row.name === '已执行且哈希一致为成功') {
        assert.deepEqual(statusesToWrite('awaiting_approval', decision), ['running', 'success']);
      }
      if (row.name === '终态不再改写') assert.equal(decision.changed, false);
      if (row.name === '重启仍是草稿不执行') assert.equal(decision.viaRunning, false);
    });
  }

  it('备份策略：桥不进布局，迁移备份不含桥，保留 5 份', () => {
    assert.equal(BRIDGE_BACKUP_POLICY.includedInWorkspaceLayout, false);
    assert.equal(BRIDGE_BACKUP_POLICY.migrationBackupIncludesBridge, false);
    assert.equal(BRIDGE_BACKUP_POLICY.migrationBackupKeep, 5);
    assert.equal(BRIDGE_BACKUP_POLICY.onUserDataRestore, 'reconcile-nonterminal-no-apply');
    assert.equal(BRIDGE_BACKUP_POLICY.approvalTimeout, false);
    const cleaned = omitAgentBridgeFromLayout({
      format: 'kb-workbench.layout',
      resources: [{ relPath: 'notes/a.md' }, { relPath: 'agent-bridge/requests/x.json' }],
      note: 'keep',
    });
    assert.equal(JSON.stringify(cleaned).includes('agent-bridge'), false);
    assert.match(JSON.stringify(cleaned), /notes\/a.md/);
  });
});

describe('计划响应闭环', () => {
  it('伪 approved 仍待批准；界面批准后 success；同 requestId 不二次执行', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-plan-'));
    const fx = createFixture();
    const bridge = await boot(userData, fx);
    try {
      writeReq(bridge.root, PLAN, {
        type: 'plan-submit',
        title: '修正笔记',
        approved: true,
        contentHash: 'forged',
        ops: [{ kind: 'write', resourceId: RID, content: '# 新\n' }],
      });
      await bridge.pumpOnce();
      await bridge.syncPlans();
      const waiting = readRes(bridge.root, PLAN);
      assert.equal(waiting.status, 'awaiting_approval');
      assert.notEqual(waiting.status, 'success');
      assert.equal(fx.counts().applyCount, 0);
      assert.equal(fx.counts().proposeCount, 1);
      const saved = (waiting.result as { contentHash: string }).contentHash;
      fx.uiApprove(waiting.planId!, saved);
      await bridge.syncPlans();
      const done = readRes(bridge.root, PLAN);
      assert.equal(done.status, 'success');
      assert.equal((done.result as { contentHash: string }).contentHash, saved);
      assert.match(JSON.stringify(done.result), /op1:ok|已执行/);
      assert.equal(fx.counts().applyCount, 1);
      assert.equal(fx.counts().opLog[0], 'agent:file');
      writeReq(bridge.root, PLAN, {
        type: 'plan-submit',
        title: '再写一次',
        approved: true,
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await bridge.pumpOnce();
      await bridge.syncPlans();
      assert.equal(readRes(bridge.root, PLAN).status, 'success');
      assert.equal(fx.counts().proposeCount, 1);
      assert.equal(fx.counts().applyCount, 1);
    } finally {
      await bridge.close();
    }
  });

  it('updatePlan 后旧批准失效，响应为 conflict', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-hash-'));
    const fx = createFixture();
    const bridge = await boot(userData, fx);
    try {
      writeReq(bridge.root, PLAN2, { type: 'plan-submit', title: '会变', ops: [{ kind: 'write', resourceId: RID, content: 'a' }] });
      await bridge.pumpOnce();
      await bridge.syncPlans();
      const waiting = readRes(bridge.root, PLAN2);
      const saved = (waiting.result as { contentHash: string }).contentHash;
      fx.updatePlan(waiting.planId!);
      await bridge.syncPlans();
      const conflict = readRes(bridge.root, PLAN2);
      assert.equal(conflict.status, 'conflict');
      assert.equal(conflict.suggestedAction, 're-propose');
      assert.match(conflict.error?.message ?? '', /请重新查看计划/);
      assert.notEqual((conflict.result as { contentHash: string }).contentHash, saved);
      assert.throws(() => fx.uiApprove(waiting.planId!, saved), /修改/);
      assert.equal(fx.counts().applyCount, 0);
    } finally {
      await bridge.close();
    }
  });

  it('外改进入 conflict，桥不执行', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-ext-'));
    const fx = createFixture();
    const bridge = await boot(userData, fx);
    try {
      writeReq(bridge.root, PLAN3, { type: 'plan-submit', title: '外改', ops: [{ kind: 'write', resourceId: RID, content: 'b' }] });
      await bridge.pumpOnce();
      const waiting = readRes(bridge.root, PLAN3);
      fx.markExternal(waiting.planId!);
      await bridge.syncPlans();
      const conflict = readRes(bridge.root, PLAN3);
      assert.equal(conflict.status, 'conflict');
      assert.equal(conflict.suggestedAction, 're-propose');
      assert.equal(fx.counts().applyCount, 0);
      assert.equal(fx.counts().proposeCount, 1);
    } finally {
      await bridge.close();
    }
  });

  it('界面拒绝写 failed，不执行', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-no-'));
    const fx = createFixture();
    const bridge = await boot(userData, fx);
    try {
      writeReq(bridge.root, PLAN4, { type: 'plan-submit', title: '不要', ops: [{ kind: 'trash', resourceId: RID }] });
      await bridge.pumpOnce();
      const waiting = readRes(bridge.root, PLAN4);
      fx.reject(waiting.planId!);
      await bridge.syncPlans();
      const failed = readRes(bridge.root, PLAN4);
      assert.equal(failed.status, 'failed');
      assert.equal(failed.error?.code, 'user_rejected');
      assert.equal(fx.counts().applyCount, 0);
    } finally {
      await bridge.close();
    }
  });

  it('重启时 running 且计划仍是草稿：回到待批准，不执行', async () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-boot-'));
    const fx = createFixture();
    const first = await boot(userData, fx);
    writeReq(first.root, PLAN, { type: 'plan-submit', title: '重启', ops: [{ kind: 'write', resourceId: RID, content: 'c' }] });
    await first.pumpOnce();
    const waiting = readRes(first.root, PLAN);
    assert.equal(waiting.status, 'awaiting_approval');
    const crashed: BridgeResponse = { ...waiting, status: 'running', updatedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(first.root, 'responses', `${PLAN}.json`), JSON.stringify(crashed), 'utf8');
    await first.close();
    const second = await boot(userData, fx);
    try {
      const restored = readRes(second.root, PLAN);
      assert.equal(restored.status, 'awaiting_approval');
      assert.match(JSON.stringify(restored.result), /没有自动再执行/);
      assert.equal(fx.counts().proposeCount, 1);
      assert.equal(fx.counts().applyCount, 0);
      await second.pumpOnce();
      await second.syncPlans();
      assert.equal(fx.counts().proposeCount, 1);
      assert.equal(fx.counts().applyCount, 0);
    } finally {
      await second.close();
    }
  });
});
