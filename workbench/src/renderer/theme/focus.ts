/** 阅读专注模式（主题接口 v2）：全局开关。开启时 :root[data-kb-focus="on"]，内置阅读器的内容根带 data-focus="on"，使用 read-focus-* 令牌。 */
import { useSyncExternalStore } from 'react';

let on = false;
const subs = new Set<() => void>();
export function setFocusMode(v: boolean) {
  on = v;
  document.documentElement.dataset.kbFocus = v ? 'on' : 'off';
  subs.forEach((f) => f());
  // 排版变化：阅读器按阅读锚点校正位置
  window.dispatchEvent(new Event('kb:appearance-changed'));
}
export const getFocusMode = () => on;
export function useFocusMode(): boolean {
  return useSyncExternalStore(
    (cb) => (subs.add(cb), () => subs.delete(cb)),
    () => on,
  );
}
