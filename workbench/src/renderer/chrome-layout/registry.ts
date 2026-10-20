/**
 * 稳定 chrome 组件注册表（冻结 v1 首版登记）
 */
import type { ChromeComponentId, ChromeComponentMeta } from '../../shared/chromeLayout';

/** 首版固定顺序；扩展须文档登记 */
export const STABLE_CHROME_IDS: readonly ChromeComponentId[] = [
  'chrome.menu',
  'chrome.toolbar',
  'chrome.sidebar',
  'chrome.status',
  'chrome.tabs',
  'chrome.console',
  'chrome.agent',
] as const;

/**
 * 当前构建的 present / defaultVisible。
 * toolbar / console / agent：本构建无独立组件 → present:false（VC-CH-03 记 N/A）
 * tabs：dockview 标签栏可分离 → present:true
 */
const BUILTIN: readonly ChromeComponentMeta[] = [
  { id: 'chrome.menu', present: true, defaultVisible: true, hitTestWhenHidden: false },
  { id: 'chrome.toolbar', present: false, defaultVisible: true, hitTestWhenHidden: false },
  { id: 'chrome.sidebar', present: true, defaultVisible: true, hitTestWhenHidden: false },
  { id: 'chrome.status', present: true, defaultVisible: true, hitTestWhenHidden: false },
  { id: 'chrome.tabs', present: true, defaultVisible: true, hitTestWhenHidden: false },
  { id: 'chrome.console', present: false, defaultVisible: false, hitTestWhenHidden: false },
  { id: 'chrome.agent', present: false, defaultVisible: false, hitTestWhenHidden: false },
];

export function createChromeRegistry(
  overrides?: Partial<Record<ChromeComponentId, Partial<ChromeComponentMeta>>>,
): ChromeComponentMeta[] {
  return BUILTIN.map((m) => {
    const o = overrides?.[m.id];
    if (!o) return { ...m };
    return {
      ...m,
      ...o,
      id: m.id,
      hitTestWhenHidden: false as const, // 硬约束不可覆盖
    };
  });
}

export function defaultVisibilityMap(
  registry: ChromeComponentMeta[] = createChromeRegistry(),
): Record<ChromeComponentId, boolean> {
  const out: Record<string, boolean> = {};
  for (const m of registry) {
    if (m.present) out[m.id] = m.defaultVisible;
  }
  return out as Record<ChromeComponentId, boolean>;
}

export function getMeta(
  id: ChromeComponentId,
  registry: ChromeComponentMeta[] = createChromeRegistry(),
): ChromeComponentMeta | undefined {
  return registry.find((m) => m.id === id);
}
