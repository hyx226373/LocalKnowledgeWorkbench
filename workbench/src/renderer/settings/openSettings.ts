import type { SettingsCategoryId } from './categories';

/** 由应用壳层接入现有设置窗口，供嵌套面板指定分类。 */
export const openSettingsRef: { current: (category?: SettingsCategoryId) => void } = {
  current: () => undefined,
};

export function openSettings(category?: SettingsCategoryId): void {
  openSettingsRef.current(category);
}
