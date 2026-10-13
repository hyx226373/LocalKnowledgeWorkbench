/**
 * 阅读面板「显示内容缩放条」。缺键按显示。切开关只改显隐，不改缩放值或快捷键／滚轮。
 */
import { kb } from '../kb';

export const ZOOM_HUD_VISIBLE_KEY = 'reader.zoomHud.visible';

let visible = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function readZoomHudVisible(): boolean {
  return visible;
}

export function subscribeZoomHudVisible(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function loadZoomHudVisible(): Promise<void> {
  return kb
    .getLayout(ZOOM_HUD_VISIBLE_KEY)
    .then((raw) => {
      if (raw === false) visible = false;
      else if (raw === true) visible = true;
      emit();
    })
    .catch(() => undefined);
}

export async function writeZoomHudVisible(next: boolean): Promise<void> {
  const prev = visible;
  visible = next;
  emit();
  try {
    await kb.setLayout(ZOOM_HUD_VISIBLE_KEY, next);
  } catch (err) {
    visible = prev;
    emit();
    throw err;
  }
}
