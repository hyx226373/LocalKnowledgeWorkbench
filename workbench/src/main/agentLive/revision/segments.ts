import fs from 'node:fs';
import path from 'node:path';
import type { ChangeSegment } from '../../../shared/agentLive/types';

export function segmentName(from: number, to: number): string {
  const pad = (n: number) => String(Math.max(0, n)).padStart(6, '0');
  return `${pad(from)}-${pad(to)}.jsonl`;
}

export interface ParsedSegment {
  file: string;
  from: number;
  to: number;
  lines: { rev: number; raw: string }[];
}

function parseRevFile(fileName: string): { from: number; to: number } | null {
  const match = /^(\d+)-(\d+)\.jsonl$/.exec(fileName);
  if (!match) return null;
  return { from: Number(match[1]), to: Number(match[2]) };
}

export function readSegments(changesDir: string): ParsedSegment[] {
  if (!fs.existsSync(changesDir)) return [];
  const names = fs.readdirSync(changesDir).filter((name) => name.endsWith('.jsonl') && !name.endsWith('.tmp'));
  const parsed: ParsedSegment[] = [];
  for (const name of names) {
    const range = parseRevFile(name);
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(changesDir, name), 'utf8');
    } catch {
      continue;
    }
    const lines: { rev: number; raw: string }[] = [];
    for (const line of raw.split(/\n/)) {
      if (!line) continue;
      try {
        const rev = Number((JSON.parse(line) as { rev?: number }).rev);
        if (Number.isFinite(rev)) lines.push({ rev, raw: line });
      } catch {
        /* 撕掉最后一行不完整的记录 */
      }
    }
    if (!lines.length && !range) continue;
    const from = range?.from ?? lines[0]?.rev ?? 0;
    const to = range?.to ?? lines[lines.length - 1]?.rev ?? from;
    parsed.push({ file: name, from, to, lines });
  }
  const best = new Map<number, { fileTo: number; raw: string; file: string }>();
  for (const seg of parsed) {
    for (const line of seg.lines) {
      const cur = best.get(line.rev);
      if (!cur || seg.to > cur.fileTo) best.set(line.rev, { fileTo: seg.to, raw: line.raw, file: seg.file });
    }
  }
  const byFile = new Map<string, ParsedSegment>();
  for (const [rev, pick] of best) {
    let seg = byFile.get(pick.file);
    if (!seg) {
      seg = { file: pick.file, from: rev, to: rev, lines: [] };
      byFile.set(pick.file, seg);
    }
    seg.lines.push({ rev, raw: pick.raw });
    seg.from = Math.min(seg.from, rev);
    seg.to = Math.max(seg.to, rev);
  }
  return [...byFile.values()].sort((a, b) => a.from - b.from || a.to - b.to);
}

export function unreferencedSegmentFiles(changesDir: string, keep: ChangeSegment[]): string[] {
  if (!fs.existsSync(changesDir)) return [];
  const used = new Set(keep.map((seg) => seg.file));
  return fs
    .readdirSync(changesDir)
    .filter((name) => name.endsWith('.jsonl') && !name.endsWith('.tmp') && !used.has(name))
    .map((name) => path.join(changesDir, name));
}
