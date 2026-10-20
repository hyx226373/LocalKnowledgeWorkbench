/**
 * 外链内置浏览：开关判断、授权文件只增字段、布局不保存临时标签、主进程不碰剪贴板和默认会话。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXT_BROWSE_PARTITION,
  browsePrefsOf,
  browseRequestAllowed,
  browseTabTitle,
  decideExternalLink,
  systemBrowserTarget,
  type ExternalBrowsePrefs,
} from '../src/shared/externalBrowse';
import {
  WEB_SITE_ACTIONS,
  emptyDocument,
  parseWebSiteGrantDocument,
  runWebSiteApply,
  serializeWebSiteGrantDocument,
  type WebSiteGrantWriter,
} from '../src/shared/webSiteGrant';
import { omitExternalBrowsePanels } from '../src/renderer/external-browse/layout';
import type { SerializedDock } from '../src/shared/items';

const off: ExternalBrowsePrefs = { allowOpenExternal: false, trustInsecureLinks: false };
const httpOn: ExternalBrowsePrefs = { allowOpenExternal: true, trustInsecureLinks: false };
const both: ExternalBrowsePrefs = { allowOpenExternal: true, trustInsecureLinks: true };

function writer(): WebSiteGrantWriter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    allow: async () => { calls.push('allow'); },
    allowAll: async () => { calls.push('allowAll'); },
    neverBlockSite: async () => { calls.push('never'); },
    setGlobalNeverBlock: async () => { calls.push('global'); },
    setAllowOpenExternal: async (enabled) => { calls.push(`ext:${enabled}`); },
    setTrustInsecureLinks: async (enabled) => { calls.push(`trust:${enabled}`); },
    revoke: async () => { calls.push('revoke'); },
  };
}

function dock(): SerializedDock {
  return {
    grid: {
      root: {
        type: 'branch',
        size: 600,
        data: [{ type: 'leaf', size: 400, data: { id: 'g1', views: ['file-1', 'extbrowse-abc'], activeView: 'extbrowse-abc' } }],
      },
      width: 800,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: {
      'file-1': { id: 'file-1', contentComponent: 'view', params: { itemId: 'file-1' } },
      'extbrowse-abc': { id: 'extbrowse-abc', contentComponent: 'external-browse', params: { browseId: 'extbrowse-abc', url: 'https://example.com/' } },
    },
    activeGroup: 'g1',
  };
}

describe('外链地址判断', () => {
  it('http(s) 只看允许打开外链；file 还要信任；javascript 与工作台协议永远拒绝', () => {
    expect(decideExternalLink('https://example.com/a', off).action).toBe('block');
    expect(decideExternalLink('http://example.com/a', httpOn)).toEqual({ action: 'open', url: 'http://example.com/a' });
    expect(decideExternalLink('https://example.com/a', httpOn)).toEqual({ action: 'open', url: 'https://example.com/a' });
    expect(decideExternalLink('//example.com/a', httpOn)).toEqual({ action: 'open', url: 'https://example.com/a' });
    expect(decideExternalLink('file:///tmp/a.txt', httpOn).action).toBe('block');
    expect(decideExternalLink('file:///tmp/a.txt', both)).toEqual({ action: 'open', url: 'file:///tmp/a.txt' });
    expect(decideExternalLink('mailto:a@example.com', both).action).toBe('open');
    expect(decideExternalLink('file:///tmp/a.txt', { allowOpenExternal: false, trustInsecureLinks: true }).action).toBe('block');
    expect(decideExternalLink('javascript:alert(1)', both)).toEqual({ action: 'deny', reason: 'javascript' });
    expect(decideExternalLink('java\nscript:alert(1)', both)).toEqual({ action: 'deny', reason: 'javascript' });
    expect(decideExternalLink(' \u0000javascript:alert(1)', both)).toEqual({ action: 'deny', reason: 'javascript' });
    expect(decideExternalLink('kbfile:///secret', both)).toEqual({ action: 'deny', reason: 'workbench' });
    expect(decideExternalLink('kbplugin://host/x', both)).toEqual({ action: 'deny', reason: 'workbench' });
    expect(decideExternalLink('#section', both)).toEqual({ action: 'ignore' });
    expect(decideExternalLink('./local.md', both)).toEqual({ action: 'ignore' });
    expect(decideExternalLink('', both)).toEqual({ action: 'ignore' });
    expect(decideExternalLink('http://', httpOn)).toEqual({ action: 'ignore' });
    expect(decideExternalLink('https://' + 'a'.repeat(8000), httpOn).action).toBe('block');
    expect(browsePrefsOf(undefined)).toEqual(httpOn);
    expect(browsePrefsOf({ allowOpenExternal: false })).toEqual(off);
    expect(browsePrefsOf({ allowOpenExternal: true }).trustInsecureLinks).toBe(false);
  });

  it('子资源放行视频所需的 https、ws 和 blob；顶层 data 和 ws 仍要信任', () => {
    expect(browseRequestAllowed('https://cdn.example/v.mp4', false, off)).toBe(true);
    expect(browseRequestAllowed('blob:https://example/id', false, off)).toBe(true);
    expect(browseRequestAllowed('wss://example/live', false, off)).toBe(true);
    expect(browseRequestAllowed('data:video/mp4;base64,AA', false, off)).toBe(true);
    expect(browseRequestAllowed('https://example/', true, off)).toBe(false);
    expect(browseRequestAllowed('https://example/', true, httpOn)).toBe(true);
    expect(browseRequestAllowed('data:text/html,hi', true, httpOn)).toBe(false);
    expect(browseRequestAllowed('data:text/html,hi', true, both)).toBe(true);
    expect(browseRequestAllowed('ws://example/x', true, httpOn)).toBe(false);
    expect(browseRequestAllowed('ws://example/x', true, both)).toBe(true);
    expect(browseRequestAllowed('javascript:alert(1)', false, both)).toBe(false);
    expect(browseRequestAllowed('kbfile:///x', false, both)).toBe(false);
    expect(browseRequestAllowed('about:blank', true, off)).toBe(true);
    expect(browseRequestAllowed('file:///tmp/a.txt', false, httpOn)).toBe(false);
  });

  it('系统浏览器只接受没有账号的 http(s)，file 单独标出', () => {
    expect(systemBrowserTarget('https://example.com/a')).toEqual({ kind: 'external', url: 'https://example.com/a' });
    expect(systemBrowserTarget('http://user:pass@example.com/').kind).toBe('reject');
    expect(systemBrowserTarget('file:///tmp/a.txt')).toEqual({ kind: 'file', url: 'file:///tmp/a.txt' });
    expect(systemBrowserTarget('javascript:alert(1)').kind).toBe('reject');
    expect(systemBrowserTarget('kbfile:///x').kind).toBe('reject');
    expect(browseTabTitle('https://example.com/a')).toBe('example.com');
    expect(browseTabTitle('file:///tmp/a%20b.txt')).toBe('a b.txt');
    expect(browseTabTitle('not a url')).toBe('外链');
    expect(EXT_BROWSE_PARTITION.startsWith('persist:')).toBe(false);
    expect(EXT_BROWSE_PARTITION).toBe('kb-ext-browse');
  });
});

describe('网站授权文件', () => {
  it('旧文件没有新字段时：允许外链默认开、信任不安全链接默认关，版本仍是 1', () => {
    const parsed = parseWebSiteGrantDocument(JSON.stringify({ version: 1, globalNeverBlock: false, sites: { 'example.com': { decision: 'allow', source: 'manual', at: 't' } } }));
    expect(parsed).toMatchObject({ version: 1, allowOpenExternal: true, trustInsecureLinks: false });
    expect(parseWebSiteGrantDocument(JSON.stringify({ version: 1, globalNeverBlock: false, sites: {}, allowOpenExternal: false }))?.allowOpenExternal).toBe(false);
    expect(parsed?.sites['example.com']?.decision).toBe('allow');
    expect(parseWebSiteGrantDocument(JSON.stringify({ version: 2, globalNeverBlock: false, sites: {} }))).toBeNull();
  });

  it('新字段写在 sites 后面，不改已有键', () => {
    const doc = emptyDocument();
    doc.globalNeverBlock = true;
    doc.allowOpenExternal = true;
    doc.sites = {
      'b.example': { decision: 'deny', source: 'manual', at: 't' },
      'a.example': { decision: 'allow', source: 'manual', at: 't' },
    };
    const text = serializeWebSiteGrantDocument(doc);
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'globalNeverBlock', 'sites', 'allowOpenExternal', 'trustInsecureLinks']);
    expect(Object.keys(JSON.parse(text).sites)).toEqual(['a.example', 'b.example']);
    expect(parseWebSiteGrantDocument(text)).toMatchObject({ version: 1, globalNeverBlock: true, allowOpenExternal: true, trustInsecureLinks: false });
  });

  it('两个开关不进桥的动作目录，批准后只改对应字段', async () => {
    expect([...WEB_SITE_ACTIONS]).toEqual(['web.allowSite', 'web.allowAllBlocked', 'web.neverBlock', 'web.revokeSite']);
    const pending = writer();
    const held = await runWebSiteApply(pending, { actionId: 'web.allowOpenExternal', enabled: true }, false);
    expect(held).toMatchObject({ status: 'awaiting_approval', executed: false, reload: 'none' });
    expect(pending.calls).toEqual([]);
    const saved = writer();
    const opened = await runWebSiteApply(saved, { actionId: 'web.allowOpenExternal', enabled: true }, true);
    const trusted = await runWebSiteApply(saved, { actionId: 'web.trustInsecureLinks' }, true);
    expect(opened).toMatchObject({ status: 'success', executed: true, reload: 'none' });
    expect(trusted).toMatchObject({ status: 'success', executed: true, reload: 'none' });
    expect(saved.calls).toEqual(['ext:true', 'trust:false']);
  });
});

describe('临时标签不进布局', () => {
  it('保存前去掉 extbrowse 面板，并清掉网格里的引用', () => {
    const next = omitExternalBrowsePanels(dock());
    expect(next?.panels['extbrowse-abc']).toBeUndefined();
    expect(next?.panels['file-1']).toBeTruthy();
    expect(next?.grid.root).toMatchObject({ data: [{ data: { views: ['file-1'], activeView: 'file-1' } }] });
    const only = dock();
    delete only.panels['file-1'];
    only.grid.root = { type: 'leaf', size: 400, data: { id: 'g1', views: ['extbrowse-abc'], activeView: 'extbrowse-abc' } };
    expect(omitExternalBrowsePanels(only)).toBeNull();
    const plain = dock();
    delete plain.panels['extbrowse-abc'];
    plain.grid.root = { type: 'leaf', size: 400, data: { id: 'g1', views: ['file-1'], activeView: 'file-1' } };
    expect(omitExternalBrowsePanels(plain)).toBe(plain);
  });
});

describe('主进程边界', () => {
  const host = readFileSync(new URL('../src/main/externalBrowseHost.ts', import.meta.url), 'utf8');
  const panels = readFileSync(new URL('../src/main/webPanels.ts', import.meta.url), 'utf8');
  const grantsUi = readFileSync(new URL('../src/renderer/web-site/grantsDialog.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/renderer/MainShell.tsx', import.meta.url), 'utf8');

  it('浏览宿主不用默认会话、不写剪贴板、不写 LOCALAPPDATA', () => {
    expect(host).not.toContain('LOCALAPPDATA');
    expect(host).not.toContain('clipboard');
    expect(host).not.toContain('defaultSession');
    expect(host).not.toContain('preload');
    expect(host).toContain('session.fromPartition(EXT_BROWSE_PARTITION');
    const openSystem = host.slice(host.indexOf('async openSystem'), host.indexOf('setBounds'));
    expect(openSystem).toContain('entry.wc.getURL()');
    expect(host).toContain('code === -3 || code === -20');
  });

  it('外链开关开着时，被拦的顶层导航先改到内容区标签，再考虑逐站询问', () => {
    const start = panels.indexOf('private navDenied');
    const body = panels.slice(start, panels.indexOf('async fetchForCache', start));
    expect(body.indexOf('tryExternalTab')).toBeGreaterThan(-1);
    expect(body.indexOf('site-prompt')).toBeGreaterThan(body.indexOf('tryExternalTab'));
    expect(body.indexOf('this.blocked')).toBeGreaterThan(body.indexOf('tryExternalTab'));
  });

  it('两个开关在网站授权页，主窗口用内容区标签而不是独立窗口', () => {
    expect(grantsUi).toContain('允许打开外链（应用内标签打开）');
    expect(grantsUi).toContain('信任不安全链接');
    expect(grantsUi).toContain('ext-browse-allow');
    expect(grantsUi).toContain('ext-browse-trust');
    expect(app).toContain('[EXTERNAL_BROWSE_COMPONENT]: ExternalBrowsePanel');
    expect(app.split('omitExternalBrowsePanels(omitAgentPanelDocs').length - 1).toBe(2);
    expect(app).toContain('installExternalBrowseClicks');
  });
});
