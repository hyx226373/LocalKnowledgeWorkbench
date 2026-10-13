import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AddResult,
  AgentMaterial,
  AgentMaterialsStore,
  MaterialEvent,
  MaterialRef,
  ResourceChange,
  ResourceChangeFeed,
  Unsubscribe,
} from '../../../shared/agentLive/types';
import { assertWorkspaceId, isWorkspaceId, MATERIAL_LIMIT, MaterialStoreError } from './errors';
import { hashBuffer, hashFileSample, hashHex } from './hashFile';
import {
  baseName,
  countPdfPages,
  displayPath,
  estimateTokens,
  isInsideDir,
  isSecretPath,
  isTransientPath,
  isUrlPath,
  normalizeRel,
  pathKey,
  preliminaryHasText,
  probeContent,
} from './identity';
import { LooseFileWatch } from './looseWatch';
import {
  createFilePinnedStore,
  parseMaterialList,
  pinnedValueIsLegacy,
  readSessionMaterials,
  serializeMaterial,
  writeSessionMaterials,
  type PersistedMaterial,
  type WorkspaceRecordStore,
} from './persist';

export interface SessionClearedEvent {
  type: 'session.cleared';
  workspaceId: string;
  materialIds: string[];
  ts?: string;
}

/** 组 1 实际发出的事件。session.cleared 在冻结的 MaterialEventType 里还没有。 */
export type MaterialsChange = MaterialEvent | SessionClearedEvent;

export type StatResult =
  | { kind: 'file'; size: number; mtimeMs: number }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'other' };

export interface MaterialIdentitySource {
  resolve(absPath: string): { resourceId: string; sourceId: string; relPath: string } | null;
}

export interface CreateMaterialsOptions {
  userDataDir: string;
  stateFile?: string;
  /** 固定资料。缺省写到 userDataDir/agent-materials/pinned.json。集成组换成 layout 表。 */
  pinned?: WorkspaceRecordStore;
  identity?: MaterialIdentitySource;
  feed?: ResourceChangeFeed;
  now?: () => Date;
  /** 缺省 30 秒。0 关闭。只 stat 已有资料，不建目录监视。 */
  repairMs?: number;
  /** 根外单文件监视的防抖。缺省 300ms。 */
  looseDebounceMs?: number;
  watchLoose?: boolean;
  stat?: (absPath: string) => StatResult;
  readFile?: (absPath: string) => Promise<Buffer>;
}

export interface AgentMaterialsApi extends AgentMaterialsStore {
  pin(workspaceId: string, materialId: string): void;
  unpin(workspaceId: string, materialId: string): void;
  clearSession(workspaceId: string): string[];
  /** 保留 materialId，换路径后重新哈希。冻结稿的 AgentMaterialsStore 还没有这一条。 */
  relocate(workspaceId: string, materialId: string, ref: MaterialRef): void;
  find(workspaceId: string, ref: MaterialRef): AgentMaterial | null;
  reconcile(): void;
  flushSync(): void;
  whenIdle(): Promise<void>;
  close(): Promise<void>;
  watchCount(): number;
}

interface LiveRow extends PersistedMaterial {
  workspaceId: string;
}

export function statPath(absPath: string): StatResult {
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) return { kind: 'file', size: st.size, mtimeMs: Math.trunc(st.mtimeMs) };
    return { kind: 'other' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return { kind: 'unreadable' };
    return { kind: 'missing' };
  }
}

export function createAgentMaterialsStore(opts: CreateMaterialsOptions): AgentMaterialsApi {
  return new MaterialsStore(opts);
}

export function onMaterialsChange(store: AgentMaterialsApi, cb: (event: MaterialsChange) => void): Unsubscribe {
  return store.onChange(cb as (event: MaterialEvent) => void);
}

class MaterialsStore implements AgentMaterialsApi {
  private readonly stateFile: string;
  private readonly pinned: WorkspaceRecordStore;
  private readonly identity?: MaterialIdentitySource;
  private readonly now: () => Date;
  private readonly stat: (absPath: string) => StatResult;
  private readonly readFile?: (absPath: string) => Promise<Buffer>;
  private readonly watchLoose: boolean;
  private readonly byWs = new Map<string, LiveRow[]>();
  private readonly listeners = new Set<(event: MaterialsChange) => void>();
  private readonly generation = new Map<string, number>();
  private readonly loose: LooseFileWatch;
  private feedUnsub?: Unsubscribe;
  private repairTimer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();
  private dirtySession = false;
  private readonly dirtyPinned = new Set<string>();
  private persistQueued = false;
  private stopping = false;
  private closed = false;

  constructor(opts: CreateMaterialsOptions) {
    this.stateFile = opts.stateFile ?? path.join(opts.userDataDir, 'agent-live-state.json');
    this.pinned = opts.pinned ?? createFilePinnedStore(path.join(opts.userDataDir, 'agent-materials', 'pinned.json'));
    this.identity = opts.identity;
    this.now = opts.now ?? (() => new Date());
    this.stat = opts.stat ?? statPath;
    this.readFile = opts.readFile;
    this.watchLoose = opts.watchLoose !== false;
    this.loose = new LooseFileWatch(opts.looseDebounceMs ?? 300, (absPath) => this.onLoose(absPath));
    this.load();
    if (opts.feed) this.feedUnsub = opts.feed.onBatch((batch) => this.onBatch(batch));
    const repairMs = opts.repairMs ?? 30_000;
    if (repairMs > 0) {
      this.repairTimer = setInterval(() => this.reconcile(), repairMs);
      this.repairTimer.unref?.();
    }
  }

  list(workspaceId: string): AgentMaterial[] {
    if (!isWorkspaceId(workspaceId)) return [];
    return this.rowsOf(workspaceId).map((row) => this.toPublic(row));
  }

  add(workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): AddResult {
    assertWorkspaceId(workspaceId);
    this.rejectRef(ref);
    const absPath = displayPath(ref.absPath);
    const st = this.stat(absPath);
    if (st.kind === 'other') throw new MaterialStoreError('not_a_file', '只接收文件，不接收目录');
    const bound = this.bindIdentity(ref, absPath);
    const existing = this.findIdentity(workspaceId, bound.resourceId, absPath);
    if (existing) {
      this.attachIdentity(existing, bound);
      return 'duplicate';
    }
    const rows = this.rowsOf(workspaceId);
    if (rows.length >= MATERIAL_LIMIT) {
      throw new MaterialStoreError('limit', `每个工作区最多 ${MATERIAL_LIMIT} 项工作资料`);
    }
    const row = this.makeRow(workspaceId, bound, absPath, cleanPurpose(opts?.purpose), st);
    this.insert(row, opts?.index);
    this.markDirty(workspaceId);
    this.emit({
      type: 'material.added',
      ...this.identityOf(row),
      order: row.order,
      purpose: row.purpose,
      ...(st.kind === 'file' ? { size: st.size, mtimeMs: st.mtimeMs } : {}),
    });
    if (st.kind === 'file') {
      this.arm(row);
      this.scheduleEstimate(row);
    }
    return 'added';
  }

  remove(workspaceId: string, materialId: string): void {
    assertWorkspaceId(workspaceId);
    const row = this.rowById(workspaceId, materialId);
    if (!row) return;
    this.bump(row);
    this.setRows(workspaceId, this.rowsOf(workspaceId).filter((item) => item !== row));
    this.disarmIfUnused(row.absPath);
    this.markDirty(workspaceId);
    this.emit({
      type: 'material.removed',
      ...this.identityOf(row),
      order: row.order,
      purpose: row.purpose,
    });
  }

  reorder(workspaceId: string, order: string[]): void {
    assertWorkspaceId(workspaceId);
    if (!Array.isArray(order)) return;
    const rows = this.rowsOf(workspaceId);
    const rank = new Map<string, number>();
    order.forEach((id, index) => {
      if (typeof id === 'string' && !rank.has(id)) rank.set(id, index);
    });
    const sortTier = (tier: 'session' | 'pinned') =>
      rows
        .filter((row) => row.tier === tier)
        .sort((a, b) => compareRank(a, b, rank));
    const next = [...sortTier('session'), ...sortTier('pinned')];
    const same = next.length === rows.length && next.every((row, index) => row === rows[index]);
    this.setRows(workspaceId, next);
    if (same) return;
    this.markDirty(workspaceId);
    this.emit({
      type: 'material.reordered',
      workspaceId,
      order: next.map((row) => row.materialId),
    });
  }

  setPurpose(workspaceId: string, materialId: string, purpose: string | null): void {
    assertWorkspaceId(workspaceId);
    const row = this.rowById(workspaceId, materialId);
    if (!row) return;
    const next = cleanPurpose(purpose);
    if (row.purpose === next) return;
    row.purpose = next;
    this.markDirty(workspaceId);
    this.emit({
      type: 'material.purposeChanged',
      ...this.identityOf(row),
      purpose: next,
    });
  }

  pin(workspaceId: string, materialId: string): void {
    this.moveTier(workspaceId, materialId, 'pinned');
  }

  unpin(workspaceId: string, materialId: string): void {
    this.moveTier(workspaceId, materialId, 'session');
  }

  clearSession(workspaceId: string): string[] {
    assertWorkspaceId(workspaceId);
    const rows = this.rowsOf(workspaceId);
    const session = rows.filter((row) => row.tier === 'session');
    if (!session.length) return [];
    const ids = session.map((row) => row.materialId);
    for (const row of session) this.bump(row);
    this.setRows(workspaceId, rows.filter((row) => row.tier === 'pinned'));
    for (const row of session) this.disarmIfUnused(row.absPath);
    this.markDirty(workspaceId);
    this.emit({ type: 'session.cleared', workspaceId, materialIds: ids });
    return ids;
  }

  relocate(workspaceId: string, materialId: string, ref: MaterialRef): void {
    assertWorkspaceId(workspaceId);
    const row = this.rowById(workspaceId, materialId);
    if (!row) throw new MaterialStoreError('bad_id', '资料不存在');
    this.rejectRef(ref);
    const absPath = displayPath(ref.absPath);
    const st = this.stat(absPath);
    if (st.kind === 'other') throw new MaterialStoreError('not_a_file', '只接收文件，不接收目录');
    const bound = this.bindIdentity(ref, absPath);
    const prevAbsPath = row.absPath;
    const prevRelPath = row.relPath;
    row.absPath = absPath;
    row.relPath = bound.relPath || baseName(absPath);
    row.name = bound.name || baseName(absPath) || row.name;
    row.resourceId = bound.resourceId;
    row.sourceId = bound.sourceId;
    row.contentHash = null;
    row.bytes = null;
    row.estTokens = null;
    row.readable = null;
    row.estimated = false;
    row.hasText = false;
    row.pages = null;
    row.mtimeMs = st.kind === 'file' ? st.mtimeMs : null;
    row.status = st.kind === 'file' ? 'ok' : st.kind === 'unreadable' ? 'unreadable' : 'missing';
    this.disarmIfUnused(prevAbsPath);
    if (row.status === 'ok') {
      this.arm(row);
      this.scheduleEstimate(row);
    } else {
      this.bump(row);
    }
    this.markDirty(workspaceId);
    this.emit({
      type: 'path.changed',
      ...this.identityOf(row),
      prevAbsPath,
      prevRelPath,
    });
  }

  find(workspaceId: string, ref: MaterialRef): AgentMaterial | null {
    if (!isWorkspaceId(workspaceId) || typeof ref?.absPath !== 'string') return null;
    try {
      const absPath = displayPath(ref.absPath);
      const row = this.findIdentity(workspaceId, emptyToNull(ref.resourceId), absPath);
      return row ? this.toPublic(row) : null;
    } catch {
      return null;
    }
  }

  onChange(cb: (event: MaterialEvent) => void): Unsubscribe {
    const listener = cb as (event: MaterialsChange) => void;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: MaterialsChange): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  reconcile(): void {
    if (this.stopping) return;
    for (const row of this.allRows()) this.onFileSignal(row);
  }

  flushSync(): void {
    this.persistQueued = false;
    this.flushDirty();
  }

  async whenIdle(): Promise<void> {
    for (let guard = 0; guard < 6; guard++) {
      this.flushSync();
      await new Promise((resolve) => setImmediate(resolve));
      const pending = this.chain;
      await pending;
      this.flushSync();
      if (this.chain === pending && !this.dirtySession && this.dirtyPinned.size === 0) return;
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.feedUnsub?.();
    this.feedUnsub = undefined;
    this.loose.close();
    if (this.repairTimer) clearInterval(this.repairTimer);
    await this.whenIdle();
    this.closed = true;
  }

  watchCount(): number {
    return this.loose.size;
  }

  private load(): void {
    const session = readSessionMaterials(this.stateFile);
    const ids = new Set<string>([...Object.keys(session.byWorkspace), ...this.pinned.keys()]);
    let dirty = session.legacy;
    for (const workspaceId of ids) {
      if (!isWorkspaceId(workspaceId)) continue;
      const rawPinned = this.pinned.read(workspaceId);
      if (pinnedValueIsLegacy(rawPinned)) dirty = true;
      const pinnedItems = parseMaterialList(rawPinned).map((item) => this.toLive(item, workspaceId, 'pinned'));
      const sessionItems = (session.byWorkspace[workspaceId] ?? []).map((item) => this.toLive(item, workspaceId, 'session'));
      const merged = this.mergeLoaded(sessionItems, pinnedItems);
      const kept = merged.filter((row) => !isSecretPath(row.absPath));
      if (kept.length !== merged.length) dirty = true;
      if (kept.length) this.setRows(workspaceId, this.group(kept));
    }
    for (const row of this.allRows()) {
      if (row.resourceId == null && row.status === 'ok') this.arm(row);
      if (row.status === 'ok' && !row.estimated) this.scheduleEstimate(row);
    }
    if (dirty) {
      for (const id of this.byWs.keys()) this.markDirty(id);
    }
  }

  private mergeLoaded(session: LiveRow[], pinned: LiveRow[]): LiveRow[] {
    const pinnedIds = new Set(pinned.map((row) => row.materialId));
    const sessionKept = session.filter((row) => {
      if (pinnedIds.has(row.materialId)) return false;
      return !pinned.some((item) => sameIdentity(item, row.resourceId, row.absPath));
    });
    return [...dedupeRows(sessionKept), ...dedupeRows(pinned)];
  }

  private rejectRef(ref: MaterialRef): void {
    if (!ref || typeof ref.absPath !== 'string' || ref.absPath.trim() === '' || isUrlPath(ref.absPath)) {
      throw new MaterialStoreError('not_a_file', '没有原文件的内容本轮不收');
    }
    if (isSecretPath(ref.absPath)) throw new MaterialStoreError('secret', '不接收 agent-token.json');
  }

  private bindIdentity(ref: MaterialRef, absPath: string): { resourceId: string | null; sourceId: string | null; relPath: string; name: string } {
    let resourceId = emptyToNull(ref.resourceId);
    let sourceId = emptyToNull(ref.sourceId);
    let relPath = typeof ref.relPath === 'string' && ref.relPath.trim() ? normalizeRel(ref.relPath) : '';
    if (!resourceId && this.identity) {
      try {
        const hit = this.identity.resolve(absPath);
        if (hit?.resourceId) {
          resourceId = hit.resourceId;
          sourceId = emptyToNull(hit.sourceId) ?? sourceId;
          if (!relPath && hit.relPath) relPath = normalizeRel(hit.relPath);
        }
      } catch {
        /* 解析失败就按根外单文件登记 */
      }
    }
    if (!relPath) relPath = baseName(absPath);
    const name = typeof ref.name === 'string' && ref.name.trim() ? ref.name.trim() : baseName(absPath);
    return { resourceId, sourceId, relPath, name };
  }

  private attachIdentity(row: LiveRow, bound: { resourceId: string | null; sourceId: string | null; relPath: string }): void {
    if (row.resourceId != null || bound.resourceId == null) return;
    row.resourceId = bound.resourceId;
    row.sourceId = bound.sourceId;
    if (bound.relPath) row.relPath = bound.relPath;
    this.disarmIfUnused(row.absPath);
    this.markDirty(row.workspaceId);
  }

  private makeRow(
    workspaceId: string,
    bound: { resourceId: string | null; sourceId: string | null; relPath: string; name: string },
    absPath: string,
    purpose: string | null,
    st: StatResult,
  ): LiveRow {
    const file = st.kind === 'file';
    return {
      workspaceId,
      materialId: `m-${crypto.randomUUID()}`,
      tier: 'session',
      resourceId: bound.resourceId,
      sourceId: bound.sourceId,
      relPath: bound.relPath,
      absPath,
      name: bound.name,
      purpose,
      order: 0,
      status: st.kind === 'unreadable' ? 'unreadable' : file ? 'ok' : 'missing',
      contentHash: null,
      contentVersion: 0,
      readable: null,
      addedAt: this.now().toISOString(),
      bytes: file ? st.size : null,
      estTokens: null,
      hasText: preliminaryHasText(absPath),
      pages: null,
      mtimeMs: file ? st.mtimeMs : null,
      estimated: !file,
      extra: {},
    };
  }

  private insert(row: LiveRow, index?: number): void {
    const rows = this.rowsOf(row.workspaceId).filter((item) => item !== row);
    const session = rows.filter((item) => item.tier === 'session');
    const pinned = rows.filter((item) => item.tier === 'pinned');
    const bucket = row.tier === 'session' ? session : pinned;
    let at = bucket.length;
    if (typeof index === 'number' && Number.isFinite(index)) at = Math.max(0, Math.min(bucket.length, Math.trunc(index)));
    bucket.splice(at, 0, row);
    this.setRows(row.workspaceId, [...session, ...pinned]);
  }

  private moveTier(workspaceId: string, materialId: string, tier: 'session' | 'pinned'): void {
    assertWorkspaceId(workspaceId);
    const row = this.rowById(workspaceId, materialId);
    if (!row || row.tier === tier) return;
    row.tier = tier;
    const rest = this.rowsOf(workspaceId).filter((item) => item !== row);
    const session = rest.filter((item) => item.tier === 'session');
    const pinned = rest.filter((item) => item.tier === 'pinned');
    const next = tier === 'pinned' ? [...session, ...pinned, row] : [...session, row, ...pinned];
    this.setRows(workspaceId, next);
    this.markDirty(workspaceId);
    this.emit({
      type: tier === 'pinned' ? 'material.pinned' : 'material.unpinned',
      ...this.identityOf(row),
    });
  }

  private onBatch(batch: ResourceChange[]): void {
    if (this.stopping) return;
    const groups = new Map<string, ResourceChange[]>();
    const order: LiveRow[] = [];
    for (const change of batch) {
      if (this.ignored(change) || change.type === 'addDir') continue;
      for (const row of this.matching(change)) {
        const key = `${row.workspaceId}\0${row.materialId}`;
        let list = groups.get(key);
        if (!list) {
          list = [];
          groups.set(key, list);
          order.push(row);
        }
        list.push(change);
      }
    }
    for (const row of order) this.applyGrouped(row, groups.get(`${row.workspaceId}\0${row.materialId}`) ?? []);
  }

  /** 同一批里的 unlink+add 视为移动，不把条目先标失效再恢复。 */
  private applyGrouped(row: LiveRow, changes: ResourceChange[]): void {
    const gone = changes.every((change) => change.type === 'unlink' || change.type === 'unlinkDir');
    if (gone) {
      this.markMissing(row);
      return;
    }
    const latest = [...changes].reverse().find((change) => change.type !== 'unlink' && change.type !== 'unlinkDir');
    if (latest) {
      const nextAbs = latest.absPath ? displayPath(latest.absPath) : row.absPath;
      const nextRel = latest.relPath ? normalizeRel(latest.relPath) : row.relPath;
      if (pathKey(nextAbs) !== pathKey(row.absPath) || (latest.relPath != null && nextRel !== row.relPath)) {
        this.applyPath(row, nextAbs, nextRel);
      }
    }
    this.onFileSignal(row);
  }

  private ignored(change: ResourceChange): boolean {
    const paths = [change.absPath, change.prevAbsPath, change.relPath, change.prevRelPath];
    if (paths.some((item) => isSecretPath(item))) return true;
    const dest = change.absPath || (!change.prevAbsPath ? change.relPath : undefined);
    return isTransientPath(dest);
  }

  private matching(change: ResourceChange): LiveRow[] {
    return this.allRows().filter((row) => {
      if (change.resourceId && row.resourceId === change.resourceId) return true;
      if (change.absPath && pathKey(change.absPath) === pathKey(row.absPath)) return true;
      if (change.prevAbsPath && pathKey(change.prevAbsPath) === pathKey(row.absPath)) return true;
      if (change.type === 'unlinkDir' && change.absPath && isInsideDir(change.absPath, row.absPath)) return true;
      if (change.rootId && row.sourceId === change.rootId) {
        if (change.relPath && normalizeRel(change.relPath) === row.relPath) return true;
        if (change.prevRelPath && normalizeRel(change.prevRelPath) === row.relPath) return true;
      }
      return false;
    });
  }

  private applyPath(row: LiveRow, nextAbs: string, nextRel: string): void {
    const prevAbsPath = row.absPath;
    const prevRelPath = row.relPath;
    row.absPath = nextAbs;
    row.relPath = nextRel || baseName(nextAbs);
    row.name = baseName(nextAbs) || row.name;
    this.disarmIfUnused(prevAbsPath);
    this.arm(row);
    this.markDirty(row.workspaceId);
    this.emit({
      type: 'path.changed',
      ...this.identityOf(row),
      prevAbsPath,
      prevRelPath,
    });
  }

  private onLoose(absPath: string): void {
    if (this.stopping) return;
    const key = pathKey(absPath);
    for (const row of this.allRows()) {
      if (row.resourceId != null) continue;
      if (pathKey(row.absPath) !== key) continue;
      this.onFileSignal(row);
    }
  }

  private onFileSignal(row: LiveRow): void {
    if (isSecretPath(row.absPath)) return;
    const st = this.stat(row.absPath);
    if (st.kind === 'unreadable') {
      this.markUnreadable(row);
      return;
    }
    if (st.kind !== 'file') {
      this.markMissing(row);
      return;
    }
    if (row.status !== 'ok') this.markRestored(row);
    if (row.bytes === st.size && row.mtimeMs === st.mtimeMs && row.contentHash && row.estimated) return;
    this.scheduleEstimate(row);
  }

  private markMissing(row: LiveRow): void {
    if (row.status === 'missing') return;
    row.status = 'missing';
    this.bump(row);
    this.disarmIfUnused(row.absPath);
    this.markDirty(row.workspaceId);
    this.emit({ type: 'material.missing', ...this.identityOf(row) });
  }

  private markRestored(row: LiveRow): void {
    if (row.status === 'ok') return;
    row.status = 'ok';
    this.arm(row);
    this.markDirty(row.workspaceId);
    this.emit({ type: 'material.restored', ...this.identityOf(row) });
  }

  private markUnreadable(row: LiveRow): void {
    if (row.status === 'unreadable') return;
    row.status = 'unreadable';
    this.bump(row);
    this.disarmIfUnused(row.absPath);
    this.markDirty(row.workspaceId);
  }

  private scheduleEstimate(row: LiveRow): void {
    const gen = this.bump(row);
    const materialId = row.materialId;
    const workspaceId = row.workspaceId;
    this.enqueue(async () => {
      if (this.closed) return;
      const current = this.rowById(workspaceId, materialId);
      if (!current || this.generation.get(materialId) !== gen) return;
      const before = this.stat(current.absPath);
      if (before.kind === 'unreadable') {
        this.markUnreadable(current);
        return;
      }
      if (before.kind !== 'file') {
        this.markMissing(current);
        return;
      }
      let hashed: { hash: string; sample: Buffer };
      try {
        hashed = await this.readHashed(current.absPath);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const again = this.rowById(workspaceId, materialId);
        if (!again || this.generation.get(materialId) !== gen) return;
        if (code === 'EACCES' || code === 'EPERM') this.markUnreadable(again);
        else this.markMissing(again);
        return;
      }
      const again = this.rowById(workspaceId, materialId);
      if (!again || this.generation.get(materialId) !== gen || this.closed) return;
      const after = this.stat(again.absPath);
      if (after.kind !== 'file') {
        if (after.kind === 'unreadable') this.markUnreadable(again);
        else this.markMissing(again);
        return;
      }
      this.applyEstimate(again, hashed.hash, hashed.sample, after);
    });
  }

  private applyEstimate(row: LiveRow, hash: string, sample: Buffer, st: { size: number; mtimeMs: number }): void {
    const prev = row.contentHash;
    const same = !!prev && hashHex(prev) === hashHex(hash);
    const sameStat = row.bytes === st.size && row.mtimeMs === st.mtimeMs;
    if (same && sameStat && row.estimated) return;
    const probe = probeContent(row.absPath, sample, st.size);
    const hex = hashHex(hash);
    row.bytes = st.size;
    row.mtimeMs = st.mtimeMs;
    row.contentHash = hash;
    row.estimated = true;
    row.hasText = probe.hasText;
    row.pages = probe.kind === 'pdf' ? countPdfPages(sample) : null;
    row.estTokens = probe.kind === 'text' || probe.decoded ? estimateTokens(probe.decoded, st.size, sample.length) : null;
    row.readable = probe.kind === 'text' && hex ? `content/${row.materialId}/${hex}.txt` : null;
    row.status = 'ok';
    if (!same) row.contentVersion += 1;
    this.markDirty(row.workspaceId);
    this.emit({
      type: 'content.changed',
      ...this.identityOf(row),
      contentHash: hash,
      ...(prev ? { prevContentHash: prev } : {}),
      size: st.size,
      mtimeMs: st.mtimeMs,
      ...(probe.kind === 'text' ? {} : { diffSupported: false }),
    });
  }

  private async readHashed(absPath: string): Promise<{ hash: string; sample: Buffer }> {
    if (this.readFile) {
      const buf = await this.readFile(absPath);
      const sample = buf.length > 2 * 1024 * 1024 ? buf.subarray(0, 2 * 1024 * 1024) : buf;
      return { hash: hashBuffer(buf), sample: sample.length === buf.length ? sample : Buffer.from(sample) };
    }
    return hashFileSample(absPath);
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task, task);
  }

  private bump(row: LiveRow): number {
    const next = (this.generation.get(row.materialId) ?? 0) + 1;
    this.generation.set(row.materialId, next);
    return next;
  }

  private arm(row: LiveRow): void {
    if (!this.watchLoose || row.resourceId != null || row.status !== 'ok') return;
    this.loose.arm(row.absPath);
  }

  private disarmIfUnused(absPath: string): void {
    const key = pathKey(absPath);
    const used = this.allRows().some((row) => row.resourceId == null && row.status === 'ok' && pathKey(row.absPath) === key);
    if (!used) this.loose.disarm(absPath);
  }

  private findIdentity(workspaceId: string, resourceId: string | null, absPath: string): LiveRow | undefined {
    const key = pathKey(absPath);
    return this.rowsOf(workspaceId).find((row) => sameIdentity(row, resourceId, absPath) || pathKey(row.absPath) === key);
  }

  private rowById(workspaceId: string, materialId: string): LiveRow | undefined {
    return this.rowsOf(workspaceId).find((row) => row.materialId === materialId);
  }

  private rowsOf(workspaceId: string): LiveRow[] {
    return this.byWs.get(workspaceId) ?? [];
  }

  private setRows(workspaceId: string, rows: LiveRow[]): void {
    rows.forEach((row, index) => {
      row.order = index;
    });
    if (rows.length === 0) this.byWs.delete(workspaceId);
    else this.byWs.set(workspaceId, rows);
  }

  private group(rows: LiveRow[]): LiveRow[] {
    const session = rows.filter((row) => row.tier === 'session').sort((a, b) => a.order - b.order);
    const pinned = rows.filter((row) => row.tier === 'pinned').sort((a, b) => a.order - b.order);
    return [...session, ...pinned];
  }

  private allRows(): LiveRow[] {
    const out: LiveRow[] = [];
    for (const rows of this.byWs.values()) out.push(...rows);
    return out;
  }

  private toLive(item: PersistedMaterial, workspaceId: string, tier: 'session' | 'pinned'): LiveRow {
    return { ...item, extra: { ...item.extra }, tier, workspaceId };
  }

  private toPublic(row: LiveRow): AgentMaterial {
    return {
      materialId: row.materialId,
      tier: row.tier,
      resourceId: row.resourceId,
      sourceId: row.sourceId,
      relPath: row.relPath,
      absPath: row.absPath,
      name: row.name,
      purpose: row.purpose,
      order: row.order,
      status: row.status,
      contentHash: row.contentHash,
      contentVersion: row.contentVersion,
      readable: row.readable,
      addedAt: row.addedAt,
      bytes: row.bytes,
      estTokens: row.estTokens,
      hasText: row.hasText,
      pages: row.pages,
    };
  }

  private identityOf(row: LiveRow) {
    return {
      workspaceId: row.workspaceId,
      materialId: row.materialId,
      resourceId: row.resourceId,
      sourceId: row.sourceId,
      relPath: row.relPath,
      absPath: row.absPath,
      tier: row.tier,
    };
  }

  private markDirty(workspaceId: string): void {
    this.dirtySession = true;
    this.dirtyPinned.add(workspaceId);
    this.queuePersist();
  }

  private queuePersist(): void {
    if (this.persistQueued) return;
    this.persistQueued = true;
    queueMicrotask(() => {
      if (!this.persistQueued) return;
      this.persistQueued = false;
      try {
        this.flushDirty();
      } catch {
        /* 磁盘失败时保留 dirty，下次 flushSync 再写 */
      }
    });
  }

  private flushDirty(): void {
    if (!this.dirtySession && this.dirtyPinned.size === 0) return;
    const pinnedIds = [...this.dirtyPinned];
    const writeSession = this.dirtySession;
    this.dirtySession = false;
    this.dirtyPinned.clear();
    try {
      if (writeSession) this.writeSession();
      for (const id of pinnedIds) this.writePinned(id);
    } catch (err) {
      if (writeSession) this.dirtySession = true;
      for (const id of pinnedIds) this.dirtyPinned.add(id);
      throw err;
    }
  }

  private writeSession(): void {
    const byWorkspace: Record<string, PersistedMaterial[]> = {};
    for (const [id, rows] of this.byWs) {
      const session = rows.filter((row) => row.tier === 'session');
      if (session.length) byWorkspace[id] = session;
    }
    writeSessionMaterials(this.stateFile, byWorkspace);
  }

  private writePinned(workspaceId: string): void {
    const items = this.rowsOf(workspaceId).filter((row) => row.tier === 'pinned');
    this.pinned.write(
      workspaceId,
      items.length
        ? { schemaVersion: 1, items: items.map((row) => serializeMaterial(row)) }
        : null,
    );
  }
}

function emptyToNull(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text : null;
}

function cleanPurpose(value: string | null | undefined): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function sameIdentity(row: LiveRow, resourceId: string | null, absPath: string): boolean {
  if (resourceId && row.resourceId === resourceId) return true;
  return pathKey(row.absPath) === pathKey(absPath);
}

function dedupeRows(rows: LiveRow[]): LiveRow[] {
  const out: LiveRow[] = [];
  for (const row of rows) {
    if (out.some((item) => item.materialId === row.materialId || sameIdentity(item, row.resourceId, row.absPath))) continue;
    out.push(row);
  }
  return out;
}

function compareRank(a: LiveRow, b: LiveRow, rank: Map<string, number>): number {
  const ra = rank.get(a.materialId);
  const rb = rank.get(b.materialId);
  if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
  if (ra !== undefined && rb === undefined) return -1;
  if (ra === undefined && rb !== undefined) return 1;
  return a.order - b.order;
}


