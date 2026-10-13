import fs from 'node:fs';
import path from 'node:path';
import { getMount, rowByPathKey } from './db.ts';
import type { Db } from './db.ts';
import { PathEscapeError } from './errors.ts';
import { isInsideRoot, normalizeRelPath, pathKey } from './pathutil.ts';
import type { ResolvedInside } from './types.ts';

function realize(rootReal: string, rel: string): string {
  const segments = rel === '' ? [] : rel.split('/');
  for (let count = segments.length; count >= 0; count -= 1) {
    const prefix = count === 0 ? rootReal : path.join(rootReal, ...segments.slice(0, count));
    if (!fs.existsSync(prefix)) continue;
    let realPrefix: string;
    try {
      realPrefix = fs.realpathSync(prefix);
    } catch {
      throw new PathEscapeError('path escapes root');
    }
    const rest = segments.slice(count);
    const abs = rest.length === 0 ? realPrefix : path.join(realPrefix, ...rest);
    if (!isInsideRoot(rootReal, realPrefix) || !isInsideRoot(rootReal, abs)) {
      throw new PathEscapeError('path escapes root');
    }
    return abs;
  }
  throw new PathEscapeError('path escapes root');
}

function relFromAbs(rootReal: string, abs: string, requested: string): string {
  if (!fs.existsSync(abs)) return requested;
  const rel = path.relative(rootReal, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathEscapeError('path escapes root');
  return normalizeRelPath(rel);
}

/** 词法检查之后再 realpath。真实路径必须仍在该根目录内，否则抛 PathEscapeError。 */
export function resolveInsideRoot(db: Db, rootId: string, relPath: string): ResolvedInside {
  const requested = normalizeRelPath(relPath);
  const mount = getMount(db, rootId);
  if (!fs.existsSync(mount)) throw new Error('mounted path does not exist');
  const rootReal = fs.realpathSync(mount);
  const absPath = realize(rootReal, requested);
  const realizedRel = requested === '' ? '' : relFromAbs(rootReal, absPath, requested);
  const hit =
    realizedRel === ''
      ? undefined
      : rowByPathKey(db, rootId, pathKey(realizedRel)) ??
        (realizedRel !== requested ? rowByPathKey(db, rootId, pathKey(requested)) : undefined);
  return {
    rootId,
    relPath: hit ? hit.rel_path : realizedRel,
    absPath,
    resourceId: hit ? hit.id : null,
  };
}
