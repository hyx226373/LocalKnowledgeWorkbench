/**
 * r12：外部资源按网站授权。域名归并、三种选择、从不拦截、全部允许、撤销、重启后仍有效。
 * 判断只查内存表，不在请求路径上读盘。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bridgeCapabilityDetails } from '../src/shared/actions/capabilityDetails';
import { installActionPackages } from '../src/shared/actions/install';
import { actionGate, getInvokeExecutor } from '../src/shared/actions/registry';
import { initialWebUi, reduceWebUi } from '../src/shared/webPanel';
import {
  GLOBAL_NEVER_BLOCK_WARNING,
  WEB_SITE_ACTIONS,
  bumpBanner,
  judgeSubresource,
  parseWebSiteGrantDocument,
  registrableDomain,
  runWebSiteApply,
  serializeWebSiteGrantDocument,
  type GrantSnapshot,
} from '../src/shared/webSiteGrant';
import { WebSiteGrantStore } from '../src/main/webSiteGrantStore';

installActionPackages();

const empty: GrantSnapshot = { globalNeverBlock: false, sites: new Map() };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-site-grant-'));
  dirs.push(dir);
  return new WebSiteGrantStore(path.join(dir, 'web-site-grants.json'));
}

describe('域名归并', () => {
  it('example.com 覆盖子域，第三方 CDN 单独成站', () => {
    expect(registrableDomain('cdn.example.com')).toBe('example.com');
    expect(registrableDomain('static.cdn.example.com')).toBe('example.com');
    expect(registrableDomain('EXAMPLE.com.')).toBe('example.com');
    expect(registrableDomain('fonts.gstatic.com')).toBe('gstatic.com');
    expect(registrableDomain('cdn.jsdelivr.net')).toBe('jsdelivr.net');
    expect(registrableDomain('a.b.example.co.uk')).toBe('example.co.uk');
    expect(registrableDomain('foo.github.io')).toBe('foo.github.io');
    expect(registrableDomain('bar.github.io')).toBe('bar.github.io');
    expect(registrableDomain('1.2.3.4')).toBeNull();
    const rows = bumpBanner(bumpBanner([], 'example.com'), 'example.com');
    expect(rows).toEqual([{ site: 'example.com', count: 2 }]);
    expect(bumpBanner(rows, 'gstatic.com')).toHaveLength(2);
  });
});

describe('子资源判断', () => {
  it('声明过的域名直接放行；协议、端口、IP 不询问', () => {
    expect(judgeSubresource('https://cdn.example.com/a.js', ['cdn.example.com'], {}, empty).reason).toBe('declared');
    expect(judgeSubresource('https://abc.mdnplay.dev/x', ['*.mdnplay.dev'], {}, empty).action).toBe('allow');
    expect(judgeSubresource('https://evil.example.com/', ['example.com'], {}, empty).reason).toBe('pending');
    expect(judgeSubresource('file:///etc/passwd', [], {}, empty).reason).toBe('scheme');
    expect(judgeSubresource('https://cdn.example.com:8443/a.js', [], {}, empty).reason).toBe('port');
    expect(judgeSubresource('https://8.8.8.8/a.js', [], { allowHttp: true }, empty).reason).toBe('ip');
    expect(judgeSubresource('data:text/plain,a', [], {}, empty).reason).toBe('data');
  });

  it('三种选择：本次允许、始终允许、拒绝', async () => {
    const saved = store();
    await saved.allow('cdn.example.com', 'session', 'manual');
    expect(saved.judgeNow('https://static.example.com/a.js', [], {}).action).toBe('allow');
    expect(fs.existsSync(saved.filePath())).toBe(false);
    await saved.allow('fonts.gstatic.com', 'always', 'manual');
    await saved.allow('cdn.jsdelivr.net', 'deny', 'manual');
    expect(saved.judgeNow('https://fonts.gstatic.com/a.css', [], {}).reason).toBe('grant');
    expect(saved.judgeNow('https://cdn.jsdelivr.net/x.js', [], {})).toMatchObject({ action: 'cancel', prompt: false, reason: 'denied', site: 'jsdelivr.net' });
    const doc = saved.document();
    expect(doc.sites['gstatic.com']).toMatchObject({ decision: 'allow', source: 'manual' });
    expect(doc.sites['jsdelivr.net']).toMatchObject({ decision: 'deny', source: 'manual' });
    expect(doc.sites['example.com']).toBeUndefined();
  });

  it('从不拦截：单个网站和全局开关', async () => {
    const saved = store();
    await saved.neverBlockSite('cdn.jsdelivr.net');
    expect(saved.judgeNow('https://cdn.jsdelivr.net/lib.js', [], {}).action).toBe('allow');
    expect(saved.judgeNow('https://fonts.gstatic.com/a.css', [], {}).prompt).toBe(true);
    await saved.setGlobalNeverBlock(true);
    expect(saved.judgeNow('https://tracker.example.net/t.js', [], {}).reason).toBe('global');
    expect(saved.judgeNow('javascript:alert(1)', [], {}).reason).toBe('scheme');
    expect(GLOBAL_NEVER_BLOCK_WARNING).toBe('所有网页面板将不再拦截外部资源');
    await saved.setGlobalNeverBlock(false);
    expect(saved.judgeNow('https://tracker.example.net/t.js', [], {}).prompt).toBe(true);
    expect(saved.judgeNow('https://cdn.jsdelivr.net/lib.js', [], {}).reason).toBe('grant');
  });

  it('一键全部允许记下 allow-all，撤销后重新询问', async () => {
    const saved = store();
    const result = await runWebSiteApply(saved, { actionId: 'web.allowAllBlocked', sites: ['fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdn.example.com'] }, true);
    expect(result).toMatchObject({ status: 'success', executed: true, reload: 'view' });
    expect(saved.document().sites['gstatic.com']?.source).toBe('allow-all');
    expect(saved.document().sites['jsdelivr.net']?.source).toBe('allow-all');
    expect(saved.document().sites['example.com']?.source).toBe('allow-all');
    expect(saved.judgeNow('https://ajax.googleapis.com/x', [], {}).prompt).toBe(true);
    const revoked = await runWebSiteApply(saved, { actionId: 'web.revokeSite', site: 'fonts.gstatic.com' }, false);
    expect(revoked.status).toBe('awaiting_approval');
    expect(revoked.executed).toBe(false);
    expect(saved.judgeNow('https://fonts.gstatic.com/a.css', [], {}).action).toBe('allow');
    await runWebSiteApply(saved, { actionId: 'web.revokeSite', site: 'fonts.gstatic.com' }, true);
    expect(saved.judgeNow('https://fonts.gstatic.com/a.css', [], {})).toMatchObject({ prompt: true, site: 'gstatic.com' });
  });

  it('持久化后新存储仍放行，判断不再读盘', async () => {
    const saved = store();
    await saved.load();
    const readsAfterLoad = saved.ioReads;
    await runWebSiteApply(saved, { actionId: 'web.allowSite', site: 'cdn.example.com', choice: 'always' }, true);
    const text = fs.readFileSync(saved.filePath(), 'utf8');
    const again = new WebSiteGrantStore(saved.filePath());
    await again.load();
    expect(again.judgeNow('https://img.example.com/a.png', [], {}).action).toBe('allow');
    expect(parseWebSiteGrantDocument(text)?.sites['example.com']?.source).toBe('manual');
    for (let i = 0; i < 2000; i++) saved.judgeNow('https://cdn.example.com/a.js', [], {});
    await saved.judge('https://static.example.com/b.js', [], {});
    expect(saved.ioReads).toBe(readsAfterLoad);
    const src = fs.readFileSync(path.join(__dirname, '../src/main/webSiteGrantStore.ts'), 'utf8');
    expect(src).not.toMatch(/readFileSync|writeFileSync|existsSync|statSync/);
    expect(serializeWebSiteGrantDocument(saved.document())).toContain('"version": 1');
  });
});

describe('提示条与操作目录', () => {
  it('多次拦截合成同一条列表，换页事件不另开提示', () => {
    let ui = reduceWebUi(initialWebUi, { viewId: 'v', type: 'external-sites', sites: [{ site: 'example.com', count: 2 }, { site: 'gstatic.com', count: 4 }], blockedCount: 6 });
    ui = reduceWebUi(ui, { viewId: 'v', type: 'external-sites', sites: [{ site: 'example.com', count: 5 }, { site: 'gstatic.com', count: 4 }], blockedCount: 9 });
    expect(ui.externalSites).toEqual([{ site: 'example.com', count: 5 }, { site: 'gstatic.com', count: 4 }]);
    expect(ui.resourcesBlocked).toBe(9);
    ui = reduceWebUi(ui, { viewId: 'v', type: 'navigate', url: 'https://example.com/', inPage: false, canGoBack: false, canGoForward: false, title: 'x' });
    expect(ui.externalSites).toHaveLength(2);
  });

  it('四个 ActionId 可提出但必须界面批准，没有执行体', () => {
    for (const id of WEB_SITE_ACTIONS) {
      const gate = actionGate(id);
      expect(gate.known).toBe(true);
      expect(gate.bridgeInvokable).toBe(true);
      expect(gate.approvalRequired).toBe(true);
      expect(getInvokeExecutor(id)).toBeUndefined();
      const detail = bridgeCapabilityDetails().find((row) => row.name === id);
      expect(detail?.approvalRequired).toBe(true);
      expect(detail?.availability).toBe('unavailable');
    }
  });
});
