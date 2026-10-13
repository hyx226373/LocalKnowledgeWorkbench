/**
 * 第三方适配器面板（H4）：授权闸门 + 沙箱 iframe + postMessage RPC + UiNode 渲染。
 *
 * 顺序（SDK §5.1）：适配器解析（ViewHost）→ 阶段（ViewHost）→ 资源存在（ViewHost）→ 权限（这里：未询问则弹窗，必需权限被拒 → 占位）
 * → 范围预检（文件根/扩展名不在授权内 → 占位）→ 启动 iframe。
 * 安全边界：iframe 为 sandbox="allow-scripts"（null origin，无法访问父文档与 window.kb），CSP 禁网络；
 * 这里只接受 event.source === 本面板 iframe 的消息，插件身份取自面板所属插件；所有文件访问在主进程再按授权检查一次。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { pluginHost } from '../plugin-host/host';
import type { AdapterContribution as HostAdapter } from '../plugin-host/types';
import type { WorkspaceItem } from '../plugin-host/layoutModel';
import type { ResourceInfo } from '../../shared/types';
import { checkStateForSave } from '../../shared/adapter-sdk/policy';
import { ADAPTER_API_VERSION, type AdapterContribution, type JsonValue, type PermissionDecl, type PermissionDenial, type PlaceholderKind, type ThemeSnapshot, type UiNode } from '../../shared/adapter-sdk/types';
import { findGrant, fileScopeError, fsReadDecl, type GrantDecision } from '../../shared/grants';
import { HOST_API_VERSION, CURRENT_PHASE } from '../../shared/hostApi';
import { BUSY_MS, FLOOD_MAX_PER_SEC, HEARTBEAT_MS, HOST_MSG, LIFECYCLE_TIMEOUT_MS, RPC_TIMEOUT_MS, parseFrameMessage, sanitizeUiNode, type FrameToHost } from '../../shared/sandboxProtocol';
import { hostTimeoutMessage, isPluginAccessCode, parseAccessError, type PluginAccessCode } from '../../shared/pluginIpc';
import { TOKENS } from '../theme/contract';
import { UiNodeView } from './UiNodeView';
import { planDialog } from '../ui/adapterDialogs';
import { checkNavigation, displayModeLabel } from '../../shared/adapter-sdk/policy';
import { hostOf, navDomains, type WebEvent, type WebViewInfo } from '../../shared/webPanel';
import { WebSurface, initialWebUi, reduceWebUi, type WebUiState } from './WebSurface';
import { pushPreserved, type ItemState, type PreservedState } from '../../shared/items';
import type { AppChangesEvent, AppProfile, ProcessHandleInfo } from '../../shared/appIpc';
import { dialogs } from '../ui/dialogs';
import { getKeybindingsStore, listBoundAccelerators, runByAccelerator, subscribeKeybindings } from '../keybindings';
import { commands } from '../plugin-host/registry';
// ---- r11-A 网络资料：逐站授权（SDK 修订 10）与网页面板工具条动作
import { siteHostOf } from '../../shared/adapter-sdk/policy';
import { siteAccess, perSiteDecl } from '../web-resources/siteAccess';
import { addToRefs, copyUrl, registerLiveWebView, saveToLocal } from '../web-resources/webActions';
import { sanitizeWebRef } from '../../shared/webResources';
// ---- r11-A 网络资料 end

export function themeSnapshot(): ThemeSnapshot {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const t of TOKENS) tokens[t.name] = cs.getPropertyValue(`--kb-${t.name}`).trim();
  const scheme = root.dataset.kbScheme === 'dark' ? 'dark' : 'light';
  return { id: `${root.dataset.kbChrome ?? ''}/${root.dataset.kbReading ?? ''}/${scheme}`, colorScheme: scheme, tokens };
}

/** 同一插件的进程被看门狗终止时，通知该插件的其他面板（它们在同一个进程里，也一起停止） */
const killBus = new Set<(pluginIds: string[], reason: string) => void>();
/** 看门狗统计（e2e 与性能检查用） */
export const watchdogStats = { kills: [] as { pluginId: string; kind: string; detectedMs: number; at: number }[] };

/** 生命周期调用超时的错误消息（运行时 withTimeout 产生） */
const LIFECYCLE_TIMEOUT_RE = /超过 \d+ 秒仍未完成/;

type Gate =
  | { kind: 'prompt'; perm: PermissionDecl; perms: Record<string, GrantDecision> }
  | { kind: 'placeholder'; reason: PlaceholderKind; detail: string; perms: Record<string, GrantDecision> }
  | { kind: 'ok'; perms: Record<string, GrantDecision> }
  // r11-A：逐站授权——条目所在网站尚未批准（denied = 本次运行中用户已拒绝）
  | { kind: 'site'; host: string; denied: boolean; perms: Record<string, GrantDecision> };

export function computeGate(pluginId: string, decl: AdapterContribution, res: ResourceInfo | null, sourceKind: string, ref?: string): Gate {
  const perms: Record<string, GrantDecision> = {};
  for (const p of decl.permissions) perms[p.id] = pluginHost.decision(pluginId, decl.id, p);
  // r11-A：逐站授权的 net 权限不弹插件级授权框（每个网站单独询问）；被撤销仍按拒绝处理
  const site = perSiteDecl(decl);
  const pending = decl.permissions.find((p) => perms[p.id] === 'prompt' && !p.optional && p !== site);
  if (pending) return { kind: 'prompt', perm: pending, perms };
  const denied = decl.permissions.find((p) => !p.optional && perms[p.id] === 'denied');
  if (denied) return { kind: 'placeholder', reason: 'permission-denied', detail: denied.reason, perms };
  const fs = fsReadDecl(decl);
  if (sourceKind === 'file' && res && fs && perms[fs.id] === 'granted') {
    const err = fileScopeError(findGrant(pluginHost.grantsOf(pluginId), pluginId, decl.id, fs.id), fs, res);
    if (err) return { kind: 'placeholder', reason: 'permission-denied', detail: `${fs.reason}（${err}）`, perms };
  }
  if (site && sourceKind === 'web' && ref !== undefined) {
    const host = siteHostOf(ref);
    if (!host) return { kind: 'placeholder', reason: 'domain-blocked', detail: `「${hostOf(ref)}」不能在应用内打开：只支持 http / https 网址，不支持 IP 地址、端口或本地文件`, perms };
    const st = siteAccess.status(pluginId, decl.id, site, host);
    if (st === 'granted') return { kind: 'ok', perms };
    return { kind: 'site', host, denied: st === 'session-denied', perms };
  }
  // 网页：条目地址必须在 net 域名内（运行中被拦截的导航只显示横幅，不换占位；SDK §10 domain-blocked）
  if (sourceKind === 'web' && ref !== undefined) {
    const domains = navDomains(decl);
    const r = checkNavigation(ref, domains);
    if (!r.ok) return { kind: 'placeholder', reason: 'domain-blocked', detail: `「${hostOf(ref)}」${r.reason === 'scheme-blocked' ? '不是 https 地址' : '不在允许的域名内'}；只允许 ${domains.join('、') || '（未声明）'}`, perms };
  }
  return { kind: 'ok', perms };
}

export interface SandboxPanelProps {
  item: WorkspaceItem;
  resource: ResourceInfo | null;
  adapter: HostAdapter;
  /** 含宿主保留的旧状态（R4，items.ts preserved）：保存时一起写回，不会被插件的新状态覆盖 */
  /** null = 回到默认状态（丢弃旧状态时插件还没保存过新状态） */
  onState(envelope: ItemState | null): void;
  onTitle(title: string): void;
  renderPlaceholder(kind: PlaceholderKind, detail: string | undefined, retry: () => void): React.ReactElement;
}

export function SandboxPanel(p: SandboxPanelProps) {
  const sb = p.adapter.sandbox!;
  const version = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.getVersion(),
  );
  const [session, setSession] = useState(0);
  const [fatal, setFatal] = useState<string | null>(null);
  const siteVersion = useSyncExternalStore(siteAccess.subscribe, siteAccess.getVersion); // r11-A
  const gate = useMemo(
    () => computeGate(sb.pluginId, sb.decl, p.resource, p.item.sourceKind, p.item.ref),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, siteVersion, sb.pluginId, sb.decl, p.resource, p.item.sourceKind, p.item.ref],
  );
  useEffect(() => {
    if (gate.kind === 'prompt') void pluginHost.ensurePermission(sb.pluginId, sb.decl, gate.perm, false, p.resource?.rootId);
  }, [gate, sb, p.resource?.rootId]);
  // ---- r11-A：条目所在网站尚未批准 → 首次打开时询问（本次运行已拒绝的不再自动询问）
  const siteHost = gate.kind === 'site' && !gate.denied ? gate.host : null;
  useEffect(() => {
    if (!siteHost) return;
    void siteAccess.ask({ pluginId: sb.pluginId, pluginName: sb.pluginName, adapterId: sb.decl.id, host: siteHost, url: p.item.ref, purpose: 'page' });
  }, [siteHost, sb, p.item.ref]);
  const retry = useCallback(() => {
    setFatal(null);
    setSession((n) => n + 1);
  }, []);

  if (gate.kind === 'prompt')
    return (
      <div className="kb-notice" data-testid="sandbox-waiting-permission">
        正在等待你决定是否授予「{sb.pluginName}」权限…
      </div>
    );
  if (gate.kind === 'site')
    return gate.denied ? (
      <div className="kb-site-gate" data-testid="site-denied" data-host={gate.host}>
        <div className="kb-sandbox-notice" role="status">
          你在本次运行中拒绝了访问 <b>{gate.host}</b>。
          <button
            className="kb-button kb-button--small"
            data-testid="site-allow-again"
            onClick={() => {
              siteAccess.forgetDenial(sb.pluginId, gate.host);
              void siteAccess.ask({ pluginId: sb.pluginId, pluginName: sb.pluginName, adapterId: sb.decl.id, host: gate.host, url: p.item.ref, purpose: 'page' });
            }}
          >
            允许访问此网站…
          </button>
        </div>
        {p.renderPlaceholder('domain-blocked', `未允许访问「${gate.host}」（逐站授权）；条目与引用已保留`, retry)}
      </div>
    ) : (
      <div className="kb-notice" data-testid="site-waiting" data-host={gate.host}>
        正在等待你决定是否允许访问 {gate.host}…
      </div>
    );
  if (gate.kind === 'placeholder') return p.renderPlaceholder(gate.reason, gate.detail, retry);
  if (fatal) return p.renderPlaceholder('adapter-error', fatal, retry);
  return <SandboxFrame key={session} {...p} perms={gate.perms} onFatal={setFatal} onReload={retry} />;
}

/** 宿主侧的逐次调用超时：需要用户操作的调用（授权、批量计划）不限时 */
function withHostTimeout<T>(method: string, p: Promise<T>, onTimeout: () => void): Promise<T> {
  if (method === 'files.requestFileops' || method === 'permissions.request') return p;
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => {
      onTimeout();
      rej(Object.assign(new Error(hostTimeoutMessage(method, RPC_TIMEOUT_MS)), { code: 'timeout' satisfies PluginAccessCode }));
    }, RPC_TIMEOUT_MS);
    p.then(
      (v) => (clearTimeout(t), res(v)),
      (e) => (clearTimeout(t), rej(e)),
    );
  });
}

/** 权限映射中的 prompt 只留给可选权限（必需权限到这里一定已授予） */
function SandboxFrame(p: SandboxPanelProps & { perms: Record<string, GrantDecision>; onFatal(msg: string): void; onReload(): void }) {
  const sb = p.adapter.sandbox!;
  const { pluginId, decl } = sb;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [ui, setUi] = useState<UiNode | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const permsRef = useRef(p.perms);
  permsRef.current = p.perms;
  const propsRef = useRef(p);
  propsRef.current = p;
  const dto = pluginHost.sandboxPlugin(pluginId);
  // ---- R5：插件升级后不自动重载已打开的面板（运行中的代码是挂载时的版本），只显示提示条
  const mountedVersion = useRef(dto ? `${dto.version}@${dto.installedAt}` : '');
  const upgraded = !!dto && mountedVersion.current !== '' && mountedVersion.current !== `${dto.version}@${dto.installedAt}`;
  // ---- R4：宿主兜底保留的旧状态
  const preservedRef = useRef<PreservedState | undefined>((p.item.state as ItemState | undefined)?.preserved);
  const [preserved, setPreserved] = useState<PreservedState | undefined>(preservedRef.current);
  const lastEnvelope = useRef<{ v: number; data: unknown } | undefined>(p.item.state ? { v: (p.item.state as ItemState).v, data: (p.item.state as ItemState).data } : undefined);
  const saveEnvelope = useCallback((env: { v: number; data: unknown }) => {
    lastEnvelope.current = env;
    propsRef.current.onState(preservedRef.current ? { ...env, preserved: preservedRef.current } : env);
  }, []);
  const discardPreserved = useCallback(() => {
    preservedRef.current = undefined;
    setPreserved(undefined);
    // 插件读不了旧状态后还没保存过新状态：条目里存的仍是那份旧状态，一起丢弃（回到默认状态）
    propsRef.current.onState(lastEnvelope.current ? { ...lastEnvelope.current } : null);
  }, []);
  // ---- 外部程序（H10–H12）：应用档案 + 进程列表；退出后的改动提示
  const isApp = p.item.sourceKind === 'app';
  const [app, setApp] = useState<{ profile: AppProfile; processes: ProcessHandleInfo[]; granted: boolean } | null | undefined>(isApp ? undefined : null);
  const [appChanges, setAppChanges] = useState<AppChangesEvent[]>([]);
  useEffect(() => {
    if (!isApp) return;
    let alive = true;
    const granted = decl.permissions.some((x) => x.kind === 'process.launch' && p.perms[x.id] === 'granted');
    Promise.all([kb.appProfileGet(p.item.ref), kb.appList(pluginId, p.item.itemId).catch(() => [] as ProcessHandleInfo[]), kb.appPendingChanges(p.item.itemId).catch(() => [] as AppChangesEvent[])]).then(
      ([profile, procs, pending]) => {
        if (!alive) return;
        if (!profile) return propsRef.current.onFatal(`找不到此项目的应用档案（${p.item.ref}），请删除此项目后重新创建`);
        setApp({ profile, processes: procs, granted });
        setAppChanges(pending);
      },
      (e) => alive && propsRef.current.onFatal(`无法读取应用档案：${parseAccessError(e).message}`),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isApp, pluginId, p.item.ref, p.item.itemId]);
  const fsGranted = decl.permissions.some((x) => x.kind === 'fs.read' && p.perms[x.id] === 'granted');
  const post = useCallback((m: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ kb: HOST_MSG, ...m }, '*');
  }, []);
  const [ready, setReady] = useState(false);
  const lastPong = useRef(0);
  const killedRef = useRef(false);
  const openSentAt = useRef(0);
  const openedRef = useRef(false);
  // ---- 网页面板（H9）：主进程 WebContentsView，由本面板创建与销毁
  const isWeb = p.item.sourceKind === 'web';
  const viewId = useMemo(() => `wv-${p.item.itemId}-${Math.random().toString(36).slice(2, 10)}`, [p.item.itemId]);
  const [webInfo, setWebInfo] = useState<WebViewInfo | undefined>(undefined);
  const [webUi, setWebUi] = useState<WebUiState>(initialWebUi);
  useEffect(() => {
    if (!isWeb) return;
    let alive = true;
    kb.webCreate(viewId, pluginId, decl.id).then(
      (info) => alive && setWebInfo(info),
      (e) => alive && propsRef.current.onFatal(`无法创建网页面板：${parseAccessError(e).message}`),
    );
    return () => {
      alive = false;
      void kb.webDestroy(viewId).catch(() => undefined);
    };
  }, [isWeb, viewId, pluginId, decl.id]);

  /**
   * 看门狗动作：终止插件进程（主进程按 pid 杀掉独立的插件渲染进程）→ 写审计 → 通知同插件的其他面板 → 本面板显示 adapter-error 占位。
   * kind：busy = 心跳超时（同步死循环）；flood = 消息洪泛；lifecycle = open/activate 超时（异步挂起，不需要杀进程，iframe 卸载即释放）。
   */
  const stop = useCallback(
    async (kind: 'busy' | 'flood' | 'lifecycle' | 'peer', message: string, detectedMs = 0) => {
      if (killedRef.current) return;
      killedRef.current = true;
      let affected: string[] = [pluginId];
      if (kind === 'busy' || kind === 'flood') {
        const r = await kb.killPluginFrames(pluginId).catch(() => null);
        if (r) affected = [pluginId, ...r.alsoAffected];
        watchdogStats.kills.push({ pluginId, kind, detectedMs, at: Date.now() });
      }
      if (kind !== 'peer') {
        void kb.recordPluginEvent(pluginId, decl.id, kind === 'lifecycle' ? 'timeout' : 'watchdog', message).catch(() => undefined);
        for (const l of [...killBus]) l(affected, kind);
      }
      propsRef.current.onFatal(message);
    },
    [pluginId, decl.id],
  );
  useEffect(() => {
    const l = (ids: string[]) => {
      if (ids.includes(pluginId)) void stop('peer', `插件「${sb.pluginName}」的另一个面板无响应，插件进程已被停止`);
    };
    killBus.add(l);
    return () => void killBus.delete(l);
  }, [pluginId, stop, sb.pluginName]);

  // 心跳看门狗：就绪后每 HEARTBEAT_MS 发一次 ping；BUSY_MS 内没有任何 pong → 判定卡死。
  // 宿主自己被拖慢（定时器迟到超过 1 秒，例如系统休眠）时不归咎于插件；iframe 不在文档中（面板被隐藏）时暂停计时。
  useEffect(() => {
    if (!ready) return;
    let seq = 0;
    let lastTick = performance.now();
    lastPong.current = lastTick;
    const iv = setInterval(() => {
      const now = performance.now();
      const frame = iframeRef.current;
      if (now - lastTick > HEARTBEAT_MS + 1000 || !frame?.isConnected) lastPong.current = now;
      lastTick = now;
      const silent = now - lastPong.current;
      if (silent > BUSY_MS) {
        clearInterval(iv);
        void stop('busy', `插件「${sb.pluginName}」没有响应（${(silent / 1000).toFixed(1)} 秒内未回应心跳，可能陷入死循环），已停止它的进程`, Math.round(silent));
        return;
      }
      post({ type: 'ping', seq: ++seq });
      // 宿主侧的生命周期超时（运行时自己的 withTimeout 失效时的兜底）
      if (openSentAt.current && !openedRef.current && now - openSentAt.current > LIFECYCLE_TIMEOUT_MS + 2000) {
        clearInterval(iv);
        void stop('lifecycle', `插件「${sb.pluginName}」打开超时（${(LIFECYCLE_TIMEOUT_MS + 2000) / 1000} 秒）`);
      }
    }, HEARTBEAT_MS);
    return () => clearInterval(iv);
  }, [ready, post, stop, sb.pluginName]);

  const denyToFrame = useCallback(
    (perm: PermissionDecl | undefined, reason: PermissionDenial['reason'], detail?: string) => {
      if (!perm) return;
      post({ type: 'permission-denied', denial: { permissionId: perm.id, kind: perm.kind, reason, detail } satisfies PermissionDenial });
    },
    [post],
  );

  // 文件令牌：只有 fs.read 已授予时才签发（kbfile://plugin/<token>/<rid> 在主进程按授权逐个检查）
  useEffect(() => {
    let alive = true;
    let tok: string | null = null;
    if (p.item.sourceKind === 'file' && fsGranted)
      kb.mintPluginFileToken(pluginId, decl.id).then(
        (t) => (alive ? setToken((tok = t)) : void kb.releasePluginFileToken(t)),
        () => alive && setToken(null),
      );
    else setToken(null);
    return () => {
      alive = false;
      if (tok) void kb.releasePluginFileToken(tok);
    };
  }, [pluginId, decl.id, fsGranted, p.item.sourceKind]);

  const handleRpc = useCallback(
    async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const item = propsRef.current.item;
      const fs = fsReadDecl(decl);
      if (method.startsWith('files.') && method !== 'files.requestFileops') {
        if (item.sourceKind !== 'file' || !fs || permsRef.current[fs.id] !== 'granted') throw Object.assign(new Error('未获得文件读取权限'), { code: 'permission-denied' });
        const resourceId = String(params.resourceId ?? '');
        const op =
          method === 'files.stat'
            ? ({ op: 'stat', resourceId } as const)
            : method === 'files.readText'
              ? ({ op: 'readText', resourceId, maxBytes: typeof params.maxBytes === 'number' ? params.maxBytes : undefined } as const)
              : ({ op: 'readBytes', resourceId, offset: typeof params.offset === 'number' ? params.offset : undefined, length: typeof params.length === 'number' ? params.length : undefined } as const);
        try {
          return await kb.pluginFile(pluginId, decl.id, op);
        } catch (e) {
          const err = parseAccessError(e);
          if (err.code === 'out-of-scope' || err.code === 'permission-denied') {
            denyToFrame(fs, 'out-of-scope', err.message);
            setNotice(`已阻止一次越界读取：${err.message}`);
          }
          throw Object.assign(new Error(err.message), { code: err.code });
        }
      }
      if (method === 'files.requestFileops') {
        const w = decl.permissions.find((x) => x.kind === 'fileops.write');
        if (!w) throw Object.assign(new Error('适配器未声明 fileops.write'), { code: 'permission-denied' });
        const d = await pluginHost.ensurePermission(pluginId, decl, w);
        if (d !== 'granted') return { ok: false, reason: 'permission-denied' };
        let preview;
        try {
          preview = await kb.planPreview(pluginId, decl.id, params.plan as never);
        } catch (e) {
          const err = parseAccessError(e);
          if (err.code === 'out-of-scope') {
            setNotice(`已阻止越界的批量修改：${err.message}`);
            return { ok: false, reason: 'out-of-scope' };
          }
          throw Object.assign(new Error(err.message), { code: err.code });
        }
        const approved = await planDialog(preview);
        return approved ? kb.planExecute(preview.planId) : kb.planDiscard(preview.planId);
      }
      if (method.startsWith('storage.')) {
        const op = method.slice(8) as 'get' | 'set' | 'delete' | 'keys';
        try {
          return (await kb.adapterStorage(pluginId, op, typeof params.key === 'string' ? params.key : undefined, params.value)) ?? (op === 'get' ? null : undefined);
        } catch (e) {
          const err = parseAccessError(e);
          throw Object.assign(new Error(err.message), { code: err.code });
        }
      }
      if (method.startsWith('web.')) {
        if (!isWeb) throw Object.assign(new Error('不是网页面板'), { code: 'invalid-request' });
        switch (method) {
          case 'web.navigate':
            return kb.webNavigate(viewId, String(params.url ?? ''));
          case 'web.back':
            return kb.webBack(viewId);
          case 'web.forward':
            return kb.webForward(viewId);
          case 'web.reload':
            return kb.webReload(viewId);
          case 'web.getScroll':
            return kb.webGetScroll(viewId);
          case 'web.setScroll':
            return kb.webSetScroll(viewId, { x: Number(params.x) || 0, y: Number(params.y) || 0 });
          case 'web.clearSessionData':
            return kb.webClearSessionData(viewId, Array.isArray(params.kinds) ? (params.kinds as never) : undefined);
        }
      }
      if (method.startsWith('process.')) {
        if (item.sourceKind !== 'app') throw Object.assign(new Error('不是外部程序项目'), { code: 'invalid-request' });
        const pl = decl.permissions.find((x) => x.kind === 'process.launch');
        if (!pl || permsRef.current[pl.id] !== 'granted') throw Object.assign(new Error('未获得启动外部程序的权限'), { code: 'permission-denied' });
        switch (method) {
          case 'process.detect':
            return kb.appDetect(pluginId, decl.id, String(params.programId ?? ''));
          case 'process.launch': {
            // 条目与应用档案由宿主按面板填写；主进程再检查请求与档案完全一致、授权、签名与备份上限
            const r = await kb.appLaunch(pluginId, decl.id, item.itemId, item.ref, params.req as never);
            if (!r.ok && r.reason === 'backup-over-limit') setNotice(`没有启动：目标文件超过启动前备份的上限，且未确认“不备份也启动”（${r.detail ?? ''}）。`);
            return r;
          }
          case 'process.focus':
            return kb.appFocus(String(params.launchId ?? ''));
          case 'process.close':
            return kb.appClose(String(params.launchId ?? ''), { force: params.force === true });
          case 'process.list':
            return kb.appList(pluginId, item.itemId);
        }
      }
      if (method === 'permissions.request') {
        const perm = decl.permissions.find((x) => x.id === params.id);
        if (!perm) throw Object.assign(new Error('未声明的权限'), { code: 'invalid-request' });
        return pluginHost.ensurePermission(pluginId, decl, perm, false, propsRef.current.resource?.rootId);
      }
      throw Object.assign(new Error('未知调用'), { code: 'invalid-request' });
    },
    [pluginId, decl, denyToFrame, isWeb, viewId],
  );

  // 主进程的网页面板事件 → 外框状态 + 转发给插件（WebPanelHandle 事件）
  useEffect(() => {
    if (!isWeb) return;
    return kb.onWebEvent((ev: WebEvent) => {
      if (ev.viewId !== viewId) return;
      if (ev.type === 'gone') {
        propsRef.current.onFatal(`网页渲染进程已退出（${ev.reason}）`);
        return;
      }
      setWebUi((s) => reduceWebUi(s, ev));
      // 子资源计数和按网站提示只画在外框上，不转发给插件。
      if (ev.type === 'resource-blocked' || ev.type === 'external-sites') return;
      // ---- r11-A：逐站授权事件只在宿主处理，不转发给插件
      if (ev.type === 'access') {
        setWebInfo((w) => (w ? { ...w, allowedDomains: ev.allowedDomains, resourceDomains: ev.resourceDomains } : w));
        return;
      }
      if (ev.type === 'site-prompt') {
        void siteAccess.ask({ pluginId, pluginName: sb.pluginName, adapterId: decl.id, host: ev.host, url: ev.url, purpose: 'page' }).then((ok) => {
          setWebUi((s) => ({ ...s, sitePrompt: null, ...(ok ? {} : { blocked: { url: ev.url, reason: 'site-denied', external: /^https:/i.test(ev.url), n: (s.blocked?.n ?? 0) + 1 } }) }));
          if (ok) void kb.webNavigate(viewId, ev.url);
        });
        return;
      }
      if (ev.type === 'navigate' && webInfo?.perSite && !ev.inPage) titleSync(ev.url, ev.title);
      if (ev.type === 'navigate' && webInfo?.perSite && ev.inPage && ev.title) titleSync(ev.url, ev.title);
      post({ type: 'web-event', event: ev.type === 'blocked' ? { type: 'blocked', url: ev.url, reason: ev.reason } : ev });
    });
  }, [isWeb, viewId, post, webInfo?.perSite, pluginId, decl.id, sb.pluginName]);

  // ---- r11-A：逐站授权面板——标题同步到标签与网络资料；登记为“当前网页”（加入工作资料 / 保存到本地 / 复制网址）
  const webUiRef = useRef(webUi);
  webUiRef.current = webUi;
  const titleSync = useCallback((url: string, title: string) => {
    if (!title) return;
    propsRef.current.onTitle(title.slice(0, 80));
    const s = sanitizeWebRef(url);
    if (s.ok && s.url === propsRef.current.item.ref) void kb.webResourceGetByUrl(s.url).then((w) => {
        if (w && w.title !== title) void kb.webResourceUpdate(w.resourceId, { title });
      });
  }, []);
  useEffect(() => {
    if (!isWeb || !webInfo?.perSite) return;
    void kb.webResourceAdd({ url: p.item.ref, adapterId: decl.id, opened: true }).catch(() => undefined);
    return registerLiveWebView(p.item.itemId, { viewId, url: () => webUiRef.current.url, title: () => webUiRef.current.title });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isWeb, webInfo?.perSite, viewId, p.item.itemId]);
  // ---- r11-A end

  // 外部程序：主进程的进程状态 → 插件（ProcessBrokerApi.onStatus）；退出后记入操作记录的改动 → 提示条
  useEffect(() => {
    if (!isApp) return;
    return kb.onAppEvent((ev) => {
      if (ev.type === 'status') {
        if (ev.pluginId === pluginId && ev.itemId === propsRef.current.item.itemId) post({ type: 'process-status', handle: ev.handle });
        return;
      }
      if (ev.itemId !== propsRef.current.item.itemId) return;
      setAppChanges((xs) => [...xs.filter((x) => x.launchId !== ev.launchId), ev]);
    });
  }, [isApp, pluginId, post]);
  const undoAppChange = useCallback(async (c: AppChangesEvent) => {
    let r = await kb.appUndoExternal(c.launchId, false);
    if (r.status === 'conflict') {
      const ok = await dialogs.confirm({
        title: '撤销外部修改',
        body: `这些文件在程序退出后又被改动过：\n${r.detail.join('\n')}\n\n继续撤销会恢复启动前的内容。当前内容会先存进备份库：撤销后可以在“操作记录”（视图 → 操作记录）里找到这次撤销，点“恢复撤销前的内容”找回。`,
        ok: '仍然撤销',
      });
      if (!ok) return;
      r = await kb.appUndoExternal(c.launchId, true);
    }
    if (r.status === 'undone' || r.status === 'nothing') setAppChanges((xs) => xs.filter((x) => x.launchId !== c.launchId));
    setNotice(r.status === 'undone' ? `已撤销「${c.programName}」的修改：${r.files.join('、')}` : r.status === 'nothing' ? '没有需要撤销的修改。' : r.status === 'unrecoverable' ? `无法撤销：${r.detail.join('；')}` : '已取消撤销。');
  }, []);

  const setupDone = token !== undefined && (!isWeb || webInfo !== undefined) && (!isApp || !!app);
  // iframe 消息
  useEffect(() => {
    if (!setupDone) return;
    let winStart = performance.now();
    let winCount = 0;
    const onMsg = (e: MessageEvent) => {
      if (!iframeRef.current || e.source !== iframeRef.current.contentWindow) return;
      if (killedRef.current) return;
      // 洪泛检测：1 秒窗口内的消息数
      const now = performance.now();
      if (now - winStart > 1000) {
        winStart = now;
        winCount = 0;
      }
      if (++winCount > FLOOD_MAX_PER_SEC) {
        void stop('flood', `插件「${sb.pluginName}」在 1 秒内发送了超过 ${FLOOD_MAX_PER_SEC} 条消息，已停止它的进程`, Math.round(now - winStart));
        return;
      }
      const m = parseFrameMessage(e.data) as FrameToHost | null;
      if (!m) return;
      lastPong.current = now; // 任何消息都说明事件循环还在转
      const cur = propsRef.current;
      switch (m.type) {
        case 'pong':
          break;
        case 'ready':
          readyRef.current = true;
          setReady(true);
          post({ type: 'init', pluginId, hostVersion: HOST_API_VERSION, adapterApiVersion: ADAPTER_API_VERSION, phase: CURRENT_PHASE, manifest: dto?.manifest, mainUrl: dto?.mainUrl, theme: themeSnapshot() });
          break;
        case 'activated': {
          const it = cur.item;
          openSentAt.current = performance.now();
          post({
            type: 'open',
            item: { itemId: it.itemId, sourceKind: it.sourceKind, adapterId: decl.id, ref: it.ref, displayMode: it.displayMode, ...(it.title ? { title: it.title } : {}), ...(it.state ? { state: it.state as never } : {}) },
            adapter: decl,
            state: it.state ?? null,
            permissions: permsRef.current,
            fileToken: token,
            panelId: it.itemId,
            web: webInfo ? { partition: webInfo.partition, allowedDomains: webInfo.allowedDomains } : null,
            app: app ?? null,
            // 插件版本变了才用保留的旧状态再试一次恢复（同一版本已经失败过）
            preserved: preservedRef.current && preservedRef.current.pluginVersion !== dto?.version ? { v: preservedRef.current.v, data: preservedRef.current.data } : null,
          });
          break;
        }
        case 'activate-error':
        case 'open-error':
          console.warn(`[plugin:${pluginId}] ${m.type}: ${m.message}`);
          if (LIFECYCLE_TIMEOUT_RE.test(m.message)) void stop('lifecycle', `插件「${sb.pluginName}」${m.type === 'activate-error' ? '激活' : '打开'}超时：${m.message}`);
          else cur.onFatal(m.message || '未知错误');
          break;
        case 'opened':
          openedRef.current = true;
          setOpened(true);
          if (m.recovered) {
            // 新版本插件成功恢复了之前保留的旧状态：不再保留（下次保存写入恢复后的状态）
            preservedRef.current = undefined;
            setPreserved(undefined);
            setNotice('插件新版本已恢复之前保留的视图状态。');
          } else if (m.reset) {
            // 插件读不了上次保存的状态：宿主原样保留（已有保留的旧状态时两份都留，见 items.ts pushPreserved），
            // 面板上显示提示条，不悄悄回到默认视图
            const st = cur.item.state as ItemState | undefined;
            if (st) {
              preservedRef.current = pushPreserved(preservedRef.current, { v: st.v, data: st.data, reason: '插件无法读取上次保存的视图状态', at: Date.now(), ...(dto?.version ? { pluginVersion: dto.version } : {}) });
              setPreserved(preservedRef.current);
              cur.onState({ v: st.v, data: st.data, preserved: preservedRef.current });
              lastEnvelope.current = undefined; // 当前显示的是默认视图，插件保存之前没有“新状态”
            } else if (preservedRef.current && dto?.version) {
              preservedRef.current = { ...preservedRef.current, pluginVersion: dto.version };
              setPreserved(preservedRef.current);
            }
          }
          // 可选权限被拒：打开后告知插件降级
          for (const perm of decl.permissions) if (perm.optional && permsRef.current[perm.id] === 'denied') denyToFrame(perm, 'user-denied');
          break;
        case 'render':
          try {
            setUi(sanitizeUiNode(m.node));
          } catch (err) {
            setUi({ type: 'notice', tone: 'error', title: '插件界面无法显示', message: String((err as Error).message) });
          }
          break;
        case 'set-title':
          cur.onTitle(m.title);
          break;
        case 'state': {
          const chk = checkStateForSave(m.data, decl.maxStateBytes);
          if (chk.ok) saveEnvelope({ v: decl.stateSchemaVersion, data: JSON.parse(chk.json) });
          else console.warn(`[plugin:${pluginId}] 视图状态未保存：${chk.reason}`);
          break;
        }
        case 'log':
          (m.level === 'error' ? console.error : m.level === 'warn' ? console.warn : console.info)(`[plugin:${pluginId}] ${m.message}`);
          break;
        case 'rpc':
          withHostTimeout(m.method, handleRpc(m.method, m.params), () => void kb.recordPluginEvent(pluginId, decl.id, 'timeout', `宿主调用 ${m.method} 超过 ${RPC_TIMEOUT_MS / 1000} 秒未完成，已向插件返回 timeout`).catch(() => undefined)).then(
            (value) => post({ type: 'rpc-result', id: m.id, ok: true, value }),
            (err: Error & { code?: unknown }) => post({ type: 'rpc-result', id: m.id, ok: false, error: { code: isPluginAccessCode(err.code) ? err.code : parseAccessError(err).code, message: isPluginAccessCode(err.code) ? String(err.message) : parseAccessError(err).message } }),
          );
          break;
        case 'shortcut':
          // r11-B：沙箱 iframe 只转发已绑定组合键
          runByAccelerator(m.accelerator);
          break;
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [setupDone, token, webInfo, app, post, pluginId, decl, dto, handleRpc, denyToFrame, stop, sb.pluginName, saveEnvelope]);

  // r11-B：向沙箱下发已绑定加速键列表（仅这些键会回传）
  useEffect(() => {
    if (!ready) return;
    const push = () => {
      const keys = listBoundAccelerators(commands.all(), getKeybindingsStore()).map((x) => x.key);
      post({ type: 'bound-shortcuts', keys });
    };
    push();
    return subscribeKeybindings(push);
  }, [ready, post]);

  // 沙箱运行时 15 秒内没有就绪（例如插件包损坏、被 CSP 拦截）→ 适配器出错占位
  const readyRef = useRef(false);
  useEffect(() => {
    if (!setupDone) return;
    const t = setTimeout(() => {
      if (!readyRef.current) propsRef.current.onFatal('插件运行环境没有响应（15 秒）');
    }, 15000);
    return () => clearTimeout(t);
  }, [setupDone]);

  // 可选权限在运行中被撤销 → 通知插件
  const prevPerms = useRef(p.perms);
  useEffect(() => {
    for (const perm of decl.permissions) if (prevPerms.current[perm.id] === 'granted' && p.perms[perm.id] === 'denied') denyToFrame(perm, 'revoked');
    prevPerms.current = p.perms;
  }, [p.perms, decl, denyToFrame]);

  // 主题切换：令牌快照推给沙箱（UiNode 自动跟随，插件自绘内容在 onThemeChange 里处理）
  useEffect(() => {
    if (!opened) return;
    let last = themeSnapshot();
    const mo = new MutationObserver(() => {
      const t = themeSnapshot();
      if (JSON.stringify(t) === JSON.stringify(last)) return;
      last = t;
      post({ type: 'theme', theme: t });
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-kb-chrome', 'data-kb-reading', 'data-kb-scheme', 'style'] });
    return () => mo.disconnect();
  }, [opened, post]);

  // 文件变化 → file-change
  useEffect(() => {
    const res = p.resource;
    if (!opened || !res || !fsGranted) return;
    return kb.onFsChange((evs) => {
      for (const ev of evs) {
        if (ev.rootId !== res.rootId || ev.relPath !== res.relPath) continue;
        post({ type: 'file-change', resourceId: p.item.ref, change: ev.type === 'unlink' ? 'deleted' : 'modified' });
      }
    });
  }, [opened, p.resource, p.item.ref, fsGranted, post]);

  // 卸载面板：先让插件交出状态，再 dispose
  useEffect(
    () => () => {
      post({ type: 'dispose' });
    },
    [post],
  );

  const onAction = useCallback((action: string, payload: JsonValue | undefined) => post({ type: 'action', action, payload }), [post]);

  if (!setupDone) return <div className="kb-notice">加载中…</div>;
  return (
    <div className="kb-sandbox" data-testid="sandbox-view" data-ready={ready ? 'true' : 'false'} data-plugin-id={pluginId} data-adapter-id={decl.id} data-opened={opened ? 'true' : 'false'}>
      {notice && (
        <div className="kb-sandbox-notice" role="status" data-testid="sandbox-notice">
          {notice}
          <button className="kb-button kb-button--ghost kb-button--small" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}
      {upgraded && (
        <div className="kb-sandbox-notice kb-sandbox-notice--info" role="status" data-testid="plugin-updated-banner">
          <button className="kb-button kb-button--small" data-testid="plugin-updated-reload" onClick={() => p.onReload()}>
            插件已更新，点此重新加载
          </button>
          <span className="meta">（此面板仍在运行 {mountedVersion.current.split('@')[0]}，新版本 {dto?.version}）</span>
        </div>
      )}
      {preserved && (
        <div className="kb-sandbox-notice" role="status" data-testid="preserved-banner">
          <strong>旧状态已保留，插件新版本无法读取</strong>
          <span className="meta">
            （{preserved.earlier?.length ? `共 ${preserved.earlier.length + 1} 份；` : ''}之后的保存不会覆盖它，插件再次更新后会自动重试读取）
          </span>
          <button className="kb-button kb-button--ghost kb-button--small" data-testid="preserved-discard" onClick={discardPreserved}>
            丢弃旧状态
          </button>
        </div>
      )}
      {isWeb && webLegacy(p.item.state) && (
        <div className="kb-sandbox-notice" role="status" data-testid="web-legacy-banner">
          上次保存的网页位置无法恢复（{webLegacy(p.item.state)}），已回到首页；旧状态已原样保留在条目中。
        </div>
      )}
      {appChanges.map((c) => (
        <div key={c.launchId} className="kb-sandbox-notice" role="status" data-testid="app-changes-banner" data-launch-id={c.launchId} data-after-restart={c.afterRestart ? "true" : undefined}>
          {c.afterRestart ? '工作台关闭期间的外部修改：' : ''}{c.programName} 修改了 {c.files.map((f) => f.relPath).join('、')}（已记入操作记录）
          <button className="kb-button kb-button--small" data-testid="app-undo-external" onClick={() => void undoAppChange(c)}>
            撤销外部修改
          </button>
          <button className="kb-button kb-button--ghost kb-button--small" onClick={() => setAppChanges((xs) => xs.filter((x) => x.launchId !== c.launchId))}>
            知道了
          </button>
        </div>
      ))}
      {isWeb && webInfo ? (
        <WebSurface
          info={webInfo}
          label={displayModeLabel(decl)}
          ui={webUi}
          onDismissBlocked={() => setWebUi((s) => ({ ...s, blocked: null }))}
          onRetry={() => void kb.webReload(viewId)}
          // ---- r11-A 网络资料
          {...(webInfo.perSite
            ? {
                actions: (
                  <>
                    <button className="kb-button kb-button--ghost kb-button--small" data-testid="web-addref" onClick={() => void addToRefs(p.item)}>
                      加入本工作资料
                    </button>
                    <button className="kb-button kb-button--ghost kb-button--small" data-testid="web-save" onClick={() => void saveToLocal({ item: p.item })}>
                      保存到本地…
                    </button>
                    <button className="kb-button kb-button--ghost kb-button--small" data-testid="web-copy" onClick={() => void copyUrl(p.item)}>
                      复制网址
                    </button>
                  </>
                ),
              }
            : {})}
        />
      ) : (
        <div className="kb-sandbox-ui" data-testid="sandbox-ui">
          {ui ? <UiNodeView node={ui} onAction={onAction} /> : <div className="meta">正在加载插件…</div>}
        </div>
      )}
      {/* 运行插件代码的 iframe 不显示内容（v1 只有 UiNode 渲染；ReaderMountTarget.element 未提供） */}
      <iframe
        ref={iframeRef}
        className="kb-sandbox-frame"
        title={`插件 ${pluginId}`}
        sandbox="allow-scripts"
        src={`kbplugin://${pluginId}/__kb/frame.html`}
        data-testid="sandbox-frame"
        aria-hidden="true"
        tabIndex={-1}
      />
    </div>
  );
}

/** 网页模板（SDK web 模板 migrateOrPreserve）把无法恢复的旧状态放在 data.legacy；返回原因文本，没有时返回空串 */
function webLegacy(st: unknown): string {
  const d = (st as { data?: { legacy?: { error?: unknown } } } | undefined)?.data;
  const l = d && typeof d === 'object' ? d.legacy : undefined;
  if (!l || typeof l !== 'object') return '';
  return typeof l.error === 'string' && l.error ? l.error.slice(0, 120) : '格式无法识别';
}
