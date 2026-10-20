import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEMPORARY_WORKSPACE_ID } from '../../src/renderer/workspace-picker/mount';
import { RestoreBar } from '../../src/renderer/workspace-picker/RestoreBar';
import {
  createRestoreFeed,
  restorePanelsFromItems,
  shouldMountRestoreBar,
  type RestoreFeed,
  type RestoreFeedPorts,
  type RestorePanelRef,
} from '../../src/renderer/workspace-picker/restoreFeed';
import type { WebPhaseEvent } from '../../src/shared/workspacePicker/types';

function row(feed: RestoreFeed, panelId: string) {
  const found = feed.getSnapshot().rows.find((item) => item.event.panelId === panelId);
  if (!found) throw new Error(`missing panel ${panelId}`);
  return found;
}

function panelSlice(html: string, panelId: string): string {
  const marker = `data-panel-id="${panelId}"`;
  const at = html.indexOf(marker);
  expect(at).toBeGreaterThan(-1);
  const next = html.indexOf('data-panel-id="', at + marker.length);
  return html.slice(at, next === -1 ? undefined : next);
}

function retryMarkup(slice: string): string {
  const at = slice.indexOf('kb-ws-restore-retry');
  expect(at).toBeGreaterThan(-1);
  const start = slice.lastIndexOf('<button', at);
  const end = slice.indexOf('</button>', at);
  return slice.slice(start, end);
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('进入与恢复条', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('文件没有事件就不推进；armed 之后才 getResource；ReadyOnMount 不是 restored', () => {
    const calls: string[] = [];
    const panels: RestorePanelRef[] = [
      { panelId: 'quiet', kind: 'file', reportsReady: true },
      { panelId: 'located', kind: 'file', reportsReady: true },
      { panelId: 'missing', kind: 'file', reportsReady: true },
      { panelId: 'ready', kind: 'file', reportsReady: true },
      { panelId: 'mounted', kind: 'file', reportsReady: true },
      { panelId: 'unarmed', kind: 'file' },
    ];
    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels,
      ports: {
        onArmed: (id, cb) => {
          if (id !== 'quiet' && id !== 'unarmed') cb(true);
          if (id === 'unarmed') cb(false);
          return () => {};
        },
        getResource: (id) => {
          calls.push(id);
          return { missing: id === 'missing' };
        },
        onContentReady: (id, cb) => {
          if (id === 'ready') cb();
          return () => {};
        },
      },
    });
    expect(calls).not.toContain('quiet');
    expect(row(feed, 'quiet').event).toMatchObject({ phase: 'unknown', retryable: false });
    expect(row(feed, 'quiet').event.phase).not.toBe('restored');
    expect(row(feed, 'located').event).toMatchObject({ phase: 'unknown', reason: 'no-content-event', retryable: false });
    expect(row(feed, 'missing').event).toMatchObject({ phase: 'failed', reason: 'resource-missing', retryable: true });
    expect(row(feed, 'ready').event).toMatchObject({ phase: 'restored', retryable: false });
    expect(row(feed, 'unarmed').event.phase).toBe('preparing');
    feed.notifyReadyOnMount('mounted');
    expect(row(feed, 'mounted').event.phase).not.toBe('restored');
    expect(row(feed, 'mounted').event).toMatchObject({ phase: 'unknown', reason: 'no-content-event' });
    expect(feed.getSnapshot().rows.map((item) => item.event.panelId)).toEqual(panels.map((panel) => panel.panelId));
    feed.dispose();
  });

  it('网页没有事件是 unknown；先 failed 再 ready 仍是 failed', () => {
    let push: (event: WebPhaseEvent) => void = () => {};
    const idle = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'web', kind: 'web' }],
      ports: { webHasView: () => true },
    });
    expect(row(idle, 'web').event).toMatchObject({ phase: 'unknown', retryable: false });
    idle.dispose();

    const noView = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'web', kind: 'web' }],
      ports: {
        webHasView: () => false,
        onWebEvent: (_id, cb) => {
          cb({ type: 'ready', navigationId: 'n1' });
          return () => {};
        },
      },
    });
    expect(row(noView, 'web').event.phase).toBe('unknown');
    expect(row(noView, 'web').event.phase).not.toBe('restored');
    noView.dispose();

    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'web', kind: 'web' }],
      ports: {
        webHasView: () => true,
        onWebEvent: (_id, cb) => {
          push = cb;
          return () => {};
        },
      },
    });
    expect(row(feed, 'web').event.phase).toBe('unknown');
    push({ type: 'load', state: 'loading', navigationId: 'n1' });
    expect(row(feed, 'web').event.phase).toBe('loading');
    push({ type: 'load', state: 'failed', error: 'ERR_NAME_NOT_RESOLVED', navigationId: 'n1' });
    push({ type: 'ready', navigationId: 'n1' });
    expect(row(feed, 'web').event).toMatchObject({ phase: 'failed', reason: 'ERR_NAME_NOT_RESOLVED', retryable: true });
    feed.dispose();
  });

  it('外部程序在点打开之前不调用 appLaunch；缺省端口保持 unavailable', async () => {
    let launches = 0;
    const missing = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'app', kind: 'app' }],
    });
    expect(row(missing, 'app').event).toMatchObject({ phase: 'unavailable', reason: 'manual-open', retryable: false });
    missing.openApp('app');
    expect(row(missing, 'app').event.phase).toBe('unavailable');
    expect(JSON.stringify(missing.getSnapshot())).not.toContain('已启动');
    missing.dispose();

    let resolveLaunch: (value: { ok: boolean }) => void = () => {};
    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'app', kind: 'app' }],
      ports: {
        appLaunch: () => {
          launches += 1;
          return new Promise((resolve) => {
            resolveLaunch = resolve;
          });
        },
      },
    });
    expect(launches).toBe(0);
    expect(row(feed, 'app').event.phase).toBe('unavailable');
    feed.openApp('app');
    feed.openApp('app');
    expect(launches).toBe(1);
    expect(row(feed, 'app').event.phase).toBe('unavailable');
    resolveLaunch({ ok: true });
    await flush();
    expect(row(feed, 'app').event).toMatchObject({ phase: 'restored', retryable: false });
    feed.dispose();

    const failed = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'app', kind: 'app' }],
      ports: { appLaunch: () => ({ ok: false, reason: 'spawn-failed' }) },
    });
    failed.openApp('app');
    expect(row(failed, 'app').event).toMatchObject({ phase: 'failed', reason: 'spawn-failed', retryable: true });
    failed.dispose();
  });

  it('原生 layout 只跟几何回调走，attach 与 document 保持 not-in-integ', () => {
    let layout: () => void = () => {};
    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels: [{ panelId: 'n', kind: 'native-host' }],
      ports: {
        onLayoutApplied: (_id, cb) => {
          layout = cb;
          return () => {};
        },
      },
    });
    expect(row(feed, 'n').event).toMatchObject({ phase: 'unavailable', reason: 'not-in-integ', retryable: false });
    expect(row(feed, 'n').event.host).toEqual({ layout: 'unknown', attach: 'unavailable', document: 'unavailable' });
    expect(row(feed, 'n').event.phase).not.toBe('restored');
    layout();
    expect(row(feed, 'n').event.host).toEqual({ layout: 'restored', attach: 'unavailable', document: 'unavailable' });
    expect(row(feed, 'n').event.phase).toBe('unavailable');
    expect(row(feed, 'n').event.phase).not.toBe('restored');
    feed.dispose();
  });

  it('假时钟推进后阶段不变，也不调用 appLaunch', () => {
    vi.useFakeTimers();
    let launches = 0;
    let nowReads = 0;
    const ports: RestoreFeedPorts = {
      onArmed: (id, cb) => {
        if (id === 'f') cb(true);
        return () => {};
      },
      getResource: () => new Promise(() => {}),
      onWebEvent: (_id, cb) => {
        cb({ type: 'load', state: 'loading', navigationId: 'n1' });
        return () => {};
      },
      webHasView: () => true,
      appLaunch: () => {
        launches += 1;
        return { ok: true };
      },
      now: () => {
        nowReads += 1;
        return Date.now();
      },
    };
    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels: [
        { panelId: 'f', kind: 'file', reportsReady: true },
        { panelId: 'web', kind: 'web' },
        { panelId: 'app', kind: 'app' },
        { panelId: 'n', kind: 'native-host' },
      ],
      ports,
    });
    const before = JSON.stringify(feed.getSnapshot());
    expect(row(feed, 'f').event.phase).toBe('loading');
    expect(row(feed, 'web').event.phase).toBe('loading');
    expect(row(feed, 'app').event.phase).toBe('unavailable');
    expect(row(feed, 'n').event.host?.layout).toBe('unknown');
    vi.advanceTimersByTime(120_000);
    expect(JSON.stringify(feed.getSnapshot())).toBe(before);
    expect(launches).toBe(0);
    expect(nowReads).toBe(0);
    expect(row(feed, 'f').event.phase).not.toBe('restored');
    expect(row(feed, 'web').event.phase).not.toBe('restored');
    feed.dispose();
  });

  it('切换工作区后丢弃旧的资源结果和网页事件', async () => {
    let resolveResource: (value: { missing: boolean }) => void = () => {};
    const webHandlers: Array<(event: WebPhaseEvent) => void> = [];
    const feed = createRestoreFeed({
      workspaceId: 'old',
      panels: [
        { panelId: 'f', kind: 'file', reportsReady: true },
        { panelId: 'web', kind: 'web' },
      ],
      ports: {
        onArmed: (id, cb) => {
          if (id === 'f') cb(true);
          return () => {};
        },
        getResource: () =>
          new Promise((resolve) => {
            resolveResource = resolve;
          }),
        webHasView: () => true,
        onWebEvent: (_id, cb) => {
          webHandlers.push(cb);
          return () => {
            const index = webHandlers.indexOf(cb);
            if (index >= 0) webHandlers.splice(index, 1);
          };
        },
      },
    });
    expect(row(feed, 'f').event.phase).toBe('loading');
    const staleWeb = webHandlers[0];
    expect(staleWeb).toBeTypeOf('function');
    feed.switchWorkspace({
      workspaceId: 'new',
      panels: [
        { panelId: 'f', kind: 'file', reportsReady: true },
        { panelId: 'web', kind: 'web' },
      ],
      ports: { webHasView: () => true },
    });
    resolveResource({ missing: false });
    staleWeb?.({ type: 'ready', navigationId: 'n1' });
    await flush();
    expect(feed.getSnapshot().workspaceId).toBe('new');
    expect(row(feed, 'f').event).toMatchObject({ workspaceId: 'new', phase: 'unknown', retryable: false });
    expect(row(feed, 'f').event.reason).toBeUndefined();
    expect(row(feed, 'web').event.phase).not.toBe('restored');
    expect(row(feed, 'web').event.phase).toBe('unknown');
    feed.dispose();
    resolveResource({ missing: false });
    staleWeb?.({ type: 'ready', navigationId: 'n9' });
    await flush();
    expect(feed.getSnapshot().workspaceId).toBe('new');
    expect(row(feed, 'web').event.phase).toBe('unknown');
  });

  it('重试按钮在不可重试时 disabled，且不调用界面回调', () => {
    const calls: Array<[string, string]> = [];
    const panels: RestorePanelRef[] = [
      { panelId: 'missing', kind: 'file', reportsReady: true },
      { panelId: 'quiet', kind: 'file', reportsReady: true },
    ];
    const ports: RestoreFeedPorts = {
      onArmed: (id, cb) => {
        if (id === 'missing') cb(true);
        return () => {};
      },
      getResource: () => ({ missing: true }),
    };
    const feed = createRestoreFeed({
      workspaceId: 'w',
      panels,
      ports,
      retryPanel: (workspaceId, panelId) => calls.push([workspaceId, panelId]),
    });
    feed.retryPanel('quiet');
    feed.retryPanel('missing');
    expect(calls).toEqual([['w', 'missing']]);
    expect(feed.getSnapshot().rows.map((item) => item.event.panelId)).toEqual(['missing', 'quiet']);
    feed.dispose();

    const html = renderToStaticMarkup(
      createElement(RestoreBar, {
        workspaceId: 'w',
        panels,
        ports,
        retryPanel: (workspaceId, panelId) => calls.push([workspaceId, panelId]),
      }),
    );
    expect(html).toContain('data-testid="ws-restore"');
    expect(html).not.toContain('data-panel-id="quiet"');
    const failed = retryMarkup(panelSlice(html, 'missing'));
    expect(failed).toContain('disabled');
    expect(failed).toContain('data-retryable="false"');
    expect(failed).toContain('找不到：已删除');
    expect(panelSlice(html, 'missing')).toContain('找不到：已删除');
    expect(html).not.toContain('已启动');
  });

  it('零工作区不挂恢复条，恢复模块不落库', () => {
    expect(shouldMountRestoreBar(0, false, '')).toBe(false);
    expect(shouldMountRestoreBar(0, false, 'ghost')).toBe(false);
    expect(shouldMountRestoreBar(0, true, TEMPORARY_WORKSPACE_ID)).toBe(false);
    expect(shouldMountRestoreBar(2, false, 'w')).toBe(true);
    expect(restorePanelsFromItems({ a: { itemId: 'a', sourceKind: 'file' }, b: { itemId: 'b', sourceKind: 'native' } })).toEqual([
      { panelId: 'a', kind: 'file' },
    ]);

    const root = process.cwd();
    const app = readFileSync(path.join(root, 'src/renderer/MainShell.tsx'), 'utf8');
    const feedSrc = readFileSync(path.join(root, 'src/renderer/workspace-picker/restoreFeed.ts'), 'utf8');
    const barSrc = readFileSync(path.join(root, 'src/renderer/workspace-picker/RestoreBar.tsx'), 'utf8');
    const css = readFileSync(path.join(root, 'src/renderer/styles.css'), 'utf8');
    const whitelist = readFileSync(path.join(root, 'src/main/agent-bridge/types.ts'), 'utf8');
    expect(app).toContain('shouldMountRestoreBar(wsList.length, temporaryWs, wsId)');
    const zero = app.indexOf('listed.length === 0');
    const current = app.indexOf('kb.getCurrentWorkspaceId()');
    expect(zero).toBeGreaterThan(0);
    expect(current).toBeGreaterThan(zero);
    expect(app.slice(zero, current)).not.toContain('RestoreBar');
    expect(app.slice(zero, current)).not.toContain('createWorkspace');
    for (const word of ['getCurrentWorkspaceId', 'createWorkspace', 'host.attach', 'createWin32Helper', 'setVisible', 'openPendingPlans', 'INVOKE_WHITELIST']) {
      expect(feedSrc, word).not.toContain(word);
      expect(barSrc, word).not.toContain(word);
    }
    expect(feedSrc + barSrc).not.toMatch(/\bsetTimeout\s*\(/);
    expect(feedSrc + barSrc).not.toMatch(/\bsetInterval\s*\(/);
    expect(feedSrc + barSrc).not.toMatch(/\brequestAnimationFrame\s*\(/);
    expect(whitelist).not.toContain('retryPanel');
    expect(whitelist).not.toContain('workspace.enter');
    const block = css.indexOf('.kb-ws-restore {');
    expect(block).toBeGreaterThan(css.indexOf('.kb-keybindings-doc'));
    expect(css.indexOf('.kb-ws-overview-mount {')).toBeLessThan(block);
    expect(css.slice(block)).not.toContain('.kb-ws-overview');
  });
});
