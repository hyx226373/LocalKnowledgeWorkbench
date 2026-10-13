/**
 * 设置键 readerBackToToc。没有这个键时按打开处理。切开关只改内存，阅读器不重绘正文。
 */
import { kb } from '../kb';

export const READER_BACK_TO_TOC_KEY = 'readerBackToToc';

let enabled = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

export function readReaderBackToToc(): boolean {
  return enabled;
}

export function subscribeReaderBackToToc(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadReaderBackToToc(): Promise<void> {
  return kb.getLayout(READER_BACK_TO_TOC_KEY).then((raw) => {
    if (raw === false) enabled = false;
    else if (raw === true) enabled = true;
    emit();
  }).catch(() => undefined);
}

export async function writeReaderBackToToc(next: boolean): Promise<void> {
  const prev = enabled;
  enabled = next;
  emit();
  try {
    await kb.setLayout(READER_BACK_TO_TOC_KEY, next);
  } catch (err) {
    enabled = prev;
    emit();
    throw err;
  }
}
