/**
 * 直链阅读器 web.file（第 11 轮 A5）：公开的 PDF / 图片 / Markdown / 文本直链 → 主进程受控下载到应用缓存
 * （<数据目录>/web-cache/<resourceId>/）→ 交给现有内置阅读器（与本地文件同一套面板）显示。
 *  - 主机未批准：先逐站询问（与网页面板同一份授权）；拒绝 → 占位 + 系统浏览器打开
 *  - 类型无法识别 / 与扩展名冲突：提示“无法识别类型，仍按网页打开 / 取消”，不把未知内容当二进制硬解
 *  - 网络不可用 / 超时 / 404：可重试的错误态，引用与 resourceId 保留
 *  - 只读：缓存文件不能编辑（textOpen 返回只读原因），需要编辑请“保存到本地”
 * 视图状态 = { inner: 内置阅读器自己的状态 }（滚动、页码、模式），重启后恢复。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { adapters } from '../plugin-host/registry';
import { pluginHost } from '../plugin-host/host';
import { restoreItemState } from '../plugin-host/layoutModel';
import type { AdapterProps } from '../plugin-host/types';
import type { ResourceInfo } from '../../shared/types';
import { WEB_GENERIC_ADAPTER, WEB_GENERIC_PLUGIN, isInsecureUrl, sanitizeWebRef, type FetchCacheResult, type WebResource } from '../../shared/webResources';
import { siteHostOf } from '../../shared/adapter-sdk/policy';
import { siteAccess, perSiteDecl } from './siteAccess';
import { addToRefs, copyUrl, openUrl, saveToLocal, WebFlash } from './webActions';
import { dialogs } from '../ui/dialogs';
import { adapterOf } from '../../shared/grants';

export interface WebFileState {
  inner?: { adapterId: string; v: number; data: unknown };
}

type Phase =
  | { kind: 'loading'; detail?: string }
  | { kind: 'ready'; res: ResourceInfo; w: WebResource }
  | { kind: 'site'; host: string; denied: boolean }
  | { kind: 'type'; detail: string; contentType: string; html: boolean }
  | { kind: 'error'; title: string; detail: string }
  | { kind: 'unavailable'; detail: string };

const ERR_TITLE: Record<string, string> = { network: '网络不可用', timeout: '请求超时', http: '服务器返回错误', 'too-large': '文件过大', blocked: '地址不被允许' };

export function WebFileView(p: AdapterProps<WebFileState>) {
  const url = p.item.ref;
  const host = siteHostOf(url) ?? '';
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [n, setN] = useState(0);
  const force = useRef(false);
  const siteVer = useSyncExternalStore(siteAccess.subscribe, siteAccess.getVersion);
  const pluginsVer = useSyncExternalStore((cb) => pluginHost.subscribe(cb), () => pluginHost.getVersion());
  const pluginName = pluginHost.sandboxPlugin(WEB_GENERIC_PLUGIN)?.name ?? '通用网页';

  useEffect(() => {
    let alive = true;
    void (async () => {
      const s = sanitizeWebRef(url);
      if (!s.ok) return alive && setPhase({ kind: 'unavailable', detail: s.reason });
      const dto = pluginHost.sandboxPlugin(WEB_GENERIC_PLUGIN);
      const decl = perSiteDecl(adapterOf(dto?.manifest, WEB_GENERIC_ADAPTER));
      if (!dto || !decl || !dto.enabled || dto.errors.length) return alive && setPhase({ kind: 'unavailable', detail: '内置网页适配器（web.generic）不可用或已禁用：直链下载使用它的网站授权与数据分区。可在插件管理中重新启用。' });
      const st = siteAccess.status(WEB_GENERIC_PLUGIN, WEB_GENERIC_ADAPTER, decl, s.host);
      if (st === 'revoked') return alive && setPhase({ kind: 'unavailable', detail: '内置网页适配器的网络权限已被撤销。可在插件管理中改为允许。' });
      if (st !== 'granted') {
        if (st === 'session-denied') return alive && setPhase({ kind: 'site', host: s.host, denied: true });
        setPhase({ kind: 'site', host: s.host, denied: false });
        const ok = await siteAccess.ask({ pluginId: WEB_GENERIC_PLUGIN, pluginName, adapterId: WEB_GENERIC_ADAPTER, host: s.host, url: s.url, purpose: 'file' });
        if (!ok) return alive && setPhase({ kind: 'site', host: s.host, denied: true });
      }
      setPhase({ kind: 'loading', detail: force.current ? '正在重新下载…' : '正在下载到本地缓存…' });
      const w = await kb.webResourceAdd({ url: s.url, adapterId: 'web.file', opened: true });
      let r: FetchCacheResult;
      try {
        r = await kb.webFetchCache(w.resourceId, { force: force.current });
      } catch (e) {
        return alive && setPhase({ kind: 'error', title: '下载失败', detail: String((e as Error).message ?? e).replace(/^Error invoking remote method 'kb': (Error: )?/, '') });
      }
      force.current = false;
      if (!alive) return;
      if (r.ok) {
        const res = await kb.getResource(w.resourceId);
        if (!alive) return;
        if (!res || !res.exists) return setPhase({ kind: 'error', title: '缓存不可用', detail: '下载完成但缓存文件不见了，请重试。' });
        return setPhase({ kind: 'ready', res, w: r.resource });
      }
      if (r.kind === 'site-not-granted') {
        // 重定向到了另一个未批准的网站：询问目标主机；允许后重新下载，拒绝则显示占位（不下载）
        const target = r.host;
        if (siteAccess.status(WEB_GENERIC_PLUGIN, WEB_GENERIC_ADAPTER, decl, target) === 'session-denied') return setPhase({ kind: 'site', host: target, denied: true });
        setPhase({ kind: 'site', host: target, denied: false });
        const ok2 = await siteAccess.ask({ pluginId: WEB_GENERIC_PLUGIN, pluginName, adapterId: WEB_GENERIC_ADAPTER, host: target, url: r.url, purpose: 'file' });
        if (!alive) return;
        if (!ok2) return setPhase({ kind: 'site', host: target, denied: true });
        return setN((x) => x + 1);
      }
      if (r.kind === 'error') return setPhase({ kind: 'error', title: r.status === 404 ? '找不到文件（404）' : (ERR_TITLE[r.reason] ?? '下载失败'), detail: r.detail });
      return setPhase({ kind: 'type', detail: r.detail, contentType: r.contentType, html: r.kind === 'html' });
    })();
    return () => {
      alive = false;
    };
  }, [url, n]);

  const retry = useCallback((redownload = false) => {
    force.current = redownload;
    setN((x) => x + 1);
  }, []);

  // 授权或插件状态变化后重新判定（例如在插件管理 / 另一个面板里允许了该网站、重新启用了内置适配器）。
  // 只在“已拒绝 / 不可用”时触发，避免与正在进行的询问 / 下载互相重启。
  const siteSeen = useRef(siteVer);
  useEffect(() => {
    if (siteSeen.current === siteVer) return;
    siteSeen.current = siteVer;
    if (phase.kind !== 'site' || !phase.denied) return;
    const decl = perSiteDecl(adapterOf(pluginHost.sandboxPlugin(WEB_GENERIC_PLUGIN)?.manifest, WEB_GENERIC_ADAPTER));
    if (decl && siteAccess.status(WEB_GENERIC_PLUGIN, WEB_GENERIC_ADAPTER, decl, phase.host) === 'granted') retry();
  }, [siteVer, phase, retry]);
  const pluginsSeen = useRef(pluginsVer);
  useEffect(() => {
    if (pluginsSeen.current === pluginsVer) return;
    pluginsSeen.current = pluginsVer;
    if (phase.kind === 'unavailable') retry();
  }, [pluginsVer, phase, retry]);

  const asWebPage = useCallback(async () => {
    await kb.webResourceAdd({ url, adapterId: WEB_GENERIC_ADAPTER });
    await openUrl(url, 'tab', { adapterId: WEB_GENERIC_ADAPTER });
  }, [url]);

  const openExternal = useCallback(async () => {
    const ok = await dialogs.confirm({ title: '用系统浏览器打开？', body: `将用系统默认浏览器打开：\n${url}\n\n只有 https 地址可以这样打开。`, ok: '用系统浏览器打开' });
    if (!ok) return;
    const r = await kb.webOpenExternal(url, { pluginId: WEB_GENERIC_PLUGIN, adapterId: WEB_GENERIC_ADAPTER });
    if (!r.ok) await dialogs.alert({ title: '无法打开', body: r.reason ?? '地址不被允许' });
  }, [url]);

  const bar = (
    <div className="kb-web-bar kb-webfile-bar" data-testid="webfile-toolbar">
      <div className="kb-web-address" title={url} data-testid="webfile-address">
        {isInsecureUrl(url) && (
          <span className="kb-web-insecure" data-testid="web-insecure">
            不安全连接
          </span>
        )}
        {url}
      </div>
      <span className="kb-web-label">网络资料 · 只读{phase.kind === 'ready' && phase.w.cached ? ' · 已缓存' : ''}</span>
      <button className="kb-button kb-button--ghost kb-button--small" data-testid="webfile-save" disabled={phase.kind !== 'ready'} onClick={() => void saveToLocal({ item: p.item })}>
        保存到本地…
      </button>
      <button className="kb-button kb-button--ghost kb-button--small" data-testid="webfile-addref" onClick={() => void addToRefs(p.item)}>
        加入本工作资料
      </button>
      <button className="kb-button kb-button--ghost kb-button--small" data-testid="webfile-copy" onClick={() => void copyUrl(p.item)}>
        复制网址
      </button>
      <button className="kb-button kb-button--ghost kb-button--small" data-testid="webfile-redownload" disabled={phase.kind === 'loading' || phase.kind === 'site'} onClick={() => retry(true)}>
        重新下载
      </button>
      <WebFlash />
    </div>
  );

  let body: React.ReactNode;
  if (phase.kind === 'ready') body = <InnerReader {...p} res={phase.res} />;
  else if (phase.kind === 'loading')
    body = (
      <div className="kb-notice" data-testid="webfile-loading">
        {phase.detail ?? '加载中…'}
      </div>
    );
  else if (phase.kind === 'site')
    body = (
      <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind={phase.denied ? 'site-denied' : 'site-prompt'} data-host={phase.host}>
        <h2>{phase.denied ? `未允许访问 ${phase.host}` : `正在等待你决定是否允许访问 ${phase.host}…`}</h2>
        <div data-testid="placeholder-message">网络资料的引用已保留。允许后会下载到本地缓存，用内置阅读器打开。</div>
        <div className="kb-placeholder-actions">
          <button
            className="kb-button"
            data-testid="site-allow-again"
            onClick={async () => {
              siteAccess.forgetDenial(WEB_GENERIC_PLUGIN, phase.host);
              const ok = await siteAccess.ask({ pluginId: WEB_GENERIC_PLUGIN, pluginName, adapterId: WEB_GENERIC_ADAPTER, host: phase.host, url, purpose: 'file' });
              if (ok) retry();
            }}
          >
            允许访问此网站…
          </button>
          <button className="kb-button kb-button--secondary" data-testid="placeholder-action-open-in-system-browser" disabled={!/^https:/i.test(url)} onClick={() => void openExternal()}>
            用系统浏览器打开…
          </button>
        </div>
      </div>
    );
  else if (phase.kind === 'type')
    body = (
      <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind="type-unknown">
        <h2>{phase.html ? '这是网页，不是文件' : '无法识别类型'}</h2>
        <div data-testid="placeholder-message">
          {phase.detail}
          {phase.contentType ? `（Content-Type：${phase.contentType}）` : ''}。{phase.html ? '可以改用网页面板打开。' : '为避免把未知内容当成乱码显示，没有用阅读器打开。'}
        </div>
        <div className="kb-placeholder-actions">
          <button className="kb-button" data-testid="webfile-open-as-web" onClick={() => void asWebPage()}>
            仍按网页打开
          </button>
          <button className="kb-button kb-button--secondary" data-testid="webfile-cancel" onClick={() => void dialogs.alert({ title: '已取消', body: '没有打开此网址；网络资料的引用保留，可以稍后再试或从工作区移除。' })}>
            取消
          </button>
        </div>
      </div>
    );
  else if (phase.kind === 'error')
    body = (
      <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind="network-offline">
        <h2 data-testid="webfile-error-title">{phase.title}</h2>
        <div data-testid="placeholder-message">{phase.detail}。网络资料的引用与 ID 已保留，恢复后点“重试”。</div>
        <div className="kb-placeholder-actions">
          <button className="kb-button" data-testid="placeholder-action-retry" onClick={() => retry(true)}>
            重试
          </button>
        </div>
      </div>
    );
  else
    body = (
      <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind="web-unavailable">
        <h2>无法打开网络资料</h2>
        <div data-testid="placeholder-message">{phase.detail}</div>
        <div className="kb-placeholder-actions">
          {pluginHost.sandboxPlugin(WEB_GENERIC_PLUGIN) && !pluginHost.sandboxPlugin(WEB_GENERIC_PLUGIN)!.enabled && (
            <button className="kb-button" data-testid="placeholder-action-enable-plugin" onClick={() => void pluginHost.setEnabled(WEB_GENERIC_PLUGIN, true)}>
              重新启用内置网页适配器
            </button>
          )}
        </div>
      </div>
    );
  return (
    <div className="kb-webfile" data-testid="webfile-view" data-url={url} data-phase={phase.kind} data-host={host}>
      {bar}
      <div className="kb-webfile-body">{body}</div>
    </div>
  );
}

/** 用最匹配的内置（非沙箱）阅读器显示缓存文件；状态包在 { inner } 里，按阅读器 id 区分 */
function InnerReader(p: AdapterProps<WebFileState> & { res: ResourceInfo }) {
  const inner = useMemo(() => adapters.resolve({ sourceKind: 'file', resource: p.res }).find((a) => !a.sandbox && a.id !== 'builtin.unsupported'), [p.res]);
  const saved = p.state?.inner;
  const innerState = useMemo(() => (inner && saved && saved.adapterId === inner.id ? restoreItemState({ v: saved.v, data: saved.data }, inner) : undefined), [inner, saved]);
  const setInner = useCallback(
    (s: unknown) => {
      if (!inner) return;
      let ser: unknown = s;
      try {
        ser = inner.serializeState ? inner.serializeState(s) : s;
      } catch {
        return;
      }
      p.setState({ inner: { adapterId: inner.id, v: inner.stateSchemaVersion ?? 1, data: ser } });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inner, p.setState],
  );
  if (!inner)
    return (
      <div className="kb-notice" data-testid="webfile-no-reader">
        没有可以显示 .{p.res.ext} 的内置阅读器。
      </div>
    );
  const V = inner.component;
  let api;
  try {
    api = pluginHost.apiFor(inner.owner);
  } catch {
    return <div className="kb-notice">阅读器尚未就绪…</div>;
  }
  return (
    <div className="kb-webfile-reader" data-testid="webfile-reader" data-reader={inner.id}>
      <V key={inner.id + ':' + p.res.mtimeMs + ':' + p.res.size} item={p.item} resource={p.res} state={innerState} setState={setInner} api={api} reportReady={inner.reportsReady ? p.reportReady : undefined} />
    </div>
  );
}
