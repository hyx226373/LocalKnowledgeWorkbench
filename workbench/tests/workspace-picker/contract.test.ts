import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyStore, findConflict } from '../../src/renderer/keybindings/store';
import {
  DEFAULT_WORKSPACE_PICKER_SETTINGS,
  QUICK_SWITCH_DEFAULT_KEY,
  WORKSPACE_CARD_CLASS,
  countWorkspace,
  layoutThumbModel,
  normalizeAccent,
  normalizeCoverRef,
  normalizePurpose,
  normalizeTags,
  parseWorkspacePickerSettings,
  resolveStartup,
  restorePhase,
  shouldAutoCreateDefaultWorkspace,
  summaryFromRow,
  type CountInput,
} from '../../src/shared/workspacePicker';

const IDS = [
  'ws-empty',
  'ws-mixed',
  'ws-same-file',
  'ws-broken',
  'ws-plugin-off',
  'ws-unknown',
  'ws-long',
  'ws-host',
  'ws-webs',
  'ws-english',
  'ws-english-2',
  'ws-stale',
  'ws-cover',
  'ws-norecent',
] as const;

interface SampleWs {
  id: string;
  counts: { files: number; webs: number; apps: number; panels: number };
  detail: {
    files: { resourceId: string }[];
    webs: { ref: string }[];
    apps: { ref: string }[];
    nativeHosts: { panelId: string; hostPath: string }[];
  };
}

const samples = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/workspace-picker-samples.json'), 'utf8')) as {
  settings: { quickSwitchKey: string };
  workspaces: SampleWs[];
};

function countInputFor(ws: SampleWs): CountInput {
  const workspaceRefs = ['workspace-ref-not-a-panel', ...ws.detail.files.map((f) => f.resourceId)];
  if (ws.id === 'ws-same-file') {
    const ref = ws.detail.files[0]?.resourceId ?? 'res-note';
    return {
      items: [{ itemId: 'note', sourceKind: 'file', ref }],
      panels: [
        { id: 'a', itemId: 'note' },
        { id: 'b', itemId: 'note' },
        { id: 'c', itemId: 'note' },
      ],
      workspaceRefs: [ref, ...workspaceRefs],
    };
  }
  const items: CountInput['items'][number][] = [];
  const panels: CountInput['panels'][number][] = [];
  for (const f of ws.detail.files) {
    items.push({ itemId: f.resourceId, sourceKind: 'file', ref: f.resourceId });
    panels.push({ id: `file-${f.resourceId}`, itemId: f.resourceId });
  }
  for (const w of ws.detail.webs) {
    const itemId = `web-${w.ref}`;
    items.push({ itemId, sourceKind: 'web', ref: w.ref });
    panels.push({ id: `panel-${itemId}`, itemId });
  }
  for (const a of ws.detail.apps) {
    const itemId = `app-${a.ref}`;
    items.push({ itemId, sourceKind: 'app', ref: a.ref });
    panels.push({ id: `panel-${itemId}`, itemId });
  }
  for (const h of ws.detail.nativeHosts) {
    panels.push({ id: h.panelId, viewType: 'native-app-host', hostPath: h.hostPath });
  }
  return { items, panels, workspaceRefs };
}

describe('样例计数', () => {
  it('副本里 14 个工作区 id 都在，且 quickSwitchKey 仍是草案旧值', () => {
    expect(samples.workspaces.map((w) => w.id)).toEqual([...IDS]);
    expect(samples.settings.quickSwitchKey).toBe('Ctrl+Shift+E');
  });

  it('每个工作区的 CountInput 等于样例 counts', () => {
    for (const ws of samples.workspaces) {
      expect(countWorkspace(countInputFor(ws)), ws.id).toEqual(ws.counts);
    }
  });

  it('同一资料三面板 files=1 panels=3；托管 hostPath 计 1 个 app；空白与从未进入全 0', () => {
    const same = samples.workspaces.find((w) => w.id === 'ws-same-file')!;
    expect(countWorkspace(countInputFor(same))).toEqual({ files: 1, webs: 0, apps: 0, panels: 3 });
    const host = samples.workspaces.find((w) => w.id === 'ws-host')!;
    expect(countWorkspace(countInputFor(host))).toEqual({ files: 0, webs: 0, apps: 1, panels: 1 });
    for (const id of ['ws-empty', 'ws-norecent'] as const) {
      const ws = samples.workspaces.find((w) => w.id === id)!;
      expect(countWorkspace(countInputFor(ws))).toEqual({ files: 0, webs: 0, apps: 0, panels: 0 });
    }
  });

  it('workspaceRefs 无 file 面板则 files=0；同一 hostPath 两面板 apps=1；侧栏不计入', () => {
    expect(
      countWorkspace({
        items: [{ itemId: 'f', sourceKind: 'file', ref: 'res-x' }],
        panels: [],
        workspaceRefs: ['res-x', 'res-y'],
      }),
    ).toEqual({ files: 0, webs: 0, apps: 0, panels: 0 });
    expect(
      countWorkspace({
        items: [],
        panels: [
          { id: 'n1', viewType: 'native-app-host', hostPath: 'notepad.exe' },
          { id: 'n2', viewType: 'native-app-host', hostPath: 'notepad.exe' },
        ],
      }),
    ).toEqual({ files: 0, webs: 0, apps: 1, panels: 2 });
    expect(
      countWorkspace({
        items: [{ itemId: 'f', sourceKind: 'file', ref: 'res-x' }],
        panels: [
          { id: 'kb.sidebar', itemId: 'f' },
          { id: 'p', itemId: 'f' },
        ],
      }),
    ).toEqual({ files: 1, webs: 0, apps: 0, panels: 1 });
    expect(
      countWorkspace({
        items: [
          { itemId: 'app', sourceKind: 'app', ref: 'ap-calc' },
          { itemId: 'file', sourceKind: 'file', ref: 'res-note' },
        ],
        panels: [
          { id: 'kb.sidebar' },
          { id: 'a1', itemId: 'app' },
          { id: 'a2', itemId: 'app' },
          { id: 'f1', itemId: 'file' },
          { id: 'f2', itemId: 'file' },
          { id: 'f3', itemId: 'file' },
        ],
        workspaceRefs: ['res-note', 'res-other'],
      }),
    ).toEqual({ files: 1, webs: 0, apps: 1, panels: 5 });
  });
});

function viewPanel(id: string, extra?: { contentComponent?: string; viewType?: string; title?: string; itemId?: string }) {
  return {
    id,
    contentComponent: extra?.contentComponent ?? 'view',
    title: extra?.title,
    params: { itemId: extra?.itemId ?? id, ...(extra?.viewType ? { viewType: extra.viewType } : {}) },
  };
}

describe('layoutThumbModel', () => {
  it('dock null → 空节点且 aspect 为 16/9', () => {
    const m = layoutThumbModel({ layout: { dock: null }, items: [], thumbVersion: 0 });
    expect(m.nodes).toEqual([]);
    expect(m.aspect).toBe(16 / 9);
    expect(m.cacheKey).not.toBe('empty');
  });

  it('未知 contentComponent 与 adapterKnown false 都是 unknown', () => {
    const unknownCc = layoutThumbModel({
      layout: {
        dock: {
          grid: {
            root: { type: 'leaf', size: 1, data: { views: ['p'], activeView: 'p', id: 'g' } },
            width: 160,
            height: 90,
            orientation: 'HORIZONTAL',
          },
          panels: { p: viewPanel('p', { contentComponent: 'mystery-widget' }) },
        },
      },
      items: [{ itemId: 'p', sourceKind: 'file', title: '数据', adapterKnown: true }],
      thumbVersion: 0,
    });
    expect(unknownCc.nodes).toHaveLength(1);
    expect(unknownCc.nodes[0]).toMatchObject({ kind: 'unknown', unknown: true, iconKey: 'unknown' });

    const off = layoutThumbModel({
      layout: {
        dock: {
          grid: {
            root: { type: 'leaf', size: 1, data: { views: ['p'], activeView: 'p', id: 'g' } },
            width: 160,
            height: 90,
            orientation: 'HORIZONTAL',
          },
          panels: { p: viewPanel('p') },
        },
      },
      items: [{ itemId: 'p', sourceKind: 'file', title: '表', adapterKnown: false, iconKey: 'table' }],
      thumbVersion: 0,
    });
    expect(off.nodes[0]).toMatchObject({ kind: 'unknown', unknown: true, iconKey: 'unknown' });
  });

  it('收起后只在浮动组里的面板仍入缩略图；contentComponent 为 unknown 时按条目类型', () => {
    const grid = { root: { type: 'branch' as const, size: 1, data: [] }, width: 800, height: 600, orientation: 'HORIZONTAL' as const };
    const layout = {
      dock: {
        grid,
        panels: {
          note: viewPanel('note', { contentComponent: 'unknown', title: '版本计划.md' }),
          mystery: viewPanel('mystery', { contentComponent: 'mystery-widget' }),
          live: viewPanel('live'),
        },
        floatingGroups: [
          { data: { views: ['note'], activeView: 'note' }, position: { left: 0, top: 0, width: 400, height: 300 } },
          { data: { views: ['mystery'], activeView: 'mystery' }, position: { left: 100, top: 50, width: 200, height: 150 } },
          { data: { views: ['live'], activeView: 'live' }, position: { left: 100, top: 50, width: 400, height: 300 } },
        ],
      },
      windows: { collapsed: { note: { seq: 2 } } },
    };
    const m = layoutThumbModel({
      layout,
      items: [
        { itemId: 'note', sourceKind: 'file', title: '版本计划.md' },
        { itemId: 'mystery', sourceKind: 'file', title: '谜' },
        { itemId: 'live', sourceKind: 'web', title: 'www.iana.org' },
      ],
      thumbVersion: 0,
    });
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
    expect(byId.note).toMatchObject({ kind: 'file', unknown: false, flags: { collapsed: true }, rect: { x: 0.18, y: 0.9, w: 0.06, h: 0.08 } });
    expect(byId.mystery).toMatchObject({ kind: 'unknown', unknown: true, iconKey: 'unknown' });
    expect(byId.live).toMatchObject({ kind: 'web', unknown: false });
    expect(byId.live!.rect.x).toBeCloseTo(100 / 800);
    expect(byId.live!.rect.w).toBeCloseTo(400 / 800);
    expect(byId.side).toBeUndefined();
  });

  it('gridMaximized 铺满；collapsed 是气泡而不是整格；侧栏不产出节点', () => {
    const layout = {
      dock: {
        grid: {
          root: {
            type: 'branch' as const,
            size: 2,
            data: [
              { type: 'leaf' as const, size: 1, data: { views: ['b', 'side'], activeView: 'b', id: 'gb' } },
              { type: 'leaf' as const, size: 1, data: { views: ['a'], activeView: 'a', id: 'ga' } },
            ],
          },
          width: 200,
          height: 100,
          orientation: 'HORIZONTAL' as const,
        },
        panels: {
          a: viewPanel('a'),
          b: viewPanel('b'),
          side: viewPanel('side', { contentComponent: 'kb.sidebar' }),
          ghost: viewPanel('kb.sidebar'),
        },
      },
      windows: { gridMaximized: 'a', collapsed: { b: { seq: 1 } } },
    };
    const m = layoutThumbModel({
      layout,
      items: [
        { itemId: 'a', sourceKind: 'file', title: '甲' },
        { itemId: 'b', sourceKind: 'web', title: '乙' },
        { itemId: 'side', sourceKind: 'file', title: '栏' },
      ],
      thumbVersion: 0,
    });
    expect(m.aspect).toBe(2);
    expect(m.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    const a = m.nodes.find((n) => n.id === 'a')!;
    const b = m.nodes.find((n) => n.id === 'b')!;
    expect(a.flags.maximized).toBe(true);
    expect(a.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(b.flags.collapsed).toBe(true);
    expect(b.rect).toEqual({ x: 0.02 + 0.08, y: 0.9, w: 0.06, h: 0.08 });
    expect(b.rect).not.toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(m.nodes.some((n) => n.id === 'kb.sidebar' || n.id === 'side')).toBe(false);
  });

  it('非活动视图 hidden 且共用矩形；嵌套分屏按正交方向切；短名按码位截到 8', () => {
    const m = layoutThumbModel({
      layout: {
        dock: {
          grid: {
            root: {
              type: 'branch',
              size: 2,
              data: [
                { type: 'leaf', size: 1, data: { views: ['show', 'hide'], activeView: 'show', id: 'g1' } },
                {
                  type: 'branch',
                  size: 1,
                  data: [
                    { type: 'leaf', size: 1, data: { views: ['top'], activeView: 'top', id: 'g2' } },
                    { type: 'leaf', size: 1, data: { views: ['bot'], activeView: 'bot', id: 'g3' } },
                  ],
                },
              ],
            },
            width: 320,
            height: 180,
            orientation: 'HORIZONTAL',
          },
          panels: {
            show: viewPanel('show'),
            hide: viewPanel('hide'),
            top: viewPanel('top'),
            bot: viewPanel('bot', { viewType: 'native-app-host', title: '记事本窗口' }),
          },
        },
      },
      items: [
        { itemId: 'show', sourceKind: 'file', title: '一二三四五六七八九十', iconKey: 'markdown' },
        { itemId: 'hide', sourceKind: 'file', title: '   ' },
        { itemId: 'top', sourceKind: 'web' },
        { itemId: 'bot', sourceKind: 'app', title: '😀'.repeat(9), iconKey: 'should-not-win' },
      ],
      thumbVersion: 1,
    });
    const byId = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
    expect(m.nodes.map((n) => n.id)).toEqual(['bot', 'hide', 'show', 'top']);
    expect(byId.show!.rect).toEqual(byId.hide!.rect);
    expect(byId.show!.rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(byId.hide!.flags.hidden).toBe(true);
    expect(byId.show!.flags.hidden).toBeUndefined();
    expect(byId.top!.rect).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(byId.bot!.rect).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(byId.show!.shortName).toBe('一二三四五六七八');
    expect(byId.show!.iconKey).toBe('markdown');
    expect(byId.hide!.shortName).toBe('未命名');
    expect(byId.top!.kind).toBe('web');
    expect(byId.top!.iconKey).toBe('web');
    expect(byId.bot!.kind).toBe('native-host');
    expect(byId.bot!.iconKey).toBe('native');
    expect(byId.bot!.unknown).toBe(false);
    expect(byId.bot!.shortName).toBe('😀'.repeat(8));
  });

  it('cacheKey 是 64 位 hex，随布局与 thumbVersion 变，同一输入稳定，不随标题变', () => {
    const layout = {
      dock: {
        grid: {
          root: { type: 'leaf' as const, size: 1, data: { views: ['a'], activeView: 'a', id: 'g' } },
          width: 1600,
          height: 900,
          orientation: 'HORIZONTAL' as const,
        },
        panels: { a: viewPanel('a') },
      },
    };
    const items = [{ itemId: 'a', sourceKind: 'file' as const, title: '短' }];
    const first = layoutThumbModel({ layout, items, thumbVersion: 0 });
    const again = layoutThumbModel({ layout, items, thumbVersion: 0 });
    expect(first.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(again.cacheKey).toBe(first.cacheKey);
    const titled = layoutThumbModel({ layout, items: [{ itemId: 'a', sourceKind: 'file', title: '完全不同的标题' }], thumbVersion: 0 });
    expect(titled.cacheKey).toBe(first.cacheKey);
    const ver = layoutThumbModel({ layout, items, thumbVersion: 3 });
    expect(ver.cacheKey).not.toBe(first.cacheKey);
    const resized = layoutThumbModel({
      layout: { dock: { ...layout.dock, grid: { ...layout.dock.grid, width: 800 } } },
      items,
      thumbVersion: 0,
    });
    expect(resized.cacheKey).not.toBe(first.cacheKey);
    const kind = layoutThumbModel({ layout, items: [{ itemId: 'a', sourceKind: 'web', title: '短' }], thumbVersion: 0 });
    expect(kind.cacheKey).not.toBe(first.cacheKey);
  });

  it('实现文件不 import fs / child_process / electron', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/shared/workspacePicker/layoutThumb.ts'), 'utf8');
    expect(src).not.toMatch(/from\s+['"](?:node:)?fs['"]/);
    expect(src).not.toMatch(/from\s+['"](?:node:)?child_process['"]/);
    expect(src).not.toMatch(/from\s+['"]electron['"]/);
    expect(src).not.toContain('child_process');
    expect(src).toContain('node:crypto');
  });

  it('floats.maximized 也铺满；无 grid 尺寸时用 viewport，再不行 16/9', () => {
    const max = layoutThumbModel({
      layout: {
        dock: {
          grid: {
            root: { type: 'leaf', size: 1, data: { views: ['f'], activeView: 'f', id: 'g' } },
            width: 10,
            height: 10,
            orientation: 'HORIZONTAL',
          },
          panels: { f: viewPanel('f') },
        },
        windows: { floats: { f: { maximized: { restore: { left: 1, top: 1, width: 2, height: 2 } } } } },
      },
      items: [{ itemId: 'f', sourceKind: 'app', title: '计算' }],
      thumbVersion: 0,
    });
    expect(max.nodes[0]!.flags.maximized).toBe(true);
    expect(max.nodes[0]!.rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });

    const vp = layoutThumbModel({
      layout: { dock: null, windows: { viewport: { width: 400, height: 200 } } },
      items: [],
      thumbVersion: 0,
    });
    expect(vp.nodes).toEqual([]);
    expect(vp.aspect).toBe(2);
  });
});

describe('restorePhase', () => {
  it('ReadyOnMount 不是 restored；文件缺失可重试；无来源是 unknown', () => {
    const mounted = restorePhase({
      workspaceId: 'w',
      panelId: 'p',
      source: { kind: 'file', armed: true, resource: { missing: false }, readyOnMount: true, contentReady: false },
    });
    expect(mounted.phase).not.toBe('restored');
    expect(mounted).toMatchObject({ phase: 'unknown', reason: 'no-content-event', retryable: false });

    const located = restorePhase({
      workspaceId: 'w',
      panelId: 'p',
      source: { kind: 'file', armed: true, resource: { missing: false } },
    });
    expect(located).toMatchObject({ phase: 'unknown', reason: 'no-content-event', retryable: false });

    const ready = restorePhase({
      workspaceId: 'w',
      panelId: 'p',
      source: { kind: 'file', armed: true, resource: { missing: false }, reportsReady: true, contentReady: true, readyOnMount: true },
    });
    expect(ready).toMatchObject({ phase: 'restored', retryable: false });

    const missing = restorePhase({
      workspaceId: 'w',
      panelId: 'miss',
      source: { kind: 'file', armed: true, resource: { missing: true }, reportsReady: true, contentReady: true },
    });
    expect(missing).toMatchObject({ phase: 'failed', reason: 'resource-missing', retryable: true });

    const none = restorePhase({ workspaceId: 'w', panelId: 'p', source: { kind: 'none' } });
    expect(none.phase).toBe('unknown');
    expect(none.retryable).toBe(false);
    expect(none.reason).toBeUndefined();

    expect(restorePhase({ workspaceId: 'w', panelId: 'p', source: { kind: 'file', armed: false } }).phase).toBe('preparing');
    expect(restorePhase({ workspaceId: 'w', panelId: 'p', source: { kind: 'file', armed: true, resource: null } }).phase).toBe('loading');
  });

  it('网页同导航 failed 后的 ready 仍失败；无失败的 ready 是 restored；无 view 不编进度', () => {
    const stuck = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: {
        kind: 'web',
        hasView: true,
        events: [
          { type: 'load', state: 'failed', error: 'ERR_NAME_NOT_RESOLVED', navigationId: 'n1' },
          { type: 'ready', navigationId: 'n1' },
        ],
      },
    });
    expect(stuck).toMatchObject({ phase: 'failed', reason: 'ERR_NAME_NOT_RESOLVED', retryable: true });

    const gone = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: { kind: 'web', hasView: true, events: [{ type: 'gone', reason: 'renderer-gone' }, { state: 'ready' }] },
    });
    expect(gone).toMatchObject({ phase: 'failed', reason: 'renderer-gone', retryable: true });

    const ok = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: { kind: 'web', hasView: true, events: [{ type: 'load', state: 'loading' }, { type: 'load', state: 'ready' }] },
    });
    expect(ok).toMatchObject({ phase: 'restored', retryable: false });

    const nextNav = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: {
        kind: 'web',
        hasView: true,
        events: [
          { type: 'load', state: 'failed', error: 'ERR', navigationId: 'n1' },
          { type: 'load', state: 'ready', navigationId: 'n2' },
        ],
      },
    });
    expect(nextNav.phase).toBe('restored');

    const noView = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: { kind: 'web', hasView: false, events: [{ type: 'load', state: 'ready' }] },
    });
    expect(noView).toMatchObject({ phase: 'unknown', retryable: false });

    const blocked = restorePhase({
      workspaceId: 'w',
      panelId: 'web',
      source: { kind: 'web', hasView: true, events: [{ type: 'site-prompt' }, { type: 'blocked', reason: 'domain-blocked' }] },
    });
    expect(blocked).toMatchObject({ phase: 'unavailable', reason: 'domain-blocked', retryable: false });
  });

  it('应用未打开是 manual-open；不发明 starting；托管门禁时 attach 与 document 不可用', () => {
    const closed = restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: false } });
    expect(closed).toMatchObject({ phase: 'unavailable', reason: 'manual-open', retryable: false });

    const pending = restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: true } });
    expect(pending.phase).toBe('unknown');
    expect(pending.phase).not.toBe('restored');

    expect(restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: true, launch: { ok: true } } }).phase).toBe('restored');
    expect(
      restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: true, launch: { ok: false, reason: 'spawn-failed' } } }),
    ).toMatchObject({ phase: 'failed', reason: 'spawn-failed', retryable: true });
    expect(restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: true, crashed: true } }).phase).toBe('failed');
    expect(restorePhase({ workspaceId: 'w', panelId: 'app', source: { kind: 'app', opened: true, exited: true } }).phase).toBe('unknown');

    const gate = restorePhase({
      workspaceId: 'w',
      panelId: 'npp',
      source: { kind: 'native-host', layoutApplied: true, integLinked: true, hostGate: true },
    });
    expect(gate).toMatchObject({ phase: 'unavailable', reason: 'host-gate', retryable: false });
    expect(gate.host).toEqual({ layout: 'restored', attach: 'unavailable', document: 'unavailable' });

    const unlinked = restorePhase({
      workspaceId: 'w',
      panelId: 'npp',
      source: { kind: 'native-host', layoutApplied: true, integLinked: false, hostGate: true },
    });
    expect(unlinked).toMatchObject({ phase: 'unavailable', reason: 'not-in-integ', retryable: false });
    expect(unlinked.host).toEqual({ layout: 'restored', attach: 'unavailable', document: 'unavailable' });

    const manual = restorePhase({
      workspaceId: 'w',
      panelId: 'npp',
      source: { kind: 'native-host', layoutApplied: false, integLinked: true, hostGate: false, userOpened: false },
    });
    expect(manual).toMatchObject({ phase: 'unavailable', reason: 'manual-open', retryable: false });
    expect(manual.host).toEqual({ layout: 'unknown', attach: 'unavailable', document: 'unknown' });
  });
});

describe('设置、启动与摘要', () => {
  it('空输入是默认 last；非法 startup 只回落 last；v 不对则整份默认', () => {
    expect(parseWorkspacePickerSettings(null)).toEqual(DEFAULT_WORKSPACE_PICKER_SETTINGS);
    expect(parseWorkspacePickerSettings(undefined)).toEqual(DEFAULT_WORKSPACE_PICKER_SETTINGS);
    expect(parseWorkspacePickerSettings('last')).toEqual(DEFAULT_WORKSPACE_PICKER_SETTINGS);
    expect(DEFAULT_WORKSPACE_PICKER_SETTINGS.startup).toBe('last');
    expect(
      parseWorkspacePickerSettings({ v: 1, startup: 'nope', startupWorkspaceId: 'a', overviewHidden: true }),
    ).toEqual({ v: 1, startup: 'last', startupWorkspaceId: 'a', overviewHidden: true, snapshotEnabled: true });
    expect(parseWorkspacePickerSettings({ v: 2, startup: 'overview', startupWorkspaceId: 'a', overviewHidden: true })).toEqual(
      DEFAULT_WORKSPACE_PICKER_SETTINGS,
    );
  });

  it('零工作区是欢迎页；workspace id 不在列表则按 last；不自动建默认工作区', () => {
    expect(
      resolveStartup({
        settings: { ...DEFAULT_WORKSPACE_PICKER_SETTINGS, startup: 'workspace', startupWorkspaceId: 'ghost' },
        savedWorkspaceIds: [],
        lastWorkspaceId: 'ghost',
      }),
    ).toEqual({ kind: 'welcome' });
    expect(
      resolveStartup({
        settings: { v: 1, startup: 'overview', startupWorkspaceId: null, overviewHidden: false, snapshotEnabled: true },
        savedWorkspaceIds: [],
        lastWorkspaceId: null,
      }),
    ).toEqual({ kind: 'welcome' });
    expect(
      resolveStartup({
        settings: { v: 1, startup: 'workspace', startupWorkspaceId: 'missing', overviewHidden: false, snapshotEnabled: true },
        savedWorkspaceIds: ['a', 'b'],
        lastWorkspaceId: 'b',
      }),
    ).toEqual({ kind: 'last', workspaceId: 'b' });
    expect(
      resolveStartup({
        settings: { v: 1, startup: 'workspace', startupWorkspaceId: null, overviewHidden: false, snapshotEnabled: true },
        savedWorkspaceIds: ['a'],
        lastWorkspaceId: null,
      }),
    ).toEqual({ kind: 'last', workspaceId: null });
    expect(
      resolveStartup({
        settings: { v: 1, startup: 'workspace', startupWorkspaceId: 'a', overviewHidden: false, snapshotEnabled: true },
        savedWorkspaceIds: ['a'],
        lastWorkspaceId: null,
      }),
    ).toEqual({ kind: 'workspace', workspaceId: 'a' });
    expect(
      resolveStartup({
        settings: { ...DEFAULT_WORKSPACE_PICKER_SETTINGS, startup: 'overview' },
        savedWorkspaceIds: ['a'],
        lastWorkspaceId: 'a',
      }),
    ).toEqual({ kind: 'overview' });
    expect(shouldAutoCreateDefaultWorkspace(0)).toBe(false);
    expect(shouldAutoCreateDefaultWorkspace(3)).toBe(false);
  });

  it('summaryFromRow 用 last_opened_at，截断 purpose/tags，封面与强调色按规则', () => {
    const row = summaryFromRow({
      id: 'w',
      name: '名',
      project: '示例分类',
      purpose: '测'.repeat(81),
      tags_json: JSON.stringify(['论文', '', '  ', '一二三四五六七八九零一二三四五六七八', 1]),
      favorite: 1,
      last_opened_at: 42,
      updated_at: 99,
      icon: 'folder',
      accent: '#3D6B4F',
      cover_ref: 'ws-cover.png',
      thumb_version: 4,
    });
    expect(row.lastUsedAt).toBe(42);
    expect(row.lastUsedAt).not.toBe(99);
    expect(Array.from(row.purpose)).toHaveLength(80);
    expect(row.tags).toEqual(['论文', '一二三四五六七八九零一二三四五六']);
    expect(row.favorite).toBe(true);
    expect(row.icon).toBe('folder');
    expect(row.accent).toBe('#3D6B4F');
    expect(row.coverRef).toBe('ws-cover.png');
    expect(row.thumbVersion).toBe(4);
    expect(row.counts).toEqual({ files: 0, webs: 0, apps: 0, panels: 0 });

    expect(summaryFromRow({ id: 'e', name: '空', last_opened_at: null, updated_at: 99, favorite: 0 }).lastUsedAt).toBeNull();
    expect(normalizePurpose(null)).toBe('');
    expect(normalizeTags(['a', ''])).toEqual(['a']);
    expect(normalizeAccent('#fff')).toBeNull();
    expect(normalizeAccent('#3d6b4f')).toBe('#3d6b4f');
    expect(normalizeAccent('3D6B4F')).toBeNull();
  });

  it('normalizeCoverRef 只留文件名', () => {
    expect(normalizeCoverRef('ws-cover.png')).toBe('ws-cover.png');
    expect(normalizeCoverRef('C:\\a.png')).toBeNull();
    expect(normalizeCoverRef('..\\x.png')).toBeNull();
    expect(normalizeCoverRef('foo/bar.png')).toBeNull();
  });

  it('卡片 class 名固定', () => {
    expect(WORKSPACE_CARD_CLASS).toEqual({ root: 'kb-ws-card', selected: 'is-selected', favorite: 'is-favorite' });
  });
});

describe('快速切换默认键', () => {
  it('空 store 下 Ctrl+Shift+F 不与命令面板冲突；已被占用时 findConflict 返回对方', () => {
    expect(QUICK_SWITCH_DEFAULT_KEY).toBe('Ctrl+Shift+F');
    const free = [
      { id: 'workspace.quickSwitch', title: '快速切换', keybinding: 'Ctrl+Shift+F', when: 'global' as const },
      { id: 'workbench.commandPalette', title: '命令面板', keybinding: 'Ctrl+Shift+P', when: 'global' as const },
    ];
    expect(findConflict(emptyStore(), free, 'workspace.quickSwitch', 'Ctrl+Shift+F', 'global')).toBeNull();

    const byDefault = [
      { id: 'workspace.quickSwitch', title: '快速切换', keybinding: 'Ctrl+Shift+F', when: 'global' as const },
      { id: 'other.cmd', title: '别的命令', keybinding: 'Ctrl+Shift+F', when: 'global' as const },
    ];
    expect(findConflict(emptyStore(), byDefault, 'workspace.quickSwitch', 'Ctrl+Shift+F', 'global')?.id).toBe('other.cmd');

    const store = emptyStore();
    store.overrides['other.cmd'] = 'Ctrl+Shift+F';
    const byOverride = [
      { id: 'workspace.quickSwitch', title: '快速切换', keybinding: 'Ctrl+Shift+F', when: 'global' as const },
      { id: 'other.cmd', title: '别的命令', keybinding: 'Ctrl+K', when: 'global' as const },
    ];
    expect(findConflict(store, byOverride, 'workspace.quickSwitch', 'Ctrl+Shift+F', 'global')?.id).toBe('other.cmd');
  });
});
