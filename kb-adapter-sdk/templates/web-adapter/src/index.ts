/**
 * 网页适配器模板 · 示例：MDN 文档（仅 developer.mozilla.org）
 *
 * 【填写】搜索 “TODO(fill)”。核心约定：
 * - 网页由宿主拥有的 webview 渲染（无 Node、无预加载、独立会话分区）；适配器只能调用 target.web 上的有限方法。
 * - 允许的域名只来自 manifest 的 net 权限；适配器无法放宽，宿主在每次导航/重定向/弹窗时都会校验。
 * - 状态只存 “去掉 query 的 URL + 滚动位置”，不存 Cookie、表单、令牌。
 * - 宿主约束：currentUrl() 是缓存值（以 onDidNavigate 为准）；网页可能在工作台浮层出现时被临时隐藏；
 *   滚动恢复是尽力而为——本模板在页面加载“稳定”后再重试一次（见 scrollRestoreTiming）。
 */
import type { AdapterImplementation, AdapterInstance, AdapterPluginManifest, AdapterPluginModule, Disposable, PreservedLegacyState, WebPanelHandle } from '@kb-workbench/adapter-sdk';
import { asRecord, checkNavigation, migrateOrPreserve, sanitizeUrlForState } from '@kb-workbench/adapter-sdk/policy';
import manifestJson from '../manifest.json' with { type: 'json' };

export const manifest = manifestJson as unknown as AdapterPluginManifest;
export const ADAPTER_ID = 'example.mdn-docs.web'; // TODO(fill)
const contrib = manifest.contributes.adapters.find((a) => a.id === ADAPTER_ID)!;
export const ALLOWED_DOMAINS: string[] = contrib.permissions.flatMap((p) => (p.kind === 'net' ? p.domains : []));
export const HOME_URL = contrib.web!.homeUrl;

/** 滚动恢复的时机（测试可调小）：最后一次滚动变化后 settleMs 无变化视为稳定；最多等 maxWaitMs */
export const scrollRestoreTiming = { settleMs: 1200, maxWaitMs: 5000, tolerancePx: 8 };

export interface WebDocState {
  /** 已去掉 query 的 URL，必须在允许域名内 */
  url: string;
  scrollY: number;
  /**
   * 升级时迁移失败（或旧地址已不在允许域名内）而原样保留的旧状态：不丢数据，保存时一并写回。
   * 网页面板不能渲染插件 UI，提示由宿主显示（状态顶层有 legacy 时，宿主在面板上方显示“旧版本状态已保留”）。
   */
  legacy?: PreservedLegacyState;
}
export const STATE_VERSION = 1; // 与 manifest stateSchemaVersion 一致
/** 迁移步骤：键 = 起始版本（v1 是第一版，暂无）。以后提升 STATE_VERSION 时在这里加一步 */
export const STATE_MIGRATIONS: Record<number, (d: any) => unknown> = {};

function validWebState(x: unknown): WebDocState | null {
  const r = asRecord(x);
  if (!r || typeof r.url !== 'string' || typeof r.scrollY !== 'number' || !(r.scrollY >= 0)) return null;
  const legacy = asRecord(r.legacy);
  const keep = legacy && typeof legacy.v === 'number' && typeof legacy.error === 'string' && 'data' in legacy ? { legacy: { v: legacy.v, data: legacy.data!, error: legacy.error } } : {};
  return { url: r.url, scrollY: Math.round(r.scrollY), ...keep };
}

/**
 * 校验 + 迁移。**不丢数据**：迁移失败、格式无法识别、旧地址已不在允许域名内时，
 * 都返回首页状态 + legacy（旧数据原样），下次保存时一并写回。
 */
export function restoreWebDocState(data: unknown, fromVersion: number): WebDocState | undefined {
  const fresh = (): WebDocState => ({ url: HOME_URL, scrollY: 0 });
  const { state, preserved } = migrateOrPreserve<unknown>(data, fromVersion, STATE_VERSION, STATE_MIGRATIONS, fresh);
  if (preserved) return { ...fresh(), legacy: preserved };
  const ok = validWebState(state);
  if (!ok) return { ...fresh(), legacy: { v: fromVersion, data: (data ?? null) as PreservedLegacyState['data'], error: '状态格式无法识别' } };
  // 恢复时再校验一次域名：manifest 收窄域名后，旧状态里的 URL 不得绕过（旧状态保留，不导航过去）
  if (!checkNavigation(ok.url, ALLOWED_DOMAINS).ok) return { ...fresh(), legacy: { v: fromVersion, data: (data ?? null) as PreservedLegacyState['data'], error: '旧地址已不在允许的域名内' } };
  return ok;
}

export const mdnAdapter: AdapterImplementation<WebDocState> = {
  id: ADAPTER_ID,
  restoreState: restoreWebDocState,
  open(item, ctx): AdapterInstance<WebDocState> {
    const start = ctx.restoredState?.url ?? item.ref;
    const legacy = ctx.restoredState?.legacy;
    let state: WebDocState = { url: sanitizeUrlForState(start) ?? HOME_URL, scrollY: ctx.restoredState?.scrollY ?? 0, ...(legacy ? { legacy } : {}) };
    let pendingScroll = ctx.restoredState?.scrollY ?? 0;
    let web: WebPanelHandle | null = null;
    const subs: Disposable[] = [];
    // 恢复阶段：idle（无需恢复/已完成）→ settling（已 setScroll，等待页面稳定后重试一次）
    let restore: { target: number; settleTimer: ReturnType<typeof setTimeout> | null; capTimer: ReturnType<typeof setTimeout> | null } | null = null;
    let disposed = false;

    const finishRestore = async () => {
      const r = restore;
      if (!r || !web || disposed) return;
      restore = null;
      if (r.settleTimer) clearTimeout(r.settleTimer);
      if (r.capTimer) clearTimeout(r.capTimer);
      const pos = await web.getScroll();
      if (Math.abs(pos.y - r.target) > scrollRestoreTiming.tolerancePx) {
        await web.setScroll({ x: 0, y: r.target }); // 只重试这一次，不“追着页面改滚动”
      }
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
        if (target.kind !== 'web') throw new Error('MDN 适配器只能挂载到网页面板');
        web = target.web;
        target.setTitle('MDN 文档');
        subs.push(
          web.onDidNavigate(({ url, inPage }) => {
            const clean = sanitizeUrlForState(url);
            if (!clean) return;
            if (!inPage) state = { url: clean, scrollY: 0, ...(state.legacy ? { legacy: state.legacy } : {}) };
            else state = { ...state, url: clean };
            ctx.requestSave();
          }),
          web.onScroll(({ y }) => {
            if (restore) {
              // 恢复期间的滚动变化（晚加载内容推动、滚动锚定）不写入状态，只推迟“稳定”判定
              armSettle();
              return;
            }
            state = { ...state, scrollY: Math.round(y) };
            ctx.requestSave();
          }),
          web.onLoadState((s) => {
            if (s === 'ready' && pendingScroll > 0) {
              const target = pendingScroll;
              pendingScroll = 0;
              state = { ...state, scrollY: target };
              restore = { target, settleTimer: null, capTimer: setTimeout(() => void finishRestore(), scrollRestoreTiming.maxWaitMs) };
              void web!.setScroll({ x: 0, y: target }).then(armSettle);
            }
          }),
          // 被拦截的导航由宿主以横幅提示（并按 offDomain 策略提供“用系统浏览器打开”），适配器无需处理
        );
        const r = await web.navigate(start);
        if (!r.ok) await web.navigate(HOME_URL);
      },
      getState: () => state,
      onPermissionDenied() {
        // net 是必需权限：被撤销时宿主会直接换成占位面板，这里无需处理
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
    api.adapters.register(mdnAdapter);
  },
};
export default plugin;
