/**
 * 网页适配器模板单测。对应 docs/验收示例.md「B. 网页适配器」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockHost, makeStubTextPlugin, DARK_THEME } from '@kb-workbench/adapter-sdk/mock-host';
import { validateAdapterManifest } from '@kb-workbench/adapter-sdk/policy';
import type { WebWorkspaceItem, FileWorkspaceItem } from '@kb-workbench/adapter-sdk';
import plugin, { ADAPTER_ID, HOME_URL, manifest, restoreWebDocState, scrollRestoreTiming, STATE_VERSION } from '../src/index.js';

// 测试中把“页面稳定”判定调短
scrollRestoreTiming.settleMs = 20;
scrollRestoreTiming.maxWaitMs = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const item = (id: string, ref: string): WebWorkspaceItem => ({ itemId: id, sourceKind: 'web', adapterId: ADAPTER_ID, ref, displayMode: 'in-app-web' });
const PAGE = 'https://developer.mozilla.org/zh-CN/docs/Web/JavaScript';

async function setup(opts: Parameters<typeof createMockHost>[0] = {}) {
  const host = createMockHost({ phase: 2, ...opts });
  await host.install(plugin);
  return host;
}

test('manifest 通过校验', () => {
  assert.deepEqual(validateAdapterManifest(manifest), []);
});

test('授权提示只列出 developer.mozilla.org；面板标签诚实显示域名', async () => {
  const host = await setup();
  host.addItem(item('w1', PAGE));
  const p = await host.openItem('w1');
  assert.equal(host.prompts.length, 1);
  assert.deepEqual(host.prompts[0]!.scopeLines[0], '仅限域名：developer.mozilla.org');
  // 显式声明的资源域名必须出现在授权对话框中
  assert.deepEqual(host.prompts[0]!.scopeLines[1], '页面资源另可加载自：bcd.developer.mozilla.org、*.mdnplay.dev、mdn.github.io');
  assert.equal(p.displayModeLabel, '内嵌网页 · 网页面板 · 仅限 developer.mozilla.org');
  assert.equal(p.web!.currentUrl(), PAGE);
});

test('不能离开允许域名：页面跳转、适配器自身调用、各种绕过写法都被拦截', async () => {
  const host = await setup();
  host.addItem(item('w1', PAGE));
  const p = await host.openItem('w1');
  const web = p.web!;
  const evil = [
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
  for (const u of evil) {
    const r = web.simulatePageNavigation(u);
    assert.equal(r.ok, false, u);
    assert.equal(web.currentUrl(), PAGE, `仍停留在原页面: ${u}`);
  }
  const r2 = await web.navigate('https://www.google.com/');
  assert.deepEqual(r2, { ok: false, reason: 'domain-blocked' });
  assert.equal(p.blocked.length, evil.length + 1);
  // 允许域内正常
  assert.equal(web.simulatePageNavigation('https://developer.mozilla.org/zh-CN/docs/Web/CSS').ok, true);
});

test('弹窗（含域内）、下载被拦截；子资源只允许 domains ∪ resourceDomains', async () => {
  const host = await setup();
  host.addItem(item('w1', PAGE));
  const p = await host.openItem('w1');
  p.web!.simulatePopup('https://ads.example.com/');
  p.web!.simulatePopup('https://developer.mozilla.org/zh-CN/docs/Web/CSS'); // 域内弹窗也不在应用内开新窗口
  p.web!.simulateDownload('https://developer.mozilla.org/file.zip');
  assert.deepEqual(p.blocked.map((b) => b.reason), ['popup-blocked', 'popup-blocked', 'download-blocked']);
  const web = p.web!;
  for (const ok of [
    'https://developer.mozilla.org/static/client/index.js',
    'https://bcd.developer.mozilla.org/bcd/api/v0/current/javascript.builtins.Array.map.json',
    'https://3f2a9c.mdnplay.dev/runner.html',
    'https://mdn.github.io/shared-assets/images/examples/firefox-logo.svg',
  ])
    assert.equal(web.simulateSubresource(ok), true, ok);
  for (const bad of [
    'https://tracker.example.com/t.js',
    'https://incoming.telemetry.mozilla.org/submit', // 遥测：有意不声明
    'https://transcend-cdn.com/cm/x.js', // 同意管理脚本：有意不声明
    'https://mdnplay.dev/', // 通配不含裸域
    'https://evil.mdnplay.dev.example.com/',
    'http://bcd.developer.mozilla.org/x.json',
  ])
    assert.equal(web.simulateSubresource(bad), false, bad);
  // 资源域名不能用于顶层导航
  assert.equal(web.simulatePageNavigation('https://mdn.github.io/').ok, false);
});

test('重启后恢复 URL 与滚动位置；query 不进入状态；主题切换不丢状态', async () => {
  const host = await setup();
  host.addItem(item('w1', PAGE));
  const p = await host.openItem('w1');
  p.web!.simulatePageNavigation('https://developer.mozilla.org/zh-CN/docs/Web/API/fetch?utm_source=x&token=abc#syntax');
  p.web!.simulateUserScroll(640);
  host.setTheme(DARK_THEME);
  assert.deepEqual(p.instance!.getState(), { url: 'https://developer.mozilla.org/zh-CN/docs/Web/API/fetch#syntax', scrollY: 640 });

  const { host: h2, panels } = await host.restart();
  const p2 = panels[0]!;
  assert.equal(h2.prompts.length, 0);
  assert.equal(p2.web!.currentUrl(), 'https://developer.mozilla.org/zh-CN/docs/Web/API/fetch#syntax');
  assert.deepEqual(await p2.web!.getScroll(), { x: 0, y: 640 });
  assert.doesNotMatch(JSON.stringify(h2.getItem('w1')!.state), /token|utm/);
});

test('保存的状态被篡改为域外 URL / 格式不对 → 回到首页，不导航过去，但旧状态原样保留（legacy）', () => {
  const evil = restoreWebDocState({ url: 'https://evil.com/', scrollY: 0 }, 1)!;
  assert.equal(evil.url, HOME_URL);
  assert.equal(evil.scrollY, 0);
  assert.deepEqual(evil.legacy, { v: 1, data: { url: 'https://evil.com/', scrollY: 0 }, error: '旧地址已不在允许的域名内' });
  const bad = restoreWebDocState({ url: PAGE, scrollY: -1 }, 1)!;
  assert.equal(bad.url, HOME_URL);
  assert.equal(bad.legacy?.error, '状态格式无法识别');
});

test('升级：状态版本高于模板且没有迁移步骤 → 首页 + legacy 保留，保存时一并写回（不丢数据）', async () => {
  const fromFuture = restoreWebDocState({ url: PAGE, scrollY: 10, extra: 1 }, 3)!;
  assert.equal(fromFuture.url, HOME_URL);
  assert.equal(fromFuture.legacy?.v, 3);
  assert.deepEqual(fromFuture.legacy?.data, { url: PAGE, scrollY: 10, extra: 1 });
  const ok = restoreWebDocState({ url: PAGE, scrollY: 12 }, STATE_VERSION)!;
  assert.deepEqual(ok, { url: PAGE, scrollY: 12 });
  // 带 legacy 的状态再次恢复：legacy 原样保留
  assert.deepEqual(restoreWebDocState({ url: PAGE, scrollY: 1, legacy: fromFuture.legacy }, STATE_VERSION)!.legacy, fromFuture.legacy);
});

test('项目地址不在允许域名 → “已阻止访问”占位；其他面板正常', async () => {
  const host = await setup({ resources: [{ resourceId: 'r-txt', rootId: 'A', name: 'a.txt', text: 'ok' }] });
  await host.install(makeStubTextPlugin());
  host.addItem(item('bad', 'https://evil.example.com/'));
  host.addItem({ itemId: 't', sourceKind: 'file', adapterId: 'stub.text.reader', ref: 'r-txt', displayMode: 'in-app-reader' } satisfies FileWorkspaceItem);
  const [bad, t] = await host.openWorkspace();
  assert.equal(bad!.placeholder?.kind, 'domain-blocked');
  assert.match(bad!.placeholder!.message, /只允许 developer\.mozilla\.org/);
  assert.equal(t!.text(), 'ok');
});

test('拒绝网络权限 → 占位；P1 阶段 → “尚未开放”占位', async () => {
  const denied = await setup({ prompt: () => 'deny' });
  denied.addItem(item('w1', PAGE));
  assert.equal((await denied.openItem('w1')).placeholder?.kind, 'permission-denied');

  const p1 = await setup({ phase: 1 });
  p1.addItem(item('w1', PAGE));
  const p = await p1.openItem('w1');
  assert.equal(p.placeholder?.kind, 'phase-unavailable');
  assert.equal(p1.prompts.length, 0, '未开放阶段不弹授权');
});

test('会话分区按插件隔离；重启保留；卸载按用户选择保留/删除', async () => {
  for (const keepData of [true, false]) {
    const host = await setup();
    host.addItem(item('w1', PAGE));
    const p = await host.openItem('w1');
    assert.equal(p.web!.partition, 'persist:kbweb.example.mdn-docs');
    p.web!.simulateSetCookie('pref-lang', 'zh-CN');
    const { host: h2 } = await host.restart();
    assert.deepEqual(h2.webSessionOf(manifest.id), { 'pref-lang': 'zh-CN' });
    await h2.uninstall(manifest.id, { keepData });
    assert.deepEqual(h2.webSessionOf(manifest.id), keepData ? { 'pref-lang': 'zh-CN' } : undefined);
    assert.equal(h2.panels.get('w1')!.placeholder?.kind, 'adapter-missing');
  }
});

test('滚动恢复：页面稳定后若被晚加载内容推走，重试一次；之后用户滚动照常保存', async () => {
  const host = await setup();
  host.addItem({ ...item('w1', PAGE), state: { v: 1, data: { url: PAGE, scrollY: 2100 } } });
  const p = await host.openItem('w1');
  const web = p.web!;
  await sleep(1);
  assert.equal(web.setScrollCalls, 1);
  assert.deepEqual(await web.getScroll(), { x: 0, y: 2100 });
  web.simulateLayoutShift(392); // 广告位/图片加载 → 2492
  assert.equal((p.instance!.getState() as { scrollY: number }).scrollY, 2100, '恢复期间的位移不写入状态');
  await sleep(60);
  assert.equal(web.setScrollCalls, 2, '只重试一次');
  assert.deepEqual(await web.getScroll(), { x: 0, y: 2100 });
  web.simulateLayoutShift(50); // 稳定后再被推动：不再追
  await sleep(60);
  assert.equal(web.setScrollCalls, 2);
  assert.equal((p.instance!.getState() as { scrollY: number }).scrollY, 2150, '恢复结束后，滚动变化照常保存');
});

test('滚动恢复：没有位移时不重试', async () => {
  const host = await setup();
  host.addItem({ ...item('w1', PAGE), state: { v: 1, data: { url: PAGE, scrollY: 640 } } });
  const p = await host.openItem('w1');
  await sleep(60);
  assert.equal(p.web!.setScrollCalls, 1);
});
