/**
 * layout.* 事件传输层（阶段 B 临时定案 · 2026-10-05）
 * - 默认：window CustomEvent，type = v1 事件名，detail = v1 payload
 * - 布局宿主为唯一发送方；integ 可替换 channel，不得改 shape
 */
import type { LayoutEventName } from '../../shared/chromeLayout';

/** 可替换传输：payload shape 冻结为 v1，仅 channel 可换 */
export interface LayoutEventTransport {
  emit(name: LayoutEventName, payload: unknown): void;
}

/**
 * 默认桥：`new CustomEvent(name, { detail: payload })` → `window.dispatchEvent`。
 * 非 DOM 环境（无 window / dispatchEvent / CustomEvent）静默跳过，不抛。
 */
export function createWindowCustomEventTransport(
  target?: { dispatchEvent?: (ev: Event) => boolean } | null,
): LayoutEventTransport {
  return {
    emit(name, payload) {
      try {
        const win =
          target ??
          (typeof globalThis !== 'undefined'
            ? (globalThis as { window?: unknown }).window ?? globalThis
            : null);
        if (!win || typeof (win as { dispatchEvent?: unknown }).dispatchEvent !== 'function') {
          return;
        }
        const CE = (typeof globalThis !== 'undefined' &&
          (globalThis as { CustomEvent?: typeof CustomEvent }).CustomEvent) as
          | (new (type: string, init?: CustomEventInit) => CustomEvent)
          | undefined;
        if (typeof CE !== 'function') return;
        const ev = new CE(name, { detail: payload });
        (win as { dispatchEvent: (ev: Event) => boolean }).dispatchEvent(ev);
      } catch {
        // 非 DOM / 受限环境：不抛
      }
    },
  };
}

/** 录制用 transport（单测） */
export function createRecordingTransport(): LayoutEventTransport & {
  records: { name: LayoutEventName; payload: unknown }[];
  clear(): void;
} {
  const records: { name: LayoutEventName; payload: unknown }[] = [];
  return {
    records,
    clear() {
      records.length = 0;
    },
    emit(name, payload) {
      records.push({ name, payload });
    },
  };
}

/** 空传输（显式禁桥时） */
export function createNoopTransport(): LayoutEventTransport {
  return { emit() {} };
}

export const defaultLayoutEventTransport: LayoutEventTransport =
  createWindowCustomEventTransport();
