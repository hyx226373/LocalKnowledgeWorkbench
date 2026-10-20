/**
 * 网页面板管理器（H9，SDK §6.3 / §12.2，SDK 050df08）。
 *
 * - 每个网页面板 = 主进程创建的一个 WebContentsView，作为主窗口 contentView 的子视图，覆盖在 dock 面板的“网页区域”上。
 *   位置/显示完全由渲染进程按 DOM 中占位元素的矩形逐帧上报（kb:web-bounds），主进程只做 setBounds/setVisible。
 * - 会话：session.fromPartition(persist:kbweb.<pluginId>)（或 kbweb-mem.<pluginId>），每个插件一个分区；
 *   权限请求/检查/设备全部拒绝；webRequest.onBeforeRequest 只放行 https + 默认端口 + 主机 ∈ domains ∪ resourceDomains（D1）；
 *   该分区不注册 kbfile:（以及任何自定义协议），file: 等非 https 一律取消。
 * - 导航：will-navigate / will-redirect / will-frame-navigate 都用 SDK checkNavigation 校验；窗口打开一律 deny；
 *   下载按策略取消（block）或交给系统保存对话框（ask，保存后不自动打开）。被拦截的导航/弹窗/下载上报给渲染进程显示横幅；
 *   离开域名的 https 链接可在用户二次确认后由 shell.openExternal 打开（D2，只允许 https）。
 * - certificate-error 不放行；HTTP 认证（login）与客户端证书选择一律取消；DevTools 禁用。
 * - 滚动：在隔离世界（world 1001）中读写 scrollX/scrollY，页面脚本看不到；节流 SCROLL_POLL_MS 上报。
 * - 浮层：原生视图总是画在主窗口 DOM 之上，渲染进程在工作台菜单/对话框与网页面板相交时把它隐藏，并显示主进程缓存的截图（snapshot）。
 *
 * r11-A（星图 · 网络资料，SDK 修订 10）：内置 web.generic 用逐站授权（net.mode = ask-per-site）。
 *   - 允许的主机 = 声明 ∪ 已批准的 grantedHosts，授权变化时（plugins.onGrantsChanged）刷新已打开的面板；
 *   - 逐站面板允许 http（allowHttp），渲染进程标注“不安全连接”；IP、端口、userinfo、file:/javascript:/data: 顶层仍一律拒绝；
 *   - 顶层导航 / 顶层重定向到未批准主机：取消并发 site-prompt 事件，用户允许后渲染进程调 webGrantSite 再导航；
 *   - 受控下载 fetchForCache（直链 PDF/图片/文本缓存）：同一分区、同一主机检查，手动跟随重定向（每一跳都检查）。
 */
import { app, BrowserWindow, net, session, shell, WebContentsView, type Session, type WebContents } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { checkNavigation, siteHostOf } from '../shared/adapter-sdk/policy';
import { browsePrefsOf, decideExternalLink } from '../shared/externalBrowse';
import { checkSubresource, externalUrlError, hostOf, SCROLL_POLL_MS, type WebBounds, type WebEvent, type WebViewInfo } from '../shared/webPanel';
import type { SubresourceJudgment } from '../shared/webSiteGrant';
import type { WebSiteGrantStore } from './webSiteGrantStore';
import type { AdapterContribution } from '../shared/adapter-sdk/types';
import type { AuditKind } from '../shared/pluginIpc';

/** 主进程用的网页授权快照。数据在数据进程里，这里只保留可同步读取的副本。 */
export interface WebPluginSnap {
  pluginId: string;
  partitions: string[];
  maxAgeDays?: number;
}

export interface WebAccessSnap {
  adapter: AdapterContribution;
  domains: string[];
  resourceDomains: string[];
  partition: string;
  web: NonNullable<AdapterContribution['web']>;
  perSite: boolean;
}

export interface WebAccessSource {
  webAccess(pluginId: string, adapterId: string): WebAccessSnap;
  webPlugins(): WebPluginSnap[];
  onGrantsChanged?(cb: (pluginId: string) => void): () => void;
  /** 可选。主进程只发起，不在询问处理里等待写入。 */
  audit?(pluginId: string, adapterId: string | null, kind: AuditKind, detail: string, code?: string | null): void;
}
import { forwardBoundShortcuts } from './keybindingsForward';
import { WEB_SCALE_MAX, WEB_SCALE_MIN, clampScale, stepWebZoom, webZoomScroll } from '../renderer/zoom/math';

const ISOLATED_WORLD = 1001;

interface Entry {
  viewId: string;
  pluginId: string;
  adapterId: string;
  view: WebContentsView;
  wc: WebContents;
  domains: string[];
  resourceDomains: string[];
  web: NonNullable<AdapterContribution['web']>;
  partition: string;
  bounds: WebBounds | null;
  scroll: { x: number; y: number };
  /** 会话内比例。isolated，不跟同源的另一块面板共享。 */
  zoom: number;
  lastCtrlWheel: { x: number; y: number; at: number } | null;
  poll: NodeJS.Timeout | null;
  loading: boolean;
  shot: Electron.NativeImage | null;
  shotDirty: boolean;
  blocked: Map<string, number>;
  /** 最近被拦截、允许在确认后交给系统浏览器的地址 */
  externalCandidates: Set<string>;
  resBlocked: Map<string, number>;
  /** r12：当前页按网站合并的外部资源。键是可注册域名。 */
  external: Map<string, { count: number }>;
  seenRes: Set<string>;
  quietBlocked: number;
  publishTimer: NodeJS.Timeout | null;
  /** r11-A：逐站授权面板（允许 http；未批准主机发 site-prompt） */
  perSite: boolean;
}

export interface WebPanelStats {
  views: number;
  blockedNavigations: { viewId: string; url: string; reason: string }[];
  blockedResources: { viewId: string | null; url: string }[];
  externalOpened: string[];
  /** 最近的 setScroll（恢复滚动）：目标与实际到达的位置 */
  setScroll: { viewId: string; target: number; got: number; tries: number }[];
}

export class WebPanelManager {
  private views = new Map<string, Entry>();
  private sidebarSuspended = false;
  suspendForSidebar() { this.sidebarSuspended = true; for (const id of this.views.keys()) this.setBounds(id, null); }
  resumeFromSidebar() { this.sidebarSuspended = false; }
  private byWc = new Map<number, Entry>();
  private sessions = new Map<string, { ses: Session; pluginId: string }>();
  /** r11-A：受控下载（fetchForCache）进行中允许的主机：pluginId → 主机集合（没有面板时 onBeforeRequest 用） */
  private fetchHosts = new Map<string, Map<string, number>>();
  /** r11-A：逐站授权的插件（onBeforeRequest 无面板时决定是否允许 http） */
  private perSitePlugins = new Set<string>();
  readonly stats: WebPanelStats = { views: 0, blockedNavigations: [], blockedResources: [], externalOpened: [], setScroll: [] };

  /** 渲染进程推送的已绑定加速键（规范化 Ctrl+…）；供 before-input-event 过滤 */
  private boundShortcuts = new Set<string>();
  private shortcutDisposers = new Map<string, () => void>();
  /** 外链开关打开时，把被拦的顶层地址交给主窗口内容区标签。没接上时仍走原来的横幅。 */
  private externalOpener: ((url: string) => void) | null = null;

  setExternalOpener(fn: ((url: string) => void) | null): void {
    this.externalOpener = fn;
  }

  /** 只有「允许打开外链」且地址被放行时返回 true。javascript: 和关着的开关都返回 false。 */
  private tryExternalTab(url: string): boolean {
    if (!this.externalOpener) return false;
    const decision = decideExternalLink(url, browsePrefsOf(this.siteGrants.snapshot()));
    if (decision.action !== 'open') return false;
    try {
      this.externalOpener(decision.url);
    } catch {
      /* 渲染进程还没接上 */
    }
    return true;
  }

  constructor(
    private getWin: () => BrowserWindow | null,
    private plugins: WebAccessSource,
    private send: (ev: WebEvent) => void,
    private kv: { get(k: string): unknown; set(k: string, v: unknown): void },
    private siteGrants: WebSiteGrantStore,
  ) {
    // r11-A：逐站批准 / 撤销 / 启用状态变化后刷新已打开面板允许的主机
    plugins.onGrantsChanged?.((pluginId) => this.refreshAccess(pluginId));
    // 证书错误不放行；HTTP 认证与客户端证书选择一律取消（只针对网页面板；主窗口不加载网络内容）
    app.on('certificate-error', (e, wc, _url, _err, _cert, cb) => {
      if (!this.byWc.has(wc.id)) return;
      e.preventDefault();
      cb(false);
    });
    app.on('login', (e, wc, _d, _auth, cb) => {
      if (!wc || !this.byWc.has(wc.id)) return;
      e.preventDefault();
      cb();
    });
    app.on('select-client-certificate', (e, wc, _url, _list, cb) => {
      if (!wc || !this.byWc.has(wc.id)) return;
      e.preventDefault();
      cb();
    });
  }

  /** 测试专用：KB_TEST_WEB_FIXTURE=<目录> 时把 https://<主机>/… 映射到 <目录>/<主机>/…（见 docs/06 §11.6）；正式运行不设置 */
  private fixtureDir = process.env.KB_TEST_WEB_FIXTURE ? path.resolve(process.env.KB_TEST_WEB_FIXTURE) : null;

  private sessionFor(partition: string, pluginId: string): Session {
    const known = this.sessions.get(partition);
    if (known) return known.ses;
    const ses = session.fromPartition(partition, { cache: true });
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.on('select-hid-device', (e, _d, cb) => (e.preventDefault(), cb()));
    ses.on('select-serial-port', (e, _p, _wc, cb) => (e.preventDefault(), cb('')));
    ses.on('select-usb-device', (e, _d, cb) => (e.preventDefault(), cb()));
    ses.setSpellCheckerEnabled(false);
    // D1：每个请求都按域名检查。顶层仍同步查声明域名。
    // r12：子资源改查内存里的网站授权（异步、O(1)，不读盘）。没决定的先取消，并入同一条提示。
    ses.webRequest.onBeforeRequest((details, cb) => {
      const e = details.webContentsId !== undefined ? this.byWc.get(details.webContentsId) : undefined;
      const isMain = details.resourceType === 'mainFrame';
      const allowHttp = e ? e.perSite : this.perSitePlugins.has(pluginId);
      if (isMain) {
        const domains = e ? e.domains : this.pluginResourceDomains(pluginId);
        const ok = checkNavigation(details.url, domains, { allowHttp }).ok;
        if (!ok) this.noteResourceBlocked(e ?? null, pluginId, details.url, details.resourceType);
        cb({ cancel: !ok });
        return;
      }
      const domains = e ? e.resourceDomains : this.pluginResourceDomains(pluginId);
      let settled = false;
      const finish = (cancel: boolean) => {
        if (settled) return;
        settled = true;
        try {
          cb({ cancel });
        } catch {
          /* 请求已经结束 */
        }
      };
      void this.siteGrants
        .judge(details.url, domains, { allowHttp })
        .then((judgment) => {
          finish(judgment.action !== 'allow');
          if (judgment.action !== 'allow') this.onSubresourceCancelled(e ?? null, pluginId, details.url, details.resourceType, judgment);
        })
        .catch(() => finish(true));
    });
    ses.on('will-download', (e, item, wc) => {
      const en = this.byWc.get(wc.id);
      if (!en || en.web.downloads !== 'ask' || checkSubresource(item.getURL(), en.resourceDomains, { allowHttp: en.perSite }).ok === false) {
        e.preventDefault();
        if (en) this.blocked(en, item.getURL(), 'download-blocked');
        return;
      }
      // ask：交给系统保存对话框，保存后不自动打开
      item.setSaveDialogOptions({ title: '保存网页面板中的下载' });
    });
    if (this.fixtureDir) this.installFixture(ses);
    this.sessions.set(partition, { ses, pluginId });
    return ses;
  }

  /**
   * 测试用本地站点：只服务夹具目录中存在的主机；其余主机返回 502（等同于连不上）。域名检查仍由 onBeforeRequest 在之前完成。
   * r11-A：同样服务 http://（逐站授权允许 http）；<主机>/.offline 存在时返回网络错误（模拟断网，e2e 删除后重试）；
   * <文件>.redirect 存在时返回 302 到其中写的地址（重定向检查）。
   */
  private installFixture(ses: Session) {
    const dir = this.fixtureDir!;
    const handler = async (req: Request) => {
      const u = new URL(req.url);
      const hostDir = path.join(dir, u.hostname);
      if (!fs.existsSync(hostDir)) return new Response('fixture: unknown host', { status: 502 });
      if (fs.existsSync(path.join(hostDir, '.offline'))) return Response.error();
      const redirect = path.normalize(path.join(hostDir, decodeURIComponent(u.pathname))) + '.redirect';
      if (redirect.startsWith(hostDir + path.sep) && fs.existsSync(redirect)) return new Response(null, { status: 302, headers: { location: fs.readFileSync(redirect, 'utf8').trim() } });
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      const abs = path.normalize(path.join(hostDir, rel));
      if (!abs.startsWith(hostDir + path.sep)) return new Response('bad path', { status: 400 });
      const file = fs.existsSync(abs) && fs.statSync(abs).isFile() ? abs : fs.existsSync(abs + '.html') ? abs + '.html' : fs.existsSync(path.join(abs, 'index.html')) ? path.join(abs, 'index.html') : null;
      if (!file) return new Response('not found', { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const typeFile = fs.existsSync(file + '.type') ? fs.readFileSync(file + '.type', 'utf8').trim() : null; // r11-A：夹具可指定 Content-Type（类型冲突用例）
      const type =
        typeFile ??
        (file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.json') ? 'application/json' : file.endsWith('.png') ? 'image/png' : file.endsWith('.zip') ? 'application/zip' : file.endsWith('.pdf') ? 'application/pdf' : file.endsWith('.md') ? 'text/markdown; charset=utf-8' : file.endsWith('.txt') ? 'text/plain; charset=utf-8' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream');
      // 夹具里的兼容性数据要被 developer.mozilla.org 页面跨源 fetch（真实 bcd 服务同样返回 CORS 头）
      const headers: Record<string, string> = { 'content-type': type, 'access-control-allow-origin': '*' };
      if (file.endsWith('.zip')) headers['content-disposition'] = 'attachment; filename="file.zip"';
      return new Response(fs.readFileSync(file), { headers });
    };
    ses.protocol.handle('https', handler);
    ses.protocol.handle('http', handler);
  }

  private pluginResourceDomains(pluginId: string): string[] {
    const out = new Set<string>();
    for (const e of this.views.values()) if (e.pluginId === pluginId) e.resourceDomains.forEach((d) => out.add(d));
    for (const h of this.fetchHosts.get(pluginId)?.keys() ?? []) out.add(h);
    return [...out];
  }

  // ---- r11-A 网络资料 ----

  /** 授权变化：重新计算该插件已打开面板允许的主机；插件级被撤销 / 禁用时由调用方销毁面板 */
  refreshAccess(pluginId: string) {
    for (const e of this.views.values()) {
      if (e.pluginId !== pluginId) continue;
      try {
        const acc = this.plugins.webAccess(pluginId, e.adapterId);
        e.domains = acc.domains;
        e.resourceDomains = acc.resourceDomains;
        this.send({ viewId: e.viewId, type: 'access', allowedDomains: acc.domains, resourceDomains: acc.resourceDomains });
      } catch {
        /* 撤销 / 禁用：index.ts 的 pluginRevoke / pluginSetEnabled 会销毁面板 */
      }
    }
  }

  /** 顶层导航被拒：外链开关开着就改到内容区标签；否则逐站询问或照旧横幅 */
  private navDenied(e: Entry, url: string, r: { ok: false; reason: string }) {
    if (this.tryExternalTab(url)) return;
    const host = e.perSite && r.reason === 'domain-blocked' ? siteHostOf(url) : null;
    if (host) {
      // 用户拒绝时可以改用系统浏览器打开（只允许 https，策略为 open-external-with-confirm）
      if (e.web.offDomain === 'open-external-with-confirm' && externalUrlError(url) === null) e.externalCandidates.add(url);
      this.send({ viewId: e.viewId, type: 'site-prompt', host, url: url.slice(0, 2000) });
      return;
    }
    this.blocked(e, url, r.reason === 'scheme-blocked' ? 'scheme-blocked' : 'domain-blocked');
  }

  /**
   * 受控下载（直链 PDF / 图片 / md / txt 缓存）：主进程在适配器分区内请求，主机必须已批准（逐站）或在声明域名内；
   * 手动跟随重定向（最多 5 跳，每跳重新检查），超时与大小上限由调用方给出。不带渲染进程的任何 Cookie / 头。
   */
  async fetchForCache(
    pluginId: string,
    adapterId: string,
    url: string,
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<
    | { ok: true; finalUrl: string; status: number; contentType: string; contentDisposition: string; bytes: Buffer }
    | { ok: false; reason: 'site-not-granted'; host: string; url: string }
    | { ok: false; reason: 'blocked' | 'network' | 'timeout' | 'http' | 'too-large'; status?: number; detail: string }
  > {
    const acc = this.plugins.webAccess(pluginId, adapterId);
    const ses = this.sessionFor(acc.partition, pluginId);
    if (acc.perSite) this.perSitePlugins.add(pluginId);
    const timeoutMs = Math.max(1000, Math.min(Number(opts.timeoutMs) || 20000, 120000));
    const maxBytes = Math.max(1, Math.min(Number(opts.maxBytes) || 100 * 1024 * 1024, 500 * 1024 * 1024));
    type Out = Awaited<ReturnType<WebPanelManager['fetchForCache']>>;
    const held: string[] = [];
    const hold = (h: string) => {
      const m = this.fetchHosts.get(pluginId) ?? new Map<string, number>();
      m.set(h, (m.get(h) ?? 0) + 1);
      this.fetchHosts.set(pluginId, m);
      held.push(h);
    };
    /** 每一跳（含重定向目标）都按当前授权检查：未批准的主机 → site-not-granted（界面询问）；协议 / IP / 端口 → blocked */
    const gate = (u: string): Out | null => {
      const r = checkNavigation(u, acc.domains, { allowHttp: acc.perSite });
      if (r.ok) return null;
      const host = acc.perSite && r.reason === 'domain-blocked' ? siteHostOf(u) : null;
      if (host) return { ok: false, reason: 'site-not-granted', host, url: u };
      return { ok: false, reason: 'blocked', detail: `地址不允许：${r.reason}` };
    };
    const hdr = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
    try {
      const first = gate(String(url));
      if (first) return first;
      hold(new URL(String(url)).hostname);
      // 逐跳请求：net.request + redirect:'manual'。重定向（'redirect' 事件，或协议处理器直接给出的 3xx + Location）
      // 一律中止当前请求，检查目标后再发下一跳（Electron 的 ses.fetch 在 manual 模式下直接取消请求，拿不到 Location）
      const deadline = Date.now() + timeoutMs;
      type Hop = Out | { redirect: string };
      const once = (cur: string) =>
        new Promise<Hop>((resolve) => {
          let settled = false;
          const req = net.request({ url: cur, session: ses, redirect: 'manual', useSessionCookies: true });
          const done = (v: Hop) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(v);
          };
          const timer = setTimeout(() => {
            req.abort();
            done({ ok: false, reason: 'timeout', detail: `请求超时（${Math.round(timeoutMs / 1000)} 秒）` });
          }, Math.max(1, deadline - Date.now()));
          req.on('redirect', (_status, _method, redirectUrl) => {
            req.abort();
            done({ redirect: redirectUrl });
          });
          req.on('response', (res) => {
            const status = res.statusCode;
            const loc = hdr(res.headers['location']);
            if (status >= 300 && status < 400 && loc) {
              res.on('data', () => undefined);
              req.abort();
              return done({ redirect: loc });
            }
            if (status < 200 || status >= 300) {
              res.on('data', () => undefined);
              req.abort();
              return done({ ok: false, reason: 'http', status, detail: `HTTP ${status}` });
            }
            const len = Number(hdr(res.headers['content-length']) || 0);
            if (len > maxBytes) {
              req.abort();
              return done({ ok: false, reason: 'too-large', detail: `文件超过 ${Math.round(maxBytes / 1048576)} MB` });
            }
            const chunks: Buffer[] = [];
            let n = 0;
            res.on('data', (c: Buffer) => {
              n += c.length;
              if (n > maxBytes) {
                req.abort();
                return done({ ok: false, reason: 'too-large', detail: `文件超过 ${Math.round(maxBytes / 1048576)} MB` });
              }
              chunks.push(c);
            });
            res.on('end', () => done({ ok: true, finalUrl: cur, status, contentType: hdr(res.headers['content-type']), contentDisposition: hdr(res.headers['content-disposition']), bytes: Buffer.concat(chunks) }));
            res.on('error', (err: Error) => done({ ok: false, reason: 'network', detail: String(err?.message ?? err).slice(0, 200) }));
          });
          req.on('error', (err) => done({ ok: false, reason: /TIMED_OUT/.test(String(err?.message)) ? 'timeout' : 'network', detail: String(err?.message ?? err).slice(0, 200) }));
          req.end();
        });
      let cur = String(url);
      for (let hop = 0; hop <= 5; hop++) {
        const r = await once(cur);
        if (!('redirect' in r)) return r;
        let next: string;
        try {
          next = new URL(r.redirect, cur).toString();
        } catch {
          return { ok: false, reason: 'blocked', detail: '重定向地址无效' };
        }
        const g = gate(next);
        if (g) return g;
        hold(new URL(next).hostname);
        cur = next;
      }
      return { ok: false, reason: 'blocked', detail: '重定向次数过多' };
    } finally {
      const m = this.fetchHosts.get(pluginId);
      for (const h of held) {
        const c = (m?.get(h) ?? 1) - 1;
        if (c <= 0) m?.delete(h);
        else m?.set(h, c);
      }
    }
  }

  /** 网页面板当前页另存为 MHTML（保存到本地；路径由主进程决定） */
  async savePage(viewId: string, abs: string): Promise<void> {
    const e = this.get(viewId);
    await e.wc.savePage(abs, 'MHTML');
  }

  /** 面板当前页的标题与地址（保存到本地、加入工作资料用） */
  pageInfo(viewId: string): { url: string; title: string; pluginId: string; adapterId: string } {
    const e = this.get(viewId);
    return { url: e.wc.getURL(), title: e.wc.getTitle().slice(0, 300), pluginId: e.pluginId, adapterId: e.adapterId };
  }

  create(viewId: string, pluginId: string, adapterId: string): WebViewInfo {
    if (typeof viewId !== 'string' || !/^[\w.:-]{1,120}$/.test(viewId)) throw new Error('viewId 不合法');
    const acc = this.plugins.webAccess(pluginId, adapterId);
    const retained = this.views.get(viewId);
    if (retained && retained.pluginId === pluginId && retained.adapterId === adapterId) {
      return { viewId, partition: acc.partition, allowedDomains: acc.domains, resourceDomains: acc.resourceDomains,
        homeUrl: acc.web.homeUrl, offDomain: acc.web.offDomain, popups: acc.web.popups, downloads: acc.web.downloads,
        ...(retained.perSite ? { perSite: true } : {}) };
    }
    this.destroy(viewId);
    const win = this.getWin();
    if (!win) throw new Error('窗口不可用');
    const ses = this.sessionFor(acc.partition, pluginId);
    const view = new WebContentsView({
      webPreferences: {
        session: ses,
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
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    const wc = view.webContents;
    const e: Entry = {
      viewId,
      pluginId,
      adapterId,
      view,
      wc,
      domains: acc.domains,
      resourceDomains: acc.resourceDomains,
      web: acc.web,
      partition: acc.partition,
      bounds: null,
      scroll: { x: 0, y: 0 },
      zoom: 1,
      lastCtrlWheel: null,
      poll: null,
      loading: false,
      shot: null,
      shotDirty: true,
      blocked: new Map(),
      externalCandidates: new Set(),
      resBlocked: new Map(),
      external: new Map(),
      seenRes: new Set(),
      quietBlocked: 0,
      publishTimer: null,
      perSite: acc.perSite === true,
    };
    if (e.perSite) this.perSitePlugins.add(pluginId);
    this.views.set(viewId, e);
    this.byWc.set(wc.id, e);
    this.stats.views = this.views.size;
    this.wire(e);
    win.contentView.addChildView(view);
    if (acc.web.session?.partition !== 'ephemeral') this.kv.set(`web.lastUsed.${pluginId}`, Date.now());
    return {
      viewId,
      partition: acc.partition,
      allowedDomains: acc.domains,
      resourceDomains: acc.resourceDomains,
      homeUrl: acc.web.homeUrl,
      offDomain: acc.web.offDomain,
      popups: acc.web.popups,
      downloads: acc.web.downloads,
      ...(e.perSite ? { perSite: true } : {}),
    };
  }

  private wire(e: Entry) {
    const { wc } = e;
    // 同源的两块面板不共享比例。这三段放在 wire() 开头；后面是 A 的导航 / 域名 / 逐站授权，不要并进来。
    wc.setZoomMode('isolated');
    wc.on('input-event', (_ev, input) => {
      const wheel = input as { type?: string; x?: number; y?: number; modifiers?: string[] };
      if (wheel.type !== 'mouseWheel') return;
      const mods = wheel.modifiers ?? [];
      if (!mods.includes('control') && !mods.includes('ctrl')) return;
      e.lastCtrlWheel = { x: Number(wheel.x) || 0, y: Number(wheel.y) || 0, at: Date.now() };
    });
    wc.on('zoom-changed', (_ev, direction) => {
      void this.applyWebZoomStep(e, direction === 'in' ? 1 : -1);
    });
    const navEvent = (url: string, inPage: boolean) =>
      this.send({ viewId: e.viewId, type: 'navigate', url, inPage, canGoBack: wc.navigationHistory.canGoBack(), canGoForward: wc.navigationHistory.canGoForward(), title: wc.getTitle().slice(0, 200) });
    // 顶层：页面发起的导航（链接、location、表单、meta refresh）
    wc.on('will-navigate', (ev) => {
      const r = checkNavigation(ev.url, e.domains, { allowHttp: e.perSite });
      if (!r.ok) {
        ev.preventDefault();
        this.navDenied(e, ev.url, r);
        return;
      }
      // 换页前清掉上一页的提示。子资源在这之后才进来，不会被这次清空抹掉。
      this.resetExternal(e);
    });
    // 重定向：顶层按 domains，子框架按网站授权（只查内存表）
    wc.on('will-redirect', (ev) => {
      if (!ev.isMainFrame) {
        if (ev.url === 'about:blank' || ev.url === 'about:srcdoc') return;
        const judgment = this.siteGrants.judgeNow(ev.url, e.resourceDomains, { allowHttp: e.perSite });
        if (judgment.action !== 'allow') {
          ev.preventDefault();
          this.onSubresourceCancelled(e, e.pluginId, ev.url, 'subFrame', judgment);
        }
        return;
      }
      const r = checkNavigation(ev.url, e.domains, { allowHttp: e.perSite });
      if (!r.ok) {
        ev.preventDefault();
        this.navDenied(e, ev.url, r);
      }
    });
    wc.on('will-frame-navigate', (ev) => {
      if (ev.isMainFrame) return; // 顶层由 will-navigate 处理
      if (ev.url === 'about:blank' || ev.url === 'about:srcdoc') return;
      const judgment = this.siteGrants.judgeNow(ev.url, e.resourceDomains, { allowHttp: e.perSite });
      if (judgment.action !== 'allow') {
        ev.preventDefault();
        this.onSubresourceCancelled(e, e.pluginId, ev.url, 'subFrame', judgment);
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      const inDomain = checkNavigation(url, e.domains, { allowHttp: e.perSite }).ok === true;
      if (!inDomain && this.tryExternalTab(url)) return { action: 'deny' };
      this.blocked(e, url, 'popup-blocked');
      return { action: 'deny' };
    });
    wc.on('did-navigate', (_ev, url) => {
      e.shotDirty = true;
      navEvent(url, false);
    });
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => {
      if (isMainFrame) navEvent(url, true);
    });
    wc.on('page-title-updated', () => navEvent(wc.getURL(), true));
    wc.on('did-start-loading', () => {
      e.loading = true;
      this.send({ viewId: e.viewId, type: 'load', state: 'loading' });
    });
    wc.on('did-stop-loading', () => {
      e.loading = false;
      e.shotDirty = true;
      this.send({ viewId: e.viewId, type: 'load', state: 'ready' });
    });
    wc.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      // -3 = ABORTED（被我们取消或用户再次导航），-20 = BLOCKED_BY_CLIENT（被域名规则拦截，已经以横幅提示）
      if (!isMainFrame || code === -3 || code === -20) return;
      this.send({ viewId: e.viewId, type: 'load', state: 'failed', error: `${desc}（${code}）：${hostOf(url)}` });
    });
    wc.on('render-process-gone', (_ev, d) => this.send({ viewId: e.viewId, type: 'gone', reason: d.reason }));
    // 禁止页面打开 DevTools、禁止拖入文件导航（navigateOnDragDrop 已关）、禁止缩放快捷键之外的特殊行为
    wc.on('devtools-opened', () => wc.closeDevTools());
    wc.on('will-prevent-unload', (ev) => ev.preventDefault()); // 不让页面用 beforeunload 卡住关闭
    // ---- r11-B：只转发已绑定组合键到主窗口渲染进程
    const offFwd = forwardBoundShortcuts(
      wc,
      () => this.boundShortcuts,
      (accel) => {
        const w = this.getWin();
        if (w && !w.isDestroyed()) w.webContents.send('kb:forwarded-shortcut', accel);
      },
    );
    this.shortcutDisposers.set(e.viewId, offFwd);
  }

  private blocked(e: Entry, url: string, reason: 'domain-blocked' | 'scheme-blocked' | 'popup-blocked' | 'download-blocked') {
    const policy = reason === 'popup-blocked' ? e.web.popups : reason === 'download-blocked' ? 'block' : e.web.offDomain;
    // 能交给系统浏览器：策略允许、https、且不是本插件允许的域（域内弹窗也可以交给系统浏览器）
    const external = policy === 'open-external-with-confirm' && externalUrlError(url) === null;
    if (external) {
      e.externalCandidates.add(url);
      if (e.externalCandidates.size > 50) e.externalCandidates.delete(e.externalCandidates.values().next().value as string);
    }
    this.stats.blockedNavigations.push({ viewId: e.viewId, url: url.slice(0, 300), reason });
    if (this.stats.blockedNavigations.length > 200) this.stats.blockedNavigations.shift();
    this.send({ viewId: e.viewId, type: 'blocked', url: url.slice(0, 2000), reason, external });
    const what = reason === 'popup-blocked' ? '弹窗' : reason === 'download-blocked' ? '下载' : '导航';
    this.plugins.audit?.(e.pluginId, e.adapterId, 'web-blocked', `${what}被拦截：${safeUrl(url)}`, reason);
  }

  /** 子资源被取消。同一 URL 只计一次；同一网站并进一条提示，不再逐条弹出。 */
  private onSubresourceCancelled(e: Entry | null, pluginId: string, url: string, type: string, judgment: SubresourceJudgment) {
    if (e?.seenRes.has(url)) return;
    e?.seenRes.add(url);
    if (e && e.seenRes.size > 800) {
      const first = e.seenRes.values().next().value;
      if (first) e.seenRes.delete(first);
    }
    this.stats.blockedResources.push({ viewId: e?.viewId ?? null, url: url.slice(0, 300) });
    if (this.stats.blockedResources.length > 500) this.stats.blockedResources.shift();
    if (!e) return;
    if (judgment.prompt && judgment.site) {
      const row = e.external.get(judgment.site) ?? { count: 0 };
      const firstSite = row.count === 0;
      row.count += 1;
      e.external.set(judgment.site, row);
      this.scheduleExternal(e);
      if (firstSite) {
        const site = judgment.site;
        setImmediate(() => {
          try {
            this.plugins.audit?.(pluginId, e.adapterId, 'web-blocked', `外部资源按网站询问：${site}（${type}）`, 'resource-blocked');
          } catch {
            /* 插件已卸载 */
          }
        });
      }
      return;
    }
    e.quietBlocked += 1;
    this.scheduleExternal(e);
  }

  private scheduleExternal(e: Entry) {
    if (e.publishTimer) clearTimeout(e.publishTimer);
    e.publishTimer = setTimeout(() => {
      e.publishTimer = null;
      this.publishExternal(e);
    }, 80);
  }

  private publishExternal(e: Entry) {
    if (!this.views.has(e.viewId)) return;
    const snap = this.siteGrants.snapshot();
    const sites: { site: string; count: number }[] = [];
    let blocked = e.quietBlocked;
    for (const [site, row] of e.external) {
      if (snap.globalNeverBlock || snap.sites.has(site)) continue;
      blocked += row.count;
      sites.push({ site, count: row.count });
    }
    sites.sort((a, b) => a.site.localeCompare(b.site));
    this.send({ viewId: e.viewId, type: 'external-sites', sites, blockedCount: blocked });
  }

  private resetExternal(e: Entry) {
    if (e.publishTimer) clearTimeout(e.publishTimer);
    e.publishTimer = null;
    e.external.clear();
    e.seenRes.clear();
    e.quietBlocked = 0;
    this.publishExternal(e);
  }

  /** 授权变了就忘掉这一页已经计过的拦截，重新加载时按新决定再计。 */
  forgetExternal(viewId?: string) {
    for (const e of this.views.values()) {
      if (viewId && e.viewId !== viewId) continue;
      if (e.publishTimer) clearTimeout(e.publishTimer);
      e.publishTimer = null;
      e.external.clear();
      e.seenRes.clear();
      e.quietBlocked = 0;
    }
  }

  /** 人机界面改完授权后刷新提示条。 */
  refreshExternal(viewId?: string) {
    for (const e of this.views.values()) {
      if (viewId && e.viewId !== viewId) continue;
      this.publishExternal(e);
    }
  }

  viewIds(): string[] {
    return [...this.views.keys()];
  }

  reloadAll() {
    for (const id of this.viewIds()) {
      try {
        this.reload(id);
      } catch {
        /* 面板已关 */
      }
    }
  }

  /** 授权变化后重新加载，绕过缓存，让新的放行或撤销作用到脚本和样式。 */
  reloadFresh(viewId: string) {
    const e = this.views.get(viewId);
    if (!e) return;
    e.wc.reloadIgnoringCache();
  }

  reloadAllFresh() {
    for (const id of this.viewIds()) this.reloadFresh(id);
  }

  private noteResourceBlocked(e: Entry | null, pluginId: string, url: string, type: string) {
    const host = hostOf(url);
    this.stats.blockedResources.push({ viewId: e?.viewId ?? null, url: url.slice(0, 300) });
    if (this.stats.blockedResources.length > 500) this.stats.blockedResources.shift();
    if (!e) return;
    const n = (e.resBlocked.get(host) ?? 0) + 1;
    e.resBlocked.set(host, n);
    // 每个主机只在第 1 次时写审计、通知渲染进程（之后只累加计数，避免刷屏）
    if (n === 1) this.plugins.audit?.(pluginId, e.adapterId, 'web-blocked', `子资源（${type}）被拦截：${host}`, 'resource-blocked');
    this.send({ viewId: e.viewId, type: 'resource-blocked', host, count: [...e.resBlocked.values()].reduce((a, b) => a + b, 0) });
  }

  private get(viewId: string): Entry {
    const e = this.views.get(viewId);
    if (!e) throw new Error('网页面板不存在');
    return e;
  }


  /** ---- r11-B 快捷键：更新已绑定集合（所有网页面板共用） */
  setBoundShortcuts(keys: string[]) {
    this.boundShortcuts = new Set((keys ?? []).map(String).filter(Boolean));
  }

  /** 插件或工作台（“回到首页”）发起的导航：主进程再按 manifest 域名检查一次 */
  navigate(viewId: string, url: string) {
    const e = this.get(viewId);
    const r = checkNavigation(String(url), e.domains, { allowHttp: e.perSite });
    if (!r.ok) {
      this.navDenied(e, String(url), r);
      return r;
    }
    e.wc.loadURL(String(url)).catch(() => undefined);
    return { ok: true as const };
  }
  back(viewId: string) {
    const h = this.get(viewId).wc.navigationHistory;
    if (h.canGoBack()) h.goBack();
  }
  forward(viewId: string) {
    const h = this.get(viewId).wc.navigationHistory;
    if (h.canGoForward()) h.goForward();
  }
  reload(viewId: string) {
    this.get(viewId).wc.reload();
  }
  currentUrl(viewId: string): string {
    return this.get(viewId).wc.getURL();
  }

  getZoom(viewId: string): { scale: number } {
    return { scale: this.get(viewId).zoom };
  }

  /** 显式设置比例（0.5–3）。锚点用面板中心，best-effort。 */
  async setZoom(viewId: string, scale: number): Promise<{ scale: number }> {
    const e = this.get(viewId);
    const mouse = e.bounds ? { x: e.bounds.width / 2, y: e.bounds.height / 2 } : { x: 0, y: 0 };
    return this.commitWebZoom(e, clampScale(Number(scale), WEB_SCALE_MIN, WEB_SCALE_MAX), mouse);
  }

  /** Ctrl+滚轮：zoom-changed 只有方向，这里按 1.1 进一格。 */
  private async applyWebZoomStep(e: Entry, direction: 1 | -1) {
    const stamp = e.lastCtrlWheel;
    if (!stamp || Date.now() - stamp.at > 1000) return;
    await this.commitWebZoom(e, stepWebZoom(e.zoom, direction), { x: stamp.x, y: stamp.y });
  }

  private async commitWebZoom(e: Entry, next: number, mouse: { x: number; y: number }): Promise<{ scale: number }> {
    const prev = e.zoom > 0 ? e.zoom : 1;
    const scale = clampScale(next, WEB_SCALE_MIN, WEB_SCALE_MAX);
    if (Math.abs(scale - prev) < 1e-4) return { scale: prev };
    const before = await this.getScroll(e.viewId).catch(() => e.scroll);
    e.zoom = scale;
    try {
      e.wc.setZoomFactor(scale);
    } catch {
      /* 视图已销毁 */
    }
    const x = Math.max(0, Math.round(webZoomScroll(before.x, mouse.x, prev, scale)));
    const y = Math.max(0, Math.round(webZoomScroll(before.y, mouse.y, prev, scale)));
    await this.writeScrollOnce(e, x, y);
    this.send({ viewId: e.viewId, type: 'zoom', scale });
    return { scale };
  }

  private async writeScrollOnce(e: Entry, x: number, y: number) {
    const left = Math.max(0, Math.round(x));
    const top = Math.max(0, Math.round(y));
    try {
      const r = (await e.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [
        { code: `scrollTo({ left: ${left}, top: ${top}, behavior: 'instant' }); [Math.round(scrollX), Math.round(scrollY)]` },
      ])) as [number, number];
      e.scroll = { x: Number(r?.[0]) || 0, y: Number(r?.[1]) || 0 };
    } catch {
      e.scroll = { x: left, y: top };
    }
  }

  async getScroll(viewId: string): Promise<{ x: number; y: number }> {
    const e = this.get(viewId);
    try {
      const r = (await e.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: '[Math.round(scrollX), Math.round(scrollY)]' }])) as [number, number];
      return { x: Number(r?.[0]) || 0, y: Number(r?.[1]) || 0 };
    } catch {
      return e.scroll;
    }
  }

  /** 恢复滚动：页面内容可能还在增长（懒加载），最多重试 ~3 秒直到到达目标或无法再滚 */
  async setScroll(viewId: string, pos: { x: number; y: number }): Promise<{ x: number; y: number }> {
    const e = this.get(viewId);
    const x = Math.max(0, Math.round(Number(pos?.x) || 0));
    const y = Math.max(0, Math.round(Number(pos?.y) || 0));
    let got = { x: 0, y: 0 };
    let tries = 0;
    for (let i = 0; i < 15; i++) {
      tries++;
      try {
        const r = (await e.wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: `scrollTo({ left: ${x}, top: ${y}, behavior: 'instant' }); [Math.round(scrollX), Math.round(scrollY)]` }])) as [number, number];
        got = { x: Number(r?.[0]) || 0, y: Number(r?.[1]) || 0 };
      } catch {
        /* 页面正在切换 */
      }
      if (Math.abs(got.y - y) <= 2) break;
      await new Promise((r) => setTimeout(r, 200));
      if (!this.views.has(viewId)) break;
    }
    e.scroll = got;
    e.shotDirty = true;
    this.stats.setScroll.push({ viewId, target: y, got: got.y, tries });
    if (this.stats.setScroll.length > 50) this.stats.setScroll.shift();
    return got;
  }

  /** 渲染进程逐帧上报的位置；null = 隐藏（标签页不可见、被浮层覆盖、面板太小） */
  setBounds(viewId: string, b: WebBounds | null) {
    const e = this.views.get(viewId);
    if (!e) return;
    if (this.sidebarSuspended) b = null;
    if (b && (b.width < 2 || b.height < 2)) b = null;
    const before = e.bounds;
    e.bounds = b ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : null;
    if (e.bounds) {
      e.view.setBounds(e.bounds);
      if (!before) e.view.setVisible(true);
      this.startPoll(e);
    } else if (before) {
      e.view.setVisible(false);
      this.stopPoll(e);
    }
  }

  private startPoll(e: Entry) {
    if (e.poll) return;
    let stableTicks = 0;
    e.poll = setInterval(async () => {
      if (!this.views.has(e.viewId) || e.wc.isDestroyed()) return this.stopPoll(e);
      if (e.loading) return;
      const s = await this.getScroll(e.viewId).catch(() => e.scroll);
      if (s.x !== e.scroll.x || s.y !== e.scroll.y) {
        e.scroll = s;
        e.shotDirty = true;
        stableTicks = 0;
        this.send({ viewId: e.viewId, type: 'scroll', x: s.x, y: s.y });
      } else if (e.shotDirty && ++stableTicks >= 2 && e.bounds) {
        // 滚动/加载稳定后缓存一张截图：浮层打开、网页面板被隐藏时显示
        // 刚加载完时可能截到空图（还没绘制）：空图不覆盖旧截图，下个稳定周期再截
        e.shotDirty = false;
        const img = await e.wc.capturePage().catch(() => null);
        if (img && !img.isEmpty()) e.shot = img;
        else e.shotDirty = true;
      }
    }, SCROLL_POLL_MS);
  }
  private stopPoll(e: Entry) {
    if (e.poll) clearInterval(e.poll);
    e.poll = null;
  }

  /** 缓存的截图（JPEG data URL），没有则 null */
  async snapshot(viewId: string): Promise<string | null> {
    const e = this.views.get(viewId);
    if (!e) return null;
    // 还没有缓存（页面一直没稳定、或刚显示就被遮住）：当场截一张（视图隐藏后仍保留最后一帧）
    if ((!e.shot || e.shot.isEmpty()) && !e.wc.isDestroyed() && !e.loading) {
      const img = await e.wc.capturePage().catch(() => null);
      if (img && !img.isEmpty()) e.shot = img;
    }
    if (!e.shot || e.shot.isEmpty()) return null;
    return `data:image/jpeg;base64,${e.shot.toJPEG(72).toString('base64')}`;
  }

  /**
   * D2：用系统浏览器打开（只允许 https）。viewId 给出时只接受该面板最近被拦截的地址（横幅按钮）；
   * 否则（domain-blocked 占位的按钮）只接受该插件条目的地址，由调用方传入 pluginId 记录审计。
   */
  async openExternal(url: string, from: { viewId?: string; pluginId?: string; adapterId?: string }): Promise<{ ok: boolean; reason?: string }> {
    const err = externalUrlError(String(url));
    if (err) return { ok: false, reason: err };
    let pluginId = from.pluginId;
    let adapterId = from.adapterId ?? null;
    if (from.viewId) {
      const e = this.get(from.viewId);
      if (!e.externalCandidates.has(url)) return { ok: false, reason: '只能打开本面板刚被拦截的地址' };
      pluginId = e.pluginId;
      adapterId = e.adapterId;
    }
    await shell.openExternal(String(url));
    this.stats.externalOpened.push(String(url));
    if (pluginId) {
      try {
        this.plugins.audit?.(pluginId, adapterId, 'web-external', `用系统浏览器打开：${safeUrl(url)}`);
      } catch {
        /* 插件已卸载 */
      }
    }
    return { ok: true };
  }

  releaseFromRenderer(viewId: string) {
    if (this.sidebarSuspended) { this.setBounds(viewId, null); return; }
    this.destroy(viewId);
  }

  destroy(viewId: string) {
    const e = this.views.get(viewId);
    if (!e) return;
    this.shortcutDisposers.get(viewId)?.();
    this.shortcutDisposers.delete(viewId);
    if (e.publishTimer) clearTimeout(e.publishTimer);
    e.publishTimer = null;
    this.stopPoll(e);
    this.views.delete(viewId);
    this.byWc.delete(e.wc.id);
    this.stats.views = this.views.size;
    const win = this.getWin();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(e.view);
    } catch {
      /* 已移除 */
    }
    if (!e.wc.isDestroyed()) e.wc.close({ waitForBeforeUnload: false });
    // clearOnClose：该插件最后一个面板关闭时清除分区数据
    if (e.web.session?.clearOnClose && ![...this.views.values()].some((x) => x.pluginId === e.pluginId)) void this.clearSessionData(e.partition, ['cookies', 'storage', 'cache']);
  }

  adapterIds(pluginId: string): string[] {
    const ids = new Set<string>();
    for (const entry of this.views.values()) if (entry.pluginId === pluginId) ids.add(entry.adapterId);
    return [...ids];
  }

  destroyPlugin(pluginId: string) {
    for (const e of [...this.views.values()]) if (e.pluginId === pluginId) this.destroy(e.viewId);
  }
  /** 撤销 net 权限：该适配器已打开的网页面板立即销毁（渲染进程同时换成占位） */
  destroyRevoked(pluginId: string, adapterId: string) {
    for (const e of [...this.views.values()]) if (e.pluginId === pluginId && e.adapterId === adapterId) this.destroy(e.viewId);
  }
  destroyAll() {
    for (const id of [...this.views.keys()]) this.destroy(id);
  }

  partitionOfView(viewId: string): string {
    return this.get(viewId).partition;
  }

  async clearSessionData(partition: string, kinds: Array<'cookies' | 'storage' | 'cache'> = ['cookies', 'storage', 'cache']) {
    const ses = session.fromPartition(partition);
    const storages: Array<'cookies' | 'filesystem' | 'indexdb' | 'localstorage' | 'shadercache' | 'serviceworkers' | 'cachestorage'> = [];
    if (kinds.includes('cookies')) storages.push('cookies');
    if (kinds.includes('storage')) storages.push('filesystem', 'indexdb', 'localstorage', 'serviceworkers', 'cachestorage');
    if (storages.length) await ses.clearStorageData({ storages });
    if (kinds.includes('cache')) await ses.clearCache();
  }

  /** 插件管理/卸载对话框显示的网站数据占用（HTTP 缓存 + 分区目录大小的近似值） */
  async siteDataBytes(pluginId: string): Promise<number> {
    let n = 0;
    for (const p of this.plugins.webPlugins().find((x) => x.pluginId === pluginId)?.partitions ?? []) {
      if (!p.startsWith('persist:')) continue;
      n += await session.fromPartition(p).getCacheSize().catch(() => 0);
      n += dirSize(path.join(app.getPath('userData'), 'Partitions', p.slice('persist:'.length)));
    }
    return n;
  }

  /** 启动时：超过 maxAgeDays 未使用的持久分区清除（宿主启动时清理过期数据，SDK §6.3） */
  async purgeExpired(now = Date.now()) {
    const purged: string[] = [];
    for (const w of this.plugins.webPlugins()) {
      if (!w.maxAgeDays) continue;
      const last = Number(this.kv.get(`web.lastUsed.${w.pluginId}`) ?? 0);
      if (!last || now - last <= w.maxAgeDays * 86400000) continue;
      for (const p of w.partitions) await this.clearSessionData(p);
      this.kv.set(`web.lastUsed.${w.pluginId}`, null);
      purged.push(w.pluginId);
    }
    return purged;
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? `${u.protocol}//${u.host}${u.pathname}`.slice(0, 200) : `${u.protocol}…`;
  } catch {
    return String(url).slice(0, 60);
  }
}

function dirSize(dir: string): number {
  let n = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 8) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const x of ents) {
      const p = path.join(d, x.name);
      if (x.isDirectory()) walk(p, depth + 1);
      else if (x.isFile()) n += fs.statSync(p, { throwIfNoEntry: false })?.size ?? 0;
    }
  };
  walk(dir, 0);
  return n;
}
