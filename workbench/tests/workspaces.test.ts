import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeRoot, makeService, tmpDir, write } from './helpers';
import { WorkbenchService, layoutResourceIds } from '../src/main/service/WorkbenchService';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(dataDir?: string) {
  const { svc, dataDir: d } = dataDir ? { svc: new WorkbenchService({ dataDir }), dataDir } : await makeService();
  cleanups.push(() => svc.close());
  return { svc, dataDir: d };
}

const layoutWith = (items: Record<string, unknown>, panelIds = Object.keys(items)) => ({
  schema: 3,
  shell: { sidebarWidth: 300 },
  items,
  dock: {
    grid: { root: { type: 'branch', size: 800, data: panelIds.map((id, i) => ({ type: 'leaf', size: 400, data: { views: [id], activeView: id, id: String(i + 1) } })) }, width: 800, height: 600, orientation: 'HORIZONTAL' },
    panels: Object.fromEntries(panelIds.map((id) => [id, { id, contentComponent: 'view', params: { itemId: id } }])),
  },
});
/** schema 4：布局只有 dock/shell，条目单独传 */
const layout4 = (items: Record<string, unknown>) => {
  const { items: _drop, ...rest } = layoutWith(items);
  return { layout: { ...rest, schema: 4 }, items: Object.values(items) };
};
const itemsOf = (ws: { items: { itemId: string }[] }) => Object.fromEntries(ws.items.map((i) => [i.itemId, i])) as Record<string, any>;
const fileItem = (itemId: string, ref: string, adapterId = 'auto', state?: unknown) => ({ itemId, sourceKind: 'file', adapterId, ref, displayMode: 'in-app-reader', ...(state ? { state } : {}) });

describe('命名工作区（全局、可按项目分组、可跨根）', () => {
  it('首次运行创建“默认工作区”并迁入旧的单一布局', async () => {
    const { svc } = await setup();
    svc.setLayout('dock', { grid: {}, panels: { 'res:a': { params: { resourceId: 'a' } } } });
    svc.setLayout('ui', { sidebarWidth: 321 });
    const id = svc.getCurrentWorkspaceId();
    const ws = svc.getWorkspace(id);
    expect(ws.name).toBe('默认工作区');
    expect(ws.layoutSchema).toBe(1);
    expect(layoutResourceIds(ws.layout)).toEqual(['a']);
    expect(svc.getCurrentWorkspaceId()).toBe(id); // 不重复创建
    expect(svc.listWorkspaces()).toHaveLength(1);
  });

  it('创建/改名/分组/切换/删除；至少保留一个；删除当前时自动换到另一个', async () => {
    const { svc, dataDir } = await setup();
    const first = svc.getCurrentWorkspaceId();
    const a = svc.createWorkspace('读文献', '论文');
    const b = svc.createWorkspace('写作', '写作');
    expect(() => svc.createWorkspace('  ')).toThrow(/不能为空/);
    svc.updateWorkspace(b.id, { name: '写作-初稿', project: '论文' });
    expect(svc.listWorkspaces().map((w) => [w.project, w.name])).toEqual([
      ['论文', '写作-初稿'],
      ['论文', '读文献'],
      ['', '默认工作区'],
    ]);
    svc.setCurrentWorkspace(a.id);
    // 旧客户端（schema 3，条目内联）保存：拆进项目表，布局升为 schema 4
    svc.saveWorkspaceLayout(a.id, layoutWith({ x: fileItem('x', 'r1', 'builtin.pdf', { v: 1, data: { page: 3, scale: 1.25 } }) }));
    expect(svc.getWorkspace(a.id)).toMatchObject({ layoutSchema: 4, layout: { schema: 4 } });
    expect((svc.getWorkspace(a.id).layout as any).items).toBeUndefined();
    await svc.close();
    cleanups.pop();
    const { svc: svc2 } = await setup(dataDir);
    expect(svc2.getCurrentWorkspaceId()).toBe(a.id);
    expect(itemsOf(svc2.getWorkspace(a.id)).x.state).toEqual({ v: 1, data: { page: 3, scale: 1.25 } });
    const l4 = layout4({ y: fileItem('y', 'r2', 'builtin.text') });
    svc2.saveWorkspaceLayout(a.id, l4.layout, l4.items);
    expect(svc2.getWorkspace(a.id).items.map((i) => i.itemId)).toEqual(['y']); // 未出现的条目从项目表删除
    expect(svc2.getWorkspace(a.id).panelCount).toBe(1);
    svc2.deleteWorkspace(a.id);
    expect([b.id, first]).toContain(svc2.getCurrentWorkspaceId());
    svc2.deleteWorkspace(b.id);
    expect(() => svc2.deleteWorkspace(first)).toThrow(/至少需要保留一个/);
  });

  it('拒绝：无 schema、超过 512 KB、含绝对路径', async () => {
    const { svc } = await setup();
    const id = svc.getCurrentWorkspaceId();
    expect(() => svc.saveWorkspaceLayout(id, { items: {} })).toThrow(/schema/);
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`i${i}`, fileItem(`i${i}`, `r${i}`, 'auto', { v: 1, data: { t: 'x'.repeat(12 * 1024) } })]));
    const big = layout4(many);
    expect(() => svc.saveWorkspaceLayout(id, big.layout, big.items)).toThrow(/过大/);
    expect(() => svc.saveWorkspaceLayout(id, layoutWith({ x: fileItem('x', 'D:\\Example Docs\\a.pdf') }))).toThrow(/绝对路径|不合法/);
    const dangling = layout4({ x: fileItem('x', 'r') });
    expect(() => svc.saveWorkspaceLayout(id, dangling.layout, [])).toThrow(/引用的条目不存在/);
    expect(() => svc.saveWorkspaceLayout(id, { ...dangling.layout, items: {} }, dangling.items)).toThrow(/不应内联/);
    expect(() => svc.saveWorkspaceLayout('nope', layoutWith({}))).toThrow(/不存在/);
  });

  it('导出 .kblayout.json 只含相对信息；导入到“另一台电脑”按根名 + 相对路径重新匹配；web/app 条目原样保留', async () => {
    const { svc } = await setup();
    const r1Dir = makeRoot();
    const r2Dir = tmpDir('kbroot2-');
    write(path.join(r2Dir, '草稿/第一章.md'), '# 第一章');
    const r1 = svc.addRoot(r1Dir);
    const r2 = svc.addRoot(r2Dir);
    await svc.scanRoot(r1.id);
    await svc.scanRoot(r2.id);
    const pdf = svc.resourceIdFor(r1.id, '资料/论文/paper.pdf');
    const md = svc.resourceIdFor(r2.id, '草稿/第一章.md');
    const l = layout4({
      p: fileItem('p', pdf, 'builtin.pdf', { v: 1, data: { page: 2, scale: 1.5 } }),
      m: fileItem('m', md, 'builtin.markdown', { v: 1, data: { scroll: 0.4 } }),
      w: { itemId: 'w', sourceKind: 'web', adapterId: 'web.generic', ref: 'https://example.com/a', displayMode: 'in-app-web' },
      a: { itemId: 'a', sourceKind: 'app', adapterId: 'app.zotero', ref: 'profile-1', displayMode: 'external-managed' },
    });
    const ws = svc.createWorkspace('写作', '论文', l.layout, l.items);
    const file = svc.exportWorkspace(ws.id);
    const text = JSON.stringify(file);
    expect(text).not.toContain(r1Dir);
    expect(text).not.toContain(r2Dir);
    expect(text).not.toContain('# 第一章');
    expect(file.resources.map((r) => r.relPath).sort()).toEqual(['草稿/第一章.md', '资料/论文/paper.pdf'].sort());

    // 另一台电脑：新数据目录，两个根复制到别处（资源 ID 全不同）
    const { svc: other } = await makeService();
    cleanups.push(() => other.close());
    const n1 = tmpDir('kbnew1-');
    const n2 = tmpDir('kbnew2-');
    fs.cpSync(r1Dir, path.join(n1, path.basename(r1Dir)), { recursive: true });
    fs.cpSync(r2Dir, path.join(n2, path.basename(r2Dir)), { recursive: true });
    const o1 = other.addRoot(path.join(n1, path.basename(r1Dir)));
    const o2 = other.addRoot(path.join(n2, path.basename(r2Dir)));
    await other.scanRoot(o1.id);
    await other.scanRoot(o2.id);
    const res = other.importWorkspace(JSON.parse(text));
    expect(res).toMatchObject({ matched: 0, remapped: 2, unresolved: [] });
    const imported = { items: itemsOf(other.getWorkspace(res.workspace.id)) };
    expect(imported.items.p).toMatchObject({ ref: other.resourceIdFor(o1.id, '资料/论文/paper.pdf'), state: { v: 1, data: { page: 2, scale: 1.5 } } });
    expect(imported.items.m.ref).toBe(other.resourceIdFor(o2.id, '草稿/第一章.md'));
    expect(imported.items.w.ref).toBe('https://example.com/a');
    expect(imported.items.a.ref).toBe('profile-1');
    expect(res.workspace).toMatchObject({ name: '写作', project: '论文' });
    // 同名再导入：自动改名；本机已有资源：直接匹配
    expect(other.importWorkspace(JSON.parse(text)).workspace.name).toBe('写作 (2)');
    expect(svc.importWorkspace(JSON.parse(text))).toMatchObject({ matched: 2, remapped: 0 });
    expect(() => other.importWorkspace({ format: 'x' })).toThrow(/format/);
  });
});

describe('主题包（纯数据）', () => {
  it('读取内置包；安装到数据目录；拒绝越出包目录的引用', async () => {
    const { svc, dataDir } = await setup();
    const studyDir = path.resolve(__dirname, '../themes/study');
    const pack = svc.readThemePack(studyDir, 'dev');
    expect(pack.error).toBeUndefined();
    expect(Object.keys(pack.files).length).toBeGreaterThan(0);
    const inst = svc.installThemePack(studyDir);
    expect(inst.source).toBe('installed');
    expect(fs.existsSync(path.join(dataDir, 'themes', 'kb.theme.study', 'theme.json'))).toBe(true);
    expect(svc.listThemePacks().map((p) => (p.manifest as any).id)).toEqual(['kb.theme.study']);
    const evil = tmpDir('kbevil-');
    write(path.join(evil, 'theme.json'), JSON.stringify({ id: 'x.evil', contributes: { chromeThemes: [{ id: 'e', light: { css: '../../etc/passwd' }, dark: {} }] } }));
    expect(svc.readThemePack(evil, 'dev').error).toBeTruthy();
    expect(() => svc.installThemePack(evil)).toThrow();
  });
});

describe('第 9 轮 R4：宿主保留的旧状态（state.preserved）', () => {
  it('sanitizeItem 保留 preserved（大小与字段受限）；写入数据库再读出不丢；插件新状态与旧状态并存', async () => {
    const { sanitizeItem } = await import('../src/shared/items');
    const base = { itemId: 'p1', sourceKind: 'file', adapterId: 'x.reader', ref: 'rid-1', displayMode: 'in-app-reader' };
    const it1 = sanitizeItem({ ...base, state: { v: 3, data: { total: 0 }, preserved: { v: 2, data: { clicks: 4 }, reason: '插件无法识别', at: 123, pluginVersion: '0.3.0', extra: 'x' } } });
    expect(it1?.state).toEqual({ v: 3, data: { total: 0 }, preserved: { v: 2, data: { clicks: 4 }, reason: '插件无法识别', at: 123, pluginVersion: '0.3.0' } });
    // 过大的旧状态不保留（与普通状态同一上限），条目本身仍有效
    const big = sanitizeItem({ ...base, state: { v: 3, data: {}, preserved: { v: 2, data: { s: 'x'.repeat(40000) }, reason: '', at: 1 } } });
    expect(big?.state).toEqual({ v: 3, data: {} });
    expect(sanitizeItem({ ...base, state: { v: 3, data: {}, preserved: { v: 0, data: {} } } })?.state).toEqual({ v: 3, data: {} });
    const { svc } = await makeService();
    try {
      const ws = svc.createWorkspace('R4', undefined, { schema: 4, dock: null, shell: { sidebarWidth: 260 } }, [it1!]);
      expect(svc.getWorkspace(ws.id).items[0].state).toEqual(it1!.state);
    } finally {
      svc.close();
    }
  });
});

describe('产品决定 6：已有保留的旧状态时插件新版本又读不了当前状态', () => {
  it('pushPreserved：当前状态成为新的 preserved，旧的挪进 earlier（同内容不重复，最多 2 份）；sanitizeItem 保留 earlier', async () => {
    const { pushPreserved, sanitizeItem, MAX_EARLIER_PRESERVED } = await import('../src/shared/items');
    const p3 = { v: 3, data: { total: 1 }, reason: 'r', at: 1, pluginVersion: '0.4.0' };
    const first = pushPreserved(undefined, p3);
    expect(first).toEqual(p3);
    const second = pushPreserved(first, { v: 4, data: { score: 1 }, reason: 'r', at: 2, pluginVersion: '0.5.0' });
    expect(second).toEqual({ v: 4, data: { score: 1 }, reason: 'r', at: 2, pluginVersion: '0.5.0', earlier: [p3] });
    // 同样的内容：只更新插件版本，不重复保留
    expect(pushPreserved(second, { v: 4, data: { score: 1 }, reason: 'r', at: 3, pluginVersion: '0.6.0' })).toEqual({ ...second, pluginVersion: '0.6.0' });
    let chain = second;
    for (let i = 5; i < 9; i++) chain = pushPreserved(chain, { v: i, data: { n: i }, reason: 'r', at: i });
    expect(chain.v).toBe(8);
    expect(chain.earlier?.length).toBe(MAX_EARLIER_PRESERVED);
    const base = { itemId: 'p2', sourceKind: 'file', adapterId: 'x.reader', ref: 'rid-2', displayMode: 'in-app-reader' };
    const it2 = sanitizeItem({ ...base, state: { v: 5, data: {}, preserved: { ...second, earlier: [...second.earlier!, { v: 0, data: {} }, { v: 2, data: { a: 1 }, reason: 'x', at: 0, junk: 1 }] } } });
    expect(it2?.state?.preserved?.earlier).toEqual([p3, { v: 2, data: { a: 1 }, reason: 'x', at: 0 }]);
  });
});
