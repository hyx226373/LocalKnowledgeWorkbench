import { describe, expect, it } from 'vitest';
import {
  DRAWER_MODULE_IDS,
  DRAWER_MODULE_LABEL,
  DRAWER_WIDTH_DEFAULT,
  clampDrawerWidth,
  initialDrawerSelection,
  normalizeDrawerSelection,
  toggleDrawerSelection,
} from '../src/renderer/drawer/order';

describe('资料抽屉选择顺序', () => {
  it('稳定 ID 与显示名按两行三列固定，不是选择顺序', () => {
    expect(DRAWER_MODULE_IDS).toEqual(['root', 'fav', 'web', 'bench', 'agent', 'plugin']);
    expect(DRAWER_MODULE_IDS.map((id) => DRAWER_MODULE_LABEL[id])).toEqual([
      '根目录',
      '收藏',
      '网络资料',
      '工作台资料',
      'Agent 资料',
      '插件',
    ]);
    expect(Object.values(DRAWER_MODULE_LABEL)).not.toContain('布局');
  });

  it('取消后重选追加到末尾，不按卡片网格重排', () => {
    let selection = toggleDrawerSelection([], 'root');
    selection = toggleDrawerSelection(selection, 'bench');
    selection = toggleDrawerSelection(selection, 'agent');
    expect(selection).toEqual(['root', 'bench', 'agent']);
    selection = toggleDrawerSelection(selection, 'bench');
    expect(selection).toEqual(['root', 'agent']);
    selection = toggleDrawerSelection(selection, 'bench');
    expect(selection).toEqual(['root', 'agent', 'bench']);
  });

  it('去重保留第一次出现，未知 ID 丢弃', () => {
    expect(normalizeDrawerSelection(['plugin', 'root', 'plugin', 'fav', 'root', 'nope', 'layout'])).toEqual(['plugin', 'root', 'fav']);
    expect(normalizeDrawerSelection(['agent', 'bench', 'agent'])).toEqual(['agent', 'bench']);
  });

  it('全空数组保持为空', () => {
    expect(normalizeDrawerSelection([])).toEqual([]);
    expect(toggleDrawerSelection(['root'], 'root')).toEqual([]);
    expect(toggleDrawerSelection([], 'missing')).toEqual([]);
  });

  it('未发现旧合并 ID：合并字样不拆成 bench 与 agent', () => {
    expect(normalizeDrawerSelection(['root', 'workbench', '合并工作台', 'bench-agent', 'agent'])).toEqual(['root', 'agent']);
    expect(toggleDrawerSelection(['fav'], '合并工作台')).toEqual(['fav']);
  });

  it('非字符串丢弃，不改变已有顺序', () => {
    expect(normalizeDrawerSelection(['web', 1, null, undefined, 'bench', 'web'])).toEqual(['web', 'bench']);
  });

  it('缺键与非数组是空选择；已存数组保持顺序并丢掉未知 ID', () => {
    expect(initialDrawerSelection(undefined)).toEqual([]);
    expect(initialDrawerSelection(null)).toEqual([]);
    expect(initialDrawerSelection({ root: true })).toEqual([]);
    expect(initialDrawerSelection(['web', 'root'])).toEqual(['web', 'root']);
    expect(initialDrawerSelection(['web', 'nope', 'root', 'web'])).toEqual(['web', 'root']);
  });
});

describe('资料抽屉宽度', () => {
  it('默认 360，夹在 240–480', () => {
    expect(DRAWER_WIDTH_DEFAULT).toBe(360);
    expect(clampDrawerWidth(360)).toBe(360);
    expect(clampDrawerWidth(300)).toBe(300);
    expect(clampDrawerWidth(440)).toBe(440);
    expect(clampDrawerWidth(239)).toBe(240);
    expect(clampDrawerWidth(481)).toBe(480);
    expect(clampDrawerWidth(Number.NaN)).toBe(360);
    expect(clampDrawerWidth(Number.POSITIVE_INFINITY)).toBe(360);
  });
});
