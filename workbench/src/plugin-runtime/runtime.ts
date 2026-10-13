/**
 * 第三方适配器插件的沙箱 iframe 运行时（H4）。由宿主以 kbplugin://<pluginId>/__kb/runtime.js 提供，
 * 运行在 <iframe sandbox="allow-scripts">（无 allow-same-origin → 独立 null origin）里，CSP 禁止网络与 kbfile://res|root。
 *
 * 它把宿主的 postMessage 协议包装成 SDK 的 AdapterHostApi / OpenContext / MountTarget，然后 import 插件 main 并 activate。
 * 注意：运行时与插件代码在同一个 realm，插件可以篡改它——因此这里不做任何安全判断，全部检查都在宿主侧。
 */
import { restoreFromEnvelope } from '../shared/adapter-sdk/policy';
import { LIFECYCLE_TIMEOUT_MS, RPC_TIMEOUT_MS } from '../shared/sandboxProtocol';
import { hostTimeoutMessage, isPluginAccessCode, type RpcErrorCode } from '../shared/pluginIpc';
import type {
  AppProfile,
  ExternalMountTarget,
  LaunchRequest,
  LaunchResult,
  ProcessBrokerApi,
  ProcessHandleInfo,
  ProcessStatusEvent,
  ProgramDetection,
  AdapterContribution,
  AdapterHostApi,
  AdapterImplementation,
  AdapterInstance,
  AdapterPluginModule,
  FileHostApi,
  FileopsPlan,
  JsonValue,
  PermissionDenial,
  ReaderMountTarget,
  ThemeSnapshot,
  UiNode,
  WebMountTarget,
  WebPanelHandle,
  WorkspaceItem,
} from '../shared/adapter-sdk/types';

const FRAME = 'kb-frame';
const HOST = 'kb-host';
const post = (m: Record<string, unknown>) => parent.postMessage({ kb: FRAME, ...m }, '*');

/** r11-B：宿主下发的已绑定加速键；仅这些组合键回传宿主 */
let boundShortcuts = new Set<string>();
function accelFromDom(e: KeyboardEvent): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let key = e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code) && key.length === 1) key = e.code.slice(3);
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
  return [...order.filter((m) => mods.includes(m)), key].join('+');
}
addEventListener('keydown', (e) => {
  const a = accelFromDom(e);
  if (!a || !boundShortcuts.has(a)) return;
  e.preventDefault();
  e.stopPropagation();
  post({ type: 'shortcut', accelerator: a });
}, true);

class Emitter<T> {
  private ls = new Set<(e: T) => void>();
  event = (l: (e: T) => void) => {
    this.ls.add(l);
    return { dispose: () => void this.ls.delete(l) };
  };
  fire(e: T) {
    for (const l of [...this.ls]) {
      try {
        l(e);
      } catch (err) {
        post({ type: 'log', level: 'error', message: String((err as Error)?.stack ?? err) });
      }
    }
  }
}

let seq = 0;
const pending = new Map<number, { res: (v: unknown) => void; rej: (e: unknown) => void }>();
function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const id = ++seq;
  post({ type: 'rpc', id, method, params });
  // 逐次调用超时：宿主一直不回应时插件拿到 code='timeout' 的错误，而不是永远等待。
  // requestFileops 与 permissions.request 要等用户操作对话框，不设超时。
  const userFacing = method === 'files.requestFileops' || method === 'permissions.request';
  return new Promise<T>((res, rej) => {
    const timer = userFacing
      ? undefined
      : setTimeout(() => {
          if (!pending.delete(id)) return;
          rej(new HostPermissionError(hostTimeoutMessage(method, RPC_TIMEOUT_MS), 'timeout'));
        }, RPC_TIMEOUT_MS);
    pending.set(id, {
      res: (v) => (clearTimeout(timer), res(v as T)),
      rej: (e) => (clearTimeout(timer), rej(e)),
    });
  });
}

/** 生命周期调用超时（异步挂起的 activate/open/mount）；同步死循环由宿主心跳发现 */
function withTimeout<T>(p: Promise<T> | T, what: string): Promise<T> {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${what} 超过 ${LIFECYCLE_TIMEOUT_MS / 1000} 秒仍未完成`)), LIFECYCLE_TIMEOUT_MS);
    Promise.resolve(p).then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

export class HostPermissionError extends Error {
  constructor(
    message: string,
    readonly code: RpcErrorCode,
  ) {
    super(message);
    this.name = 'HostPermissionError';
  }
}

let theme: ThemeSnapshot = { id: '', colorScheme: 'light', tokens: {} };
const themeEm = new Emitter<ThemeSnapshot>();
const fileEm = new Emitter<{ resourceId: string; change: 'modified' | 'deleted' | 'moved' }>();
const impls = new Map<string, AdapterImplementation<any>>();
let manifest: AdapterPluginModule['manifest'] | null = null;
let instance: AdapterInstance<any> | null = null;
const actionHandlers = new Set<(a: string, p: JsonValue | undefined) => void>();
let perms: Record<string, 'granted' | 'denied' | 'prompt'> = {};

function applyTheme(t: ThemeSnapshot) {
  theme = t;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.tokens)) root.style.setProperty(`--kb-${k}`, v);
  root.style.colorScheme = t.colorScheme;
}

async function init(m: { pluginId: string; hostVersion: string; adapterApiVersion: string; phase: 1 | 2 | 3; manifest: AdapterPluginModule['manifest']; mainUrl: string; theme: ThemeSnapshot }) {
  manifest = m.manifest;
  applyTheme(m.theme);
  const api: AdapterHostApi = {
    pluginId: m.pluginId,
    hostVersion: m.hostVersion,
    adapterApiVersion: m.adapterApiVersion,
    phase: m.phase,
    adapters: {
      register(impl) {
        if (!manifest?.contributes.adapters.some((a) => a.id === impl.id)) throw new Error(`适配器 ${impl.id} 未在 manifest 中声明`);
        impls.set(impl.id, impl);
        return { dispose: () => void impls.delete(impl.id) };
      },
    },
    storage: {
      get: (key) => rpc('storage.get', { key }),
      set: (key, value) => rpc('storage.set', { key, value }),
      delete: (key) => rpc('storage.delete', { key }),
      keys: () => rpc('storage.keys'),
    },
    theme: { current: () => theme, onDidChange: themeEm.event },
    log: {
      info: (message) => post({ type: 'log', level: 'info', message: String(message) }),
      warn: (message) => post({ type: 'log', level: 'warn', message: String(message) }),
      error: (message) => post({ type: 'log', level: 'error', message: String(message) }),
    },
  };
  try {
    const mod = (await import(/* @vite-ignore */ m.mainUrl)) as { default?: AdapterPluginModule; activate?: AdapterPluginModule['activate'] };
    const plugin = (mod.default ?? mod) as AdapterPluginModule;
    if (typeof plugin?.activate !== 'function') throw new Error('插件 main 没有导出 activate（default 导出 { manifest, activate }）');
    await withTimeout(plugin.activate(api), 'activate()');
    post({ type: 'activated' });
  } catch (e) {
    post({ type: 'activate-error', message: String((e as Error)?.message ?? e) });
  }
}

function makeFiles(token: string, adapter: AdapterContribution): FileHostApi {
  const files: FileHostApi = {
    stat: (resourceId) => rpc('files.stat', { resourceId }),
    readText: (resourceId, opts) => rpc('files.readText', { resourceId, maxBytes: opts?.maxBytes }),
    readBytes: (resourceId, range) => rpc('files.readBytes', { resourceId, offset: range?.offset, length: range?.length }),
    contentUrl: (resourceId) => `kbfile://plugin/${token}/${encodeURIComponent(resourceId)}`,
    onDidChange: fileEm.event,
  };
  if (adapter.permissions.some((p) => p.kind === 'fileops.write')) files.requestFileops = (plan: FileopsPlan) => rpc('files.requestFileops', { plan: plan as unknown as Record<string, unknown> });
  return files;
}

let saveQueued = false;
function pushState() {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    if (!instance) return;
    try {
      post({ type: 'state', data: instance.getState() ?? null });
    } catch (e) {
      post({ type: 'log', level: 'warn', message: `getState 失败：${(e as Error)?.message}` });
    }
  });
}

// 网页面板事件（宿主 → 插件）：WebPanelHandle 的 onDidNavigate / onScroll / onBlocked / onLoadState
const webNav = new Emitter<{ url: string; inPage: boolean }>();
const webScroll = new Emitter<{ x: number; y: number }>();
const webBlocked = new Emitter<{ url: string; reason: 'domain-blocked' | 'scheme-blocked' | 'popup-blocked' | 'download-blocked' }>();
const webLoad = new Emitter<'loading' | 'ready' | 'failed'>();
let webUrl: string | null = null;

function makeWebHandle(info: { partition: string; allowedDomains: string[] }): WebPanelHandle {
  return {
    partition: String(info.partition),
    allowedDomains: Object.freeze([...(info.allowedDomains ?? [])].map(String)),
    navigate: (url) => rpc('web.navigate', { url: String(url) }),
    back: () => void rpc('web.back').catch(() => undefined),
    forward: () => void rpc('web.forward').catch(() => undefined),
    reload: () => void rpc('web.reload').catch(() => undefined),
    currentUrl: () => webUrl,
    getScroll: () => rpc('web.getScroll'),
    setScroll: (pos) => rpc<unknown>('web.setScroll', { x: Number(pos?.x) || 0, y: Number(pos?.y) || 0 }).then(() => undefined),
    onScroll: webScroll.event,
    onDidNavigate: webNav.event,
    onBlocked: webBlocked.event,
    onLoadState: webLoad.event,
    clearSessionData: (kinds) => rpc<unknown>('web.clearSessionData', { kinds: Array.isArray(kinds) ? kinds : undefined }).then(() => undefined),
  };
}

// 外部程序（H10）：ProcessBrokerApi.list() 是同步的——宿主在 open 时给出初始列表，之后用 process-status 推送更新
const procs = new Map<string, ProcessHandleInfo>();
const procEm = new Emitter<ProcessStatusEvent>();
function makeProcess(): ProcessBrokerApi {
  return {
    detect: (programId) => rpc<ProgramDetection>('process.detect', { programId: String(programId) }),
    launch: async (req: LaunchRequest) => {
      const r = await rpc<LaunchResult>('process.launch', { req: JSON.parse(JSON.stringify(req ?? {})) });
      if (r && r.ok) procs.set(r.handle.launchId, r.handle);
      return r;
    },
    focus: (launchId) => rpc<boolean>('process.focus', { launchId: String(launchId) }),
    close: (launchId, opts) => rpc<boolean>('process.close', { launchId: String(launchId), force: opts?.force === true }),
    list: () => [...procs.values()].map((h) => JSON.parse(JSON.stringify(h)) as ProcessHandleInfo),
    onStatus: procEm.event,
  };
}

async function open(m: {
  item: WorkspaceItem;
  adapter: AdapterContribution;
  state: unknown;
  permissions: Record<string, 'granted' | 'denied' | 'prompt'>;
  fileToken: string | null;
  panelId: string;
  web?: { partition: string; allowedDomains: string[] } | null;
  app?: { profile: AppProfile; processes: ProcessHandleInfo[]; granted: boolean } | null;
  /** 宿主保留的旧状态（R4）：插件版本变化后先用它再试一次 */
  preserved?: { v: number; data: unknown } | null;
}) {
  try {
    const impl = impls.get(m.adapter.id);
    if (!impl) throw new Error(`插件未注册适配器 ${m.adapter.id}`);
    perms = { ...m.permissions };
    let restored = restoreFromEnvelope(m.state ?? null, impl, m.adapter.stateSchemaVersion);
    let recovered = false;
    if (m.preserved) {
      const again = restoreFromEnvelope({ v: m.preserved.v, data: m.preserved.data } as never, impl, m.adapter.stateSchemaVersion);
      if (!again.reset) {
        restored = again;
        recovered = true;
      }
    }
    procs.clear();
    for (const h of m.app?.processes ?? []) procs.set(h.launchId, h);
    const fsGranted = m.adapter.permissions.some((p) => p.kind === 'fs.read' && perms[p.id] === 'granted');
    const ctx = {
      adapter: m.adapter,
      restoredState: restored.state,
      requestSave: pushState,
      permissions: {
        query: (id: string) => perms[id] ?? 'prompt',
        request: async (id: string) => {
          const r = await rpc<'granted' | 'denied'>('permissions.request', { id });
          perms[id] = r;
          return r;
        },
      },
      theme,
      files: m.item.sourceKind === 'file' && fsGranted && m.fileToken ? makeFiles(m.fileToken, m.adapter) : undefined,
      process: m.item.sourceKind === 'app' && m.app?.granted ? makeProcess() : undefined,
      appProfile: m.item.sourceKind === 'app' && m.app ? Object.freeze(JSON.parse(JSON.stringify(m.app.profile)) as AppProfile) : undefined,
    };
    instance = await withTimeout(impl.open(m.item, ctx), 'open()');
    const setTitle = (title: string) => post({ type: 'set-title', title: String(title) });
    const uiTarget = {
      panelId: m.panelId,
      setTitle,
      render: (node: UiNode) => post({ type: 'render', node: JSON.parse(JSON.stringify(node)) }),
      onAction: (h: (a: string, p: JsonValue | undefined) => void) => {
        actionHandlers.add(h);
        return { dispose: () => void actionHandlers.delete(h) };
      },
    };
    const target: ReaderMountTarget | WebMountTarget | ExternalMountTarget = m.web
      ? { kind: 'web', panelId: m.panelId, setTitle, web: makeWebHandle(m.web) }
      : m.item.sourceKind === 'app'
        ? { kind: 'external', ...uiTarget }
        : {
          kind: 'reader',
          panelId: m.panelId,
          setTitle,
          render: (node: UiNode) => post({ type: 'render', node: JSON.parse(JSON.stringify(node)) }),
          onAction: (h) => {
            actionHandlers.add(h);
            return { dispose: () => void actionHandlers.delete(h) };
          },
        };
    await withTimeout(instance.mount(target), 'mount()');
    post({ type: 'opened', reset: restored.reset, recovered });
  } catch (e) {
    post({ type: 'open-error', message: String((e as Error)?.message ?? e) });
  }
}

addEventListener('message', (e: MessageEvent) => {
  if (e.source !== parent) return;
  const m = e.data as Record<string, any>;
  if (!m || m.kb !== HOST) return;
  switch (m.type) {
    case 'ping':
      post({ type: 'pong', seq: Number(m.seq) | 0 });
      break;
    case 'bound-shortcuts':
      boundShortcuts = new Set(Array.isArray(m.keys) ? m.keys.map(String) : []);
      break;
    case 'init':
      void init(m as any);
      break;
    case 'open':
      void open(m as any);
      break;
    case 'rpc-result': {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.res(m.value);
      else p.rej(new HostPermissionError(String(m.error?.message ?? '宿主拒绝了该调用'), isPluginAccessCode(m.error?.code) ? m.error.code : 'error'));
      break;
    }
    case 'action':
      for (const h of [...actionHandlers]) {
        try {
          h(String(m.action), m.payload);
        } catch (err) {
          post({ type: 'log', level: 'error', message: String((err as Error)?.stack ?? err) });
        }
      }
      break;
    case 'theme':
      applyTheme(m.theme);
      themeEm.fire(m.theme);
      try {
        instance?.onThemeChange?.(m.theme);
      } catch {
        /* 主题回调失败不影响面板 */
      }
      break;
    case 'permission-denied': {
      const d = m.denial as PermissionDenial;
      perms[d.permissionId] = 'denied';
      try {
        instance?.onPermissionDenied?.(d);
      } catch {
        /* 降级显示失败不影响宿主 */
      }
      break;
    }
    case 'web-event': {
      const ev = m.event as Record<string, any>;
      if (!ev) break;
      if (ev.type === 'navigate') {
        webUrl = String(ev.url);
        webNav.fire({ url: webUrl, inPage: ev.inPage === true });
      } else if (ev.type === 'scroll') webScroll.fire({ x: Number(ev.x) || 0, y: Number(ev.y) || 0 });
      else if (ev.type === 'blocked') webBlocked.fire({ url: String(ev.url), reason: ev.reason });
      else if (ev.type === 'load') webLoad.fire(ev.state === 'ready' || ev.state === 'failed' ? ev.state : 'loading');
      break;
    }
    case 'process-status': {
      const h = m.handle as ProcessHandleInfo;
      if (!h || typeof h.launchId !== 'string') break;
      procs.set(h.launchId, h);
      procEm.fire({ launchId: h.launchId, status: h.status, ...(h.exitCode !== undefined ? { exitCode: h.exitCode } : {}), window: h.window });
      break;
    }
    case 'file-change':
      fileEm.fire({ resourceId: String(m.resourceId), change: m.change });
      break;
    case 'get-state':
      pushState();
      break;
    case 'visibility':
      try {
        instance?.onVisibilityChange?.(m.visible === true);
      } catch {
        /* ignore */
      }
      break;
    case 'dispose':
      try {
        void instance?.dispose();
      } catch {
        /* ignore */
      }
      instance = null;
      actionHandlers.clear();
      break;
  }
});

post({ type: 'ready' });
