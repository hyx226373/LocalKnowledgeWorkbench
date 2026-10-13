import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkNavigation,
  checkSiteNavigation,
  describePermission,
  displayModeLabel,
  isAskPerSite,
  netAllowedHosts,
  netResourceHosts,
  permissionDeclHash,
  siteHostError,
  siteHostOf,
  validateAdapterManifest,
  withGrantedHost,
  withoutGrantedHost,
} from '../src/policy.js';
import type { AdapterPluginManifest, NetPermission } from '../src/types.js';

const perSite: NetPermission = { id: 'net-any', kind: 'net', domains: [], mode: 'ask-per-site', reason: '打开你输入的网址' };

function manifest(net: NetPermission, homeUrl = 'https://example.com/'): AdapterPluginManifest {
  return {
    id: 'web.generic',
    name: '通用网页',
    version: '1.0.0',
    engines: { workbench: '^0.2.0', adapterApi: '^0.1.0' },
    main: 'dist/index.js',
    sandbox: 'iframe',
    contributes: {
      adapters: [
        {
          id: 'web.generic',
          title: '网页',
          sourceKinds: ['web'],
          displayMode: 'in-app-web',
          match: { web: { urlPatterns: [] }, priority: 1 },
          permissions: [net],
          web: { homeUrl, session: { partition: 'persistent' }, offDomain: 'open-external-with-confirm', popups: 'open-external-with-confirm', downloads: 'block' },
          stateSchemaVersion: 1,
        },
      ],
    },
  } as AdapterPluginManifest;
}

test('修订 10：只有内置适配器能声明 ask-per-site；第三方拒绝安装', () => {
  assert.deepEqual(validateAdapterManifest(manifest(perSite), '0.1.0', { source: 'builtin' }), []);
  const third = validateAdapterManifest(manifest(perSite));
  assert.ok(third.some((e) => /只有随包内置的适配器可以声明/.test(e)), third.join('\n'));
  const third2 = validateAdapterManifest(manifest(perSite), '0.1.0', { source: 'third-party' });
  assert.ok(third2.some((e) => /ask-per-site/.test(e)));
});

test('修订 10：listed 仍必须列域名、禁止 * / IP / 端口；未知 mode 拒绝', () => {
  const listedEmpty = validateAdapterManifest(manifest({ ...perSite, mode: 'listed' }), '0.1.0', { source: 'builtin' });
  assert.ok(listedEmpty.some((e) => /必须列出域名/.test(e)));
  for (const bad of ['*', '1.2.3.4', 'example.com:8080']) {
    const errs = validateAdapterManifest(manifest({ ...perSite, domains: [bad] }), '0.1.0', { source: 'builtin' });
    assert.ok(errs.length > 0, bad);
  }
  const weird = validateAdapterManifest(manifest({ ...perSite, mode: 'any' as never }), '0.1.0', { source: 'builtin' });
  assert.ok(weird.some((e) => /未知的 net\.mode/.test(e)));
});

test('修订 10：逐站授权的 homeUrl 必须是合法 http(s) 地址', () => {
  assert.deepEqual(validateAdapterManifest(manifest(perSite, 'http://example.com/'), '0.1.0', { source: 'builtin' }), []);
  for (const bad of ['file:///C:/x', 'https://127.0.0.1/', 'https://example.com:8443/', 'javascript:alert(1)']) {
    assert.ok(validateAdapterManifest(manifest(perSite, bad), '0.1.0', { source: 'builtin' }).length > 0, bad);
  }
});

test('修订 10：siteHostError / siteHostOf', () => {
  for (const ok of ['example.com', 'www.example.com', 'xn--fiqs8s.example.cn', 'site-a.test']) assert.equal(siteHostError(ok), null, ok);
  for (const bad of ['', '*.example.com', '1.2.3.4', '[::1]', 'localhost', 'Example.com', 'example.com:80', 'example.com.']) assert.notEqual(siteHostError(bad), null, bad);
  assert.equal(siteHostOf('https://Example.COM/a?b=1'), 'example.com');
  assert.equal(siteHostOf('http://example.com/'), 'example.com');
  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://10.0.0.1/', 'ftp://example.com/']) assert.equal(siteHostOf(bad), null, bad);
});

test('修订 10：已批准主机才允许导航；未批准 → site-not-granted；IP/端口/协议/userinfo 永远拒绝', () => {
  const grant = { decision: 'granted' as const, grantedHosts: ['example.com'] };
  assert.deepEqual(checkSiteNavigation('https://example.com/a', perSite, grant), { ok: true });
  assert.deepEqual(checkSiteNavigation('http://example.com/a', perSite, grant), { ok: true });
  assert.deepEqual(checkSiteNavigation('https://www.example.com/', perSite, grant), { ok: false, reason: 'site-not-granted', host: 'www.example.com' });
  assert.deepEqual(checkSiteNavigation('https://example.com.evil.net/', perSite, grant), { ok: false, reason: 'site-not-granted', host: 'example.com.evil.net' });
  assert.deepEqual(checkSiteNavigation('https://example.com:8443/', perSite, grant), { ok: false, reason: 'domain-blocked' });
  assert.deepEqual(checkSiteNavigation('https://127.0.0.1/', perSite, grant), { ok: false, reason: 'domain-blocked' });
  assert.deepEqual(checkSiteNavigation('https://u:p@example.com/', perSite, grant), { ok: false, reason: 'invalid-url' });
  for (const s of ['file:///C:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'kbfile://res/x', 'ftp://example.com/']) {
    const r = checkSiteNavigation(s, perSite, grant);
    assert.equal(r.ok, false, s);
    assert.notEqual((r as { reason: string }).reason, 'site-not-granted', s);
  }
  // 授权被撤销（denied）后已批准主机全部失效（仍可询问，由宿主按 denied 显示占位）
  assert.equal(checkSiteNavigation('https://example.com/', perSite, { decision: 'denied', grantedHosts: ['example.com'] }).ok, false);
  // listed 模式：http 不放行、未列出的主机是 domain-blocked（不会变成询问）
  const listed: NetPermission = { id: 'n', kind: 'net', domains: ['developer.mozilla.org'], reason: 'r' };
  assert.deepEqual(checkSiteNavigation('http://developer.mozilla.org/', listed), { ok: false, reason: 'scheme-blocked' });
  assert.deepEqual(checkSiteNavigation('https://example.com/', listed), { ok: false, reason: 'domain-blocked' });
  assert.deepEqual(checkNavigation('http://developer.mozilla.org/', ['developer.mozilla.org']), { ok: false, reason: 'scheme-blocked' });
});

test('修订 10：允许主机集合 = domains ∪ grantedHosts（子资源另加 resourceDomains），非法主机被忽略', () => {
  const p: NetPermission = { ...perSite, domains: ['pre.example.org'], resourceDomains: ['cdn.example.net'] };
  const g = { decision: 'granted' as const, grantedHosts: ['example.com', '*.evil.com', '1.2.3.4'] };
  assert.deepEqual(netAllowedHosts(p, g).sort(), ['example.com', 'pre.example.org']);
  assert.deepEqual(netResourceHosts(p, g).sort(), ['cdn.example.net', 'example.com', 'pre.example.org']);
  assert.deepEqual(netAllowedHosts(p, undefined), ['pre.example.org']);
  assert.deepEqual(netAllowedHosts({ ...p, mode: 'listed' }, g), ['pre.example.org']);
  assert.equal(isAskPerSite(p), true);
});

test('修订 10：withGrantedHost / withoutGrantedHost；授权说明与显示方式标签', () => {
  const g0 = { pluginId: 'web.generic', adapterId: 'web.generic', permissionId: 'net-any', decision: 'granted' as const, declHash: permissionDeclHash(perSite), decidedAt: 1 };
  const g1 = withGrantedHost(g0, 'example.com');
  const g2 = withGrantedHost(g1, 'a.example.com');
  assert.deepEqual(g2.grantedHosts, ['a.example.com', 'example.com']);
  assert.deepEqual(withGrantedHost(g2, 'example.com').grantedHosts, ['a.example.com', 'example.com']);
  assert.throws(() => withGrantedHost(g0, '*.example.com'));
  assert.throws(() => withGrantedHost(g0, '127.0.0.1'));
  assert.deepEqual(withoutGrantedHost(g2, 'example.com').grantedHosts, ['a.example.com']);
  const lines = describePermission(perSite);
  assert.ok(lines.some((l) => /逐站授权/.test(l)));
  assert.ok(lines.some((l) => /不安全连接/.test(l)));
  assert.equal(displayModeLabel({ displayMode: 'in-app-web', permissions: [perSite] }), '内嵌网页 · 网页面板 · 逐站授权');
  // mode 进入权限指纹：listed → ask-per-site 视为声明变化（重新询问）
  assert.notEqual(permissionDeclHash(perSite), permissionDeclHash({ ...perSite, mode: 'listed' }));
});
