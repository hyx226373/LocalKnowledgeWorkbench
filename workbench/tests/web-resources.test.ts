/**
 * 第 11 轮 A（星图组）：网络资料——sanitizeWebRef / 判型 / web_resources 存储（稳定 resourceId、收藏、缓存）/
 * 受控下载 fetchAndCache / WorkbenchService 外部资源钩子（工作资料、导出导入重映射、只读）/ 内置 web.generic 与逐站授权。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { makeService, tmpDir, write } from './helpers';
import { WebResourceStore, fetchAndCache, migrateWebResources, type Fetcher } from '../src/main/webResources';
import { classifyWebContent, normalizeUserInput, safeCacheFileName, sanitizeWebRef, sniffWebFile, webExtOfUrl } from '../src/shared/webResources';
import { parseAccessError } from '../src/shared/pluginIpc';

const ROOT = path.resolve(__dirname, '..');
const SDK = process.env.KB_ADAPTER_SDK_DIR ?? path.resolve(__dirname, '../../kb-adapter-sdk');
const BUILTIN_DIR = path.join(ROOT, 'resources/builtin-adapters');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const enc = (s: string) => new TextEncoder().encode(s);
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function service() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const store = new WebResourceStore(svc.db, path.join(dataDir, 'web-cache'));
  svc.externalResources = store;
  return { svc, dataDir, store };
}
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return parseAccessError(e).code;
  }
  return 'ok';
};

describe('sanitizeWebRef / normalizeUserInput', () => {
  it('只允许 http/https；去掉 query、fragment、账号密码', () => {
    const r = sanitizeWebRef('https://user:pw@Example.COM/a/b.pdf?token=1#x');
    expect(r).toEqual({ ok: true, url: 'https://example.com/a/b.pdf', host: 'example.com', scheme: 'https' });
    const h = sanitizeWebRef('http://docs.example.org/');
    expect(h.ok && h.scheme).toBe('http');
  });
  it('拒绝其他协议、IP、端口、localhost、非法输入', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'kbfile://res/x', 'ftp://example.com/a', 'https://127.0.0.1/', 'https://[::1]/', 'https://example.com:8443/', 'https://localhost/', 'not a url', '', `https://example.com/${'a'.repeat(2100)}`]) {
      expect(sanitizeWebRef(bad).ok, bad).toBe(false);
    }
  });
  it('地址栏输入补 https://', () => {
    expect(normalizeUserInput('example.com/a')).toBe('https://example.com/a');
    expect(normalizeUserInput('  http://a.example.com ')).toBe('http://a.example.com');
    expect(normalizeUserInput('example.com:8080/x')).toBe('https://example.com:8080/x');
    expect(normalizeUserInput('')).toBe('');
  });
});

describe('直链判型', () => {
  it('扩展名白名单与魔数', () => {
    expect(webExtOfUrl('https://a.example.com/x/paper.PDF')).toBe('pdf');
    expect(webExtOfUrl('https://a.example.com/p.jpg')).toBe('jpeg');
    expect(webExtOfUrl('https://a.example.com/readme.markdown')).toBe('md');
    expect(webExtOfUrl('https://a.example.com/a.zip')).toBe(null);
    expect(webExtOfUrl('https://a.example.com/')).toBe(null);
    expect(sniffWebFile(PDF)).toBe('pdf');
    expect(sniffWebFile(PNG)).toBe('png');
    expect(sniffWebFile(enc('hello'))).toBe(null);
  });
  it('classifyWebContent 各分支', () => {
    expect(classifyWebContent('https://a.example.com/p.pdf', 'application/pdf', PDF)).toMatchObject({ kind: 'file', ext: 'pdf', fileName: 'p.pdf' });
    expect(classifyWebContent('https://a.example.com/p.pdf', 'application/pdf', enc('<html>'))).toMatchObject({ kind: 'conflict' });
    expect(classifyWebContent('https://a.example.com/p.png', 'application/pdf', PDF)).toMatchObject({ kind: 'conflict' });
    expect(classifyWebContent('https://a.example.com/', 'text/html; charset=utf-8', enc('<!doctype html>'))).toMatchObject({ kind: 'html' });
    expect(classifyWebContent('https://a.example.com/n.md', 'text/plain', enc('# 标题'))).toMatchObject({ kind: 'file', ext: 'md' });
    expect(classifyWebContent('https://a.example.com/n.txt', 'text/plain', enc('abc'))).toMatchObject({ kind: 'file', ext: 'txt' });
    expect(classifyWebContent('https://a.example.com/n.txt', 'text/plain', Buffer.from([1, 0, 2]))).toMatchObject({ kind: 'conflict' });
    expect(classifyWebContent('https://a.example.com/download', 'application/octet-stream', PDF, 'attachment; filename="r.pdf"')).toMatchObject({ kind: 'file', ext: 'pdf', fileName: 'r.pdf' });
    expect(classifyWebContent('https://a.example.com/blob', '', enc('plain'))).toMatchObject({ kind: 'unknown' });
    expect(classifyWebContent('https://a.example.com/a.zip', 'application/zip', enc('PK'))).toMatchObject({ kind: 'unknown' });
  });
  it('缓存文件名清洗', () => {
    expect(safeCacheFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeCacheFileName('CON.txt')).toMatch(/^file_/);
    expect(safeCacheFileName('')).toBe('file');
    expect(safeCacheFileName('a\\b:c?.pdf')).toBe('a_b_c_.pdf');
  });
});

describe('WebResourceStore', () => {
  it('稳定 resourceId（UUID v4）：同一网址（去 query 后）只有一条；更新、收藏、列表、删除', async () => {
    const { store } = await service();
    const events: string[] = [];
    store.onChange((e) => events.push(e.type));
    const a = store.add({ url: 'https://site-a.test/doc?x=1', title: '文档' });
    expect(a.resourceId).toMatch(UUID4);
    expect(a.url).toBe('https://site-a.test/doc');
    const again = store.add({ url: 'https://site-a.test/doc#frag', opened: true });
    expect(again.resourceId).toBe(a.resourceId);
    expect(again.lastOpenedAt).toBeTruthy();
    const b = store.add({ url: 'https://files.test/b.pdf', adapterId: 'web.file', ext: 'pdf' });
    expect(b.resourceId).not.toBe(a.resourceId);
    expect(store.getByUrl('https://site-a.test/doc?y=2')?.resourceId).toBe(a.resourceId);
    store.update(b.resourceId, { favorite: true, title: '  论文\u0000 ' });
    expect(store.get(b.resourceId)).toMatchObject({ favorite: true, title: '论文' });
    expect(store.list()[0].resourceId).toBe(b.resourceId);
    expect(store.list({ favoritesOnly: true }).map((x) => x.resourceId)).toEqual([b.resourceId]);
    expect(() => store.add({ url: 'file:///x' })).toThrow(/invalid-url/);
    expect(store.get('not-a-uuid')).toBe(null);
    expect(store.remove(a.resourceId)).toBe(true);
    expect(store.has(a.resourceId)).toBe(false);
    expect(events).toContain('add');
    expect(events).toContain('remove');
  });
  it('建表幂等（不占迁移号）', async () => {
    const { svc, store } = await service();
    store.add({ url: 'https://site-a.test/' });
    migrateWebResources(svc.db);
    migrateWebResources(svc.db);
    expect(store.list().length).toBe(1);
  });
  it('缓存：路径不能越出 <cacheDir>/<resourceId>/；写入后只读、adapter 改为 web.file；resourceInfo / resolvePath', async () => {
    const { store } = await service();
    const w = store.add({ url: 'https://files.test/p.pdf' });
    expect(() => store.cachePathOf('../x', 'a.pdf')).toThrow();
    expect(path.dirname(store.cachePathOf(w.resourceId, '../../evil.pdf'))).toBe(path.join(store.cacheDir, w.resourceId));
    expect(store.resourceInfo(w.resourceId)).toMatchObject({ rootId: '', exists: false, readerType: 'unsupported' });
    expect(() => store.resolvePath(w.resourceId)).toThrow(/尚未缓存/);
    const c = store.writeCache(w.resourceId, { fileName: 'p', ext: 'pdf', contentType: 'application/pdf', bytes: PDF });
    expect(c).toMatchObject({ cached: true, adapterId: 'web.file', ext: 'pdf', cacheBytes: PDF.length });
    const abs = store.resolvePath(w.resourceId);
    expect(abs).toBe(path.join(store.cacheDir, w.resourceId, 'p.pdf'));
    expect(fs.readFileSync(abs).equals(PDF)).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(abs).mode & 0o222).toBe(0);
    expect(store.resourceInfo(w.resourceId)).toMatchObject({ rootId: '', relPath: 'p.pdf', ext: 'pdf', exists: true, readerType: 'pdf' });
    expect(store.cachedFilesForIndex().map((x) => x.resourceId)).toEqual([w.resourceId]);
    store.dropCache(w.resourceId);
    expect(store.cacheFile(w.resourceId)).toBe(null);
    expect(fs.existsSync(path.join(store.cacheDir, w.resourceId))).toBe(false);
  });
  it('搜索：只按标题与网址（matchKind name），不含正文', async () => {
    const { store } = await service();
    store.add({ url: 'https://site-a.test/guide', title: '入门指南' });
    store.add({ url: 'https://files.test/x.pdf', title: 'X' });
    expect(store.search('指南').map((h) => h.name)).toEqual(['入门指南']);
    expect(store.search('files.test')[0]).toMatchObject({ matchKind: 'name', rootId: '' });
    expect(store.search('100%')).toEqual([]);
    expect(store.search('')).toEqual([]);
  });
});

describe('fetchAndCache（受控下载）', () => {
  const ok = (contentType: string, bytes: Buffer, finalUrl?: string, cd = ''): Fetcher => async (url) => ({ ok: true, finalUrl: finalUrl ?? url, status: 200, contentType, contentDisposition: cd, bytes });
  it('PDF → 缓存；已缓存不重复下载；force 重新下载', async () => {
    const { store } = await service();
    const w = store.add({ url: 'https://files.test/r.pdf' });
    let n = 0;
    const f: Fetcher = async (u) => (n++, ok('application/pdf', PDF)(u));
    const r = await fetchAndCache(store, w.resourceId, f);
    expect(r).toMatchObject({ ok: true, kind: 'cached' });
    await fetchAndCache(store, w.resourceId, f);
    expect(n).toBe(1);
    await fetchAndCache(store, w.resourceId, f, { force: true });
    expect(n).toBe(2);
  });
  it('html / conflict / unknown 不缓存', async () => {
    const { store } = await service();
    const w = store.add({ url: 'https://files.test/r.pdf' });
    expect(await fetchAndCache(store, w.resourceId, ok('text/html', Buffer.from('<html>')))).toMatchObject({ ok: false, kind: 'html' });
    expect(await fetchAndCache(store, w.resourceId, ok('application/pdf', Buffer.from('nope')))).toMatchObject({ ok: false, kind: 'conflict' });
    expect(await fetchAndCache(store, w.resourceId, ok('application/zip', Buffer.from('PK')))).toMatchObject({ ok: false, kind: 'unknown' });
    expect(store.get(w.resourceId)?.cached).toBe(false);
  });
  it('未授权网站 / 404 / 超时 / 断网：返回可重试结果，记录保留', async () => {
    const { store } = await service();
    const w = store.add({ url: 'https://files.test/r.pdf' });
    expect(await fetchAndCache(store, w.resourceId, async (url) => ({ ok: false, reason: 'site-not-granted', host: 'files.test', url }))).toEqual({ ok: false, kind: 'site-not-granted', host: 'files.test', url: w.url });
    expect(await fetchAndCache(store, w.resourceId, async () => ({ ok: false, reason: 'http', status: 404, detail: 'HTTP 404' }))).toMatchObject({ ok: false, kind: 'error', reason: 'http', status: 404 });
    expect(await fetchAndCache(store, w.resourceId, async () => ({ ok: false, reason: 'timeout', detail: '超时' }))).toMatchObject({ kind: 'error', reason: 'timeout' });
    expect(await fetchAndCache(store, w.resourceId, async () => ({ ok: false, reason: 'network', detail: 'offline' }))).toMatchObject({ kind: 'error', reason: 'network' });
    expect(store.has(w.resourceId)).toBe(true);
    await expect(fetchAndCache(store, '00000000-0000-4000-8000-000000000000', ok('application/pdf', PDF))).rejects.toThrow(/not-found/);
  });
});

describe('WorkbenchService 外部资源钩子（网络资料）', () => {
  it('已缓存直链被现有阅读器当本地文件读（缓存文件只读）', async () => {
    const { svc, store } = await service();
    const w = store.add({ url: 'https://files.test/n.md' });
    store.writeCache(w.resourceId, { fileName: 'n.md', ext: 'md', contentType: 'text/markdown', bytes: Buffer.from('# 网络笔记\n') });
    expect(svc.getResource(w.resourceId)).toMatchObject({ rootId: '', ext: 'md', exists: true });
    expect(svc.resolveResourcePath(w.resourceId)).toBe(store.resolvePath(w.resourceId));
    expect(svc.readText(w.resourceId).text).toContain('网络笔记');
    expect(fs.readFileSync(store.resolvePath(w.resourceId), 'utf8')).toBe('# 网络笔记\n');
  });
  it('工作资料引用 web resourceId（rootId \'\'、sourceKind web）；导出导入按 url 重映射', async () => {
    const { svc, store } = await service();
    const ws = svc.createWorkspace('网页研究');
    const w = store.add({ url: 'https://site-a.test/page', title: '页面 A' });
    const refs = svc.addWorkspaceRefs(ws.id, [w.resourceId]);
    expect(refs).toEqual([expect.objectContaining({ resourceId: w.resourceId, rootId: '', relPath: '', ext: '', kind: 'file', sourceKind: 'web', url: 'https://site-a.test/page', missing: false, name: '页面 A' })]);
    expect(() => svc.addWorkspaceRefs(ws.id, ['00000000-0000-4000-8000-000000000000'])).toThrow();
    const file = svc.exportWorkspace(ws.id);
    expect(file.webResources).toEqual([expect.objectContaining({ resourceId: w.resourceId, url: 'https://site-a.test/page', title: '页面 A' })]);

    // 另一台机器：同一网址得到本机自己的 resourceId，引用被改写
    const other = await service();
    const pre = other.store.add({ url: 'https://site-a.test/page' });
    const imp = other.svc.importWorkspace(JSON.parse(JSON.stringify(file)));
    const r2 = other.svc.listWorkspaceRefs(imp.workspace.id);
    expect(r2.map((r) => r.resourceId)).toEqual([pre.resourceId]);
    expect(r2[0]).toMatchObject({ sourceKind: 'web', url: 'https://site-a.test/page' });

    // 本机没有：新建记录
    const third = await service();
    const imp3 = third.svc.importWorkspace(JSON.parse(JSON.stringify(file)));
    const r3 = third.svc.listWorkspaceRefs(imp3.workspace.id);
    expect(r3).toHaveLength(1);
    expect(r3[0].url).toBe('https://site-a.test/page');
    expect(third.store.has(r3[0].resourceId)).toBe(true);
  });
});

describe('内置 web.generic 与逐站授权（SDK 修订 10）', () => {
  let thirdPerSite = '';
  let thirdSameId = '';
  beforeAll(() => {
    const build = (name: string, mutate: (m: any) => void) => {
      const out = path.join(tmpDir('kbplug-'), name);
      execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SDK, 'templates/web-adapter'), '--out', out], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
      const mf = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
      mutate(mf);
      fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(mf, null, 2));
      return out;
    };
    thirdPerSite = build('persite', (mf) => {
      const net = mf.contributes.adapters[0].permissions.find((p: any) => p.kind === 'net');
      net.mode = 'ask-per-site';
      net.domains = [];
      delete net.resourceDomains;
    });
    thirdSameId = build('sameid', (mf) => {
      mf.id = 'web.generic';
    });
  });

  it('产物与源码同步（bundle --check）', () => {
    const r = spawnSync('node', [path.join(ROOT, 'scripts/bundle-builtin-adapters.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const mf = JSON.parse(fs.readFileSync(path.join(BUILTIN_DIR, 'web.generic/manifest.json'), 'utf8'));
    expect(mf.contributes.adapters[0].permissions[0]).toMatchObject({ kind: 'net', mode: 'ask-per-site', domains: [] });
    expect(fs.statSync(path.join(BUILTIN_DIR, 'web.generic/dist/index.js')).size).toBeGreaterThan(1000);
  });

  it('loadBuiltins：source=builtin 默认启用；不可卸载；第三方不能占用其 id，也不能声明 ask-per-site', async () => {
    const { svc } = await service();
    expect(svc.plugins.loadBuiltins(BUILTIN_DIR)).toEqual(['web.generic']);
    expect(svc.plugins.loadBuiltins(path.join(BUILTIN_DIR, 'nope'))).toEqual([]);
    const d = svc.plugins.list().find((p) => p.id === 'web.generic')!;
    expect(d).toMatchObject({ source: 'builtin', enabled: true });
    expect(d.errors).toEqual([]);
    expect(svc.plugins.isBuiltin('web.generic')).toBe(true);
    expect(() => svc.plugins.uninstall('web.generic', { keepData: false } as never)).toThrow(/内置/);
    expect(() => svc.plugins.installFromFolder(thirdSameId)).toThrow();
    expect(() => svc.plugins.installFromFolder(thirdPerSite)).toThrow(/逐站|ask-per-site/);
    // 禁用后仍保留；reload 后仍是内置
    svc.plugins.setEnabled('web.generic', false);
    svc.plugins.reload();
    expect(svc.plugins.list().find((p) => p.id === 'web.generic')).toMatchObject({ source: 'builtin', enabled: false });
  });

  it('webAccess / grantSite / revokeSite / revoke：插件级未决定可建视图；主机逐个批准；撤销后整体拒绝', async () => {
    const { svc } = await service();
    svc.plugins.loadBuiltins(BUILTIN_DIR);
    const P = 'web.generic';
    const A = 'web.generic';
    const acc = svc.plugins.webAccess(P, A);
    expect(acc).toMatchObject({ perSite: true, domains: [] });
    const changes: string[] = [];
    svc.plugins.onGrantsChanged((id) => changes.push(id));
    expect(code(() => svc.plugins.grantSite(P, A, '127.0.0.1'))).toBe('invalid-request');
    expect(code(() => svc.plugins.grantSite(P, A, '*.example.com'))).toBe('invalid-request');
    svc.plugins.grantSite(P, A, 'Site-A.test');
    svc.plugins.grantSite(P, A, 'files.test');
    expect(svc.plugins.grantedSites(P, A).sort()).toEqual(['files.test', 'site-a.test']);
    expect(svc.plugins.webAccess(P, A).domains.sort()).toEqual(['files.test', 'site-a.test']);
    svc.plugins.revokeSite(P, A, 'files.test');
    expect(svc.plugins.grantedSites(P, A)).toEqual(['site-a.test']);
    // setGrant（重新询问 → 允许）保留已批准的主机
    svc.plugins.setGrant({ pluginId: P, adapterId: A, permissionId: 'net-sites', decision: 'granted' });
    expect(svc.plugins.grantedSites(P, A)).toEqual(['site-a.test']);
    svc.plugins.revoke(P, A, 'net-sites');
    expect(svc.plugins.grantedSites(P, A)).toEqual([]);
    expect(code(() => svc.plugins.webAccess(P, A))).toBe('permission-denied');
    // 用户在询问框里再次明确允许某个网站：插件级恢复为允许，只含这一个主机
    svc.plugins.grantSite(P, A, 'site-a.test');
    expect(svc.plugins.webAccess(P, A).domains).toEqual(['site-a.test']);
    expect(changes.length).toBeGreaterThanOrEqual(5);
    svc.plugins.setEnabled(P, false);
    expect(code(() => svc.plugins.webAccess(P, A))).toBe('plugin-unavailable');
  });

  it('第三方插件不能使用逐站授权接口', async () => {
    const { svc } = await service();
    svc.plugins.loadBuiltins(BUILTIN_DIR);
    expect(code(() => svc.plugins.grantSite('example.mdn-docs', 'example.mdn-docs.web', 'site-a.test'))).not.toBe('ok');
  });
});

void write;
