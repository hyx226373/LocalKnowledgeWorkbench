// 第 9 轮 B：工作资料（集合）——跨根引用原文件；添加/移除不移动、不复制原文件
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makeRoot, makeService, tmpDir, write } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
const EMPTY = { schema: 4, dock: null, shell: { sidebarWidth: 280 } };
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const aDir = makeRoot();
  const bDir = tmpDir('kbroot-b-');
  const cDir = tmpDir('kbroot-c-');
  write(path.join(bDir, '章节/一.md'), '# 一');
  write(path.join(cDir, '数据.csv'), 'a,b\n1,2');
  const roots = [svc.addRoot(aDir), svc.addRoot(bDir), svc.addRoot(cDir)];
  for (const r of roots) await svc.scanRoot(r.id);
  return { svc, dataDir, roots, dirs: [aDir, bDir, cDir] };
}

describe('工作资料（集合）', () => {
  it('三个根、多种格式进同一工作；同一文件被两个工作引用；移除引用原文件字节不变', async () => {
    const { svc, roots, dirs } = await setup();
    const pdf = svc.resourceIdFor(roots[0].id, '资料/论文/paper.pdf');
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    const csv = svc.resourceIdFor(roots[2].id, '数据.csv');
    const w1 = svc.getCurrentWorkspaceId();
    const w2 = svc.createWorkspace('另一项', '', EMPTY, []).id;
    const before = sha(path.join(dirs[0], '资料/论文/paper.pdf'));
    const refs = svc.addWorkspaceRefs(w1, [pdf, md, csv, pdf]); // 幂等
    expect(refs.map((r) => r.resourceId)).toEqual([pdf, md, csv]);
    expect(new Set(refs.map((r) => r.rootId)).size).toBe(3);
    expect(new Set(refs.map((r) => r.ext)).size).toBe(3);
    svc.addWorkspaceRefs(w2, [pdf]);
    expect(svc.workspacesReferencing(pdf).map((w) => w.id).sort()).toEqual([w1, w2].sort());
    const s1 = svc.listWorkspaces().find((w) => w.id === w1)!;
    expect(s1.refCount).toBe(3);
    expect(s1.rootIds.length).toBe(3);
    svc.removeWorkspaceRef(w1, pdf);
    expect(svc.listWorkspaceRefs(w1).map((r) => r.resourceId)).toEqual([md, csv]);
    expect(svc.listWorkspaceRefs(w2).map((r) => r.resourceId)).toEqual([pdf]);
    expect(sha(path.join(dirs[0], '资料/论文/paper.pdf'))).toBe(before);
    // 没有写过 op_log（引用不是文件操作）
    expect(svc.listOps(50).filter((o) => /ref/i.test(o.op))).toEqual([]);
  });

  it('文件夹可以加入工作资料；不存在的资源报错；删除工作区清掉引用记录', async () => {
    const { svc, roots } = await setup();
    svc.getCurrentWorkspaceId();
    const w = svc.createWorkspace('临时', '', EMPTY, []).id;
    const folderId = roots[0].resourceId;
    expect(svc.addWorkspaceRefs(w, [folderId]).map((r) => r.resourceId)).toContain(folderId);
    expect(() => svc.addWorkspaceRefs(w, ['nope'])).toThrow(/资源不存在/);
    svc.addWorkspaceRefs(w, [svc.resourceIdFor(roots[1].id, '章节/一.md')]);
    svc.deleteWorkspace(w);
    expect(svc.getLayout(`workspace.refs:${w}`)).toBeNull();
  });

  it('原文件被删除后标记 missing，引用保留；移除根后同样 missing', async () => {
    const { svc, roots, dirs } = await setup();
    const w = svc.getCurrentWorkspaceId();
    const csv = svc.resourceIdFor(roots[2].id, '数据.csv');
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    svc.addWorkspaceRefs(w, [csv, md]);
    fs.rmSync(path.join(dirs[2], '数据.csv'));
    await svc.scanRoot(roots[2].id);
    svc.removeRoot(roots[1].id);
    const refs = svc.listWorkspaceRefs(w);
    expect(refs.map((r) => [r.resourceId, r.missing])).toEqual([[csv, true], [md, true]]);
  });

  it('导出/导入带上资料引用，按根名 + 相对路径重新匹配', async () => {
    const { svc, roots } = await setup();
    const w = svc.getCurrentWorkspaceId();
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    svc.addWorkspaceRefs(w, [md]);
    const file = svc.exportWorkspace(w);
    expect(file.refs).toEqual([md]);
    expect(file.resources.some((r) => r.relPath === '章节/一.md')).toBe(true);
    // 模拟另一台电脑：资源 ID 不同
    const fake = JSON.parse(JSON.stringify(file).split(md).join('00000000-0000-0000-0000-000000000000'));
    const r = svc.importWorkspace(fake, '导入的');
    expect(svc.listWorkspaceRefs(r.workspace.id).map((x) => x.resourceId)).toEqual([md]);
    expect(r.workspace.refCount).toBe(1);
  });
});
