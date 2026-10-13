import type { ReaderZone } from './types';

/** 阅读区：中央 = 标签，四边 = 分屏。边带取 48px 与 18% 中的较小值。 */
export function readerZone(rect: { left: number; top: number; width: number; height: number }, x: number, y: number): ReaderZone {
  const band = Math.min(48, Math.min(rect.width, rect.height) * 0.18);
  const l = x - rect.left;
  const t = y - rect.top;
  const r = rect.width - l;
  const b = rect.height - t;
  const edges: { zone: ReaderZone; d: number }[] = [
    { zone: 'left', d: l },
    { zone: 'right', d: r },
    { zone: 'up', d: t },
    { zone: 'down', d: b },
  ];
  const hit = edges.filter((e) => e.d >= 0 && e.d <= band).sort((a, c) => a.d - c.d)[0];
  return hit ? hit.zone : 'center';
}
