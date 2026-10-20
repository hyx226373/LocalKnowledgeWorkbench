import { expect, it } from 'vitest';
import { parseSidebarPrefs, SIDEBAR_PREFS_KEY } from '../src/renderer/drawer/uiPrefs';
import { SIDEBAR_PREFS_KEY as canonicalKey } from '../src/renderer/drawer/sidebarPrefs';

it('两个导入入口复用同一偏好存储和解析器', () => {
  expect(SIDEBAR_PREFS_KEY).toBe(canonicalKey);
  expect(parseSidebarPrefs(null).categoriesCollapsed).toBe(false);
  expect(parseSidebarPrefs({ categoriesCollapsed: true }).categoriesCollapsed).toBe(true);
  expect(parseSidebarPrefs({ categoriesCollapsed: 'true' }).categoriesCollapsed).toBe(false);
});
