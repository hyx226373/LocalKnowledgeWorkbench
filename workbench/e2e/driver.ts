import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryHost } from './memoryHost';
import { startAgentBridge } from '../src/main/agent-bridge/index';

const PLAN = '33333333-3333-4333-8333-333333333333';
const QUERY = '11111111-1111-4111-8111-111111111111';
const BAD = '12121212-1212-4121-8121-121212121212';
const RID = '22222222-2222-4222-8222-222222222222';

/** 不连 HTTP。写请求文件，读响应文件，并核对 UI 用的 pending 列表。 */
export async function runE2E(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-e2e-'));
  const { host, stats } = createMemoryHost();
  const bridge = await startAgentBridge({
    userDataDir: userData,
    host,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
  });
  try {
    const root = bridge.root;
    assert.equal(path.basename(root), 'agent-bridge');
    fs.writeFileSync(path.join(root, 'requests', `${QUERY}.json`), JSON.stringify({
      requestId: QUERY,
      type: 'query',
      query: { scope: 'roots' },
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'requests', `${BAD}.json`), JSON.stringify({
      requestId: BAD,
      type: 'plan-submit',
    }), 'utf8');
    fs.writeFileSync(path.join(root, 'requests', `${PLAN}.json`), JSON.stringify({
      requestId: PLAN,
      type: 'plan-submit',
      agentName: 'file',
      title: '修正笔记标题',
      approved: true,
      ops: [{ kind: 'write', resourceId: RID, content: '# 标题\n' }],
    }), 'utf8');
    await bridge.pumpOnce();
    const query = JSON.parse(fs.readFileSync(path.join(root, 'responses', `${QUERY}.json`), 'utf8'));
    const bad = JSON.parse(fs.readFileSync(path.join(root, 'responses', `${BAD}.json`), 'utf8'));
    const plan = JSON.parse(fs.readFileSync(path.join(root, 'responses', `${PLAN}.json`), 'utf8'));
    assert.equal(query.status, 'success');
    assert.equal(bad.status, 'failed');
    assert.equal(bad.error.code, 'incomplete_request');
    assert.equal(plan.status, 'awaiting_approval');
    assert.equal(typeof plan.planId, 'string');
    assert.ok(plan.ignoredFields.includes('approved'));
    const pending = host.listPendingPlans();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].planId, plan.planId);
    assert.equal(stats.proposeCount, 1);
    assert.equal(stats.approveCount, 0);
    await bridge.pumpOnce();
    assert.equal(stats.proposeCount, 1);
    const summary = { query: query.status, incomplete: bad.error.code, plan: plan.status, planId: plan.planId, pending: pending.length };
    fs.writeFileSync(path.join(userData, 'e2e-agent-bridge-result.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary));
  } finally {
    await bridge.close();
  }
}
