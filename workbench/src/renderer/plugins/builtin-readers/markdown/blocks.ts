/** 普通块的上限。围栏代码和跨行公式整段保留，不从中间切开。 */
export const MAX_BLOCK_CHARS = 32 * 1024;
export const LARGE_MD_CHARS = 32 * 1024; // P0: force slices earlier; sync renderMarkdown while blocks renderer
/** 每一片同步工作的时间预算。长任务门槛是 200ms，这里留出余量。 */
export const SLICE_BUDGET_MS = 32;
export const LONG_TASK_LIMIT_MS = 200;

function fenceClose(line: string, ch: string, len: number): boolean {
  const m = /^( {0,3})(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[2][0] === ch && m[2].length >= len;
}

/**
 * 按空行、标题切开，单块大约不超过 MAX_BLOCK_CHARS。
 * 未闭合的围栏或公式会一直收到文末，避免把定界符拆开。
 */
export function splitMarkdownBlocks(source: string): string[] {
  if (!source) return [''];
  const lines = source.split('\n');
  const blocks: string[] = [];
  let buf: string[] = [];
  let size = 0;
  let fence: { ch: string; len: number } | null = null;
  let math: '$$' | '\\]' | null = null;

  const flush = () => {
    if (!buf.length) return;
    blocks.push(buf.join('\n'));
    buf = [];
    size = 0;
  };

  for (const line of lines) {
    if (fence) {
      buf.push(line);
      size += line.length + 1;
      if (fenceClose(line, fence.ch, fence.len)) fence = null;
      continue;
    }
    if (math) {
      buf.push(line);
      size += line.length + 1;
      if (math === '$$' ? line.includes('$$') : line.includes('\\]')) math = null;
      continue;
    }
    const opened = /^( {0,3})(`{3,}|~{3,})([^`~]*)$/.exec(line);
    if (opened) {
      if (buf.length) flush();
      fence = { ch: opened[2][0], len: opened[2].length };
      buf.push(line);
      size += line.length + 1;
      continue;
    }
    if (line.startsWith('$$') && line.slice(2).indexOf('$$') < 0) {
      if (buf.length) flush();
      math = '$$';
      buf.push(line);
      size += line.length + 1;
      continue;
    }
    if (line.startsWith('\\[') && !line.includes('\\]')) {
      if (buf.length) flush();
      math = '\\]';
      buf.push(line);
      size += line.length + 1;
      continue;
    }
    if (/^#{1,6}\s/.test(line) && buf.length) flush();
    buf.push(line);
    size += line.length + 1;
    if (size >= MAX_BLOCK_CHARS) flush();
  }
  flush();
  return blocks.length ? blocks : [''];
}
