/**
 * 第六轮（H9 网页面板）：共享判定（子资源 D1、系统浏览器 D2、分区派生）、主进程 webAccess（授权、declHash、非网页适配器）、
 * 网页插件的会话策略清单、外框状态归约、运行时/协议对 web.* 调用的白名单。WebContentsView 本身由 e2e/e2e-web.mjs 在真实应用中验证。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeService, tmpDir } from './helpers';
import { checkSubresource, externalUrlError, navDomains, resourceDomainsOf, webPartition, OVERLAY_SELECTOR } from '../src/shared/webPanel';
import { checkNavigation, permissionDeclHash, sanitizeUrlForState } from '../src/shared/adapter-sdk/policy';
import { parseFrameMessage, RPC_METHODS } from '../src/shared/sandboxProtocol';
import { parseAccessError } from '../src/shared/pluginIpc';
import { reduceWebUi, initialWebUi } from '../src/shared/webPanel';
import { CURRENT_PHASE } from '../src/shared/hostApi';
import { isKindAvailable } from '../src/renderer/plugin-host/layoutModel';

const SDK = process.env.KB_ADAPTER_SDK_DIR ?? path.resolve(__dirname, '../../kb-adapter-sdk');
const ROOT = path.resolve(__dirname, '..');
let webPlugin = '';
beforeAll(() => {
  webPlugin = path.join(tmpDir('kbplug-'), 'mdn');
  execFileSync('node', [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SDK, 'templates/web-adapter'), '--out', webPlugin], { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
});
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
async function setup() {
  const { svc } = await makeService();
  cleanups.push(() => svc.close());
  svc.plugins.installFromFolder(webPlugin);
  return svc;
}
const PID = 'example.mdn-docs';
const AID = 'example.mdn-docs.web';
const MDN = ['developer.mozilla.org'];
/** web 模板 v0.2.0（SDK e72e619）新增的子资源域名 */
const MDN_RES = ['bcd.developer.mozilla.org', '*.mdnplay.dev', 'mdn.github.io'];

/** SDK templates/web-adapter/test/mdn.test.ts 中的 11 种越界写法 */
const EVIL = [
  'https://evil.example.com/',
  'https://developer.mozilla.org.evil.com/',
  'https://developer.mozilla.org@evil.com/',
  'https://evil.com/?u=https://developer.mozilla.org/',
  'http://developer.mozilla.org/',
  'https://developer.mozilla.org:8443/',
  'https://sub.developer.mozilla.org/',
  'javascript:alert(1)',
  'file:///C:/Windows/win.ini',
  'data:text/html,<script>alert(1)</script>',
  'kbfile://res/abc/secret.txt',
];

describe('阶段', () => {
  it('当前为 P3（第 9 轮接线）：web 与 app 都已开放；P2 时 app 仍是“尚未开放”', () => {
    expect(CURRENT_PHASE).toBe(3);
    expect(isKindAvailable('web')).toBe(true);
    expect(isKindAvailable('app')).toBe(true);
    expect(isKindAvailable('app', 2)).toBe(false);
  });
});

describe('域名判定（SDK checkNavigation 组合）', () => {
  it('11 种越界写法：顶层导航与子资源检查都拒绝', () => {
    for (const u of EVIL) {
      expect(checkNavigation(u, MDN).ok, u).toBe(false);
      if (!u.startsWith('data:')) expect(checkSubresource(u, MDN).ok, u).toBe(false);
    }
    expect(checkNavigation('https://developer.mozilla.org/zh-CN/docs/Web/CSS', MDN).ok).toBe(true);
  });
  it('子资源：data:/blob: 由页面自身产生，允许；其余只认 domains ∪ resourceDomains（D1）', () => {
    expect(checkSubresource('data:image/png;base64,AA', MDN).ok).toBe(true);
    expect(checkSubresource('blob:https://developer.mozilla.org/abc', MDN).ok).toBe(true);
    expect(checkSubresource('https://tracker.example.com/t.js', MDN).ok).toBe(false);
    expect(checkSubresource('wss://developer.mozilla.org/x', MDN).ok).toBe(false);
    const decl = { permissions: [{ id: 'n', kind: 'net' as const, reason: 'r', domains: ['a.example.com'], resourceDomains: ['cdn.example.net'] }] };
    expect(navDomains(decl)).toEqual(['a.example.com']);
    expect(resourceDomainsOf(decl)).toEqual(['a.example.com', 'cdn.example.net']);
    expect(checkSubresource('https://cdn.example.net/x.css', resourceDomainsOf(decl)).ok).toBe(true);
    expect(checkNavigation('https://cdn.example.net/', navDomains(decl)).ok).toBe(false); // 子资源域名不能当顶层导航
    expect(resourceDomainsOf({ permissions: [] })).toEqual([]);
  });
  it('IDN 统一为 punycode 后比较；大小写不敏感', () => {
    expect(checkNavigation('https://DEVELOPER.mozilla.org/', MDN).ok).toBe(true);
    expect(checkNavigation('https://developer.mozillа.org/', MDN).ok).toBe(false); // 西里尔字母 а
  });
});

describe('系统浏览器（D2：只允许 https）', () => {
  it('拒绝 http、file:、自定义协议、带账号的地址', () => {
    expect(externalUrlError('https://github.com/mdn/content')).toBeNull();
    for (const u of ['http://example.org/', 'file:///etc/passwd', 'ms-settings:privacy', 'kbfile://res/x', 'javascript:alert(1)', 'https://a:b@evil.com/', 'not a url'])
      expect(externalUrlError(u), u).not.toBeNull();
  });
});

describe('分区与状态', () => {
  it('模板 v0.2.0 的子资源域名：兼容性数据、交互示例（随机子域）、示例素材可加载，裸域与其他主机不行', () => {
    const res = [...MDN, ...MDN_RES];
    for (const u of ['https://bcd.developer.mozilla.org/bcd/api/v0/current/javascript.builtins.Array.map.json', 'https://abc123.mdnplay.dev/runner.html', 'https://mdn.github.io/shared-assets/images/x.png']) expect(checkSubresource(u, res).ok, u).toBe(true);
    for (const u of ['https://mdnplay.dev/', 'https://incoming.telemetry.mozilla.org/submit', 'https://evil.mdnplay.dev.evil.com/']) expect(checkSubresource(u, res).ok, u).toBe(false);
  });
  it('分区由宿主按插件派生', () => {
    expect(webPartition(PID)).toBe('persist:kbweb.example.mdn-docs');
    expect(webPartition(PID, 'ephemeral')).toBe('kbweb-mem.example.mdn-docs');
  });
  it('web 条目 ref 去掉 query 与账号', () => {
    expect(sanitizeUrlForState('https://u:p@developer.mozilla.org/zh-CN/docs/Web/API/fetch?utm_source=x&token=abc#syntax')).toBe('https://developer.mozilla.org/zh-CN/docs/Web/API/fetch#syntax');
  });
  it('浮层选择器覆盖对话框背景、菜单/弹出层、状态表', () => {
    for (const c of ['.kb-dialog-backdrop', '.kb-popover', '.states-sheet', '[data-kb-overlay]']) expect(OVERLAY_SELECTOR).toContain(c);
  });
});

describe('主进程 webAccess（创建 WebContentsView 之前的检查）', () => {
  it('未授权 → permission-denied；授予后返回 manifest 中的域名、分区与策略', async () => {
    const svc = await setup();
    expect(() => svc.plugins.webAccess(PID, AID)).toThrow(/尚未授予网络权限/);
    svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'net-mdn', decision: 'granted' });
    const a = svc.plugins.webAccess(PID, AID);
    expect(a.domains).toEqual(MDN);
    expect(a.resourceDomains).toEqual([...MDN, ...MDN_RES]);
    expect(a.partition).toBe('persist:kbweb.example.mdn-docs');
    expect(a.web).toMatchObject({ homeUrl: 'https://developer.mozilla.org/zh-CN/', offDomain: 'open-external-with-confirm', popups: 'block', downloads: 'block' });
    // 撤销 → 拒绝，并写审计
    svc.plugins.revoke(PID, AID, 'net-mdn');
    let err: unknown;
    try {
      svc.plugins.webAccess(PID, AID);
    } catch (e) {
      err = e;
    }
    expect(parseAccessError(err).code).toBe('permission-denied');
    expect(svc.plugins.listAudit(PID).some((r) => r.kind === 'denied' && /打开网页面板/.test(r.detail))).toBe(true);
  });
  it('declHash 变化（升级后多了一个域名）→ 原授权失效', async () => {
    const svc = await setup();
    svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'net-mdn', decision: 'granted' });
    const g = svc.plugins.grants(PID)[0]!;
    const m = JSON.parse(fs.readFileSync(path.join(webPlugin, 'manifest.json'), 'utf8'));
    const decl = m.contributes.adapters[0].permissions[0];
    expect(g.declHash).toBe(permissionDeclHash(decl));
    const up = path.join(tmpDir('kbplug-up-'), 'mdn');
    fs.cpSync(webPlugin, up, { recursive: true });
    m.version = '0.2.0';
    m.contributes.adapters[0].permissions[0].domains.push('mdn.github.io');
    fs.writeFileSync(path.join(up, 'manifest.json'), JSON.stringify(m));
    svc.plugins.installFromFolder(up);
    expect(() => svc.plugins.webAccess(PID, AID)).toThrow(/尚未授予网络权限/);
  });
  it('禁用插件 / 不是网页适配器 → 拒绝', async () => {
    const svc = await setup();
    svc.plugins.setGrant({ pluginId: PID, adapterId: AID, permissionId: 'net-mdn', decision: 'granted' });
    expect(() => svc.plugins.webAccess(PID, 'example.mdn-docs.other')).toThrow(/不是网页适配器/);
    svc.plugins.setEnabled(PID, false);
    expect(() => svc.plugins.webAccess(PID, AID)).toThrow(/已禁用/);
  });
  it('网页插件清单：分区与 maxAgeDays（启动清理、卸载清理用）；卸载信息含网站数据项', async () => {
    const svc = await setup();
    expect(svc.plugins.webPlugins()).toEqual([{ pluginId: PID, partitions: ['persist:kbweb.example.mdn-docs'], maxAgeDays: 30 }]);
    expect(svc.plugins.uninstallInfo(PID).siteDataBytes).toBe(0);
  });
  it('审计类型包含网页拦截与系统浏览器，且只能由主进程写入', async () => {
    const svc = await setup();
    svc.plugins.audit(PID, AID, 'web-blocked', '导航被拦截：https://evil.example.com/', 'domain-blocked');
    svc.plugins.audit(PID, AID, 'web-external', '用系统浏览器打开：https://github.com/mdn/content');
    expect(svc.plugins.listAudit(PID).map((r) => r.kind)).toEqual(['web-external', 'web-blocked']);
    const { RENDERER_AUDIT_KINDS } = await import('../src/shared/pluginIpc');
    expect(RENDERER_AUDIT_KINDS).not.toContain('web-blocked');
    expect(RENDERER_AUDIT_KINDS).not.toContain('web-external');
  });
});

describe('协议与外框状态', () => {
  it('web.* 调用在 RPC 白名单中；未知方法丢弃', () => {
    for (const m of ['web.navigate', 'web.back', 'web.forward', 'web.reload', 'web.getScroll', 'web.setScroll', 'web.clearSessionData']) {
      expect(RPC_METHODS).toContain(m);
      expect(parseFrameMessage({ kb: 'kb-frame', type: 'rpc', id: 1, method: m, params: {} })).not.toBeNull();
    }
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'rpc', id: 1, method: 'web.executeJavaScript', params: {} })).toBeNull();
    expect(parseFrameMessage({ kb: 'kb-frame', type: 'rpc', id: 1, method: 'web.openExternal', params: {} })).toBeNull();
  });
  it('外框状态：导航、加载、拦截（计数）、子资源', () => {
    let s = reduceWebUi(initialWebUi, { viewId: 'v', type: 'navigate', url: 'https://developer.mozilla.org/a', inPage: false, canGoBack: true, canGoForward: false, title: 'A' });
    s = reduceWebUi(s, { viewId: 'v', type: 'load', state: 'failed', error: 'ERR' });
    expect(s).toMatchObject({ url: 'https://developer.mozilla.org/a', canGoBack: true, load: 'failed', error: 'ERR' });
    s = reduceWebUi(s, { viewId: 'v', type: 'blocked', url: 'https://evil.com/', reason: 'domain-blocked', external: true });
    s = reduceWebUi(s, { viewId: 'v', type: 'blocked', url: 'https://evil.com/', reason: 'domain-blocked', external: true });
    expect(s.blocked).toMatchObject({ n: 2, external: true });
    s = reduceWebUi(s, { viewId: 'v', type: 'resource-blocked', host: 't.example.com', count: 3 });
    expect(s).toMatchObject({ resourcesBlocked: 3, resourceHosts: ['t.example.com'] });
  });
});
