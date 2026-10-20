import fs from 'node:fs';
import path from 'node:path';
import type { PlaybookDelivery, PlaybookMount, PlaybookRelation } from '../../../shared/ctxPlaybook';
import { isPlaybookDelivery, isPlaybookMount, isPlaybookRelation } from '../../../shared/ctxPlaybook';
import { MaterialStoreError } from './errors';
import type { MaterialStatus } from '../../../shared/agentLive/types';

export interface PersistedMaterial {
  materialId: string;
  tier: 'session' | 'pinned';
  resourceId: string | null;
  sourceId: string | null;
  relPath: string;
  absPath: string;
  name: string;
  purpose: string | null;
  order: number;
  status: MaterialStatus;
  contentHash: string | null;
  contentVersion: number;
  readable: string | null;
  addedAt: string;
  bytes: number | null;
  estTokens: number | null;
  hasText: boolean;
  pages: number | null;
  mtimeMs: number | null;
  /** 后台哈希和粗估已结束。estTokens 对 PDF、Office、二进制仍是 null。 */
  estimated: boolean;
  /** 上下文剧本。缺省不写入，旧资料字节不变。 */
  slotId?: string;
  mount?: PlaybookMount;
  delivery?: PlaybookDelivery;
  summary?: string;
  relations?: PlaybookRelation[];
  extra: Record<string, unknown>;
}

const ITEM_KEYS = new Set([
  'materialId', 'tier', 'resourceId', 'sourceId', 'relPath', 'absPath', 'name', 'purpose', 'order',
  'status', 'contentHash', 'contentVersion', 'readable', 'addedAt', 'bytes', 'estTokens', 'hasText',
  'pages', 'mtimeMs', 'estimated', 'extra',
  'slotId', 'mount', 'delivery', 'summary', 'relations',
]);

export interface WorkspaceRecordStore {
  read(workspaceId: string): unknown;
  write(workspaceId: string, value: unknown): void;
  keys(): string[];
}

function delaySpin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 只在状态文件锁冲突时占用，正常加入路径不进这里 */
  }
}

export function atomicWriteSync(dest: string, data: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  const fh = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fh, data);
    fs.fsyncSync(fh);
  } finally {
    fs.closeSync(fh);
  }
  const retryable = new Set(['EPERM', 'EEXIST', 'EACCES', 'EBUSY']);
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, dest);
      return;
    } catch (err) {
      last = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (!code || !retryable.has(code)) break;
      if (attempt === 4) {
        try {
          fs.rmSync(dest, { force: true });
          fs.renameSync(tmp, dest);
          return;
        } catch (err2) {
          last = err2;
        }
        break;
      }
      delaySpin(20 * 2 ** attempt);
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

export function promoteStateTmp(dest: string): void {
  const tmp = `${dest}.tmp`;
  if (!fs.existsSync(tmp)) return;
  let raw = '';
  try {
    raw = fs.readFileSync(tmp, 'utf8');
    JSON.parse(raw);
  } catch {
    fs.rmSync(tmp, { force: true });
    return;
  }
  let destMtime = -1;
  if (fs.existsSync(dest)) {
    try {
      destMtime = fs.statSync(dest).mtimeMs;
    } catch {
      destMtime = -1;
    }
  }
  const tmpMtime = fs.statSync(tmp).mtimeMs;
  if (destMtime >= tmpMtime) {
    fs.rmSync(tmp, { force: true });
    return;
  }
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
    fs.renameSync(tmp, dest);
  } catch {
    /* 留下 tmp，下次再提升 */
  }
}

function withStateLock(lockDir: string, fn: () => void): void {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let held = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      delaySpin(5);
    }
  }
  if (!held) throw new MaterialStoreError('state_unreadable', 'agent-live-state.json 正在被占用');
  try {
    fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}

function readJsonObject(file: string): Record<string, unknown> {
  promoteStateTmp(file);
  if (!fs.existsSync(file)) return {};
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new MaterialStoreError('state_unreadable', `无法读取 ${path.basename(file)}：${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MaterialStoreError('state_unreadable', `${path.basename(file)} 不是合法 JSON，未覆盖`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MaterialStoreError('state_unreadable', `${path.basename(file)} 不是对象，未覆盖`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.schemaVersion === 'number' && obj.schemaVersion !== 1) {
    throw new MaterialStoreError('unsupported_schema', `不支持 schemaVersion ${obj.schemaVersion}`);
  }
  return obj;
}

export interface SessionLoad {
  byWorkspace: Record<string, PersistedMaterial[]>;
  legacy: boolean;
}

export function readSessionMaterials(file: string): SessionLoad {
  const disk = readJsonObject(file);
  if (!fs.existsSync(file)) return { byWorkspace: {}, legacy: false };
  const block = disk.sessionMaterials;
  if (block == null) return { byWorkspace: {}, legacy: false };
  if (typeof block !== 'object' || Array.isArray(block)) {
    throw new MaterialStoreError('state_unreadable', 'sessionMaterials 格式无法迁移');
  }
  const rec = block as Record<string, unknown>;
  if (typeof rec.v === 'number' && rec.v > 1) {
    throw new MaterialStoreError('unsupported_schema', `不支持 sessionMaterials v${rec.v}`);
  }
  const legacy = rec.v !== 1;
  const source = rec.byWorkspace ?? rec.workspaces;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return { byWorkspace: {}, legacy };
  }
  const byWorkspace: Record<string, PersistedMaterial[]> = {};
  for (const [id, value] of Object.entries(source as Record<string, unknown>)) {
    byWorkspace[id] = parseMaterialList(value).map((item) => ({ ...item, tier: 'session' }));
  }
  return { byWorkspace, legacy };
}

export function writeSessionMaterials(file: string, byWorkspace: Record<string, PersistedMaterial[]>): void {
  const lockDir = `${file}.lock`;
  withStateLock(lockDir, () => {
    const disk = readJsonObject(file);
    if (disk.schemaVersion !== 1) disk.schemaVersion = 1;
    if (!disk.current || typeof disk.current !== 'object' || Array.isArray(disk.current)) {
      disk.current = {
        workspaceId: null,
        currentRevision: 0,
        revision: 0,
        oldestRevision: 0,
        segments: [],
        revisionTimes: {},
        pendingUnlinks: [],
      };
    }
    if (!disk.workspaces || typeof disk.workspaces !== 'object' || Array.isArray(disk.workspaces)) {
      disk.workspaces = {};
    }
    const stored: Record<string, unknown[]> = {};
    for (const [id, items] of Object.entries(byWorkspace)) {
      if (items.length) stored[id] = items.map(serializeMaterial);
    }
    disk.sessionMaterials = { v: 1, byWorkspace: stored };
    atomicWriteSync(file, JSON.stringify(disk));
  });
}

export function parseMaterialList(raw: unknown): PersistedMaterial[] {
  const items = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? (raw as { items: unknown[] }).items
      : [];
  const out: PersistedMaterial[] = [];
  items.forEach((item, index) => {
    const parsed = parseMaterial(item, index);
    if (parsed) out.push(parsed);
  });
  return out;
}

export function pinnedValueIsLegacy(raw: unknown): boolean {
  return Array.isArray(raw);
}

export function serializeMaterial(item: PersistedMaterial): Record<string, unknown> {
  return {
    ...item.extra,
    materialId: item.materialId,
    tier: item.tier,
    resourceId: item.resourceId,
    sourceId: item.sourceId,
    relPath: item.relPath,
    absPath: item.absPath,
    name: item.name,
    purpose: item.purpose,
    order: item.order,
    status: item.status,
    contentHash: item.contentHash,
    contentVersion: item.contentVersion,
    readable: item.readable,
    addedAt: item.addedAt,
    bytes: item.bytes,
    estTokens: item.estTokens,
    hasText: item.hasText,
    pages: item.pages,
    mtimeMs: item.mtimeMs,
    estimated: item.estimated,
    ...(item.slotId ? { slotId: item.slotId } : {}),
    ...(item.mount ? { mount: item.mount } : {}),
    ...(item.delivery ? { delivery: item.delivery } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.relations?.length ? { relations: item.relations } : {}),
  };
}

function parseRelations(value: unknown): PlaybookRelation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: PlaybookRelation[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    if (!isPlaybookRelation(rec.type) || typeof rec.targetId !== 'string' || !rec.targetId.trim()) continue;
    out.push({ type: rec.type, targetId: rec.targetId.trim() });
  }
  return out.length ? out : undefined;
}

function parseMaterial(raw: unknown, index: number): PersistedMaterial | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.materialId !== 'string' || typeof obj.absPath !== 'string' || obj.absPath.trim() === '') return null;
  const status: MaterialStatus = obj.status === 'missing' || obj.status === 'unreadable' ? obj.status : 'ok';
  const tier = obj.tier === 'pinned' ? 'pinned' : 'session';
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!ITEM_KEYS.has(key)) extra[key] = value;
  }
  return {
    materialId: obj.materialId,
    tier,
    resourceId: typeof obj.resourceId === 'string' && obj.resourceId ? obj.resourceId : null,
    sourceId: typeof obj.sourceId === 'string' && obj.sourceId ? obj.sourceId : null,
    relPath: typeof obj.relPath === 'string' ? obj.relPath : '',
    absPath: obj.absPath,
    name: typeof obj.name === 'string' && obj.name ? obj.name : obj.absPath,
    purpose: typeof obj.purpose === 'string' && obj.purpose.trim() ? obj.purpose : null,
    order: typeof obj.order === 'number' && Number.isFinite(obj.order) ? obj.order : index,
    status,
    contentHash: typeof obj.contentHash === 'string' ? obj.contentHash : null,
    contentVersion: typeof obj.contentVersion === 'number' && Number.isFinite(obj.contentVersion) ? obj.contentVersion : 0,
    readable: typeof obj.readable === 'string' ? obj.readable : null,
    addedAt: typeof obj.addedAt === 'string' ? obj.addedAt : new Date(0).toISOString(),
    bytes: typeof obj.bytes === 'number' && Number.isFinite(obj.bytes) ? obj.bytes : null,
    estTokens: typeof obj.estTokens === 'number' && Number.isFinite(obj.estTokens) ? obj.estTokens : null,
    hasText: obj.hasText === true,
    pages: typeof obj.pages === 'number' && Number.isFinite(obj.pages) ? obj.pages : null,
    mtimeMs: typeof obj.mtimeMs === 'number' && Number.isFinite(obj.mtimeMs) ? obj.mtimeMs : null,
    estimated: obj.estimated === true,
    ...(typeof obj.slotId === 'string' && obj.slotId.trim() ? { slotId: obj.slotId.trim() } : {}),
    ...(isPlaybookMount(obj.mount) ? { mount: obj.mount } : {}),
    ...(isPlaybookDelivery(obj.delivery) ? { delivery: obj.delivery } : {}),
    ...(typeof obj.summary === 'string' && obj.summary.trim() ? { summary: obj.summary.trim() } : {}),
    ...(() => {
      const relations = parseRelations(obj.relations);
      return relations ? { relations } : {};
    })(),
    extra,
  };
}

export function createFilePinnedStore(file: string): WorkspaceRecordStore {
  const readAll = (): Record<string, unknown> => {
    const disk = readJsonObject(file);
    if (!fs.existsSync(file)) return {};
    const workspaces = disk.workspaces;
    if (!workspaces || typeof workspaces !== 'object' || Array.isArray(workspaces)) return {};
    return { ...(workspaces as Record<string, unknown>) };
  };
  return {
    read(workspaceId) {
      return readAll()[workspaceId] ?? null;
    },
    write(workspaceId, value) {
      const workspaces = readAll();
      if (value == null) delete workspaces[workspaceId];
      else workspaces[workspaceId] = value;
      const disk = fs.existsSync(file) ? readJsonObject(file) : {};
      disk.schemaVersion = 1;
      disk.workspaces = workspaces;
      atomicWriteSync(file, JSON.stringify(disk));
    },
    keys() {
      return Object.keys(readAll());
    },
  };
}

export function createMemoryPinnedStore(): WorkspaceRecordStore {
  const map = new Map<string, unknown>();
  return {
    read: (id) => (map.has(id) ? map.get(id) : null),
    write(id, value) {
      if (value == null) map.delete(id);
      else map.set(id, value);
    },
    keys: () => [...map.keys()],
  };
}
