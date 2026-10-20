/**
 * 主窗口内容区里的外链浏览。每个标签是一个 WebContentsView，盖在渲染进程占位元素上。
 * 会话分区是内存分区 kb-ext-browse，不用默认 session，也不注册 kbfile / kbplugin。
 * 不写剪贴板。分区名不带 persist:，不在用户数据目录落一份站点数据。
 */
import { BrowserWindow, session, shell, WebContentsView, type Session, type WebContents } from 'electron';
import { fileURLToPath } from 'node:url';
import {
  EXT_BROWSE_PARTITION,
  browsePrefsOf,
  browseRequestAllowed,
  decideExternalLink,
  externalLinkRejectReason,
  systemBrowserTarget,
  type ExtBrowseEvent,
} from '../shared/externalBrowse';
import type { WebBounds } from '../shared/webPanel';
import type { WebSiteGrantStore } from './webSiteGrantStore';

const VIEW_ID = /^extbrowse-[a-z0-9-]{1,40}$/;

interface BrowseEntry {
  viewId: string;
  view: WebContentsView;
  wc: WebContents;
  bounds: WebBounds | null;
}

export class ExternalBrowseHost {
  private readonly views = new Map<string, BrowseEntry>();
  private ses: Session | null = null;

  constructor(
    private getWin: () => BrowserWindow | null,
    private grants: WebSiteGrantStore,
    private send: (ev: ExtBrowseEvent) => void,
  ) {}

  has(viewId: string): boolean {
    return this.views.has(viewId);
  }

  /** 内存分区，和主窗口、网页面板插件分区都不共用。 */
  private session(): Session {
    if (this.ses) return this.ses;
    const ses = session.fromPartition(EXT_BROWSE_PARTITION, { cache: true });
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'fullscreen'));
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'fullscreen');
    ses.setDevicePermissionHandler(() => false);
    ses.setSpellCheckerEnabled(false);
    ses.webRequest.onBeforeRequest((details, cb) => {
      const prefs = browsePrefsOf(this.grants.snapshot());
      const isMain = details.resourceType === 'mainFrame';
      cb({ cancel: !browseRequestAllowed(details.url, isMain, prefs) });
    });
    this.ses = ses;
    return ses;
  }

  private prefs() {
    return browsePrefsOf(this.grants.snapshot());
  }

  create(viewId: string, url: string): { ok: true; url: string } | { ok: false; reason: string } {
    if (!VIEW_ID.test(viewId)) return { ok: false, reason: '视图编号无效' };
    const decision = decideExternalLink(url, this.prefs());
    if (decision.action !== 'open') return { ok: false, reason: externalLinkRejectReason(decision) };
    const win = this.getWin();
    if (!win || win.isDestroyed()) return { ok: false, reason: '窗口不可用' };
    this.destroy(viewId);
    const view = new WebContentsView({
      webPreferences: {
        session: this.session(),
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
        navigateOnDragDrop: false,
        devTools: false,
        spellcheck: false,
        safeDialogs: true,
        webviewTag: false,
        autoplayPolicy: 'no-user-gesture-required',
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    const wc = view.webContents;
    const entry: BrowseEntry = { viewId, view, wc, bounds: null };
    this.views.set(viewId, entry);
    this.wire(entry);
    win.contentView.addChildView(view);
    void wc.loadURL(decision.url).catch((err: unknown) => {
      this.send({ type: 'load', viewId, state: 'failed', error: String((err as Error)?.message ?? err) });
    });
    return { ok: true, url: decision.url };
  }

  navigate(viewId: string, url: string): { ok: true; url: string } | { ok: false; reason: string } {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return { ok: false, reason: '页面已关闭' };
    const decision = decideExternalLink(url, this.prefs());
    if (decision.action !== 'open') return { ok: false, reason: externalLinkRejectReason(decision) };
    void entry.wc.loadURL(decision.url).catch((err: unknown) => {
      this.send({ type: 'load', viewId, state: 'failed', error: String((err as Error)?.message ?? err) });
    });
    return { ok: true, url: decision.url };
  }

  back(viewId: string): void {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return;
    if (canBack(entry.wc)) goBack(entry.wc);
  }

  reload(viewId: string): void {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return;
    entry.wc.reload();
  }

  async openSystem(viewId: string): Promise<{ ok: boolean; reason?: string }> {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return { ok: false, reason: '页面已关闭' };
    const plan = systemBrowserTarget(entry.wc.getURL());
    if (plan.kind === 'reject') return { ok: false, reason: plan.reason };
    try {
      if (plan.kind === 'file') {
        if (!this.prefs().trustInsecureLinks) return { ok: false, reason: '未信任不安全链接' };
        const err = await shell.openPath(fileURLToPath(plan.url));
        if (err) return { ok: false, reason: err };
        return { ok: true };
      }
      await shell.openExternal(plan.url);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String((err as Error)?.message ?? err) };
    }
  }

  setBounds(viewId: string, bounds: WebBounds | null): void {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return;
    const next = bounds && bounds.width >= 2 && bounds.height >= 2
      ? { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height) }
      : null;
    const before = entry.bounds;
    entry.bounds = next;
    if (next) {
      entry.view.setBounds(next);
      if (!before) entry.view.setVisible(true);
      entry.wc.setBackgroundThrottling(false);
    } else if (before) {
      entry.view.setVisible(false);
      entry.wc.setBackgroundThrottling(true);
    }
  }

  async snapshot(viewId: string): Promise<string | null> {
    const entry = this.views.get(viewId);
    if (!entry || entry.wc.isDestroyed()) return null;
    const img = await entry.wc.capturePage().catch(() => null);
    if (!img || img.isEmpty()) return null;
    return `data:image/jpeg;base64,${img.toJPEG(72).toString('base64')}`;
  }

  destroy(viewId: string): void {
    const entry = this.views.get(viewId);
    if (!entry) return;
    this.views.delete(viewId);
    const win = this.getWin();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(entry.view);
    } catch {
      /* 已移除 */
    }
    if (!entry.wc.isDestroyed()) entry.wc.close({ waitForBeforeUnload: false });
  }

  destroyAll(): void {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }

  private wire(entry: BrowseEntry): void {
    const { wc, viewId } = entry;
    const publishNav = () => {
      if (wc.isDestroyed() || !this.views.has(viewId)) return;
      this.send({
        type: 'nav',
        viewId,
        url: wc.getURL(),
        title: wc.getTitle().slice(0, 200),
        canGoBack: canBack(wc),
      });
    };
    wc.on('will-navigate', (ev) => {
      const decision = decideExternalLink(ev.url, this.prefs());
      if (decision.action === 'open') return;
      ev.preventDefault();
      this.send({ type: 'blocked', viewId, url: ev.url.slice(0, 2000), reason: externalLinkRejectReason(decision) });
    });
    wc.on('will-redirect', (ev) => {
      if (!ev.isMainFrame) {
        if (!browseRequestAllowed(ev.url, false, this.prefs())) ev.preventDefault();
        return;
      }
      const decision = decideExternalLink(ev.url, this.prefs());
      if (decision.action !== 'open') {
        ev.preventDefault();
        this.send({ type: 'blocked', viewId, url: ev.url.slice(0, 2000), reason: externalLinkRejectReason(decision) });
      }
    });
    wc.on('will-frame-navigate', (ev) => {
      if (ev.isMainFrame) return;
      if (ev.url === 'about:blank' || ev.url === 'about:srcdoc') return;
      if (!browseRequestAllowed(ev.url, false, this.prefs())) ev.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      const decision = decideExternalLink(url, this.prefs());
      if (decision.action === 'open') this.send({ type: 'open', url: decision.url });
      else this.send({ type: 'blocked', viewId, url: url.slice(0, 2000), reason: externalLinkRejectReason(decision) });
      return { action: 'deny' };
    });
    wc.on('did-navigate', publishNav);
    wc.on('did-navigate-in-page', (_ev, _url, isMainFrame) => {
      if (isMainFrame) publishNav();
    });
    wc.on('page-title-updated', publishNav);
    wc.on('did-start-loading', () => this.send({ type: 'load', viewId, state: 'loading' }));
    wc.on('did-stop-loading', () => {
      this.send({ type: 'load', viewId, state: 'ready' });
      publishNav();
    });
    wc.on('did-fail-load', (_ev, code, desc, _url, isMainFrame) => {
      // -3 = ABORTED（再次导航或被取消），-20 = BLOCKED_BY_CLIENT（地址被策略拦住，已经单独提示）
      if (!isMainFrame || code === -3 || code === -20) return;
      this.send({ type: 'load', viewId, state: 'failed', error: `${desc}（${code}）` });
    });
    wc.on('devtools-opened', () => wc.closeDevTools());
    wc.on('will-prevent-unload', (ev) => ev.preventDefault());
  }
}

function canBack(wc: WebContents): boolean {
  const history = wc.navigationHistory;
  if (history && typeof history.canGoBack === 'function') return history.canGoBack();
  return wc.canGoBack();
}

function goBack(wc: WebContents): void {
  const history = wc.navigationHistory;
  if (history && typeof history.goBack === 'function') history.goBack();
  else wc.goBack();
}
