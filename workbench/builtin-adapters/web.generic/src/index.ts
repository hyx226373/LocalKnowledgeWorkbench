/**
 * 内置通用网页适配器 web.generic（第 11 轮 A，SDK 修订 10 逐站授权）。由 SDK 网页模板改写：
 * - 允许哪些网站完全由宿主决定（manifest net.mode = 'ask-per-site'，宿主逐站询问并记录 grantedHosts）；本插件拿不到“批准网站”的能力，
 *   navigate() 到未批准的网站会被宿主拒绝（domain-blocked）。
 * - 状态只存去掉 query 的 URL + 滚动位置（sanitizeUrlForState），不存 Cookie、表单、令牌。
 * - 恢复：先回到上次停留的地址；该地址已不被允许（网站授权被撤销）时回到条目自己的地址，旧状态原样保留（legacy）。
 * - 滚动恢复沿用模板：加载完成后 setScroll，页面稳定后只重试一次。
 * 打包：node scripts/bundle-builtin-adapters.mjs→ resources/builtin-adapters/web.generic/。
 */
import type { AdapterImplementation, AdapterInstance, AdapterPluginManifest, AdapterPluginModule, Disposable, PreservedLegacyState, WebPanelHandle } from '@kb-workbench/adapter-sdk';
import { asRecord, migrateOrPreserve, sanitizeUrlForState, siteHostOf } from '@kb-workbench/adapter-sdk/policy';
import manifestJson from '../manifest.json' with { type: 'json' };

export const manifest = manifestJson as unknown as AdapterPluginManifest;
export const ADAPTER_ID = 'web.generic';
export const scrollRestoreTiming = { settleMs: 1200, maxWaitMs: 5000, tolerancePx: 8 };

export interface WebDocState {
  url: string;
  scrollY: number;
  legacy?: PreservedLegacyState;
}
export const STATE_VERSION = 1;
export const STATE_MIGRATIONS: Record<number, (d: any) => unknown> = {};

function validState(x: unknown): WebDocState | null {
  const r = asRecord(x);
  if (!r || typeof r.url !== 'string' || typeof r.scrollY !== 'number' || !(r.scrollY >= 0)) return null;
  if (!siteHostOf(r.url)) return null;
  const legacy = asRecord(r.legacy);
  const keep = legacy && typeof legacy.v === 'number' && typeof legacy.error === 'string' && 'data' in legacy ? { legacy: { v: legacy.v, data: legacy.data!, error: legacy.error } } : {};
  return { url: r.url, scrollY: Math.round(r.scrollY), ...keep };
}

/** 校验 + 迁移，不丢数据：无法识别时返回 undefined 之外的“空地址”状态 + legacy，由 open() 回到条目地址 */
export function restoreWebDocState(data: unknown, fromVersion: number): WebDocState | undefined {
  const fresh = (): WebDocState => ({ url: '', scrollY: 0 });
  const { state, preserved } = migrateOrPreserve<unknown>(data, fromVersion, STATE_VERSION, STATE_MIGRATIONS, fresh);
  if (preserved) return { ...fresh(), legacy: preserved };
  const ok = validState(state);
  if (!ok) return { ...fresh(), legacy: { v: fromVersion, data: (data ?? null) as PreservedLegacyState['data'], error: '状态格式无法识别' } };
  return ok;
}

export const genericWebAdapter: AdapterImplementation<WebDocState> = {
  id: ADAPTER_ID,
  restoreState: restoreWebDocState,
  open(item, ctx): AdapterInstance<WebDocState> {
    const itemUrl = sanitizeUrlForState(item.ref) ?? item.ref;
    const restored = ctx.restoredState;
    const start = restored?.url || itemUrl;
    let state: WebDocState = { url: sanitizeUrlForState(start) ?? itemUrl, scrollY: restored?.url ? restored.scrollY : 0, ...(restored?.legacy ? { legacy: restored.legacy } : {}) };
    let pendingScroll = state.scrollY;
    let web: WebPanelHandle | null = null;
    const subs: Disposable[] = [];
    let restore: { target: number; settleTimer: ReturnType<typeof setTimeout> | null; capTimer: ReturnType<typeof setTimeout> | null } | null = null;
    let disposed = false;

    const finishRestore = async () => {
      const r = restore;
      if (!r || !web || disposed) return;
      restore = null;
      if (r.settleTimer) clearTimeout(r.settleTimer);
      if (r.capTimer) clearTimeout(r.capTimer);
      const pos = await web.getScroll();
      if (Math.abs(pos.y - r.target) > scrollRestoreTiming.tolerancePx) await web.setScroll({ x: 0, y: r.target });
      state = { ...state, scrollY: r.target };
      ctx.requestSave();
    };
    const armSettle = () => {
      if (!restore) return;
      if (restore.settleTimer) clearTimeout(restore.settleTimer);
      restore.settleTimer = setTimeout(() => void finishRestore(), scrollRestoreTiming.settleMs);
    };

    return {
      async mount(target) {
        if (target.kind !== 'web') throw new Error('通用网页适配器只能挂载到网页面板');
        web = target.web;
        target.setTitle(siteHostOf(start) ?? '网页');
        subs.push(
          web.onDidNavigate(({ url, inPage }) => {
            const clean = sanitizeUrlForState(url);
            if (!clean || !siteHostOf(clean)) return;
            state = inPage ? { ...state, url: clean } : { url: clean, scrollY: 0, ...(state.legacy ? { legacy: state.legacy } : {}) };
            if (!inPage) target.setTitle(siteHostOf(clean) ?? '网页');
            ctx.requestSave();
          }),
          web.onScroll(({ y }) => {
            if (restore) return armSettle();
            state = { ...state, scrollY: Math.round(y) };
            ctx.requestSave();
          }),
          web.onLoadState((s) => {
            if (s === 'ready' && pendingScroll > 0) {
              const t = pendingScroll;
              pendingScroll = 0;
              state = { ...state, scrollY: t };
              restore = { target: t, settleTimer: null, capTimer: setTimeout(() => void finishRestore(), scrollRestoreTiming.maxWaitMs) };
              void web!.setScroll({ x: 0, y: t }).then(armSettle);
            }
          }),
        );
        const r = await web.navigate(state.url);
        if (!r.ok && state.url !== itemUrl) {
          // 上次停留的网站已不被允许：回到条目地址，旧状态保留
          state = { url: itemUrl, scrollY: 0, legacy: { v: STATE_VERSION, data: { url: state.url, scrollY: state.scrollY }, error: '上次停留的网站已不在授权范围内' } };
          pendingScroll = 0;
          await web.navigate(itemUrl);
          ctx.requestSave();
        }
      },
      getState: () => state,
      onPermissionDenied() {
        // 逐站授权由宿主处理（占位/横幅），插件无需处理
      },
      dispose() {
        disposed = true;
        if (restore?.settleTimer) clearTimeout(restore.settleTimer);
        if (restore?.capTimer) clearTimeout(restore.capTimer);
        restore = null;
        subs.forEach((s) => s.dispose());
        web = null;
      },
    };
  },
};

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register(genericWebAdapter);
  },
};
export default plugin;
