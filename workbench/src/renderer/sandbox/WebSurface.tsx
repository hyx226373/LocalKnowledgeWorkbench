/**
 * 网页面板的宿主外框（H9，SDK §6.3）：固定显示“网页面板 · 仅限 <域名>”、后退/前进/刷新、只读地址、拦截横幅，
 * 以及一个“网页区域”占位元素（slot）。真正的网页是主进程的 WebContentsView，盖在 slot 的位置上。
 *
 * 位置跟随（docs/06 §11.3）：requestAnimationFrame 逐帧读取 slot 的矩形，变化时 kb.sendWebBounds（拖动分隔条、切换标签、
 * 最大化、窗口缩放都是同一条路径）。slot 不在文档中 / 不可见（非活动标签、工作区切换）/ 尺寸为 0 → 发送 null（隐藏）。
 *
 * 浮层（z-order）：原生视图总是画在主窗口 DOM 之上，CSS z-index 对它无效。因此只要任一工作台浮层（对话框背景、菜单、
 * 命令面板、搜索结果、状态表；选择器 OVERLAY_SELECTOR）与 slot 相交，或正在拖放 dock 标签，就隐藏原生视图，
 * slot 里显示主进程缓存的最近一帧截图（页面看上去仍在，但对话框/菜单完整可见、可点击）。浮层关闭后同一帧恢复显示。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { OVERLAY_SELECTOR, hostOf, initialWebUi, reduceWebUi, type WebBounds, type WebUiState, type WebViewInfo } from '../../shared/webPanel';
import { GLOBAL_NEVER_BLOCK_WARNING } from '../../shared/webSiteGrant';
import { openWebSiteGrants } from '../web-site/grantsDialog';
import { WebFlash } from '../web-resources/webActions'; // r11-A

export { initialWebUi, reduceWebUi, type WebUiState };

/** 拖放 dock 标签期间隐藏所有网页面板（原生视图会吃掉拖放事件，落点提示也会被盖住） */
let dragging = false;
if (typeof window !== 'undefined') {
  window.addEventListener('dragstart', () => (dragging = true), true);
  for (const t of ['dragend', 'drop']) window.addEventListener(t, () => (dragging = false), true);
  // 拖放期间浏览器不派发指针事件；收到指针事件说明拖放已结束（源元素在拖放中被移出 DOM 时收不到 dragend，标记会卡住）
  for (const t of ['pointermove', 'pointerdown']) window.addEventListener(t, () => (dragging = false), { capture: true, passive: true });
}

function intersects(a: DOMRect, b: DOMRect) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** 当前与 r 相交的工作台浮层（e2e 也用它判断） */
export function coveringOverlays(r: DOMRect): Element[] {
  const out: Element[] = [];
  for (const el of document.querySelectorAll(OVERLAY_SELECTOR)) {
    const o = el.getBoundingClientRect();
    if (o.width > 0 && o.height > 0 && intersects(o, r)) out.push(el);
  }
  return out;
}

/**
 * 额外的遮挡判断（面板管理层注册：层级更高的浮动窗口与网页区域相交 → 同样改显示截图，docs/11 §5）。
 * 返回取消注册函数。
 */
const coverProbes = new Set<(slot: Element, r: DOMRect) => boolean>();
export function registerWebCoverProbe(fn: (slot: Element, r: DOMRect) => boolean): () => void {
  coverProbes.add(fn);
  return () => void coverProbes.delete(fn);
}

/** 已显示网页面板的统计（e2e 用） */
export const webSurfaceStats = { boundsSent: 0, hiddenByOverlay: 0 };

const REASON_TEXT: Record<string, string> = {
  'domain-blocked': '不在允许的域名内',
  'scheme-blocked': '协议不被允许（只允许 https）',
  'popup-blocked': '弹出窗口已被阻止',
  'download-blocked': '下载已被阻止',
  'site-denied': '你拒绝了访问该网站', // r11-A 逐站授权
};

/** r11-A：页面加载失败的分类（网络不可用 / 超时 / 其他），文案带重试 */
function failTitle(err: string | undefined): string {
  const e = err ?? '';
  if (/TIMED_OUT|\(-7\)|\(-118\)/.test(e)) return '请求超时';
  if (/INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_(REFUSED|RESET|CLOSED|FAILED)|NETWORK_CHANGED|\(-10[0-9]\)|\(-2\)|\(-21\)/.test(e)) return '网络不可用';
  return '无法连接网络';
}

export function WebSurface(p: {
  info: WebViewInfo;
  label: string;
  ui: WebUiState;
  onDismissBlocked(): void;
  onRetry(): void;
  // ---- r11-A 网络资料：逐站授权面板的工具条动作（加入工作资料 / 保存到本地 / 复制网址）
  actions?: React.ReactNode;
}) {
  const { info, ui } = p;
  const viewId = info.viewId;
  const slotRef = useRef<HTMLDivElement>(null);
  const [covered, setCovered] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const failed = ui.load === 'failed';
  const failedRef = useRef(failed);
  failedRef.current = failed;

  // 逐帧位置跟随
  useEffect(() => {
    let raf = 0;
    let last = '';
    let wasCovered = false;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = slotRef.current;
      let b: WebBounds | null = null;
      let cover = false;
      if (el && el.isConnected && !failedRef.current) {
        const r = el.getBoundingClientRect();
        const visible = r.width >= 2 && r.height >= 2 && (el.checkVisibility?.({ visibilityProperty: true } as never) ?? true);
        if (visible) {
          cover = dragging || coveringOverlays(r).length > 0 || [...coverProbes].some((f) => f(el, r));
          if (!cover) {
            const x = Math.round(r.left);
            const y = Math.round(r.top);
            // 只取视口内的部分（面板被滚出窗口时不画到窗口外）
            const right = Math.min(Math.round(r.right), window.innerWidth);
            const bottom = Math.min(Math.round(r.bottom), window.innerHeight);
            b = { x: Math.max(0, x), y: Math.max(0, y), width: right - Math.max(0, x), height: bottom - Math.max(0, y) };
            // 浮动窗：WebContentsView 盖满会挡住边缘缩放把手；左右下各让 8px
            if (b && el.closest('.dv-resize-container')) {
              const edge = 8;
              b = { x: b.x + edge, y: b.y, width: Math.max(0, b.width - edge * 2), height: Math.max(0, b.height - edge) };
            }
            if (b.width < 2 || b.height < 2) b = null;
          }
        }
      }
      const key = b ? `${b.x},${b.y},${b.width},${b.height}` : 'hidden';
      if (key !== last) {
        last = key;
        webSurfaceStats.boundsSent++;
        kb.sendWebBounds(viewId, b);
      }
      if (cover !== wasCovered) {
        wasCovered = cover;
        if (cover) webSurfaceStats.hiddenByOverlay++;
        setCovered(cover);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      kb.sendWebBounds(viewId, null);
    };
  }, [viewId]);

  // 被浮层覆盖时取主进程缓存的截图
  useEffect(() => {
    if (!covered) return;
    let alive = true;
    // 主进程在页面稳定后才缓存截图：刚加载完就被遮挡时可能还没有，稍后重试几次
    let tries = 0;
    let t: ReturnType<typeof setTimeout> | undefined;
    const get = () =>
      void kb.webSnapshot(viewId).then((s) => {
        if (!alive) return;
        if (s) setShot(s);
        else if (++tries < 12) t = setTimeout(get, 400);
      });
    get();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [covered, viewId]);

  const openExternal = useCallback(async (url: string) => {
    const ok = await dialogs.confirm({
      title: '用系统浏览器打开？',
      body: `${info.perSite ? '这个网站未获允许在应用内打开。' : `这个链接不在此面板允许的域名内（只允许 ${info.allowedDomains.join('、')}）。`}\n\n将用系统默认浏览器打开：\n${url}\n\n只有 https 地址可以这样打开。`,
      ok: '用系统浏览器打开',
      cancel: '取消',
    });
    if (!ok) return;
    const r = await kb.webOpenExternal(url, { viewId });
    if (!r.ok) await dialogs.alert({ title: '无法打开', body: r.reason ?? '地址不被允许' });
    else p.onDismissBlocked();
  }, [info.allowedDomains, viewId, p]);

  const b = ui.blocked;
  return (
    <div className="kb-web" data-testid="web-panel" data-view-id={viewId} data-url={ui.url ?? ''} data-load={ui.load} data-covered={covered ? 'true' : 'false'}>
      <div className="kb-web-bar" data-testid="web-toolbar">
        <button className="kb-button kb-button--ghost kb-button--small" title="后退" aria-label="后退" disabled={!ui.canGoBack} onClick={() => void kb.webBack(viewId)} data-testid="web-back">
          ←
        </button>
        <button className="kb-button kb-button--ghost kb-button--small" title="前进" aria-label="前进" disabled={!ui.canGoForward} onClick={() => void kb.webForward(viewId)} data-testid="web-forward">
          →
        </button>
        <button className="kb-button kb-button--ghost kb-button--small" title="刷新" aria-label="刷新" onClick={() => void kb.webReload(viewId)} data-testid="web-reload">
          ⟳
        </button>
        <div className="kb-web-address" title={ui.url ?? ''} data-testid="web-address" aria-label="地址（只读）">
          {ui.load === 'loading' && <span className="kb-web-spinner" aria-hidden="true" />}
          {info.perSite && /^http:\/\//i.test(ui.url ?? '') && (
            <span className="kb-web-insecure" data-testid="web-insecure" title="不加密的 http 连接：内容可能被网络中的他人查看或篡改">
              不安全连接
            </span>
          )}
          {ui.url ?? '…'}
        </div>
        <span className="kb-web-label" data-testid="web-label">
          {p.label}
        </span>
        {ui.resourcesBlocked > 0 && (
          <span className="kb-web-res" title={`已拦截来自这些网站的资源：${ui.resourceHosts.join('、')}`} data-testid="web-res-blocked">
            已拦截 {ui.resourcesBlocked} 个外部资源
          </span>
        )}
        {p.actions}
        <WebFlash />
      </div>
      {ui.externalSites.length > 0 && (
        <div className="kb-web-sites" role="status" data-testid="web-site-grant-banner" data-count={ui.externalSites.length}>
          <div>外部资源按网站询问。页面可以继续操作。同一网站只问一次。</div>
          <div className="kb-web-sites-row">
            <button
              className="kb-button kb-button--small"
              data-testid="web-site-allow-all"
              onClick={() => void kb.webSiteApply({ actionId: 'web.allowAllBlocked', sites: ui.externalSites.map((row) => row.site), viewId })}
            >
              全部允许
            </button>
            <button className="kb-button kb-button--ghost kb-button--small" data-testid="web-site-open-settings" onClick={() => void openWebSiteGrants()}>
              在设置中查看和撤销
            </button>
          </div>
          {ui.externalSites.map((row) => (
            <div className="kb-web-sites-row" key={row.site} data-testid={`web-site-row-${row.site}`} data-site={row.site}>
              <span data-testid={`web-site-count-${row.site}`}>
                {row.site} ×{row.count}
              </span>
              <button className="kb-button kb-button--small" data-testid={`web-site-allow-session-${row.site}`} onClick={() => void kb.webSiteApply({ actionId: 'web.allowSite', site: row.site, choice: 'session', viewId })}>
                允许本次
              </button>
              <button className="kb-button kb-button--small" data-testid={`web-site-allow-always-${row.site}`} onClick={() => void kb.webSiteApply({ actionId: 'web.allowSite', site: row.site, choice: 'always', viewId })}>
                始终允许
              </button>
              <button className="kb-button kb-button--ghost kb-button--small" data-testid={`web-site-deny-${row.site}`} onClick={() => void kb.webSiteApply({ actionId: 'web.allowSite', site: row.site, choice: 'deny', viewId })}>
                拒绝
              </button>
              <button className="kb-button kb-button--ghost kb-button--small" data-testid={`web-site-never-${row.site}`} onClick={() => void kb.webSiteApply({ actionId: 'web.neverBlock', site: row.site, viewId })}>
                从不拦截
              </button>
            </div>
          ))}
          <div className="kb-web-sites-warning" data-testid="web-site-global-warning">
            {GLOBAL_NEVER_BLOCK_WARNING}。可以随时在设置里改回来。
          </div>
          <div className="kb-web-sites-row">
            <button
              className="kb-button kb-button--ghost kb-button--small"
              data-testid="web-site-never-global"
              onClick={() =>
                void dialogs
                  .confirm({
                    title: '不再拦截外部资源？',
                    body: `${GLOBAL_NEVER_BLOCK_WARNING}。\n\n这只影响网页面板里的图片、样式和脚本。文件、本机地址和非默认端口仍然拦截。可以随时在「网页外部资源授权」里改回来。`,
                    ok: '不再拦截',
                    cancel: '保持询问',
                  })
                  .then((ok) => {
                    if (ok) return kb.webSiteApply({ actionId: 'web.neverBlock', global: true, enabled: true, viewId });
                  })
              }
            >
              从不拦截所有网站
            </button>
          </div>
        </div>
      )}
      {b && (
        <div className="kb-web-banner" role="status" data-testid="web-blocked-banner" data-reason={b.reason}>
          <span>
            已阻止：<code>{b.url.length > 120 ? b.url.slice(0, 120) + '…' : b.url}</code>（{REASON_TEXT[b.reason] ?? b.reason}
            {b.reason === 'domain-blocked' && !info.perSite ? `；只允许 ${info.allowedDomains.join('、')}` : ''}）{b.n > 1 ? ` · 共 ${b.n} 次` : ''}
          </span>
          {b.external && (
            <button className="kb-button kb-button--small" data-testid="web-open-external" onClick={() => void openExternal(b.url)}>
              用系统浏览器打开…
            </button>
          )}
          <button className="kb-button kb-button--ghost kb-button--small" onClick={p.onDismissBlocked} data-testid="web-banner-close">
            关闭
          </button>
        </div>
      )}
      <div className="kb-web-slot" ref={slotRef} data-testid="web-slot">
        {failed ? (
          <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind="network-offline">
            <h2 data-testid="web-fail-title">{failTitle(ui.error)}</h2>
            <div data-testid="placeholder-message">页面加载失败，请检查网络后重试；条目与引用已保留。{ui.error ? `（${ui.error}）` : ''}</div>
            <div className="kb-placeholder-actions">
              <button className="kb-button" data-testid="placeholder-action-retry" onClick={p.onRetry}>
                重试
              </button>
            </div>
          </div>
        ) : covered ? (
          shot ? (
            <img className="kb-web-shot" src={shot} alt="" data-testid="web-snapshot" />
          ) : (
            <div className="kb-web-hidden meta">网页面板被菜单、对话框或上层窗口遮住时暂时隐藏（{hostOf(ui.url ?? info.homeUrl)}）</div>
          )
        ) : null}
      </div>
    </div>
  );
}
