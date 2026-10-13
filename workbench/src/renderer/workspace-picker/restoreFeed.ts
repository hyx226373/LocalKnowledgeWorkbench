/**
 * 恢复条的订阅层。阶段只走 restorePhase。
 * 没有事件就不推进。不读时钟。外部程序只在「打开」之后才调用注入的 appLaunch。
 * 原生 attach / document 固定为未接入（integLinked false → not-in-integ）。
 */
import { keepOverviewForEmptyLibrary } from './mount';
import { restorePhase } from '../../shared/workspacePicker/restore';
import type { RestoreEvent, RestoreSource, WebPhaseEvent } from '../../shared/workspacePicker/types';

export type RestorePanelKind = 'file' | 'web' | 'app' | 'native-host' | 'unknown';

export interface RestorePanelRef {
  panelId: string;
  kind: RestorePanelKind;
  /** 适配器声明了 reportsReady 时才可能变成 restored。 */
  reportsReady?: boolean;
  /** 气泡或面板上的显示名。不写 unknown。 */
  title?: string;
}

export interface FileResource {
  missing?: boolean;
  /** 找不到时给界面的短原因，不含「找不到：」前缀。 */
  missingReason?: string;
  rootName?: string;
  /** false：根不在当前工作区。缺省表示没有这条信息。 */
  rootInWorkspace?: boolean;
  switchWorkspaceId?: string;
  /** 文件还在，重试应打开或聚焦。 */
  openFailed?: boolean;
}

export interface AppLaunchResult {
  ok?: boolean;
  failure?: string;
  reason?: string;
}

export interface RestoreFeedPorts {
  /** 仅在 armed 之后调用。缺省则不取资源。 */
  getResource?: (panelId: string) => Promise<FileResource | null> | FileResource | null;
  /** 内容就绪。不是挂载帧。 */
  onContentReady?: (panelId: string, cb: () => void) => () => void;
  onArmed?: (panelId: string, cb: (armed: boolean) => void) => () => void;
  onWebEvent?: (panelId: string, cb: (event: WebPhaseEvent) => void) => () => void;
  webHasView?: (panelId: string) => boolean;
  /** 缺省时点「打开」也不假装已启动。 */
  appLaunch?: (panelId: string) => Promise<AppLaunchResult> | AppLaunchResult;
  onLayoutApplied?: (panelId: string, cb: () => void) => () => void;
  /** 测试可注入。本模块不读取，时间不能改变阶段。 */
  now?: () => number;
  /** 文件还在时，重试打开或聚焦这个面板。 */
  openPanel?: (panelId: string) => void;
  locateFile?: (panelId: string) => void;
  remapFile?: (panelId: string) => void;
  switchWorkspace?: (workspaceId: string) => void;
}

export interface RestoreFeedInput {
  workspaceId: string;
  panels: readonly RestorePanelRef[];
  ports?: RestoreFeedPorts;
  /** workspace.retryPanel：只给界面，不进桥。 */
  retryPanel?: (workspaceId: string, panelId: string) => void;
}

export interface RestoreBarRow {
  event: RestoreEvent;
  kind: RestorePanelKind;
  title?: string;
  retryDisabled: boolean;
  showOpen: boolean;
  file?: FileResource;
}

export interface RestoreFeedSnapshot {
  workspaceId: string;
  rows: RestoreBarRow[];
}

export interface RestoreFeed {
  getSnapshot(): RestoreFeedSnapshot;
  subscribe(listener: () => void): () => void;
  openApp(panelId: string): void;
  retryPanel(panelId: string): void;
  /** 挂载帧信号。不把它写成 contentReady。 */
  notifyReadyOnMount(panelId: string): void;
  switchWorkspace(next: RestoreFeedInput): void;
  dispose(): void;
}

interface Slot {
  panelId: string;
  kind: RestorePanelKind;
  title?: string;
  reportsReady: boolean;
  sawArmed: boolean;
  armed: boolean;
  resource: FileResource | null | undefined;
  contentReady: boolean;
  readyOnMount: boolean;
  webEvents: WebPhaseEvent[];
  webHasView: boolean | undefined;
  sawWeb: boolean;
  opened: boolean;
  crashed: boolean;
  exited: boolean;
  launch: AppLaunchResult | null;
  launching: boolean;
  layoutApplied: boolean;
}

/** 没有已保存工作区（欢迎页或仅临时现场）或还没有工作区 id 时不挂恢复条，避免落库。 */
export function shouldMountRestoreBar(savedCount: number, temporary: boolean, workspaceId: string | null | undefined): boolean {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) return false;
  if (savedCount <= 0) return false;
  return !keepOverviewForEmptyLibrary(savedCount, temporary);
}

export function restorePanelsFromItems(
  items: Readonly<Record<string, { itemId?: string; sourceKind?: string } | undefined>>,
): RestorePanelRef[] {
  const out: RestorePanelRef[] = [];
  const seen = new Set<string>();
  for (const item of Object.values(items)) {
    if (!item || typeof item.itemId !== 'string' || !item.itemId || seen.has(item.itemId)) continue;
    if (item.sourceKind !== 'file' && item.sourceKind !== 'web' && item.sourceKind !== 'app') continue;
    seen.add(item.itemId);
    out.push({ panelId: item.itemId, kind: item.sourceKind });
  }
  return out;
}

export function restorePanelKey(panels: readonly RestorePanelRef[]): string {
  return panels.map((panel) => `${panel.panelId}\t${panel.kind}\t${panel.reportsReady === true ? 1 : 0}\t${panel.title ?? ''}`).join('\n');
}

function cleanRestoreTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const t = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!t || t === 'unknown') return undefined;
  return t.slice(0, 200);
}

function normalizePanels(panels: readonly RestorePanelRef[]): RestorePanelRef[] {
  const seen = new Set<string>();
  const out: RestorePanelRef[] = [];
  for (const panel of panels) {
    if (!panel || typeof panel.panelId !== 'string' || !panel.panelId || seen.has(panel.panelId)) continue;
    if (panel.kind !== 'file' && panel.kind !== 'web' && panel.kind !== 'app' && panel.kind !== 'native-host' && panel.kind !== 'unknown') continue;
    seen.add(panel.panelId);
    const title = cleanRestoreTitle(panel.title);
    out.push({ panelId: panel.panelId, kind: panel.kind, reportsReady: panel.reportsReady === true, ...(title ? { title } : {}) });
  }
  return out;
}

function blankSlot(panel: RestorePanelRef): Slot {
  return {
    panelId: panel.panelId,
    kind: panel.kind,
    title: panel.title,
    reportsReady: panel.reportsReady === true,
    sawArmed: false,
    armed: false,
    resource: undefined,
    contentReady: false,
    readyOnMount: false,
    webEvents: [],
    webHasView: undefined,
    sawWeb: false,
    opened: false,
    crashed: false,
    exited: false,
    launch: null,
    launching: false,
    layoutApplied: false,
  };
}

function isThenable<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}

function fileSource(slot: Slot): RestoreSource | null {
  if (!slot.sawArmed && slot.resource === undefined && !slot.contentReady && !slot.readyOnMount) return null;
  const source: Extract<RestoreSource, { kind: 'file' }> = { kind: 'file' };
  if (slot.sawArmed) source.armed = slot.armed;
  if (slot.resource === undefined && slot.sawArmed) source.resource = null;
  else if (slot.resource !== undefined) source.resource = slot.resource;
  if (slot.reportsReady) source.reportsReady = true;
  if (slot.contentReady) source.contentReady = true;
  if (slot.readyOnMount) source.readyOnMount = true;
  return source;
}

function webSource(slot: Slot): RestoreSource | null {
  if (!slot.sawWeb && slot.webEvents.length === 0 && slot.webHasView === undefined) return null;
  const source: Extract<RestoreSource, { kind: 'web' }> = { kind: 'web', events: slot.webEvents.slice() };
  if (slot.webHasView !== undefined) source.hasView = slot.webHasView;
  else if (slot.webEvents.length > 0) source.hasView = true;
  return source;
}

function appSource(slot: Slot): RestoreSource {
  const source: Extract<RestoreSource, { kind: 'app' }> = { kind: 'app', opened: slot.opened };
  if (slot.crashed) source.crashed = true;
  if (slot.exited) source.exited = true;
  if (slot.launch) source.launch = slot.launch;
  return source;
}

function nativeSource(slot: Slot): RestoreSource {
  return { kind: 'native-host', layoutApplied: slot.layoutApplied, integLinked: false };
}

function sourceOf(slot: Slot): RestoreSource | null {
  switch (slot.kind) {
    case 'file':
      return fileSource(slot);
    case 'web':
      return webSource(slot);
    case 'app':
      return appSource(slot);
    case 'native-host':
      return nativeSource(slot);
    default:
      return null;
  }
}

/** 界面重试。不可重试时不调用。不写桥白名单。 */
export function workspaceRetryPanel(
  workspaceId: string,
  panelId: string,
  retryable: boolean,
  ui: ((workspaceId: string, panelId: string) => void) | undefined,
): void {
  if (!retryable) return;
  ui?.(workspaceId, panelId);
}

export function createRestoreFeed(input: RestoreFeedInput): RestoreFeed {
  let generation = 1;
  let disposed = false;
  let workspaceId = input.workspaceId;
  let ports: RestoreFeedPorts = input.ports ?? {};
  let retryCb = input.retryPanel;
  let slots = normalizePanels(input.panels).map(blankSlot);
  let unsubs: Array<() => void> = [];
  const pulled = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: RestoreFeedSnapshot = { workspaceId, rows: [] };

  function find(panelId: string, kind?: RestorePanelKind): Slot | undefined {
    return slots.find((slot) => slot.panelId === panelId && (kind === undefined || slot.kind === kind));
  }

  function build(): RestoreFeedSnapshot {
    return {
      workspaceId,
      rows: slots.map((slot) => {
        const event = restorePhase({ workspaceId, panelId: slot.panelId, source: sourceOf(slot) ?? { kind: 'none' } });
        const file = slot.kind === 'file' && slot.resource && typeof slot.resource === 'object' ? slot.resource : undefined;
        return {
          event,
          kind: slot.kind,
          title: slot.title,
          retryDisabled: !event.retryable,
          showOpen: slot.kind === 'app',
          ...(file ? { file } : {}),
        };
      }),
    };
  }

  function publish(): void {
    if (disposed) return;
    snapshot = build();
    for (const listener of [...listeners]) listener();
  }

  function dropSubs(): void {
    const list = unsubs;
    unsubs = [];
    for (const unsub of list) {
      try {
        unsub();
      } catch {
        /* 旧端口取消失败不挡住新订阅 */
      }
    }
  }

  function applyResource(panelId: string, gen: number, value: FileResource | null): void {
    if (gen !== generation || disposed) return;
    const slot = find(panelId, 'file');
    if (!slot) return;
    slot.resource = value ?? { missing: true };
    publish();
  }

  function pullResource(panelId: string, gen: number, port: RestoreFeedPorts): void {
    if (!port.getResource || pulled.has(panelId)) return;
    pulled.add(panelId);
    let result: Promise<FileResource | null> | FileResource | null;
    try {
      result = port.getResource(panelId);
    } catch {
      applyResource(panelId, gen, null);
      return;
    }
    if (isThenable(result)) {
      void result.then(
        (value) => applyResource(panelId, gen, value),
        () => applyResource(panelId, gen, null),
      );
      return;
    }
    applyResource(panelId, gen, result);
  }

  function markArmed(panelId: string, armed: boolean, gen: number, port: RestoreFeedPorts): void {
    if (gen !== generation || disposed) return;
    const slot = find(panelId, 'file');
    if (!slot) return;
    slot.sawArmed = true;
    slot.armed = armed;
    publish();
    if (armed) pullResource(panelId, gen, port);
  }

  function markContentReady(panelId: string, gen: number): void {
    if (gen !== generation || disposed) return;
    const slot = find(panelId, 'file');
    if (!slot) return;
    slot.contentReady = true;
    publish();
  }

  function bind(gen: number, port: RestoreFeedPorts): void {
    for (const slot of slots) {
      if (slot.kind === 'file') {
        if (port.onArmed) {
          unsubs.push(
            port.onArmed(slot.panelId, (armed) => {
              if (gen !== generation) return;
              markArmed(slot.panelId, armed === true, gen, port);
            }),
          );
        }
        if (slot.reportsReady && port.onContentReady) {
          unsubs.push(
            port.onContentReady(slot.panelId, () => {
              if (gen !== generation) return;
              markContentReady(slot.panelId, gen);
            }),
          );
        }
      } else if (slot.kind === 'web') {
        if (port.webHasView) {
          slot.webHasView = port.webHasView(slot.panelId);
          slot.sawWeb = true;
        }
        if (port.onWebEvent) {
          unsubs.push(
            port.onWebEvent(slot.panelId, (event) => {
              if (gen !== generation || disposed) return;
              if (!event || typeof event !== 'object') return;
              const current = find(slot.panelId, 'web');
              if (!current) return;
              current.webEvents.push({ ...event });
              current.sawWeb = true;
              if (current.webHasView === undefined) current.webHasView = true;
              publish();
            }),
          );
        }
      } else if (slot.kind === 'native-host' && port.onLayoutApplied) {
        unsubs.push(
          port.onLayoutApplied(slot.panelId, () => {
            if (gen !== generation || disposed) return;
            const current = find(slot.panelId, 'native-host');
            if (!current) return;
            current.layoutApplied = true;
            publish();
          }),
        );
      }
    }
  }

  function applyLaunch(panelId: string, gen: number, value: unknown): void {
    if (gen !== generation || disposed) return;
    const slot = find(panelId, 'app');
    if (!slot) return;
    slot.launching = false;
    slot.opened = true;
    if (!value || typeof value !== 'object') slot.launch = { ok: false, reason: 'failed' };
    else {
      const row = value as AppLaunchResult;
      slot.launch = { ok: row.ok, failure: row.failure, reason: row.reason };
    }
    publish();
  }

  function load(next: RestoreFeedInput): void {
    generation += 1;
    dropSubs();
    pulled.clear();
    workspaceId = next.workspaceId;
    ports = next.ports ?? {};
    retryCb = next.retryPanel;
    slots = normalizePanels(next.panels).map(blankSlot);
    bind(generation, ports);
    publish();
  }

  bind(generation, ports);
  snapshot = build();

  return {
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openApp(panelId) {
      if (disposed) return;
      const gen = generation;
      const slot = find(panelId, 'app');
      if (!slot || slot.launching) return;
      const launch = ports.appLaunch;
      if (!launch) return;
      slot.launching = true;
      let result: Promise<AppLaunchResult> | AppLaunchResult;
      try {
        result = launch(panelId);
      } catch {
        applyLaunch(panelId, gen, { ok: false, reason: 'failed' });
        return;
      }
      if (isThenable(result)) {
        void result.then(
          (value) => applyLaunch(panelId, gen, value),
          () => applyLaunch(panelId, gen, { ok: false, reason: 'failed' }),
        );
        return;
      }
      applyLaunch(panelId, gen, result);
    },
    retryPanel(panelId) {
      if (disposed) return;
      const row = snapshot.rows.find((item) => item.event.panelId === panelId);
      workspaceRetryPanel(workspaceId, panelId, !!row && !row.retryDisabled, retryCb);
    },
    notifyReadyOnMount(panelId) {
      if (disposed) return;
      const slot = find(panelId, 'file');
      if (!slot) return;
      slot.readyOnMount = true;
      publish();
    },
    switchWorkspace(next) {
      if (disposed) return;
      load(next);
    },
    dispose() {
      disposed = true;
      generation += 1;
      dropSubs();
      pulled.clear();
    },
  };
}
