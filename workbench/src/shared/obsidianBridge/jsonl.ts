/** 按字节偏移读 jsonl。只消费以换行结束的行，半行留给下次。 */

export interface CompleteLines {
  lines: string[];
  nextOffset: number;
}

export function takeCompleteLines(buf: Buffer, offset: number): CompleteLines {
  const start = Math.max(0, Math.min(offset, buf.length));
  const text = buf.subarray(start).toString('utf8');
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], nextOffset: start };
  const complete = text.slice(0, end + 1);
  const lines = complete.split('\n');
  lines.pop();
  return {
    lines: lines.map((line) => line.replace(/\r$/, '')),
    nextOffset: start + Buffer.byteLength(complete, 'utf8'),
  };
}

export interface RenameRecord {
  from: string;
  to: string;
  ts?: string;
}

export function parseRenameLines(lines: readonly string[]): { records: RenameRecord[]; bad: number } {
  const records: RenameRecord[] = [];
  let bad = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { from?: unknown; to?: unknown; ts?: unknown };
      if (typeof value.from !== 'string' || typeof value.to !== 'string' || !value.from.trim() || !value.to.trim()) {
        bad += 1;
        continue;
      }
      records.push({
        from: value.from,
        to: value.to,
        ...(typeof value.ts === 'string' ? { ts: value.ts } : {}),
      });
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}
