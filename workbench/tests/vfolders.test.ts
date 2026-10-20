// 第 11 轮 C：全局自建目录。只改归属，不移动、不复制原文件，不写 op_log，不进工作区导出。
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
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  const aDir = makeRoot();
  const bDir = tmpDir('kbroot-b-');
  write(path.join(bDir, '章节/一.md'), '# 一');
  write(path.join(aDir, '杂项.xyz'), 'xyz');
  const roots = [svc.addRoot(aDir), svc.addRoot(bDir)];
  for (const r of roots) await svc.scanRoot(r.id);
  return { svc, roots, dirs: [aDir, bDir] };
}

describe('全局自建目录', () => {
  it('多层目录、跨根归类、一资源多目录；删除时子目录上移、成员回到上一级；不改文件、不写 op_log', async () => {
    const { svc, roots, dirs } = await setup();
    const pdf = svc.resourceIdFor(roots[0].id, '资料/论文/paper.pdf');
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    const pdfPath = path.join(dirs[0], '资料/论文/paper.pdf');
    const before = sha(pdfPath);
    const size = fs.statSync(pdfPath).size;
    const ops = svc.listOps(50).length;

    const top = svc.createVirtualFolder(null, '资料柜');
    const child = svc.createVirtualFolder(top.folderId, '论文');
    expect(svc.listVirtualFolders().map((f) => f.name).sort()).toEqual(['资料柜', '论文'].sort());
    expect(svc.listVfolderView(null).folders.map((f) => f.name)).toEqual(['资料柜']);
    expect(svc.listVfolderView(top.folderId).folders.map((f) => f.folderId)).toEqual([child.folderId]);

    expect(svc.setVfolderMembership(pdf, [top.folderId, child.folderId]).sort()).toEqual([top.folderId, child.folderId].sort());
    expect(svc.setVfolderMembership(md, [child.folderId])).toEqual([child.folderId]);
    expect(svc.listVfolderView(child.folderId).entries.map((e) => e.resourceId).sort()).toEqual([pdf, md].sort());
    expect(new Set(svc.listVfolderView(child.folderId).entries.map((e) => e.rootId)).size).toBe(2);
    // 未知资源 ID 允许记下（网页占位 / 缺失），不报错
    svc.setVfolderMembership('web-stub-1', [child.folderId]);
    expect(svc.listVfolderMembership('web-stub-1')).toEqual([child.folderId]);

    expect(() => svc.moveVirtualFolder(top.folderId, child.folderId, 1)).toThrow(/子目录/);
    svc.moveVirtualFolder(child.folderId, null, 0);
    expect(svc.listVirtualFolders().find((f) => f.folderId === child.folderId)?.parentId).toBeNull();
    svc.moveVirtualFolder(child.folderId, top.folderId, 3);

    const gone = svc.deleteVirtualFolder(top.folderId);
    expect(gone.parentId).toBeNull();
    expect(svc.listVirtualFolders().find((f) => f.folderId === child.folderId)?.parentId).toBeNull();
    expect(svc.listVfolderView(null).entries.map((e) => e.resourceId)).toContain(pdf);
    expect(svc.listVfolderMembership(md)).toEqual([child.folderId]);

    expect(sha(pdfPath)).toBe(before);
    expect(fs.statSync(pdfPath).size).toBe(size);
    expect(svc.listOps(50).length).toBe(ops);
    expect(svc.listOps(50).filter((o) => /vfolder|ref/i.test(o.op))).toEqual([]);
  });

  it('按类型整理可撤销；只增加归属；空的新建目录会被删掉', async () => {
    const { svc, roots } = await setup();
    const pdf = svc.resourceIdFor(roots[0].id, '资料/论文/paper.pdf');
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    const xyz = svc.resourceIdFor(roots[0].id, '杂项.xyz');
    const keep = svc.createVirtualFolder(null, '保留');
    svc.setVfolderMembership(md, [keep.folderId]);
    const r = svc.classifyByType([pdf, md, xyz]);
    expect(r.added).toBe(3);
    const names = svc.listVirtualFolders().map((f) => f.name).sort();
    expect(names).toEqual(['PDF', '保留', '其他', '笔记'].sort());
    expect(svc.listVfolderMembership(md).sort()).toEqual([keep.folderId, svc.listVirtualFolders().find((f) => f.name === '笔记')!.folderId].sort());
    expect(svc.vfolderUndoAvailable()).toBe(true);
    const u = svc.undoVfolderClassify();
    expect(u.restored).toBe(3);
    expect(u.removedFolders).toBe(3);
    expect(svc.listVirtualFolders().map((f) => f.name)).toEqual(['保留']);
    expect(svc.listVfolderMembership(md)).toEqual([keep.folderId]);
    expect(svc.listVfolderMembership(pdf)).toEqual([]);
    expect(svc.vfolderUndoAvailable()).toBe(false);
  });

  it('撤销归类会把原先停在虚拟根的条目放回去', async () => {
    const { svc, roots } = await setup();
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    const folder = svc.createVirtualFolder(null, '临时');
    svc.setVfolderMembership(md, [folder.folderId]);
    svc.removeVfolderMembership(md, folder.folderId);
    expect(svc.listVfolderView(null).entries.map((e) => e.resourceId)).toContain(md);
    svc.classifyByType([md]);
    expect(svc.listVfolderView(null).entries.map((e) => e.resourceId)).not.toContain(md);
    expect(svc.listVfolderMembership(md)).toEqual([svc.listVirtualFolders().find((f) => f.name === '笔记')!.folderId]);
    svc.undoVfolderClassify();
    expect(svc.listVfolderMembership(md)).toEqual([]);
    expect(svc.listVfolderView(null).entries.map((e) => e.resourceId)).toContain(md);
    expect(svc.listVirtualFolders().map((f) => f.name)).toEqual(['临时']);
  });

  it('导出不含自建目录；导入旧布局不清目录；删除工作区不清全局目录', async () => {
    const { svc, roots } = await setup();
    const md = svc.resourceIdFor(roots[1].id, '章节/一.md');
    const folder = svc.createVirtualFolder(null, '不进导出');
    svc.setVfolderMembership(md, [folder.folderId]);
    const w = svc.getCurrentWorkspaceId();
    svc.addWorkspaceRefs(w, [md]);
    const file = svc.exportWorkspace(w);
    const dumped = JSON.stringify(file);
    expect(dumped).not.toContain('library.vfolders');
    expect(dumped).not.toContain(folder.folderId);
    expect(dumped).not.toContain('不进导出');
    const other = svc.createWorkspace('临时', '', EMPTY, []).id;
    svc.deleteWorkspace(other);
    expect(svc.listVirtualFolders().map((f) => f.folderId)).toEqual([folder.folderId]);
    const old = { format: 'kb-workbench.layout', formatVersion: 1, exportedAt: new Date().toISOString(), workspace: { name: '旧文件', project: '' }, layoutSchema: 4, layout: EMPTY, items: [], resources: [], refs: [md] };
    svc.importWorkspace(old, '旧文件');
    expect(svc.listVirtualFolders().map((f) => f.folderId)).toEqual([folder.folderId]);
    expect(svc.listVfolderMembership(md)).toEqual([folder.folderId]);
  });

  it('网页占位可以进自建目录，且不写进工作区导出', async () => {
    const { svc } = await setup();
    const id = '11111111-1111-1111-1111-111111111111';
    svc.rememberWebStub({ resourceId: id, url: 'https://example.com/page', title: '示例页' });
    const folder = svc.createVirtualFolder(null, '网络');
    svc.setVfolderMembership(id, [folder.folderId]);
    const entry = svc.listVfolderView(folder.folderId).entries.find((e) => e.resourceId === id);
    expect(entry).toMatchObject({ sourceKind: 'web', missing: false, name: '示例页', url: 'https://example.com/page' });
    const dumped = JSON.stringify(svc.exportWorkspace(svc.getCurrentWorkspaceId()));
    expect(dumped).not.toContain('library.webStubs');
    expect(dumped).not.toContain('example.com');
  });

  it('成员带真实 absPath，编排用 rootName/relPath；网页 absPath 为 null', async () => {
    const { svc, roots, dirs } = await setup();
    const md = svc.resourceIdFor(roots[0].id, '笔记/读书笔记.md');
    const folder = svc.createVirtualFolder(null, '待改');
    svc.setVfolderMembership(md, [folder.folderId]);
    const entry = svc.listVfolderView(folder.folderId).entries.find((e) => e.resourceId === md);
    expect(entry?.rootName).toBeTruthy();
    expect(entry?.relPath).toBe('笔记/读书笔记.md');
    expect(entry?.absPath?.toLowerCase()).toBe(path.join(dirs[0], '笔记', '读书笔记.md').toLowerCase());
    const view = svc.listVfolderView(folder.folderId);
    expect(view.folders.every((f) => !('absPath' in f))).toBe(true);
    const wid = '22222222-2222-2222-2222-222222222222';
    svc.rememberWebStub({ resourceId: wid, url: 'https://example.com/x', title: '网' });
    svc.setVfolderMembership(wid, [folder.folderId]);
    const web = svc.listVfolderView(folder.folderId).entries.find((e) => e.resourceId === wid);
    expect(web?.absPath).toBeNull();
  });
});
