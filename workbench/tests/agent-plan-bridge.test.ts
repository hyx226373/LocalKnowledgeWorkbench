import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { LocalPlanService, OperationService } from '../src/main/backend/operations';
import { omitAgentBridgeFromLayout } from '../src/main/agent-bridge/layoutPolicy';
import { mountFileAgentBridge } from '../src/main/agent-bridge';
import { makeService, tmpDir, write } from './helpers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REQ = '33333333-3333-4333-8333-333333333333';

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const dir = tmpDir('g2ops-');
  write(path.join(dir, 'a.md'), 'A');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  const fileOps = new LocalFileOps(svc);
  const plans = new LocalPlanService(svc, fileOps);
  const ops = new OperationService(svc, plans);
  const bridge = await mountFileAgentBridge({
    userDataDir: dataDir,
    svc,
    ops,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
  });
  cleanups.push(() => bridge.close());
  const resourceId = svc.resourceIdFor(root.id, 'a.md');
  return { svc, dataDir, dir, ops, plans, bridge, resourceId, fileOps };
}

function readRes(root: string) {
  return JSON.parse(fs.readFileSync(path.join(root, 'responses', `${REQ}.json`), 'utf8')) as {
    status: string;
    planId?: string;
    suggestedAction?: string;
    error?: { message: string };
    result?: { contentHash?: string };
  };
}

describe('G2 与界面共用批准', () => {
  it('AgentOps 没有 approve；伪 approved 在人批前不是 success', async () => {
    const { bridge, resourceId, ops } = await setup();
    expect('approve' in ops.forAgent('file')).toBe(false);
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      agentName: 'file',
      title: '改 a.md',
      approved: true,
      ops: [{ kind: 'write', resourceId, content: 'A2' }],
    }), 'utf8');
    await bridge.pumpOnce();
    await bridge.syncPlans();
    const waiting = readRes(bridge.root);
    expect(waiting.status).toBe('awaiting_approval');
    expect(waiting.status).not.toBe('success');
  });

  it('界面 review + approve 后响应 success，op_log actor 为 agent，同请求不二次写入', async () => {
    const { svc, dir, ops, bridge, resourceId, fileOps } = await setup();
    const before = fileOps.stat(resourceId).hash;
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      agentName: '整理',
      title: '改 a.md',
      ops: [{ kind: 'write', resourceId, content: 'A2', expectedHash: before }],
    }), 'utf8');
    await bridge.pumpOnce();
    const waiting = readRes(bridge.root);
    expect(waiting.planId).toBeTruthy();
    const ui = ops.forUi();
    await expect(ui.approve(waiting.planId!, [ 'op1' ], waiting.result!.contentHash!)).rejects.toMatchObject({ code: 'not-reviewed' });
    await ui.preview(waiting.planId!);
    await expect(ui.approve(waiting.planId!, ['op1'], waiting.result!.contentHash!)).rejects.toMatchObject({ code: 'not-reviewed' });
    const review = await ui.review(waiting.planId!);
    const done = await ui.approve(waiting.planId!, review.plan.ops.map((op) => op.opId), review.preview.contentHash);
    expect(done.status).toBe('applied');
    await bridge.syncPlans();
    const res = readRes(bridge.root);
    expect(res.status).toBe('success');
    expect(res.result?.contentHash).toBe(waiting.result?.contentHash);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A2');
    const writes = svc.listOps(20).filter((op) => op.op === 'write' && op.actor.startsWith('agent:'));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.actor).toBe('agent:整理');
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      title: '再来',
      ops: [{ kind: 'write', resourceId, content: 'A3', expectedHash: fileOps.stat(resourceId).hash }],
    }), 'utf8');
    await bridge.pumpOnce();
    await bridge.syncPlans();
    expect(readRes(bridge.root).status).toBe('success');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A2');
    expect(svc.listOps(20).filter((op) => op.op === 'write' && op.actor.startsWith('agent:'))).toHaveLength(1);
  });

  it('updatePlan 后响应 conflict，旧 contentHash 不能批准', async () => {
    const { dir, ops, plans, bridge, resourceId } = await setup();
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      title: '会变',
      ops: [{ kind: 'write', resourceId, content: 'B' }],
    }), 'utf8');
    await bridge.pumpOnce();
    const waiting = readRes(bridge.root);
    const saved = waiting.result!.contentHash!;
    const current = await plans.getPlan(waiting.planId!);
    plans.updatePlan(waiting.planId!, current!.ops.map((op, index) => ({ ...op, expectedHash: index === 0 ? 'changed-hash' : op.expectedHash })));
    await bridge.syncPlans();
    const conflict = readRes(bridge.root);
    expect(conflict.status).toBe('conflict');
    expect(conflict.suggestedAction).toBe('re-propose');
    expect(conflict.error?.message).toMatch(/请重新查看计划/);
    await expect(ops.forUi().approve(waiting.planId!, ['op1'], saved)).rejects.toThrow(/修改/);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A');
  });

  it('外改在预览期变成 conflict，不覆盖文件', async () => {
    const { dir, bridge, resourceId, fileOps } = await setup();
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      title: '外改',
      ops: [{ kind: 'write', resourceId, content: 'C', expectedHash: fileOps.stat(resourceId).hash }],
    }), 'utf8');
    await bridge.pumpOnce();
    fs.writeFileSync(path.join(dir, 'a.md'), '外部');
    await bridge.syncPlans();
    const conflict = readRes(bridge.root);
    expect(conflict.status).toBe('conflict');
    expect(conflict.suggestedAction).toBe('re-propose');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('外部');
  });

  it('界面拒绝后响应 failed，文件不变', async () => {
    const { dir, ops, bridge, resourceId } = await setup();
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      title: '不要',
      ops: [{ kind: 'write', resourceId, content: 'D' }],
    }), 'utf8');
    await bridge.pumpOnce();
    const waiting = readRes(bridge.root);
    await ops.forUi().review(waiting.planId!);
    const rejected = await ops.forUi().reject(waiting.planId!, '用户拒绝');
    expect(rejected.status).toBe('discarded');
    await bridge.syncPlans();
    expect(readRes(bridge.root).status).toBe('failed');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A');
    expect(ops.forUi().pending().some((plan) => plan.planId === waiting.planId)).toBe(false);
  });

  it('重启对账不把未批准计划执行掉', async () => {
    const { svc, dataDir, dir, ops, bridge, resourceId } = await setup();
    fs.writeFileSync(path.join(bridge.root, 'requests', `${REQ}.json`), JSON.stringify({
      requestId: REQ,
      type: 'plan-submit',
      title: '重启',
      ops: [{ kind: 'write', resourceId, content: 'E' }],
    }), 'utf8');
    await bridge.pumpOnce();
    const waiting = readRes(bridge.root);
    const crashed = { ...waiting, status: 'running' };
    fs.writeFileSync(path.join(bridge.root, 'responses', `${REQ}.json`), JSON.stringify(crashed), 'utf8');
    await bridge.close();
    const again = await mountFileAgentBridge({
      userDataDir: dataDir,
      svc,
      ops,
      pollMs: 0,
      useChokidar: false,
      stableMs: 0,
    });
    cleanups.push(() => again.close());
    expect(readRes(again.root).status).toBe('awaiting_approval');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A');
  });

  it('布局导出剔除 agent-bridge', () => {
    const file = omitAgentBridgeFromLayout({
      format: 'kb-workbench.layout',
      resources: [{ relPath: 'a.md' }],
      'agent-bridge': { requests: ['secret'] },
    });
    expect(JSON.stringify(file)).not.toContain('agent-bridge');
    expect(JSON.stringify(file)).toContain('a.md');
  });
});
