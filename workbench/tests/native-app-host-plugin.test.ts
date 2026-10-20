/**
 * host-r1-plugin · native-app-host view plugin tests
 * Covers VC-L1-06 / VC-L1-09 / VC-L1-10 (+ first-click / no-hover-enter).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  NATIVE_APP_HOST_VIEW_TYPE,
  NATIVE_HOST_ACTION_IDS,
  sanitizePersist,
  toPersistPayload,
  FORBIDDEN_PERSIST_KEYS,
} from '../src/shared/nativeAppHost';
import {
  NATIVE_APP_HOST_ADAPTER_ID,
  NATIVE_APP_HOST_COMMANDS,
  NATIVE_APP_HOST_REF,
} from '../src/renderer/plugins/native-app-host/constants';
import {
  MockNativeHostClient,
  FAKE_NPP,
  setHostClient,
} from '../src/renderer/plugins/native-app-host/hostClient';
import { proposeAttach, proposeDetach } from '../src/renderer/plugins/native-app-host/proposeAttach';
import {
  serializeNativeAppHostState,
  restoreNativeAppHostState,
  emptyViewState,
  isPendingActivation,
} from '../src/renderer/plugins/native-app-host/persistView';
import {
  applyHover,
  interactionAfterLayoutChrome,
  reduceInteraction,
  shouldConsumeFirstClick,
} from '../src/renderer/plugins/native-app-host/interaction';
import {
  LAYOUT_EVENTS,
  LAYOUT_EVENT_NAMES,
  LAYOUT_REQUEST_ACTIVATE,
  emitLayoutEvent,
  reduceLayoutUi,
  reduceLayoutUiForPanel,
  appliesToPanel,
  emptyLayoutUiState,
  layoutAdjustReflect,
  subscribeLayoutEvents,
  requestActivate,
  shouldRequestPanelFocus,
  type LayoutChangeReason,
} from '../src/renderer/plugins/native-app-host/layoutEvents';
import type { HostListResult } from '../src/shared/nativeAppHost';
import {
  hostPanelLayoutSync,
  resolveDisplays,
  nativeVisibleAttr,
  placeholderBlocksPointer,
  resetDisplayCacheForTests,
  cacheDisplaysFromLayout,
} from '../src/renderer/plugins/native-app-host/chrome';
import {
  listNativePanels,
  resetNativePanelsForTests,
  restingShouldShow,
  upsertNativePanel,
  removeNativePanel,
  NATIVE_PANELS_HOOK,
} from '../src/renderer/plugins/native-app-host/panelRegistry';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTION_ID_LIST, runNativeAppHostAction } from '../src/renderer/plugins/native-app-host/actions';
import { setNativeAppHostOpener, createHostPanel } from '../src/renderer/plugins/native-app-host/openBridge';
import plugin from '../src/renderer/plugins/native-app-host';

describe('VC-L1-06 · viewType must be native-app-host', () => {
  it('constant and adapter id are literal native-app-host (not desktopPanel)', () => {
    expect(NATIVE_APP_HOST_VIEW_TYPE).toBe('native-app-host');
    expect(NATIVE_APP_HOST_ADAPTER_ID).toBe('native-app-host');
    expect(NATIVE_APP_HOST_VIEW_TYPE).not.toBe('desktopPanel');
    expect(NATIVE_APP_HOST_VIEW_TYPE).not.toBe('desktop-panel');
    expect(NATIVE_APP_HOST_REF).toBe('native-app-host.main');
  });

  it('serializeState payload viewType is strictly native-app-host', () => {
    const empty = serializeNativeAppHostState(undefined);
    expect(empty).toMatchObject({ viewType: 'native-app-host' });
    expect((empty as { viewType: string }).viewType).not.toMatch(/desktop/i);

    const withHost = serializeNativeAppHostState({
      ...emptyViewState(),
      hostPath: FAKE_NPP.path,
      titleHint: FAKE_NPP.title,
      persist: toPersistPayload({ hostPath: FAKE_NPP.path, titleHint: FAKE_NPP.title }),
    });
    expect(withHost.viewType).toBe(NATIVE_APP_HOST_VIEW_TYPE);
    expect(withHost.viewType).toBe('native-app-host');
  });

  it('plugin manifest adapter id aligns with native-app-host', () => {
    expect(plugin.manifest.id).toBe('builtin.native-app-host');
    const adapters = plugin.manifest.contributes?.adapters ?? [];
    expect(adapters.some((a) => a.id === 'native-app-host')).toBe(true);
    expect(adapters.every((a) => a.id !== 'desktop-panel' && a.id !== 'desktopPanel')).toBe(true);
  });
});

describe('VC-L1-09 · proposeAttach requires confirm; cancel skips attach', () => {
  let client: MockNativeHostClient;

  beforeEach(() => {
    client = new MockNativeHostClient();
    setHostClient(client);
  });

  it('cancel → no attach call', async () => {
    const result = await proposeAttach({
      client,
      panelId: 'panel-1',
      candidate: FAKE_NPP,
      confirm: async () => false,
    });
    expect(result).toEqual({ ok: false, cancelled: true });
    expect(client.attachCallCount()).toBe(0);
    expect(client.calls.some((c) => c.method === 'host.attach')).toBe(false);
  });

  it('confirm → attach once with selected identity', async () => {
    const result = await proposeAttach({
      client,
      panelId: 'panel-1',
      candidate: FAKE_NPP,
      confirm: async () => true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.response.bindingId).toBeTruthy();
    expect(result.response.identity.path).toMatch(/notepad\+\+\.exe$/i);
    expect(client.attachCallCount()).toBe(1);
  });

  it('no silent auto-attach on list / restore', async () => {
    await client.list();
    expect(client.attachCallCount()).toBe(0);
    const restored = restoreNativeAppHostState(
      toPersistPayload({ hostPath: FAKE_NPP.path, titleHint: FAKE_NPP.title }),
    );
    expect(restored.needsReselect).toBe(true);
    expect(restored.bindingId).toBeNull();
    expect(restored.interaction).toBe('idle');
    expect(client.attachCallCount()).toBe(0);
  });

  it('ActionId proposeAttach is cancellable via runNativeAppHostAction', async () => {
    const cancelled = await runNativeAppHostAction(NATIVE_HOST_ACTION_IDS.proposeAttach, {
      client,
      panelId: 'p',
      candidate: FAKE_NPP,
      confirm: async () => false,
    });
    expect(cancelled).toMatchObject({ ok: false, cancelled: true });
    expect(client.attachCallCount()).toBe(0);
  });

  it('proposeDetach cancel does not detach', async () => {
    const att = await proposeAttach({
      client,
      panelId: 'p',
      candidate: FAKE_NPP,
      confirm: async () => true,
    });
    if (!att.ok) throw new Error('attach failed');
    const det = await proposeDetach({
      client,
      bindingId: att.response.bindingId,
      confirm: async () => false,
    });
    expect(det).toEqual({ ok: false, cancelled: true });
    const st = await client.getState({ bindingId: att.response.bindingId });
    expect(st.ok && st.snapshot.state).toBe('attached');
  });
});

describe('VC-L1-10 · persist has no hwnd/pid/bindingId/createTime', () => {
  it('toPersistPayload / serialize omit forbidden keys and include required fields', () => {
    const p = toPersistPayload({
      hostPath: FAKE_NPP.path,
      titleHint: FAKE_NPP.title,
      layout: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(p.viewType).toBe('native-app-host');
    expect(p.hostPath).toBe(FAKE_NPP.path);
    expect(p.titleHint).toBe(FAKE_NPP.title);
    expect(p.layout).toEqual({ x: 1, y: 2, w: 3, h: 4 });
    expect(p.attachPolicy).toBe('reselect-on-restore');
    for (const k of ['hwnd', 'pid', 'bindingId', 'createTime'] as const) {
      expect(p).not.toHaveProperty(k);
    }
    for (const k of FORBIDDEN_PERSIST_KEYS) expect(p).not.toHaveProperty(k);

    const ser = serializeNativeAppHostState({
      ...emptyViewState(),
      hostPath: p.hostPath,
      titleHint: p.titleHint,
      persist: p,
      bindingId: 'runtime-only-bind', // must not leak into serialize
    });
    expect(ser).not.toHaveProperty('hwnd');
    expect(ser).not.toHaveProperty('pid');
    expect(ser).not.toHaveProperty('bindingId');
    expect(ser).not.toHaveProperty('createTime');
    expect(ser).toMatchObject({
      viewType: 'native-app-host',
      hostPath: FAKE_NPP.path,
      titleHint: FAKE_NPP.title,
      attachPolicy: 'reselect-on-restore',
    });
  });

  it('sanitizePersist throws on hwnd (and pid/bindingId/createTime)', () => {
    expect(() =>
      sanitizePersist({ viewType: 'native-app-host', hostPath: 'x', hwnd: '1' }),
    ).toThrow(/hwnd/);
    expect(() =>
      sanitizePersist({ viewType: 'native-app-host', hostPath: 'x', pid: 1 }),
    ).toThrow(/pid/);
    expect(() =>
      sanitizePersist({ viewType: 'native-app-host', hostPath: 'x', bindingId: 'b' }),
    ).toThrow(/bindingId/);
    expect(() =>
      sanitizePersist({ viewType: 'native-app-host', hostPath: 'x', createTime: 1 }),
    ).toThrow(/createTime/);
  });

  it('restore never silently binds; policy is reselect-on-restore', () => {
    const restored = restoreNativeAppHostState({
      viewType: 'native-app-host',
      hostPath: FAKE_NPP.path,
      titleHint: 'hint',
      layout: { x: 0, y: 0, w: 10, h: 10 },
      attachPolicy: 'reselect-on-restore',
    });
    expect(restored.persist?.attachPolicy).toBe('reselect-on-restore');
    expect(restored.needsReselect).toBe(true);
    expect(restored.bindingId).toBeNull();
  });
});

describe('interaction · no hover-enter; first-click consume', () => {
  it('hover does not enter interacting', () => {
    expect(applyHover('idle')).toBe('idle');
    expect(applyHover('attached')).toBe('attached');
    expect(reduceInteraction('attached', { type: 'hover' })).toBe('attached');
  });

  it('first click from attached → interacting and is consumed', () => {
    expect(shouldConsumeFirstClick('attached')).toBe(true);
    expect(shouldConsumeFirstClick('interacting')).toBe(false);
    expect(shouldConsumeFirstClick('idle')).toBe(false);
    expect(reduceInteraction('attached', { type: 'first-click' })).toBe('interacting');
  });

  it('exit leaves interacting → attached', () => {
    expect(reduceInteraction('interacting', { type: 'exit' })).toBe('attached');
  });
});

describe('layout.* freeze v1 · four events + CustomEvent transport', () => {
  const REASONS: LayoutChangeReason[] = [
    'chrome-toggle',
    'content-only',
    'edit-drag',
    'restore',
    'workspace-open',
    'dpi-change',
    'layout-adjust',
  ];

  /** Minimal window mock so subscribeLayoutEvents can attach CustomEvent listeners. */
  function installMockWindow() {
    const handlerMap = new Map<string, Set<EventListener>>();
    const win = {
      addEventListener(type: string, handler: EventListener) {
        if (!handlerMap.has(type)) handlerMap.set(type, new Set());
        handlerMap.get(type)!.add(handler);
      },
      removeEventListener(type: string, handler: EventListener) {
        handlerMap.get(type)?.delete(handler);
      },
      dispatchEvent(event: Event): boolean {
        const name = (event as { type: string }).type;
        const detail = (event as { detail?: unknown }).detail;
        for (const h of handlerMap.get(name) ?? []) {
          h({ type: name, detail } as unknown as Event);
        }
        return true;
      },
    };
    (globalThis as { window?: typeof win }).window = win;
    return () => {
      delete (globalThis as { window?: typeof win }).window;
    };
  }

  it('exports layout.* event names including L2 displaysChanged', () => {
    expect(LAYOUT_EVENT_NAMES).toEqual([
      'layout.contentBoundsChanged',
      'layout.chromeVisibilityChanged',
      'layout.hostOcclusionChanged',
      'layout.editModeChanged',
      'layout.displaysChanged',
    ]);
    expect(LAYOUT_EVENTS.editModeChanged).toBe('layout.editModeChanged');
    expect(LAYOUT_EVENTS.displaysChanged).toBe('layout.displaysChanged');
  });

  it('reduceLayoutUi: contentBounds / chromeVisibility require reason; occlusion has no reason', () => {
    let s = emptyLayoutUiState();
    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.contentBoundsChanged,
      detail: {
        panelId: 'p',
        bounds: { x: 10, y: 20, w: 300, h: 200 },
        reason: 'dpi-change',
      },
    });
    expect(s.contentBounds).toEqual({ x: 10, y: 20, w: 300, h: 200 });
    expect(s.contentBoundsReason).toBe('dpi-change');

    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.chromeVisibilityChanged,
      detail: {
        visibility: { 'chrome.menu': false },
        contentOnly: true,
        reason: 'content-only',
      },
    });
    expect(s.contentOnly).toBe(true);
    expect(s.chromeVisibilityReason).toBe('content-only');
    expect(s.chromeVisibility['chrome.menu']).toBe(false);

    const occDetail = { panelId: 'p', occluded: true };
    expect(occDetail).not.toHaveProperty('reason');
    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.hostOcclusionChanged,
      detail: occDetail,
    });
    expect(s.occluded).toBe(true);
    expect(s).not.toHaveProperty('occlusionReason');

    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.editModeChanged,
      detail: { editMode: true, dirty: true },
    });
    expect(s.editMode).toBe(true);
    expect(s.dirty).toBe(true);

    for (const r of REASONS) {
      expect(typeof r).toBe('string');
    }
  });

  it('subscribeLayoutEvents receives window CustomEvent (layout-host product path)', () => {
    const uninstall = installMockWindow();
    const seen: Array<{ name: string; detail: unknown }> = [];
    const off = subscribeLayoutEvents((ev) => seen.push({ name: ev.name, detail: ev.detail }));

    (globalThis as { window: { dispatchEvent(e: Event): boolean } }).window.dispatchEvent(
      new (class {
        type = LAYOUT_EVENTS.contentBoundsChanged;
        detail = {
          panelId: 'panel-a',
          bounds: { x: 1, y: 2, w: 3, h: 4 },
          reason: 'layout-adjust' as LayoutChangeReason,
        };
      })() as unknown as Event,
    );
    (globalThis as { window: { dispatchEvent(e: Event): boolean } }).window.dispatchEvent(
      new (class {
        type = LAYOUT_EVENTS.chromeVisibilityChanged;
        detail = {
          visibility: { 'chrome.sidebar': true },
          contentOnly: false,
          reason: 'chrome-toggle' as LayoutChangeReason,
        };
      })() as unknown as Event,
    );
    (globalThis as { window: { dispatchEvent(e: Event): boolean } }).window.dispatchEvent(
      new (class {
        type = LAYOUT_EVENTS.hostOcclusionChanged;
        detail = { panelId: 'panel-a', occluded: false };
      })() as unknown as Event,
    );
    (globalThis as { window: { dispatchEvent(e: Event): boolean } }).window.dispatchEvent(
      new (class {
        type = LAYOUT_EVENTS.editModeChanged;
        detail = { editMode: false, dirty: false };
      })() as unknown as Event,
    );

    off();
    uninstall();

    expect(seen.map((s) => s.name)).toEqual([
      LAYOUT_EVENTS.contentBoundsChanged,
      LAYOUT_EVENTS.chromeVisibilityChanged,
      LAYOUT_EVENTS.hostOcclusionChanged,
      LAYOUT_EVENTS.editModeChanged,
    ]);
    expect(seen[0].detail).toMatchObject({ reason: 'layout-adjust' });
    expect(seen[1].detail).toMatchObject({ contentOnly: false, reason: 'chrome-toggle' });
    expect(seen[2].detail).toEqual({ panelId: 'panel-a', occluded: false });
    expect(seen[2].detail).not.toHaveProperty('reason');
    expect(seen[3].detail).toEqual({ editMode: false, dirty: false });
  });

  it('emitLayoutEvent is test-only in-process helper (not used by product actions/view)', () => {
    const seen: string[] = [];
    const off = subscribeLayoutEvents((ev) => seen.push(ev.name));
    // @internal test-only path
    emitLayoutEvent({
      name: LAYOUT_EVENTS.editModeChanged,
      detail: { editMode: true, dirty: false },
    });
    off();
    expect(seen).toEqual([LAYOUT_EVENTS.editModeChanged]);

    const actionsSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/actions.ts'),
      'utf8',
    );
    const viewSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/NativeAppHostView.tsx'),
      'utf8',
    );
    expect(actionsSrc).not.toMatch(/emitLayoutEvent/);
    expect(viewSrc).not.toMatch(/emitLayoutEvent/);
    expect(layoutAdjustReflect(emptyLayoutUiState()).note).toMatch(/layout\.\*/);
  });

  it('layoutAdjust ActionId only reflects; never setBounds / never emit', async () => {
    const client = new MockNativeHostClient();
    const result = await runNativeAppHostAction(NATIVE_HOST_ACTION_IDS.layoutAdjust, {
      client,
      layoutUi: emptyLayoutUiState(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(client.calls.some((c) => String(c.method).includes('setBounds'))).toBe(false);
    expect(client.calls).toHaveLength(0);
  });
});

describe('ActionId list + createHostPanel bridge', () => {
  it('exports stable ActionId literals from 01 §6', () => {
    expect(ACTION_ID_LIST).toEqual([
      'createHostPanel',
      'listHosts',
      'proposeAttach',
      'layoutAdjust',
      'proposeDetach',
    ]);
    expect(NATIVE_APP_HOST_COMMANDS.createHostPanel).toBe('createHostPanel');
  });

  it('createHostPanel uses opener bridge', async () => {
    setNativeAppHostOpener(() => 'item-nah-1');
    await expect(createHostPanel()).resolves.toBe('item-nah-1');
    setNativeAppHostOpener(() => null);
  });

  it('listHosts ActionId returns mock candidates including Notepad++', async () => {
    const client = new MockNativeHostClient();
    const res = (await runNativeAppHostAction('listHosts', { client })) as HostListResult;
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected HostListResult');
    expect(res.candidates.some((c) => /notepad\+\+/i.test(c.path))).toBe(true);
  });
});

describe('P-1 · panelId filter (multi-panel isolation)', () => {
  it('panel A applies A bounds; ignores B occlusion/bounds', () => {
    const panelA = 'panel-A';
    const panelB = 'panel-B';
    let s = emptyLayoutUiState();

    const boundsA = {
      name: LAYOUT_EVENTS.contentBoundsChanged,
      detail: {
        panelId: panelA,
        bounds: { x: 1, y: 2, w: 100, h: 50 },
        reason: 'layout-adjust' as LayoutChangeReason,
      },
    } as const;
    const boundsB = {
      name: LAYOUT_EVENTS.contentBoundsChanged,
      detail: {
        panelId: panelB,
        bounds: { x: 9, y: 9, w: 9, h: 9 },
        reason: 'layout-adjust' as LayoutChangeReason,
      },
    } as const;
    const occB = {
      name: LAYOUT_EVENTS.hostOcclusionChanged,
      detail: { panelId: panelB, occluded: true },
    } as const;
    const occA = {
      name: LAYOUT_EVENTS.hostOcclusionChanged,
      detail: { panelId: panelA, occluded: true },
    } as const;

    expect(appliesToPanel(boundsA, panelA)).toBe(true);
    expect(appliesToPanel(boundsB, panelA)).toBe(false);
    expect(appliesToPanel(occB, panelA)).toBe(false);

    s = reduceLayoutUiForPanel(s, boundsA, panelA);
    expect(s.contentBounds).toEqual({ x: 1, y: 2, w: 100, h: 50 });
    s = reduceLayoutUiForPanel(s, boundsB, panelA);
    expect(s.contentBounds).toEqual({ x: 1, y: 2, w: 100, h: 50 }); // unchanged
    s = reduceLayoutUiForPanel(s, occB, panelA);
    expect(s.occluded).toBe(false);
    s = reduceLayoutUiForPanel(s, occA, panelA);
    expect(s.occluded).toBe(true);
  });

  it('global chromeVisibility / editMode apply; future panelId filters', () => {
    const panelA = 'panel-A';
    let s = emptyLayoutUiState();
    const chrome = {
      name: LAYOUT_EVENTS.chromeVisibilityChanged,
      detail: {
        visibility: { 'chrome.menu': false },
        contentOnly: true,
        reason: 'content-only' as LayoutChangeReason,
      },
    } as const;
    expect(appliesToPanel(chrome, panelA)).toBe(true);
    s = reduceLayoutUiForPanel(s, chrome, panelA);
    expect(s.contentOnly).toBe(true);

    const scopedChrome = {
      name: LAYOUT_EVENTS.chromeVisibilityChanged,
      detail: {
        visibility: { 'chrome.menu': true },
        contentOnly: false,
        reason: 'chrome-toggle' as LayoutChangeReason,
        panelId: 'panel-B',
      },
    } as const;
    expect(appliesToPanel(scopedChrome as never, panelA)).toBe(false);
    s = reduceLayoutUiForPanel(s, scopedChrome as never, panelA);
    expect(s.contentOnly).toBe(true); // unchanged

    const edit = {
      name: LAYOUT_EVENTS.editModeChanged,
      detail: { editMode: true, dirty: false },
    } as const;
    expect(appliesToPanel(edit, panelA)).toBe(true);
    s = reduceLayoutUiForPanel(s, edit, panelA);
    expect(s.editMode).toBe(true);
  });

  it('getState with panelId only returns that panel binding', async () => {
    const client = new MockNativeHostClient();
    const a = await client.attach({
      identity: {
        hwnd: FAKE_NPP.hwnd,
        pid: FAKE_NPP.pid,
        createTime: FAKE_NPP.createTime,
        path: FAKE_NPP.path,
      },
      panelId: 'panel-A',
    });
    expect(a.ok).toBe(true);
    const stA = await client.getState({ panelId: 'panel-A' });
    const stB = await client.getState({ panelId: 'panel-B' });
    expect(stA.ok && stA.snapshot.panelId).toBe('panel-A');
    expect(stA.ok && stA.snapshot.bindingId).toBeTruthy();
    expect(stB.ok && stB.snapshot.bindingId).toBeNull();
    expect(stB.ok && stB.snapshot.state).toBe('idle');
  });
});

describe('OPEN-1 · layout.requestActivate (plugin-only outbound)', () => {
  function installMockWindow() {
    const handlerMap = new Map<string, Set<EventListener>>();
    const win = {
      addEventListener(type: string, handler: EventListener) {
        if (!handlerMap.has(type)) handlerMap.set(type, new Set());
        handlerMap.get(type)!.add(handler);
      },
      removeEventListener(type: string, handler: EventListener) {
        handlerMap.get(type)?.delete(handler);
      },
      dispatchEvent(event: Event): boolean {
        const name = (event as { type: string }).type;
        const detail = (event as { detail?: unknown }).detail;
        for (const h of handlerMap.get(name) ?? []) {
          h({ type: name, detail } as unknown as Event);
        }
        return true;
      },
    };
    (globalThis as { window?: typeof win }).window = win;
    return () => {
      delete (globalThis as { window?: typeof win }).window;
    };
  }

  it('requestActivate dispatches CustomEvent with panelId + reason; no host.activate', () => {
    const uninstall = installMockWindow();
    const client = new MockNativeHostClient();
    setHostClient(client);
    const seen: unknown[] = [];
    const w = (globalThis as { window: { addEventListener: Function } }).window;
    w.addEventListener(
      LAYOUT_REQUEST_ACTIVATE,
      ((e: Event) => {
        seen.push((e as unknown as { detail: unknown }).detail);
      }) as EventListener,
    );

    expect(requestActivate('panel-A', 'user-enter')).toBe(true);
    expect(requestActivate('panel-A', 'panel-focus')).toBe(true);
    uninstall();

    expect(seen).toEqual([
      { panelId: 'panel-A', reason: 'user-enter' },
      { panelId: 'panel-A', reason: 'panel-focus' },
    ]);
    expect(client.calls.some((c) => String(c.method).includes('activate'))).toBe(false);
    expect(LAYOUT_REQUEST_ACTIVATE).toBe('layout.requestActivate');
  });

  it('product view/actions do not emit other layout.* ; requestActivate is the only outbound', () => {
    const viewSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/NativeAppHostView.tsx'),
      'utf8',
    );
    const actionsSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/actions.ts'),
      'utf8',
    );
    expect(viewSrc).toMatch(/requestActivate/);
    expect(viewSrc).not.toMatch(/emitLayoutEvent/);
    expect(actionsSrc).not.toMatch(/emitLayoutEvent/);
    expect(viewSrc).not.toMatch(/host\.activate|NATIVE_HOST_IPC\.activate/);
    expect(actionsSrc).not.toMatch(/host\.activate|requestActivate/);
  });
});

describe('N-1 · panel-focus only on focus enter from outside', () => {
  function fakeNode(id: string, containsIds: string[] = []) {
    const node = {
      id,
      nodeType: 1,
      contains(other: { id?: string } | null) {
        return !!other && containsIds.includes(String(other.id));
      },
    };
    return node as unknown as EventTarget;
  }

  it('outside enter → true; intra-panel move → false; unbound → false', () => {
    const childBtn = fakeNode('btn');
    const otherChild = fakeNode('btn2');
    const container = fakeNode('root', ['btn', 'btn2']);
    const outside = fakeNode('outside');

    expect(
      shouldRequestPanelFocus({
        bound: true,
        container,
        relatedTarget: null,
      }),
    ).toBe(true);

    expect(
      shouldRequestPanelFocus({
        bound: true,
        container,
        relatedTarget: outside,
      }),
    ).toBe(true);

    // button → button inside panel: relatedTarget is previous focus inside container
    expect(
      shouldRequestPanelFocus({
        bound: true,
        container,
        relatedTarget: childBtn,
      }),
    ).toBe(false);
    expect(
      shouldRequestPanelFocus({
        bound: true,
        container,
        relatedTarget: otherChild,
      }),
    ).toBe(false);

    expect(
      shouldRequestPanelFocus({
        bound: false,
        container,
        relatedTarget: null,
      }),
    ).toBe(false);

    expect(
      shouldRequestPanelFocus({
        bound: true,
        container: null,
        relatedTarget: null,
      }),
    ).toBe(false);
  });

  it('view uses shouldRequestPanelFocus for onFocus (not blind panel-focus)', () => {
    const viewSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/NativeAppHostView.tsx'),
      'utf8',
    );
    expect(viewSrc).toMatch(/shouldRequestPanelFocus/);
    expect(viewSrc).toMatch(/relatedTarget/);
    expect(viewSrc).not.toMatch(/if \(bound\) requestActivate\(panelId, 'panel-focus'\)/);
  });
});

describe('Amy 03 · pending activation on restore', () => {
  it('restore → pending + idle + needsReselect; never interacting; serialize omits activation', () => {
    const restored = restoreNativeAppHostState(
      toPersistPayload({ hostPath: FAKE_NPP.path, titleHint: FAKE_NPP.title }),
    );
    expect(restored.activation).toBe('pending');
    expect(isPendingActivation(restored)).toBe(true);
    expect(restored.interaction).toBe('idle');
    expect(restored.interaction).not.toBe('interacting');
    expect(restored.bindingId).toBeNull();
    expect(restored.needsReselect).toBe(true);
    expect(restored.hostPath).toBe(FAKE_NPP.path);

    const ser = serializeNativeAppHostState(restored);
    expect(ser).not.toHaveProperty('activation');
    expect(ser).not.toHaveProperty('bindingId');

    // attached event must not auto-promote restore idle→interacting
    expect(reduceInteraction('idle', { type: 'attached' })).toBe('attached');
    expect(reduceInteraction('attached', { type: 'attached' })).toBe('attached');
  });

  it('empty / restore paths do not imply requestActivate; view mount does not auto-activate', () => {
    expect(emptyViewState().activation).toBe('pending');
    expect(restoreNativeAppHostState({}).activation).toBe('pending');

    const viewSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/NativeAppHostView.tsx'),
      'utf8',
    );
    // reportReady mount effect must not call requestActivate
    expect(viewSrc).toMatch(/reportReady/);
    const readyIdx = viewSrc.indexOf('reportReady?.()');
    const slice = viewSrc.slice(Math.max(0, readyIdx - 80), readyIdx + 120);
    expect(slice).not.toMatch(/requestActivate/);
    // restore helper file has no requestActivate
    const persistSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/persistView.ts'),
      'utf8',
    );
    expect(persistSrc).not.toMatch(/requestActivate\s*\(/);
  });
});

describe('Amy 03 · exit interaction when content-only ends', () => {
  it('contentOnly true→false: interacting → attached; false→true does not force change', () => {
    expect(interactionAfterLayoutChrome('interacting', true, false)).toBe('attached');
    expect(interactionAfterLayoutChrome('attached', true, false)).toBe('attached');
    expect(interactionAfterLayoutChrome('idle', true, false)).toBe('idle');
    // entering content-only: leave interaction alone
    expect(interactionAfterLayoutChrome('interacting', false, true)).toBe('interacting');
    expect(interactionAfterLayoutChrome('attached', false, true)).toBe('attached');
  });

  it('chromeVisibility contentOnly end updates via reduce path; no exit CustomEvent emit', () => {
    let s = emptyLayoutUiState();
    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.chromeVisibilityChanged,
      detail: {
        visibility: {},
        contentOnly: true,
        reason: 'content-only',
      },
    });
    expect(s.contentOnly).toBe(true);
    const next = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.chromeVisibilityChanged,
      detail: {
        visibility: { 'chrome.menu': true },
        contentOnly: false,
        reason: 'content-only',
      },
    });
    expect(next.contentOnly).toBe(false);
    expect(interactionAfterLayoutChrome('interacting', s.contentOnly, next.contentOnly)).toBe(
      'attached',
    );

    const viewSrc = readFileSync(
      resolve(__dirname, '../src/renderer/plugins/native-app-host/NativeAppHostView.tsx'),
      'utf8',
    );
    expect(viewSrc).toMatch(/interactionAfterLayoutChrome/);
    // Must not invent exit CustomEvent names
    expect(viewSrc).not.toMatch(/layout\.exit|requestDeactivate|exitInteraction.*dispatchEvent/);
    expect(viewSrc).toMatch(/LAYOUT_EVENTS\.chromeVisibilityChanged/);
  });
});

describe('L2 · hostPanelLayoutSync + native-visible (HOST-REPORT-0031)', () => {
  beforeEach(() => {
    resetDisplayCacheForTests();
  });

  it('rejects empty displays array (no silent scale=1)', () => {
    const r = hostPanelLayoutSync({
      panelId: 'p1',
      bounds: { x: 0, y: 0, w: 100, h: 100 },
      displays: [],
    });
    expect(r).toMatchObject({ ok: false, code: 'EMPTY_DISPLAYS' });
  });

  it('uses scaleFactor 1.25 from displays and writes data-scale-factor on root', () => {
    const root = {
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: string) {
        this.attrs[k] = v;
      },
    };
    const displays = [
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 1.25,
      },
    ];
    const r = hostPanelLayoutSync({
      panelId: 'p1',
      bounds: { x: 10, y: 10, w: 800, h: 600 },
      displays,
      root: root as unknown as Element,
    });
    expect(r).toEqual({ ok: true, scaleFactor: 1.25, displaysUsed: 1 });
    expect(root.attrs['data-scale-factor']).toBe('1.25');
  });

  it('prefers bounds.scaleFactor when present', () => {
    const r = hostPanelLayoutSync({
      panelId: 'p1',
      bounds: { x: 0, y: 0, w: 10, h: 10, scaleFactor: 1.5 },
      displays: [
        { bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1.25 },
      ],
    });
    expect(r.ok && r.scaleFactor).toBe(1.5);
  });

  it('resolveDisplays never returns empty', () => {
    expect(resolveDisplays().length).toBeGreaterThanOrEqual(1);
    expect(resolveDisplays({ displays: [] }).length).toBeGreaterThanOrEqual(1);
    cacheDisplaysFromLayout([
      { bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 1.25 },
    ]);
    const cached = resolveDisplays();
    expect(cached[0]!.scaleFactor).toBe(1.25);
  });

  it('nativeVisible true after attach and not occluded; false when occluded; placeholder does not block when visible', () => {
    expect(nativeVisibleAttr({ bound: true, occluded: false })).toBe('true');
    expect(nativeVisibleAttr({ bound: true, occluded: true })).toBe('false');
    expect(nativeVisibleAttr({ bound: false, occluded: false })).toBe('false');
    expect(placeholderBlocksPointer({ nativeVisible: true })).toBe(false);
    expect(placeholderBlocksPointer({ nativeVisible: false })).toBe(true);
  });

  it('displaysChanged caches list for resolveDisplays', () => {
    let s = emptyLayoutUiState();
    s = reduceLayoutUi(s, {
      name: LAYOUT_EVENTS.displaysChanged,
      detail: {
        displays: [
          { id: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
        ],
      },
    });
    expect(s.displays[0]!.scaleFactor).toBe(1.25);
    expect(resolveDisplays()[0]!.scaleFactor).toBe(1.25);
  });
});

describe('L2 · __kbNativePanels resting visibility (setVisible path)', () => {
  beforeEach(() => {
    resetNativePanelsForTests();
  });

  it('restingShouldShow true only when bound and not occluded', () => {
    expect(restingShouldShow({ bound: true, occluded: false })).toBe(true);
    expect(restingShouldShow({ bound: true, occluded: true })).toBe(false);
    expect(restingShouldShow({ bound: false, occluded: false })).toBe(false);
  });

  it('upsert publishes attached+shouldShow for layout getPanels', () => {
    upsertNativePanel({
      id: 'panel-a',
      layout: { x: 10, y: 20, w: 800, h: 600 },
      attached: true,
      shouldShow: true,
    });
    const list = listNativePanels();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: 'panel-a',
      attached: true,
      shouldShow: true,
      layout: { x: 10, y: 20, w: 800, h: 600 },
    });
    const g = globalThis as unknown as Record<string, unknown>;
    expect(Array.isArray(g[NATIVE_PANELS_HOOK])).toBe(true);
  });

  it('detach / remove clears so layout stops setVisible(true)', () => {
    upsertNativePanel({
      id: 'panel-a',
      layout: { x: 0, y: 0, w: 1, h: 1 },
      attached: true,
      shouldShow: true,
    });
    upsertNativePanel({
      id: 'panel-a',
      layout: { x: 0, y: 0, w: 1, h: 1 },
      attached: false,
      shouldShow: false,
    });
    expect(listNativePanels()[0]).toMatchObject({ attached: false, shouldShow: false });
    removeNativePanel('panel-a');
    expect(listNativePanels()).toHaveLength(0);
  });
});
