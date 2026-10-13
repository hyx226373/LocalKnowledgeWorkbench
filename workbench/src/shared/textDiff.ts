/**
 * 行级文本差异（保存前预览、冲突对比共用；主进程与渲染进程都可用，纯函数）。
 * 先去掉公共前后缀，中间部分用 LCS；中间部分过大时退化为“整段删除 + 整段新增”（approximate=true）。
 */
export interface DiffLine {
  kind: 'ctx' | 'add' | 'del' | 'gap';
  /** 旧文本行号（1 起），add/gap 没有 */
  a?: number;
  /** 新文本行号（1 起），del/gap 没有 */
  b?: number;
  text: string;
}
export interface TextDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  identical: boolean;
  approximate: boolean;
}

const splitLines = (s: string) => s.replace(/\r\n?/g, '\n').split('\n');

export function diffLines(oldText: string, newText: string, opts: { context?: number; maxCells?: number } = {}): TextDiff {
  const context = opts.context ?? 3;
  const maxCells = opts.maxCells ?? 4_000_000;
  const A = splitLines(oldText);
  const B = splitLines(newText);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf);
  const b = B.slice(pre, B.length - suf);
  // 原始操作序列
  const ops: { k: 'ctx' | 'add' | 'del'; ai: number; bi: number }[] = [];
  for (let i = 0; i < pre; i++) ops.push({ k: 'ctx', ai: i, bi: i });
  let approximate = false;
  const n = a.length;
  const m = b.length;
  if (n && m && (n + 1) * (m + 1) <= maxCells) {
    const W = m + 1;
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) ops.push({ k: 'ctx', ai: pre + i++, bi: pre + j++ });
      else if (j < m && (i >= n || L[i * W + j + 1] >= L[(i + 1) * W + j])) ops.push({ k: 'add', ai: -1, bi: pre + j++ });
      else ops.push({ k: 'del', ai: pre + i++, bi: -1 });
    }
  } else {
    if (n && m) approximate = true;
    for (let i = 0; i < n; i++) ops.push({ k: 'del', ai: pre + i, bi: -1 });
    for (let j = 0; j < m; j++) ops.push({ k: 'add', ai: -1, bi: pre + j });
  }
  for (let s = 0; s < suf; s++) ops.push({ k: 'ctx', ai: A.length - suf + s, bi: B.length - suf + s });

  const changed = ops.map((o) => o.k !== 'ctx');
  const keep = new Array(ops.length).fill(false);
  for (let x = 0; x < ops.length; x++) if (changed[x]) for (let y = Math.max(0, x - context); y <= Math.min(ops.length - 1, x + context); y++) keep[y] = true;
  const lines: DiffLine[] = [];
  let skipped = 0;
  const flushGap = () => {
    if (skipped) lines.push({ kind: 'gap', text: `… ${skipped} 行未改动 …` });
    skipped = 0;
  };
  let added = 0;
  let removed = 0;
  for (let x = 0; x < ops.length; x++) {
    const o = ops[x];
    if (o.k === 'add') added++;
    if (o.k === 'del') removed++;
    if (!keep[x]) {
      skipped++;
      continue;
    }
    flushGap();
    if (o.k === 'ctx') lines.push({ kind: 'ctx', a: o.ai + 1, b: o.bi + 1, text: A[o.ai] });
    else if (o.k === 'del') lines.push({ kind: 'del', a: o.ai + 1, text: A[o.ai] });
    else lines.push({ kind: 'add', b: o.bi + 1, text: B[o.bi] });
  }
  if (added || removed) flushGap();
  return { lines: added || removed ? lines : [], added, removed, identical: !added && !removed, approximate };
}
