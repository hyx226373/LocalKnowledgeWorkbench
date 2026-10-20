/**
 * r22-B: 大图标卡片四档尺寸——parseSidebarPrefs.cardSize、CSS 变量映射、列数计算。
 */
import { expect, it, describe } from 'vitest';
import { parseSidebarPrefs, type CardSize } from '../src/renderer/drawer/sidebarPrefs';
import {
  CARD_SIZE_SPECS,
  CARD_SIZES,
  CARD_SIZE_LABELS,
  cardSizeCSSVars,
  computeCardColumns,
} from '../src/renderer/drawer/cardSize';

// ─── parseSidebarPrefs.cardSize 解析与兜底 ───

describe('parseSidebarPrefs cardSize', () => {
  it('缺省值回落 lg', () => {
    expect(parseSidebarPrefs(null).cardSize).toBe('lg');
    expect(parseSidebarPrefs({}).cardSize).toBe('lg');
    expect(parseSidebarPrefs(undefined).cardSize).toBe('lg');
  });

  it('合法值原样保留', () => {
    for (const size of CARD_SIZES) {
      expect(parseSidebarPrefs({ cardSize: size }).cardSize).toBe(size);
    }
  });

  it('未知值回落 lg', () => {
    expect(parseSidebarPrefs({ cardSize: 'xs' }).cardSize).toBe('lg');
    expect(parseSidebarPrefs({ cardSize: '' }).cardSize).toBe('lg');
    expect(parseSidebarPrefs({ cardSize: 123 }).cardSize).toBe('lg');
    expect(parseSidebarPrefs({ cardSize: true }).cardSize).toBe('lg');
    expect(parseSidebarPrefs({ cardSize: null }).cardSize).toBe('lg');
  });

  it('JSON 序列化往返', () => {
    for (const size of CARD_SIZES) {
      const json = JSON.stringify({ cardSize: size });
      expect(parseSidebarPrefs(JSON.parse(json)).cardSize).toBe(size);
    }
  });

  it('旧字段不受影响', () => {
    const old = { categoriesCollapsed: true, ribbonCollapsed: true, categoriesLayout: 'list' as const, hideUnopenableFiles: false, dragOutMode: 'path' as const };
    const result = parseSidebarPrefs(old);
    expect(result.categoriesCollapsed).toBe(true);
    expect(result.ribbonCollapsed).toBe(true);
    expect(result.categoriesLayout).toBe('list');
    expect(result.hideUnopenableFiles).toBe(false);
    expect(result.dragOutMode).toBe('path');
    expect(result.cardSize).toBe('lg'); // 旧数据无 cardSize，兜底
  });
});

// ─── 档位→CSS 变量映射 ───

describe('cardSizeCSSVars', () => {
  it('每档生成正确的四个 CSS 变量', () => {
    const vars = cardSizeCSSVars('sm');
    expect(vars['--kb-card-icon']).toBe('28px');
    expect(vars['--kb-card-min-h']).toBe('64px');
    expect(vars['--kb-card-min-w']).toBe('72px');
    expect(vars['--kb-card-title-size']).toBe('11px');

    const lg = cardSizeCSSVars('lg');
    expect(lg['--kb-card-icon']).toBe('58px');
    expect(lg['--kb-card-min-h']).toBe('112px');
    expect(lg['--kb-card-min-w']).toBe('104px');
    expect(lg['--kb-card-title-size']).toBe('13px');
  });

  it('xl 生成最大档变量', () => {
    const xl = cardSizeCSSVars('xl');
    expect(xl['--kb-card-icon']).toBe('76px');
    expect(xl['--kb-card-min-h']).toBe('140px');
    expect(xl['--kb-card-min-w']).toBe('132px');
    expect(xl['--kb-card-title-size']).toBe('14px');
  });
});

// ─── CARD_SIZE_SPECS 规格表 ───

describe('CARD_SIZE_SPECS', () => {
  it('四档都有完整规格', () => {
    expect(Object.keys(CARD_SIZE_SPECS)).toEqual(['sm', 'md', 'lg', 'xl']);
    for (const size of CARD_SIZES) {
      const spec = CARD_SIZE_SPECS[size];
      expect(spec.icon).toBeGreaterThan(0);
      expect(spec.minH).toBeGreaterThan(0);
      expect(spec.minW).toBeGreaterThan(0);
      expect(spec.titleSize).toBeGreaterThan(0);
      expect(typeof spec.hideTitle).toBe('boolean');
    }
  });

  it('小档 hideTitle=true，其余为 false', () => {
    expect(CARD_SIZE_SPECS.sm.hideTitle).toBe(true);
    expect(CARD_SIZE_SPECS.md.hideTitle).toBe(false);
    expect(CARD_SIZE_SPECS.lg.hideTitle).toBe(false);
    expect(CARD_SIZE_SPECS.xl.hideTitle).toBe(false);
  });

  it('大档与现有默认一致：图标 58、最小高 112', () => {
    expect(CARD_SIZE_SPECS.lg.icon).toBe(58);
    expect(CARD_SIZE_SPECS.lg.minH).toBe(112);
  });
});

// ─── 列数计算（四档 × 240/360/480，含最少 2 列、小档最多 6 列）───

describe('computeCardColumns', () => {
  // 与 card-sizes.png 标注一致的 3×4 矩阵
  const expected: Record<CardSize, Record<number, number>> = {
    sm: { 240: 2, 360: 4, 480: 5 },
    md: { 240: 2, 360: 3, 480: 4 },
    lg: { 240: 2, 360: 3, 480: 4 },
    xl: { 240: 2, 360: 2, 480: 3 },
  };

  for (const size of CARD_SIZES) {
    for (const width of [240, 360, 480]) {
      it(`${CARD_SIZE_LABELS[size]}档 (${size}) 栏宽 ${width} → ${expected[size][width]} 列`, () => {
        expect(computeCardColumns(width, size)).toBe(expected[size][width]);
      });
    }
  }

  it('最少 2 列（极窄栏宽）', () => {
    expect(computeCardColumns(100, 'xl')).toBe(2);
    expect(computeCardColumns(50, 'lg')).toBe(2);
    expect(computeCardColumns(0, 'sm')).toBe(2);
  });

  it('小档最多 6 列（超宽栏）', () => {
    // 栏宽 1000：(1000-28+8)/(72+8) = 980/80 = 12.25 → 12 → clamp to 6
    expect(computeCardColumns(1000, 'sm')).toBe(6);
    // 栏宽 600：(600-28+8)/(72+8) = 580/80 = 7.25 → 7 → clamp to 6
    expect(computeCardColumns(600, 'sm')).toBe(6);
  });

  it('中/大/特大档无最多列限制', () => {
    // 栏宽 1000：md=(1000-28+8)/(92+8)=980/100=9.8→9
    expect(computeCardColumns(1000, 'md')).toBe(9);
    // lg=(1000-28+8)/(104+8)=980/112=8.75→8
    expect(computeCardColumns(1000, 'lg')).toBe(8);
  });
});

// ─── 常量表 ───

describe('CARD_SIZES / CARD_SIZE_LABELS', () => {
  it('四档从小到大', () => {
    expect(CARD_SIZES).toEqual(['sm', 'md', 'lg', 'xl']);
  });

  it('中文标签完整', () => {
    expect(CARD_SIZE_LABELS).toEqual({ sm: '小', md: '中', lg: '大', xl: '特大' });
  });
});

// ─── CSS 网格本身也要守住「最少 2 列、小档最多 6 列」───

describe('drawer.css 卡片网格', () => {
  it('列下限夹在半宽以内，小档另设六分之一宽下限', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../src/renderer/drawer/drawer.css', import.meta.url), 'utf8');
    expect(css).toContain('minmax(max(min(var(--kb-card-min-w, 104px), calc((100% - 8px) / 2)), var(--kb-card-col-floor)), 1fr)');
    expect(css).toMatch(/\.kb-drawer-cards\[data-card-size="sm"\]\s*\{\s*--kb-card-col-floor: calc\(\(100% - 40px\) \/ 6\);/);
  });
});
