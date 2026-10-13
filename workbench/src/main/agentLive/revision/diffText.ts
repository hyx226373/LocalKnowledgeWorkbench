import { AgentLiveError } from './errors';

export const DIFF_INLINE_MAX = 64 * 1024;
export const DIFF_TIMEOUT_MS = 5000;
const DIFF_CELL_LIMIT = 1_000_000;

interface Op {
  kind: ' ' | '-' | '+';
  line: string;
}

function checkBudget(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) throw new AgentLiveError('cancelled', '差异生成已取消');
  if (Date.now() > deadline) throw new AgentLiveError('timeout', '差异生成超过 5 秒');
}

function lineDiff(a: string[], b: string[], signal: AbortSignal | undefined, deadline: number): Op[] {
  checkBudget(signal, deadline);
  if (a.length * b.length > DIFF_CELL_LIMIT) {
    return [...a.map((line) => ({ kind: '-' as const, line })), ...b.map((line) => ({ kind: '+' as const, line }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    if ((i & 31) === 0) checkBudget(signal, deadline);
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: '-', line: a[i]! });
      i++;
    } else {
      ops.push({ kind: '+', line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++]! });
  while (j < m) ops.push({ kind: '+', line: b[j++]! });
  return ops;
}

function formatHunks(ops: Op[], context: number): string {
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i]!.kind === ' ') continue;
    const from = Math.max(0, i - context);
    const to = Math.min(ops.length - 1, i + context);
    for (let j = from; j <= to; j++) keep[j] = true;
  }
  let oldLine = 1;
  let newLine = 1;
  let i = 0;
  let out = '';
  while (i < ops.length) {
    if (!keep[i]) {
      oldLine++;
      newLine++;
      i++;
      continue;
    }
    const oldStart = oldLine;
    const newStart = newLine;
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    while (i < ops.length && keep[i]) {
      const op = ops[i]!;
      body.push(`${op.kind}${op.line}`);
      if (op.kind !== '+') {
        oldCount++;
        oldLine++;
      }
      if (op.kind !== '-') {
        newCount++;
        newLine++;
      }
      i++;
    }
    const oldAt = oldCount === 0 ? 0 : oldStart;
    const newAt = newCount === 0 ? 0 : newStart;
    out += `@@ -${oldAt},${oldCount} +${newAt},${newCount} @@\n`;
    for (const line of body) out += `${line}\n`;
  }
  return out;
}

export function unifiedDiff(
  fromText: string,
  toText: string,
  opts: { fromHash: string; toHash: string; context?: number; signal?: AbortSignal; deadline: number },
): string {
  checkBudget(opts.signal, opts.deadline);
  const fromLines = fromText.length ? fromText.split(/\n/) : [];
  const toLines = toText.length ? toText.split(/\n/) : [];
  if (fromLines.length && fromText.endsWith('\n')) fromLines.pop();
  if (toLines.length && toText.endsWith('\n')) toLines.pop();
  const ops = lineDiff(fromLines, toLines, opts.signal, opts.deadline);
  const header = `--- fromHash ${opts.fromHash}\n+++ toHash ${opts.toHash}\n`;
  return header + formatHunks(ops, opts.context ?? 3);
}

export function diffTooLarge(diff: string): boolean {
  return Buffer.byteLength(diff) >= DIFF_INLINE_MAX;
}
