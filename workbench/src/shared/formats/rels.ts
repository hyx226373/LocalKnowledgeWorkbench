import { FormatFail } from './types';
import { decodeXml, encodeXml, flatXml, prepareXml } from './xml';
import { MSG } from './messages';

export interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

function externalTarget(target: string, mode: string): boolean {
  if (mode.toLowerCase() === 'external') return true;
  return /^(https?:|file:|mailto:|\\\\)/i.test(target.trim());
}

/** 包外地址。调用方只丢弃，不取、不写进正文。 */
export function isRemoteTarget(target: string): boolean {
  const text = target.trim();
  if (!text || text.startsWith('#')) return false;
  return /^(https?:|file:|mailto:|javascript:|vbscript:|\\\\|\/\/)/i.test(text);
}

/**
 * TargetMode=External 以及绝对 URL / file: 都不进入关系表，调用方也不会去取。
 * 关系文件本身也会被改写，避免下游库再看到这些目标。
 */
const REL_TAG = /<Relationship\b[^>]*\/>|<Relationship\b[^>]*>[\s\S]*?<\/Relationship>/gi;

export function stripExternalRels(files: Map<string, Uint8Array>): { dropped: number } {
  let dropped = 0;
  for (const [name, bytes] of files) {
    if (!name.toLowerCase().endsWith('.rels')) continue;
    const xml = decodeXml(bytes);
    const next = xml.replace(REL_TAG, (tag) => {
      const mode = /TargetMode\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
      const target = /Target\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
      if (!externalTarget(target, mode)) return tag;
      dropped++;
      return '';
    });
    if (next !== xml) files.set(name, encodeXml(next));
  }
  return { dropped };
}

/** 关系目标相对源部件所在目录，拒绝跳出包根。 */
export function resolvePart(fromPart: string, target: string): string | null {
  const base = fromPart.split('/').slice(0, -1);
  for (const seg of target.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (base.length === 0) return null;
      base.pop();
    } else base.push(seg);
  }
  return base.join('/');
}

export function readRels(bytes: Uint8Array | undefined): Rel[] {
  if (!bytes) return [];
  let parsed: unknown;
  try {
    parsed = flatXml.parse(prepareXml(decodeXml(bytes)));
  } catch (error) {
    if (error instanceof FormatFail) throw error;
    return [];
  }
  const root = parsed as { Relationships?: { Relationship?: Record<string, unknown>[] } };
  const list = root.Relationships?.Relationship ?? [];
  const rels: Rel[] = [];
  for (const item of list) {
    const id = String(item['@_Id'] ?? '');
    const target = String(item['@_Target'] ?? '');
    const mode = String(item['@_TargetMode'] ?? '');
    if (!id) continue;
    const external = externalTarget(target, mode);
    if (external) continue;
    rels.push({ id, type: String(item['@_Type'] ?? ''), target, external: false });
  }
  return rels;
}

export function relMap(rels: Rel[]): Map<string, Rel> {
  return new Map(rels.map((rel) => [rel.id, rel]));
}

export function externalWarning(dropped: number, warnings: string[]): void {
  if (dropped > 0 && !warnings.includes(MSG.externalRel)) warnings.push(MSG.externalRel);
}
