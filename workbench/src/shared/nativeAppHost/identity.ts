import type {
  NativeAppHostPersist,
  NativeHostAttachPolicy,
  NativeHostIdentity,
} from './types';
import { NATIVE_APP_HOST_VIEW_TYPE } from './types';

/** Canonical identity key string for maps / logs (runtime). */
export function identityKey(id: Pick<NativeHostIdentity, 'hwnd' | 'pid' | 'createTime' | 'path'>): string {
  return `${id.hwnd}|${id.pid}|${id.createTime}|${normalizePath(id.path)}`;
}

export function normalizePath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase();
}

/** True when two identities refer to the same OS window instance. */
export function identitiesMatch(
  a: Pick<NativeHostIdentity, 'hwnd' | 'pid' | 'createTime' | 'path'>,
  b: Pick<NativeHostIdentity, 'hwnd' | 'pid' | 'createTime' | 'path'>,
): boolean {
  return (
    a.hwnd === b.hwnd &&
    a.pid === b.pid &&
    a.createTime === b.createTime &&
    normalizePath(a.path) === normalizePath(b.path)
  );
}

/**
 * Build persist payload. Strips hwnd / pid — only path + title + layout + policy.
 */
export function toPersistPayload(input: {
  hostPath: string;
  titleHint?: string;
  layout?: { x: number; y: number; w: number; h: number };
  attachPolicy?: NativeHostAttachPolicy;
}): NativeAppHostPersist {
  return {
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    hostPath: input.hostPath,
    titleHint: input.titleHint ?? '',
    layout: input.layout ?? { x: 0, y: 0, w: 0, h: 0 },
    attachPolicy: input.attachPolicy ?? 'reselect-on-restore',
  };
}

/** Keys that must never appear in workspace layout JSON. */
export const FORBIDDEN_PERSIST_KEYS = ['hwnd', 'bindingId', 'createTime'] as const;

/**
 * Validate a candidate persist object: no hwnd, viewType exact, policy present.
 * Returns sanitized copy or throws.
 */
export function sanitizePersist(raw: unknown): NativeAppHostPersist {
  if (!raw || typeof raw !== 'object') throw new Error('invalid persist payload');
  const o = raw as Record<string, unknown>;
  for (const k of FORBIDDEN_PERSIST_KEYS) {
    if (k in o) throw new Error(`forbidden persist field: ${k}`);
  }
  // pid must not be persisted (debug-only off-by-default)
  if ('pid' in o) throw new Error('forbidden persist field: pid');
  if (o.viewType !== NATIVE_APP_HOST_VIEW_TYPE) {
    throw new Error(`viewType must be ${NATIVE_APP_HOST_VIEW_TYPE}`);
  }
  if (typeof o.hostPath !== 'string' || !o.hostPath) {
    throw new Error('hostPath required');
  }
  const layout = (o.layout ?? { x: 0, y: 0, w: 0, h: 0 }) as Record<string, unknown>;
  return {
    viewType: NATIVE_APP_HOST_VIEW_TYPE,
    hostPath: o.hostPath,
    titleHint: typeof o.titleHint === 'string' ? o.titleHint : '',
    layout: {
      x: Number(layout.x) || 0,
      y: Number(layout.y) || 0,
      w: Number(layout.w) || 0,
      h: Number(layout.h) || 0,
    },
    attachPolicy: 'reselect-on-restore',
  };
}

/**
 * host-r1 L2: normalise an attach-request identity. hwnd may arrive as number
 * (CDP / devtools callers) and is converted to decimal string; createTime / pid
 * may arrive as numeric strings. Returns the list of missing/invalid fields
 * instead of throwing so attach can answer IDENTITY_INCOMPLETE explicitly.
 */
export function normalizeAttachIdentity(raw: unknown):
  | { ok: true; identity: Pick<NativeHostIdentity, 'hwnd' | 'pid' | 'createTime' | 'path'> }
  | { ok: false; missing: string[] } {
  if (!raw || typeof raw !== 'object') return { ok: false, missing: ['identity'] };
  const o = raw as Record<string, unknown>;
  const missing: string[] = [];
  let hwnd = '';
  if (typeof o.hwnd === 'string' && /^[0-9]+$/.test(o.hwnd) && o.hwnd !== '0') hwnd = o.hwnd;
  else if (typeof o.hwnd === 'number' && Number.isSafeInteger(o.hwnd) && o.hwnd > 0) hwnd = String(o.hwnd);
  else missing.push('hwnd');
  const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  const pid = num(o.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0) missing.push('pid');
  const createTime = num(o.createTime);
  if (!Number.isFinite(createTime) || createTime <= 0) missing.push('createTime');
  const path = typeof o.path === 'string' ? o.path : '';
  if (!path) missing.push('path');
  if (missing.length) return { ok: false, missing };
  return { ok: true, identity: { hwnd, pid, createTime, path } };
}

/** Shape check for identity after attach. */
export function assertIdentityShape(id: unknown): asserts id is NativeHostIdentity {
  if (!id || typeof id !== 'object') throw new Error('identity required');
  const o = id as Record<string, unknown>;
  if (typeof o.hwnd !== 'string' || !o.hwnd) throw new Error('hwnd required (string)');
  if (typeof o.pid !== 'number' || !Number.isFinite(o.pid) || o.pid <= 0) throw new Error('pid invalid');
  if (typeof o.createTime !== 'number' || !Number.isFinite(o.createTime)) throw new Error('createTime invalid');
  if (typeof o.path !== 'string' || !o.path) throw new Error('path required');
}
