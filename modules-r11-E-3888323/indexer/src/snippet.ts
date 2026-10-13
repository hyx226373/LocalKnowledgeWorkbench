import { HIGHLIGHT_END, HIGHLIGHT_START } from './types.ts';

const RADIUS = 48;

function indexOfFold(hay: string, needle: string): number {
  return hay.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
}

function clip(text: string, max: number): string {
  const nfc = text.normalize('NFC');
  if (nfc.length <= max) return nfc;
  return `${nfc.slice(0, max)}…`;
}

/** 在原文上包住查询串。不用 FTS5 snippet()，避免 trigram 把词拆碎。 */
export function makeSnippet(title: string, body: string, query: string): string {
  const needle = query.trim().normalize('NFC');
  const sources = [body ?? '', title ?? ''];
  if (!needle) return clip(sources[0] || sources[1], RADIUS * 2);
  for (const source of sources) {
    const text = source.normalize('NFC');
    const idx = indexOfFold(text, needle);
    if (idx < 0) continue;
    const start = Math.max(0, idx - RADIUS);
    const end = Math.min(text.length, idx + needle.length + RADIUS);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return (
      prefix +
      text.slice(start, idx) +
      HIGHLIGHT_START +
      text.slice(idx, idx + needle.length) +
      HIGHLIGHT_END +
      text.slice(idx + needle.length, end) +
      suffix
    );
  }
  return clip(sources[0] || sources[1], RADIUS * 2);
}
