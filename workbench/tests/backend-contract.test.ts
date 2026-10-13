// 第 9 轮 E：后端接入准备——适配层契约测试（mock）。
// 磐石组的 @kb/plan、searchGrouped、createSync 验收后，把真模块放进同一套 contract 函数再跑一遍即可。
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeService, tmpDir, write } from './helpers';
import { ApprovalError, PlanGateway, planContentHash, type KbPlanService, type PlanDto, type PlanOp } from '../src/main/backend/plan';
import { LocalPlanService, OperationService } from '../src/main/backend/operations';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { KbSearch, LocalSearch, type GroupedHit } from '../src/main/backend/search';
import { LocalSync, guardHandle, type SyncHandle, type SyncProgress } from '../src/main/backend/sync';
import { createPlanService } from '@kb/plan';
import { createFileOps } from '@kb/fileops';
import { migrate as migrateIdentity, setMount, ensureResource, resolveInsideRoot } from '@kb/identity-watch';
import { migrate as migrateIndexer, searchGrouped, startIndex, closeIndexer } from '@kb/indexer';
import Database from 'better-sqlite3';
import { KbPlanAdapter } from '../src/main/backend/planAdapter';
import { fromIndexerGrouped } from '../src/main/backend/search';
import { startAgentServer } from '../src/main/backend/agentServer';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** 按磐石组交付说明写的 mock（异步接口，模拟对方实现） */
class MockPlanService implements KbPlanService {
  plans = new Map<string, PlanDto>();
  applied: string[] = [];
  migrated = false;
  async migrate() {
    this.migrated = true;
  }
  async createPlan(i: { actor: string; title: string; ops: Omit<PlanOp, 'opId'>[] }) {
    const ops = i.ops.map((o, k) => ({ ...o, opId: `m${k + 1}` }));
    const p: PlanDto = { planId: crypto.randomUUID(), actor: i.actor, title: i.title, ops, status: 'draft', contentHash: planContentHash(ops), approval: null };
    this.plans.set(p.planId, p);
    return structuredClone(p);
  }
  async updatePlan(id: string, ops: PlanOp[]) {
    const p = this.plans.get(id)!;
    Object.assign(p, { ops, contentHash: planContentHash(ops), approval: null, status: 'draft' });
  }
  async previewPlan(id: string) {
    const p = this.plans.get(id)!;
    return { planId: id, contentHash: p.contentHash, items: p.ops.map((o) => ({ opId: o.opId, summary: o.kind, conflicts: [] })) };
  }
  async approvePlan(id: string, a: { approvedOpIds: string[]; contentHash: string; channel: 'ui' }) {
    const p = this.plans.get(id)!;
    if (a.contentHash !== p.contentHash) throw new Error('stale');
    p.approval = { ...a, at: Date.now() };
    p.status = 'approved';
    return structuredClone(p);
  }
  async applyPlan(id: string) {
    const p = this.plans.get(id)!;
    if (p.status !== 'approved') throw new Error('not approved');
    this.applied.push(...p.approval!.approvedOpIds);
    p.status = 'applied';
    p.results = p.approval!.approvedOpIds.map((opId) => ({ opId, ok: true }));
    return structuredClone(p);
  }
  async getPlan(id: string) {
    const p = this.plans.get(id);
    return p ? structuredClone(p) : null;
  }
}

const OPS: Omit<PlanOp, 'opId'>[] = [
  { kind: 'move', resourceId: 'r1', rootId: 'R', relPath: 'a.md', toRelPath: 'b.md' },
  { kind: 'trash', resourceId: 'r2', rootId: 'R', relPath: 'c.md' },
];

function planContract(name: string, make: () => Promise<{ plans: KbPlanService & { updatePlan(id: string, ops: PlanOp[]): unknown }; ops: Omit<PlanOp, 'opId'>[]; after?: (p: PlanDto) => void }>) {
  describe(`计划服务契约：${name}`, () => {
    it('计划带内容哈希且与操作内容一致；预览返回同一哈希', async () => {
      const { plans, ops } = await make();
      const { plan, preview } = await new PlanGateway(plans).create('user', '整理', ops);
      expect(plan.contentHash).toBe(planContentHash(plan.ops));
      expect(preview.contentHash).toBe(plan.contentHash);
      expect(plan.status).toBe('draft');
    });
    it('只有界面能批准：agent / 插件渠道被拒绝，计划仍是草稿', async () => {
      const { plans, ops } = await make();
      const g = new PlanGateway(plans);
      const { plan } = await g.create('agent:x', '整理', ops);
      for (const ch of ['agent', 'plugin'] as const) await expect(g.approveAndApply(plan.planId, [plan.ops[0].opId], plan.contentHash, ch)).rejects.toMatchObject({ code: 'not-ui' });
      expect((await g.get(plan.planId))!.status).toBe('draft');
    });
    it('计划修改后原批准失效（用旧哈希批准被拒绝）', async () => {
      const { plans, ops } = await make();
      const g = new PlanGateway(plans);
      const { plan } = await g.create('agent:x', '整理', ops);
      await plans.updatePlan(plan.planId, plan.ops.slice(0, 1));
      await expect(g.approveAndApply(plan.planId, [plan.ops[0].opId], plan.contentHash, 'ui')).rejects.toMatchObject({ code: 'stale' });
    });
    it('批准不存在的操作、空批准被拒绝', async () => {
      const { plans, ops } = await make();
      const g = new PlanGateway(plans);
      const { plan } = await g.create('user', '整理', ops);
      await expect(g.approveAndApply(plan.planId, ['nope'], plan.contentHash, 'ui')).rejects.toBeInstanceOf(ApprovalError);
      await expect(g.approveAndApply(plan.planId, [], plan.contentHash, 'ui')).rejects.toMatchObject({ code: 'empty' });
    });
    it('批准后服务层自动执行，只执行被批准的操作；已执行的计划不能再批准', async () => {
      const { plans, ops, after } = await make();
      const g = new PlanGateway(plans);
      const { plan } = await g.create('user', '整理', ops);
      const done = await g.approveAndApply(plan.planId, [plan.ops[0].opId], plan.contentHash, 'ui');
      expect(['applied', 'failed']).toContain(done.status);
      expect(done.results!.map((r) => r.opId)).toEqual([plan.ops[0].opId]);
      after?.(done);
      await expect(g.approveAndApply(plan.planId, [plan.ops[0].opId], plan.contentHash, 'ui')).rejects.toMatchObject({ code: 'not-draft' });
    });
  });
}

planContract('mock（按磐石组接口）', async () => ({ plans: new MockPlanService(), ops: OPS }));

async function realSetup() {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  const dir = tmpDir('kbops-');
  write(path.join(dir, 'a.md'), 'A');
  write(path.join(dir, 'c.md'), 'C');
  const root = svc.addRoot(dir);
  await svc.scanRoot(root.id);
  const fileOps = new LocalFileOps(svc);
  return { svc, dir, root, fileOps, a: svc.resourceIdFor(root.id, 'a.md'), c: svc.resourceIdFor(root.id, 'c.md') };
}
planContract('LocalPlanService（本地实现）', async () => {
  const { svc, fileOps, a, c, root, dir } = await realSetup();
  return {
    plans: new LocalPlanService(svc, fileOps),
    ops: [
      { kind: 'move', resourceId: a, rootId: root.id, relPath: 'a.md', toRelPath: 'b.md' },
      { kind: 'trash', resourceId: c, rootId: root.id, relPath: 'c.md' },
    ],
    after: (p) => {
      expect(p.status).toBe('applied');
      expect(fs.existsSync(path.join(dir, 'b.md'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'c.md'))).toBe(true); // 未批准的 trash 没执行
    },
  };
});

describe('统一操作服务：界面与 agent 同一入口', () => {
  it('agent 只能提出计划（门面上没有 approve）；界面批准后自动执行，op_log 记 agent 身份，可撤销', async () => {
    const { svc, fileOps, a, dir } = await realSetup();
    const ops = new OperationService(svc, new LocalPlanService(svc, fileOps));
    const agent = ops.forAgent('整理助手');
    expect('approve' in agent).toBe(false);
    const { plan, preview } = await agent.propose('改写 a.md', [{ kind: 'write', resourceId: a, content: 'A2', expectedHash: fileOps.stat(a).hash }]);
    expect(preview.items[0].conflicts).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A');
    const ui = ops.forUi();
    expect(ui.pending().map((p) => p.planId)).toEqual([plan.planId]);
    // 产品决定：agent 的修改计划必须先看差异预览
    await expect(ui.approve(plan.planId, ['op1'], preview.contentHash)).rejects.toMatchObject({ code: 'not-reviewed' });
    const rv = await ui.review(plan.planId);
    expect(rv.diffs.op1.diff).toMatchObject({ added: 1, removed: 1, identical: false });
    expect(rv.diffs.op1.diff!.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(expect.arrayContaining(['del:A', 'add:A2']));
    const done = await ui.approve(plan.planId, ['op1'], preview.contentHash);
    expect(done.status).toBe('applied');
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A2');
    const op = svc.listOpsFor(a).find((o) => o.op === 'write')!;
    expect(op.actor).toBe('agent:整理助手');
    expect(ops.forAgent('a b/../c').propose).toBeTypeOf('function');
    expect(op.detail.planId).toBe(plan.planId);
    svc.undo(op.id);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('A');
  });
  it('提出计划后文件被外部修改：预览列出冲突；批准执行时不覆盖（结果 failed），文件保持外部版本', async () => {
    const { svc, fileOps, a, dir } = await realSetup();
    const plans = new LocalPlanService(svc, fileOps);
    const ui = new OperationService(svc, plans).forUi();
    const { plan } = await ui.propose('改写', [{ kind: 'write', resourceId: a, content: '我的', expectedHash: fileOps.stat(a).hash }]);
    fs.writeFileSync(path.join(dir, 'a.md'), '外部');
    const pv = await plans.previewPlan(plan.planId);
    expect(pv.items[0].conflicts.length).toBeGreaterThan(0);
    const done = await ui.approve(plan.planId, ['op1'], plan.contentHash);
    expect(done.status).toBe('failed');
    expect(done.results![0].error).toMatch(/冲突/);
    expect(fs.readFileSync(path.join(dir, 'a.md'), 'utf8')).toBe('外部');
  });
});

describe('搜索适配层契约', () => {
  const hit = (i: number, rootId = 'R1', n = 5): GroupedHit => ({ resourceId: `r${i}`, rootId, relPath: `f${i}.md`, title: `f${i}`, score: 1, matchKind: 'content', page: 2, snippet: '…', matches: Array.from({ length: n }, (_, k) => ({ start: k, end: k + 1, anchor: `#a${k}` })), matchesTruncated: false });
  it('KbSearch：按 rootIds 过滤、matches ≤ 3 并标 matchesTruncated、limit 截断标 truncated', async () => {
    const calls: unknown[] = [];
    const s = new KbSearch((db, q, o) => (calls.push([db, q, o]), { hits: [hit(1), hit(2, 'R2'), hit(3), hit(4)], truncated: false }), 'DB');
    const r = await s.search('关键词', { limit: 2, rootIds: ['R1'] });
    expect(calls[0]).toEqual(['DB', '关键词', { limit: 2, rootIds: ['R1'] }]);
    expect(r.hits.map((h) => h.resourceId)).toEqual(['r1', 'r3']);
    expect(r.truncated).toBe(true);
    expect(r.hits[0].matches).toHaveLength(3);
    expect(r.hits[0].matchesTruncated).toBe(true);
    expect(r.hits[0].matches[0].anchor).toBe('#a0');
  });
  it('LocalSearch（现有文件名搜索）返回同样形状', async () => {
    const { svc } = await realSetup();
    const r = await new LocalSearch(svc).search('a', { limit: 10 });
    expect(r.hits[0]).toMatchObject({ relPath: 'a.md', matchKind: 'name', matchesTruncated: false });
    expect(r.hits[0].matches.length).toBeLessThanOrEqual(3);
  });
});

describe('同步适配层契约', () => {
  function mockHandle() {
    const cbs = new Set<(p: SyncProgress) => void>();
    let resolve!: (v: { ok: boolean; cancelled: boolean }) => void;
    let cancels = 0;
    const h: SyncHandle = {
      onProgress: (cb) => (cbs.add(cb), () => cbs.delete(cb)),
      cancel: () => {
        cancels++;
        resolve({ ok: false, cancelled: true });
      },
      whenIdle: async () => undefined,
      done: new Promise((r) => (resolve = r)),
    };
    return { h, emit: (p: SyncProgress) => cbs.forEach((c) => c(p)), cancels: () => cancels, finish: () => resolve({ ok: true, cancelled: false }) };
  }
  it('guardHandle：进度可退订、cancel 幂等、done 结算为 {ok,cancelled}', async () => {
    const m = mockHandle();
    const g = guardHandle(m.h);
    const seen: SyncProgress[] = [];
    const off = g.onProgress((p) => seen.push(p));
    m.emit({ rootId: 'R', phase: 'scanning', processed: 1 });
    off();
    m.emit({ rootId: 'R', phase: 'scanning', processed: 2 });
    g.cancel();
    g.cancel();
    expect(seen.map((p) => p.processed)).toEqual([1]);
    expect(m.cancels()).toBe(1);
    expect(await g.done).toEqual({ ok: false, cancelled: true });
  });
  it('guardHandle：对方 done 抛错 → {ok:false,error}', async () => {
    const g = guardHandle({ onProgress: () => () => {}, cancel() {}, whenIdle: async () => {}, done: Promise.reject(new Error('坏了')) });
    expect(await g.done).toMatchObject({ ok: false, error: '坏了' });
  });
  it('LocalSync：包装现有对账扫描，有进度事件，done 成功', async () => {
    const { svc, root } = await realSetup();
    const h = new LocalSync(svc).startSync(root.id);
    const phases: string[] = [];
    h.onProgress((p) => phases.push(p.phase));
    expect(await h.done).toMatchObject({ ok: true, cancelled: false });
    await h.whenIdle();
    expect(phases.length).toBeGreaterThan(0);
  });
});


// ---- 第 10 轮：真实 @kb/plan / searchGrouped / agent 无 approve ----
async function kbPlanSetup() {
  const dir = tmpDir('kbplan-');
  const rootDir = path.join(dir, 'root');
  fs.mkdirSync(rootDir, { recursive: true });
  write(path.join(rootDir, 'a.md'), 'A');
  write(path.join(rootDir, 'c.md'), 'C');
  const dbPath = path.join(dir, 'm.sqlite');
  const db = new Database(dbPath);
  migrateIdentity(db);
  migrateIndexer(db);
  const rootId = 'R';
  db.prepare('INSERT INTO roots (id, name, created_at) VALUES (?,?,?)').run(rootId, 'r', Date.now());
  setMount(db, rootId, rootDir);
  const fileOps = createFileOps({
    db,
    dataDir: dir,
    resolveInsideRoot: (d, r, rel) => resolveInsideRoot(d, r, rel),
    ensureResource: (d, r, rel) => ensureResource(d, r, rel),
    onMoved: () => {},
  });
  fileOps.migrate();
  const plans = new KbPlanAdapter(createPlanService({ db, fileOps }));
  plans.migrate();
  cleanups.push(() => { db.close(); });
  return {
    plans,
    ops: [
      { kind: 'move' as const, resourceId: 'x', rootId, relPath: 'a.md', toRelPath: 'b.md' },
      { kind: 'trash' as const, resourceId: 'y', rootId, relPath: 'c.md' },
    ],
    after: (p: PlanDto) => {
      expect(['applied', 'failed']).toContain(p.status);
      if (p.status === 'applied') {
        expect(fs.existsSync(path.join(rootDir, 'b.md'))).toBe(true);
        expect(fs.existsSync(path.join(rootDir, 'c.md'))).toBe(true);
      }
    },
  };
}

planContract('@kb/plan（KbPlanAdapter）', () => kbPlanSetup());

describe('正文搜索 searchGrouped', () => {
  it('短查询走 fts_short；可命中正文', async () => {
    const dir = tmpDir('kbsearch-');
    const rootDir = path.join(dir, 'root');
    fs.mkdirSync(path.join(rootDir, 'notes'), { recursive: true });
    write(path.join(rootDir, 'notes', 'alpha.md'), '开头\n独一无二的正文词戊己庚\n结尾\n');
    const dbPath = path.join(dir, 's.sqlite');
    const db = new Database(dbPath);
    migrateIdentity(db);
    migrateIndexer(db);
    const rootId = 'SR';
    db.prepare('INSERT INTO roots (id, name, created_at) VALUES (?,?,?)').run(rootId, 's', Date.now());
    setMount(db, rootId, rootDir);
    const rid = 'res-alpha';
    const job = startIndex({
      rootId,
      localPath: rootDir,
      dbPath,
      resolveResourceId: () => rid,
      mode: 'full',
    });
    await job.done;
    cleanups.push(async () => {
      await closeIndexer().catch(() => {});
      db.close();
    });
    const short = fromIndexerGrouped(searchGrouped(db, '戊己', { limit: 10 }));
    expect(short.hits.length).toBeGreaterThan(0);
    expect(short.hits[0].matchKind).toBe('content');
    expect(short.hits[0].snippet || '').toMatch(/戊己/);
    const s = new KbSearch((d, q, o) => fromIndexerGrouped(searchGrouped(d as Database.Database, q, o)), db);
    const r = await s.search('戊己', { limit: 5 });
    expect(r.hits[0].resourceId).toBe(rid);
  });
});

describe('agent HTTP：无 approve', () => {
  it('propose 成功；approve/apply 返回 403；门面无 approve', async () => {
    const { svc, fileOps, a } = await realSetup();
    const opsSvc = new OperationService(svc, new LocalPlanService(svc, fileOps));
    const agent = opsSvc.forAgent('tester');
    expect('approve' in agent).toBe(false);
    const dir = tmpDir('kbagent-');
    const srv = await startAgentServer({ dataDir: dir, ops: opsSvc, agentName: 'tester', port: 0 });
    cleanups.push(() => srv.close());
    const { plan } = await agent.propose('改写', [{ kind: 'write', resourceId: a, content: 'Z', expectedHash: fileOps.stat(a).hash }]);
    const deny = await fetch(srv.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'plans.approve', params: { planId: plan.planId } }),
    });
    expect(deny.status).toBe(403);
    const body = await deny.json();
    expect(JSON.stringify(body)).toMatch(/user_approval_required/);
    const got = await fetch(srv.url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'plans.get', params: { planId: plan.planId } }),
    });
    expect(got.status).toBe(200);
    const gj = (await got.json()) as { result: { planId: string } };
    expect(gj.result.planId).toBe(plan.planId);
  });
});
