/**
 * 大图标卡片四档尺寸：CSS 变量映射与列数计算。
 * 侧栏模式和主界面共用这一个设置。
 */
import type { CardSize } from './sidebarPrefs';

/** 每档的具体像素数值。 */
export interface CardSizeSpec {
  icon: number;      // --kb-card-icon
  minH: number;      // --kb-card-min-h
  minW: number;      // --kb-card-min-w
  titleSize: number; // --kb-card-title-size
  /** 小档只显示图标，不渲染标题文字。 */
  hideTitle: boolean;
}

export const CARD_SIZE_SPECS: Record<CardSize, CardSizeSpec> = {
  sm: { icon: 28, minH: 64, minW: 72, titleSize: 11, hideTitle: true },
  md: { icon: 40, minH: 84, minW: 92, titleSize: 12, hideTitle: false },
  lg: { icon: 58, minH: 112, minW: 104, titleSize: 13, hideTitle: false },
  xl: { icon: 76, minH: 140, minW: 132, titleSize: 14, hideTitle: false },
};

/** 四档的中文标签，用于设置页和右键菜单。 */
export const CARD_SIZE_LABELS: Record<CardSize, string> = {
  sm: '小',
  md: '中',
  lg: '大',
  xl: '特大',
};

/** 所有档位，按从小到大排列。 */
export const CARD_SIZES: readonly CardSize[] = ['sm', 'md', 'lg', 'xl'];

/**
 * 计算给定栏宽下的网格列数。
 * 公式：floor((containerWidth - 2*padding) / (minW + gap))，但受最少 2 列、小档最多 6 列限制。
 * 容器左右 padding 各 14px，gap 8px。
 */
export function computeCardColumns(containerWidth: number, size: CardSize): number {
  const spec = CARD_SIZE_SPECS[size];
  const padding = 14 * 2; // .kb-drawer-cats padding: 14px each side
  const gap = 8;
  const usable = containerWidth - padding;
  if (usable <= 0) return 2;
  // auto-fill 算法：每列至少 minW，加 gap（除最后一列无右 gap）
  // cols = floor((usable + gap) / (minW + gap))
  const cols = Math.floor((usable + gap) / (spec.minW + gap));
  // 最少 2 列
  const clamped = Math.max(2, cols);
  // 小档最多 6 列
  if (size === 'sm') return Math.min(clamped, 6);
  return clamped;
}

/** 生成注入到容器 style 中的 CSS 变量字符串。 */
export function cardSizeCSSVars(size: CardSize): Record<string, string> {
  const spec = CARD_SIZE_SPECS[size];
  return {
    '--kb-card-icon': `${spec.icon}px`,
    '--kb-card-min-h': `${spec.minH}px`,
    '--kb-card-min-w': `${spec.minW}px`,
    '--kb-card-title-size': `${spec.titleSize}px`,
  };
}
