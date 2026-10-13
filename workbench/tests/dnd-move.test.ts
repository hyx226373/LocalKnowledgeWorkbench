import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, makeService, write } from './helpers';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { LocalPlanService, OperationService } from '../src/main/backend/operations';
import { WorkbenchService } from '../src/main/service/WorkbenchService';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  const rootDir = makeRoot();
  const root = svc.addRoot(rootDir);
  await svc.scanRoot(root.id);
  return { svc, rootDir, root };
}

const ridOf = (svc: WorkbenchService, rootId: string, rel: string) => svc.resourceIdFor(rootId, rel);

describe('跨根真移动', () => {
  it('resourceId 不变，可撤销，同根记录仍是 from/to', async () => {
    const { svc, root, rootDir } = await setup();
    const otherDir = makeRoot();
    const other = svc.addRoot(otherDir);
    await svc.scanRoot(other.id);
    const rid = ridOf(svc, root.id, '资料/报告.docx');
    const op = svc.move(rid, '收件/报告.docx', 'user', other.id);
    expect(op.detail).toMatchObject({ from: '资料/报告.docx', to: '收件/报告.docx', fromRoot: root.id, toRoot: other.id });
    expect(fs.existsSync(path.join(otherDir, '收件/报告.docx'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(false);
    expect(svc.getResource(rid)?.rootId).toBe(other.id);
    expect(svc.getResource(rid)?.relPath).toBe('收件/报告.docx');
    svc.undo(op.id);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    expect(svc.getResource(rid)?.rootId).toBe(root.id);
    expect(svc.getResource(rid)?.relPath).toBe('资料/报告.docx');

    const same = svc.move(rid, '归档/报告.docx');
    expect(same.detail).toEqual({ from: '资料/报告.docx', to: '归档/报告.docx' });
    write(path.join(rootDir, '归档/已有.txt'), 'x');
  });

  it('界面先提出计划，批准前原文件不动；同根计划不带 toRootId', async () => {
    const { svc, root, rootDir } = await setup();
    const otherDir = makeRoot();
    const other = svc.addRoot(otherDir);
    await svc.scanRoot(other.id);
    const rid = ridOf(svc, root.id, '资料/报告.docx');
    const ui = new OperationService(svc, new LocalPlanService(svc, new LocalFileOps(svc))).forUi();
    const same = await ui.propose('将移动原文件', [{ kind: 'move', resourceId: rid, toRelPath: '归档/报告.docx' }]);
    expect(same.plan.ops[0].toRootId).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    const { plan } = await ui.propose('将移动原文件', [{ kind: 'move', resourceId: rid, toRelPath: '收件/报告.docx', toRootId: other.id }]);
    expect(plan.ops[0].toRootId).toBe(other.id);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    const done = await ui.approve(plan.planId, plan.ops.map((o) => o.opId), plan.contentHash);
    expect(done.status).toBe('applied');
    expect(fs.existsSync(path.join(otherDir, '收件/报告.docx'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(false);
    expect(svc.getResource(rid)?.rootId).toBe(other.id);
    const op = svc.listOps(20).find((o) => o.op === 'move' && o.resourceId === rid);
    expect(op).toBeTruthy();
    svc.undo(op!.id);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    expect(svc.getResource(rid)?.rootId).toBe(root.id);
  });

  it('字节已经在新位置时补记同一个 resourceId，并可撤销', async () => {
    const { svc, root, rootDir } = await setup();
    const rid = ridOf(svc, root.id, '资料/报告.docx');
    fs.mkdirSync(path.join(rootDir, '归档'), { recursive: true });
    fs.renameSync(path.join(rootDir, '资料/报告.docx'), path.join(rootDir, '归档/报告.docx'));
    const op = svc.adoptMove(rid, '归档/报告.docx');
    expect(op?.detail).toEqual({ from: '资料/报告.docx', to: '归档/报告.docx' });
    expect(svc.getResource(rid)?.relPath).toBe('归档/报告.docx');
    expect(svc.adoptMove(rid, '归档/报告.docx')).toBeNull();
    svc.undo(op!.id);
    expect(fs.existsSync(path.join(rootDir, '资料/报告.docx'))).toBe(true);
    expect(svc.getResource(rid)?.relPath).toBe('资料/报告.docx');
  });
});
