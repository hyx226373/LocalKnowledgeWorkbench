/** 网页正文本轮不进索引。已落地的本地文件（含直链缓存）可以。 */

export type IndexTargetKind = 'local-file' | 'web' | 'reject';

export function classifyIndexTarget(input: string): IndexTargetKind {
  const text = input.trim();
  if (!text) return 'reject';
  if (/^https?:\/\//i.test(text)) return 'web';
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) return 'reject';
  return 'local-file';
}

export function shouldIndexFileBody(input: string): boolean {
  return classifyIndexTarget(input) === 'local-file';
}
