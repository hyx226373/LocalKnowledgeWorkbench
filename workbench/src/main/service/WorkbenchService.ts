/**
 * WorkbenchService —— UI 与（下一轮的）Agent API 共用的唯一服务层。
 * 不依赖 Electron，可在纯 Node / 测试中运行。重活（扫描、对账、未来的正文抽取）交给 IndexRunner（worker）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { claimUnownedRoots, EMPTY_ROOT_FILTER_JSON, openDb, openReadDb, workspaceRootFallbacks, type DB, type WorkspaceRootFallback } from './db';
import { PathEscapeError, normalizeRelPath, parseKbfileUrl, resolveInRoot, toRelPath } from './paths';
import { extensionsFromFilterJson, inAccessScope, normalizeExtensions, OutOfScopeError, type AccessScope } from '../../shared/sourceFilter';
import { isTemporaryWorkspaceId } from '../../shared/temporaryWorkspace';
import { applyEvents, isIgnoredName, reconcileFilter, statForIndex, upsertSeen, hashFileSync, type FsEvent, type ScanChange } from './indexer';
import { stallNote, stallOp } from '../startupTrace';
import { disk, diskPromises } from './disk';
import { noteDbWait } from '../runtimeStats';
import type { FsChangeEvent } from '../../shared/types';
import { PHASE_DELETED, PHASE_DELETING, type RootOpReceipt, type RootTask, type RootTaskPriority } from '../../shared/rootTask';
import { runRootDiskDelete } from './rootDiskDelete';
import {
  ensureRootRetirementSchema,
  hiddenRootIds,
  listRootTasks as listRootTaskRows,
  patchRootTask,
  readPublishSnapshot,
  restoreRootRecord,
  retireRoot,
} from './rootGeneration';
import { cleanupRetiredRoot } from './rootCleanup';
import { publishRootResult, RootJobScheduler } from './rootScheduler';
import { ensureWorkspaceRootInstances, liveOtherCount, readInstance, upsertInstance } from './workspaceRootInstance';
import { updateWorkspaceCardFields } from './workspaceCardFields';
import { applyRemapPreview, buildRemapPreview, type RemapPreview, type RemapSelection } from './remapPreview';
import { InProcessIndexRunner, type IndexRunner, type IndexRunnerEvents } from './indexRunner';
import { PluginHostService } from './pluginHost';
import { LAYOUT_SCHEMA_VERSION, panelItemId, pruneDock, sanitizeItem, splitLegacyItems, type SerializedDock, type StoredLayout, type WorkspaceItem } from '../../shared/items';
import {
  readerTypeOf,
  type DirEntry,
  type Favorite,
  type IndexStatus,
  type OpLogEntry,
  type OpLogView,
  type OpUndoResult,
  type OpPreview,
  type ResourceInfo,
  type Root,
  type RootKind,
  type SearchHit,
  type TextContent,
  type WorkspaceSummary,
  type WorkspaceDto,
  type KbLayoutFile,
  type ImportResult,
  type ThemePackDto,
  type WorkspaceRef,
  type EntryKind,
  type VirtualFolder,
  type VfolderView,
  type VfolderEntry,
} from '../../shared/types';
import { DEFAULT_CATALOG_ID, DEFAULT_VIRTUAL_ROOT_NAME, parentChain, refsFromByFolder, type CatalogRef } from '../../shared/catalog';
import { catalogSelectable, ensureDefaultCatalog, readCatalogView, saveCatalog } from './catalogStore';
import {
  VFOLDERS_KEY,
  VFOLDER_REFS_KEY,
  VFOLDER_UNDO_KEY,
  WEB_STUBS_KEY,
  emptyVfolderRefs,
  emptyVfolders,
  parseUndo,
  parseWebStubs,
  createFolder,
  renameFolder,
  deleteFolder,
  moveFolder,
  setMembership,
  foldersOf,
  classifyInto,
  undoClassify,
  removeFromOneFolder,
  type ClassItem,
  type ClassifyUndo,
  type VfolderRefs,
  type VfolderStore,
} from './workspaceRefs';
import {
  exportCatalogFromDb,
  importCatalogIntoDb,
  migrateWebStubsIntoWebSources,
  type CatalogFile,
  type ImportCatalogResult,
} from './catalogFile';
import { DEFAULT_APP_BACKUP_LIMITS } from '../../shared/adapter-sdk/policy';

/** 布局（工作区）JSON 上限：只放视图状态，不放文件内容 */
export const MAX_WORKSPACE_LAYOUT_BYTES = 512 * 1024;
const LEGACY_DOCK_KEY = 'dock';
const CURRENT_WS_KEY = 'workspace.current';
/** 工作资料（集合）：layout 表中按工作区保存的资源 ID 列表（不改数据库结构、不改布局格式） */
const WS_REFS_KEY = (id: string) => `workspace.refs:${id}`;
const MAX_WS_REFS = 2000;
const THEME_FILE_MAX = 256 * 1024;

export interface PluginState {
  id: string;
  version: string;
  source: 'builtin' | 'user' | 'adapter';
  enabled: boolean;
  granted: unknown[];
  installedAt: number;
}

/** 外部程序改动备份的保留期（与 SDK 启动前备份保留期一致） */
export const EXTERNAL_BACKUP_RETENTION_MS = DEFAULT_APP_BACKUP_LIMITS.retentionDays * 24 * 3600 * 1000;
export const BACKUP_EXPIRED_TEXT = '备份已过期，无法撤销';
/** 撤销预览里的“硬冲突”：无论是否确认都不能撤销 */
export const isHardUndoConflict = (c: string) => c.includes('无法恢复') || c.includes('缺失') || c.includes('无法撤销');

export class ConflictError extends Error {
  constructor(msg: string, public conflicts: string[]) {
    super(msg);
    this.name = 'ConflictError';
  }
}
export class NotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'NotFoundError';
  }
}

/** 新文件夹盖住已有来源。不吞并、不改那些来源的资料 ID。 */
export class SourceCoveredError extends Error {
  readonly covered: { id: string; name: string }[];
  constructor(covered: { id: string; name: string }[]) {
    super(`新文件夹盖住已有来源：${covered.map((c) => `${c.name}（${c.id}）`).join('、')}`);
    this.name = 'SourceCoveredError';
    this.covered = covered;
  }
}

/** resolveIngest 的结果：别名、已有来源，或可以新建（调用方再插入）。 */
export type IngestResolution =
  | { alias: true; resourceId: string }
  | { alias: false; root: Root }
  | { alias: false; abs: string; real: string };

export interface ServiceOptions {
  dataDir: string;
  createRunner?: (dbFile: string, ev: IndexRunnerEvents) => IndexRunner;
  machineId?: string;
  stagingRetentionMs?: number;
}

interface ResRow {
  id: string;
  root_id: string;
  rel_path: string;
  name: string;
  ext: string;
  kind: 'file' | 'dir';
  size: number;
  mtime_ms: number;
  missing_since: number | null;
  out_of_scope?: number;
}

const TEXT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * r11-A 网络资料：外部资源（网络资料 web resourceId）的解析钩子。只在 resources 表中查不到时使用，
 * 让已缓存的直链文件能被现有阅读器读取（getResource / resolveResourcePath / kbfile://res / readText），
 * 并让工作资料引用 web resourceId。写操作仍按 resources 表查找，web resourceId 天然失败（只读）。
 */
/** 某个工作区当前选用的编排。读出来的是那一套的目录和引用，不是资料副本。 */
export interface WorkspaceCatalog {
  workspaceId: string;
  catalogId: string;
  virtualRootName: string;
  folders: VirtualFolder[];
  refs: CatalogRef[];
}

export interface ExternalResourceProvider {
  has(resourceId: string): boolean;
  resourceInfo(resourceId: string): ResourceInfo | null;
  resolvePath(resourceId: string): string;
  workspaceRef(resourceId: string, addedAt: number): WorkspaceRef | null;
  exportRecords(ids: string[]): NonNullable<KbLayoutFile['webResources']>;
  importRecords(recs: unknown): Map<string, string>;
}

/** 固定资料随工作区放在 layout 表。这一键允许保存绝对路径，其它布局键仍然拒绝。 */
export const AGENT_PINNED_LAYOUT_PREFIX = 'agent.materials.pinned:';

export class WorkbenchService extends EventEmitter {
  readonly db: DB;
  /** 界面读取。打不开时为 null，view() 改走写连接。 */
  private readDb: DB | null = null;
  readonly dbFile: string;
  readonly dataDir: string;
  readonly stagingDir: string;
  readonly blobDir: string;
  private runner: IndexRunner;
  private machineId: string;
  private status = new Map<string, IndexStatus>();
  private backfill: Array<{ rootId: string; rel: string; abs: string }> = [];
  private backfillTimer: ReturnType<typeof setTimeout> | null = null;
  private beforeMutate: ((abs: string) => void) | null = null;
  private afterMutate: (() => void) | null = null;
  private stagingRetentionMs: number;
  /** 第三方（沙箱）适配器插件：开发者模式安装、结构化授权、files.*、存储、批量计划 */
  readonly plugins: PluginHostService;
  // ---- r11-A 网络资料：外部资源钩子（由 main/index.ts 接上 WebResourceStore；单测可不设）
  externalResources: ExternalResourceProvider | null = null;

  constructor(opts: ServiceOptions) {
    super();
    this.dataDir = path.resolve(opts.dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.stagingDir = path.join(this.dataDir, 'staging');
    this.blobDir = path.join(this.dataDir, 'blobs');
    fs.mkdirSync(this.stagingDir, { recursive: true });
    fs.mkdirSync(this.blobDir, { recursive: true });
    this.dbFile = path.join(this.dataDir, 'workbench.db');
    this.db = openDb(this.dbFile);
    this.readDb = openReadDb(this.dbFile);
    migrateWebStubsIntoWebSources(this.db);
    this.machineId = opts.machineId ?? os.hostname();
    this.stagingRetentionMs = opts.stagingRetentionMs ?? 30 * 24 * 3600 * 1000;
    const ev: IndexRunnerEvents = {
      onProgress: (rootId, processed) => this.patchStatus(rootId, { state: 'scanning', progress: processed }, true),
    };
    this.runner = opts.createRunner ? opts.createRunner(this.dbFile, ev) : new InProcessIndexRunner(this.dbFile, ev);
    this.plugins = new PluginHostService(this);
  }

  /** 当前内容的 sha256（批量计划的乐观锁） */
  contentHash(resourceId: string): string | null {
    try {
      return hashFileSync(this.resolveResourcePath(resourceId));
    } catch {
      return null;
    }
  }

  private closed = false;
  private dbClosed = false;
  private rootJobs = new RootJobScheduler();
  private retirementReady = false;
  /** 删除磁盘上的根之前松开监听。返回的 Promise 会等句柄关掉。 */
  private beforeRootDelete: ((abs: string) => void | Promise<void>) | null = null;
  private inflight = new Set<Promise<unknown>>();
  private cancelEpoch = new Map<string, number>();
  /** 同一个工作区的布局保存串行。锁被占时这条链在定时器上等，不占着主线程。 */
  private layoutTail = new Map<string, Promise<void>>();
  /** 写锁被占时先记住要切换的工作区，布局键等锁放开再写。 */
  private desiredWorkspaceId: string | null = null;
  private workspacePersistTimer: ReturnType<typeof setTimeout> | null = null;

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.rootJobs.close();
    if (this.backfillTimer) clearTimeout(this.backfillTimer);
    this.backfillTimer = null;
    this.backfill = [];
    for (const r of this.loadRootRows()) this.runner.cancel(r.id);
    await this.rootJobs.whenIdle();
    await Promise.allSettled([...this.inflight]);
    await this.runner.close();
    // 扫描连接先放开写锁，再把还在等锁的布局写完。
    await Promise.allSettled([...this.layoutTail.values()]);
    if (this.workspacePersistTimer) clearTimeout(this.workspacePersistTimer);
    this.workspacePersistTimer = null;
    const pendingWorkspace = this.desiredWorkspaceId;
    if (pendingWorkspace) {
      const until = Date.now() + 2000;
      while (this.desiredWorkspaceId === pendingWorkspace && Date.now() < until) {
        try {
          this.commitCurrentWorkspace(pendingWorkspace);
          if (this.desiredWorkspaceId === pendingWorkspace) this.desiredWorkspaceId = null;
        } catch (err) {
          if (!isDbBusy(err)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    this.dbClosed = true;
    try { this.readDb?.close(); } catch { /* 只读连接已经关了 */ }
    this.readDb = null;
    this.db.close();
  }

  /** 已提交的数据。界面读取走这里，不等写锁。事务内要看见未提交的写入时仍用 this.db。 */
  private view(): DB {
    return this.readDb ?? this.db;
  }

  /** 正文索引过的资料数。表还没有时返回 0。 */
  countIndexedFiles(): number {
    try {
      const row = this.view().prepare('SELECT COUNT(DISTINCT resource_id) AS c FROM indexer_files').get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch {
      return 0;
    }
  }

  // ---------------- roots ----------------

  /** 全部根行，含已退休但仍在库里的。列表过滤不要走这里。 */
  private loadRootRows(): Root[] {
    const rows = this.view()
      .prepare(
        `SELECT r.id, r.name, r.kind, r.created_at, m.local_path, (SELECT id FROM resources x WHERE x.root_id = r.id AND x.rel_path = '') AS res_id
         FROM roots r LEFT JOIN root_mounts m ON m.root_id = r.id ORDER BY r.created_at`,
      )
      .all() as { id: string; name: string; kind: string; created_at: number; local_path: string | null; res_id: string }[];
    return rows.map((r) => {
      const kind: RootKind = r.kind === 'file' ? 'file' : 'folder';
      const mounted = r.local_path ? (kind === 'file' ? isFile(r.local_path) : isDir(r.local_path)) : false;
      return {
        id: r.id,
        sourceId: r.id,
        workspaceRootId: r.id,
        name: r.name,
        path: r.local_path ?? '',
        resourceId: r.res_id,
        status: mounted ? 'ok' : 'missing',
        createdAt: r.created_at,
        kind,
      };
    });
  }

  /** 全局列表。排除「没有任何存活 workspace_roots 且存在 hidden 行」的根。 */
  listRoots(): Root[] {
    this.ensureRetirement();
    this.ensureInstances();
    const hidden = hiddenRootIds(this.db, null);
    const workspaceId = this.activeWorkspaceId();
    return this.loadRootRows()
      .filter((root) => !hidden.has(root.id))
      .map((root) => (workspaceId ? this.presentRoot(root, workspaceId) : root));
  }

  getRoot(rootId: string): Root {
    const r = this.loadRootRows().find((x) => x.id === rootId);
    if (!r) throw new NotFoundError(`根不存在: ${rootId}`);
    const workspaceId = this.activeWorkspaceId();
    return workspaceId ? this.presentRoot(r, workspaceId) : r;
  }

  rootPath(rootId: string): string {
    const r = this.view().prepare('SELECT local_path FROM root_mounts WHERE root_id = ?').get(rootId) as { local_path: string } | undefined;
    if (!r) throw new NotFoundError(`根未挂载: ${rootId}`);
    return r.local_path;
  }

  /** 重映射仍拒绝任何路径重叠（别名只用于登记）。目标必须是文件夹。 */
  private assertRemapFolder(p: string, exceptRootId: string): string {
    const abs = path.resolve(p);
    if (!isDir(abs)) throw new Error(`不是可访问的文件夹: ${p}`);
    const real = fs.realpathSync.native(abs);
    this.assertNotDataDir(real);
    for (const s of this.mountedSources(exceptRootId)) {
      if (sameReal(s.real, real) || strictlyInside(s.real, real) || strictlyInside(real, s.real)) {
        throw new Error(`与已注册的根「${s.name}」重叠`);
      }
    }
    return abs;
  }

  private assertNotDataDir(real: string) {
    const dataReal = fs.realpathSync.native(this.dataDir);
    if (toRelPath(real, dataReal) !== null) throw new Error('根目录不能包含应用数据目录');
    if (toRelPath(dataReal, real) !== null) throw new Error('根目录不能位于应用数据目录内');
  }

  private rootKindOf(rootId: string): RootKind {
    const row = this.view().prepare('SELECT kind FROM roots WHERE id=?').get(rootId) as { kind: string } | undefined;
    return row?.kind === 'file' ? 'file' : 'folder';
  }

  /** 能 realpath 的来源。离线的跳过（比不了）。 */
  private mountedSources(exceptId?: string): { id: string; name: string; kind: RootKind; real: string }[] {
    const rows = this.db
      .prepare('SELECT r.id, r.name, r.kind, m.local_path AS path FROM roots r JOIN root_mounts m ON m.root_id = r.id')
      .all() as { id: string; name: string; kind: string; path: string }[];
    const out: { id: string; name: string; kind: RootKind; real: string }[] = [];
    for (const r of rows) {
      if (r.id === exceptId || !r.path) continue;
      const kind: RootKind = r.kind === 'file' ? 'file' : 'folder';
      if (kind === 'file' ? !isFile(r.path) : !isDir(r.path)) continue;
      try {
        out.push({ id: r.id, name: r.name, kind, real: fs.realpathSync.native(r.path) });
      } catch {
        /* 路径在检查期间消失 */
      }
    }
    return out;
  }

  /**
   * 登记前按 realpath 决定身份。不插入 roots。
   * 1. 与已有来源相同 → 该来源
   * 2. 落在文件夹来源内部 → { alias:true, resourceId }（ensureResource，不建第二个资料 ID）
   * 3. 新文件夹盖住已有来源 → 抛出，列出 ID 与名字
   * 4. 非空 file_key 只命中一条未缺失资料 → 同一别名；多于一条不按哈希合并
   */
  resolveIngest(p: string, kind: RootKind): IngestResolution {
    const abs = path.resolve(p);
    if (kind === 'folder') {
      if (!isDir(abs)) throw new Error(`不是可访问的文件夹: ${p}`);
    } else if (!isFile(abs)) {
      throw new Error(`不是可访问的文件: ${p}`);
    }
    let real: string;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      throw new Error(kind === 'folder' ? `不是可访问的文件夹: ${p}` : `不是可访问的文件: ${p}`);
    }
    this.assertNotDataDir(real);
    const sources = this.mountedSources();
    const same = sources.find((s) => sameReal(s.real, real));
    if (same) return { alias: false, root: this.getRoot(same.id) };

    const containers = sources.filter((s) => s.kind === 'folder' && strictlyInside(s.real, real));
    if (containers.length) {
      containers.sort((a, b) => b.real.length - a.real.length);
      const host = containers[0];
      const rel = toRelPath(host.real, real);
      if (rel === null) throw new NotFoundError(`路径不存在: ${p}`);
      const resourceId = this.ensureResource(host.id, rel);
      if (!resourceId) throw new NotFoundError(`路径不存在: ${p}`);
      return { alias: true, resourceId };
    }

    if (kind === 'folder') {
      const covered = sources.filter((s) => strictlyInside(real, s.real));
      if (covered.length) throw new SourceCoveredError(covered.map((s) => ({ id: s.id, name: s.name })));
    }

    const st = statForIndex(abs) ?? statForIndex(real);
    if (st?.fileKey) {
      const hits = this.db
        .prepare('SELECT id FROM resources WHERE file_key = ? AND missing_since IS NULL')
        .all(st.fileKey) as { id: string }[];
      if (hits.length === 1) return { alias: true, resourceId: hits[0].id };
    }
    const mount = statForIndex(abs) ? abs : real;
    return { alias: false, abs: mount, real };
  }

  private aliasView(resourceId: string): Root {
    const row = this.db.prepare('SELECT root_id FROM resources WHERE id=?').get(resourceId) as { root_id: string } | undefined;
    if (!row) throw new NotFoundError(`资源不存在: ${resourceId}`);
    const root = this.getRoot(row.root_id);
    return { ...root, alias: true, resourceId };
  }

  private finishIngest(p: string, kind: RootKind, name?: string, extensions?: readonly string[]): Root {
    const hit = this.resolveIngest(p, kind);
    if (hit.alias) return this.aliasView(hit.resourceId);
    if ('root' in hit) {
      this.attachToActive(hit.root.id);
      this.rememberInstance(hit.root.id, name, extensions);
      this.revealRetiredInstance(hit.root.id);
      return this.getRoot(hit.root.id);
    }
    return this.insertSource(hit.abs, kind, name, extensions);
  }

  private filterJsonFor(extensions?: readonly string[]): string {
    if (extensions === undefined) return EMPTY_ROOT_FILTER_JSON;
    return JSON.stringify({ extensions: normalizeExtensions(extensions) });
  }

  private insertSource(abs: string, kind: RootKind, name?: string, extensions?: readonly string[]): Root {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO roots(id, name, created_at, kind, filter_json) VALUES (?,?,?,?,?)')
        .run(id, name || path.basename(abs) || abs, now, kind, this.filterJsonFor(extensions));
      this.db.prepare('INSERT INTO root_mounts(root_id, local_path, machine_id, updated_at) VALUES (?,?,?,?)').run(id, abs, this.machineId, now);
      const st = statForIndex(abs);
      if (!st) throw new Error(kind === 'file' ? `不是可访问的文件: ${abs}` : `不是可访问的文件夹: ${abs}`);
      upsertSeen(this.db, id, abs, '', st);
      if (kind === 'file') {
        // 单文件来源不走目录扫描，直接记 1 个文件，避免状态栏长期显示「已扫描 0」。
        this.db
          .prepare(
            `INSERT INTO index_state(root_id, last_scan_at, last_error, file_count) VALUES (?,?,NULL,1)
             ON CONFLICT(root_id) DO UPDATE SET last_scan_at=excluded.last_scan_at, last_error=NULL, file_count=1`,
          )
          .run(id, now);
      }
    }).immediate();
    this.emit('roots-changed');
    this.attachToActive(id);
    this.rememberInstance(id, name || path.basename(abs) || abs, extensions);
    if (kind === 'folder') void this.scanRoot(id);
    else if (kind === 'file') this.patchStatus(id, { state: 'idle', lastError: null, fileCount: 1 });
    return this.getRoot(id);
  }

  /** 当前工作区要监听、扫描的根。隐藏根不在内。还没有工作区时保持旧行为，再去掉全局隐藏根。 */
  rootsToWatch(): Root[] {
    const workspaceId = this.activeWorkspaceId();
    this.ensureRetirement();
    this.ensureInstances();
    if (!workspaceId) {
      const hidden = hiddenRootIds(this.db, null);
      return this.loadRootRows().filter((root) => !hidden.has(root.id));
    }
    return this.rootsForWorkspace(workspaceId);
  }

  /** 某个工作区仍登记、且没有被本工作区隐藏的根。名称和排序来自实例。 */
  private rootsForWorkspace(workspaceId: string): Root[] {
    this.ensureInstances();
    const hidden = hiddenRootIds(this.db, workspaceId);
    const ids = new Set(this.workspaceRootIds(workspaceId));
    return this.loadRootRows()
      .filter((root) => ids.has(root.id) && !hidden.has(root.id))
      .map((root) => this.presentRoot(root, workspaceId))
      .sort((a, b) => {
        const order = this.instanceSort(workspaceId, a.id) - this.instanceSort(workspaceId, b.id);
        if (order !== 0) return order;
        return a.createdAt - b.createdAt;
      });
  }

  private presentRoot(root: Root, workspaceId: string): Root {
    const instance = readInstance(this.db, workspaceId, root.id);
    if (!instance || instance.hidden) return root;
    return { ...root, workspaceRootId: instance.id, sourceId: root.id, name: instance.name };
  }

  private instanceSort(workspaceId: string, sourceId: string): number {
    return readInstance(this.db, workspaceId, sourceId)?.sortOrder ?? 0;
  }

  /** 为当前工作区写下这次登记的名称和筛选。不改资料源上的名字，不改其他实例。 */
  private rememberInstance(sourceId: string, name?: string, extensions?: readonly string[]): void {
    const workspaceId = this.activeWorkspaceId();
    if (!workspaceId) return;
    this.ensureInstances();
    upsertInstance(this.db, workspaceId, sourceId, {
      ...(name ? { name } : {}),
      ...(extensions !== undefined ? { filterJson: this.filterJsonFor(extensions) } : {}),
      reveal: true,
    });
  }

  /** 重新登记时揭开本工作区的退休行。其他工作区不动。 */
  private revealRetiredInstance(sourceId: string): void {
    const workspaceId = this.activeWorkspaceId();
    if (!workspaceId) return;
    const snap = readPublishSnapshot(this.db, sourceId, workspaceId);
    if (snap && !snap.publishable) restoreRootRecord(this.db, sourceId, workspaceId);
  }

  /** 发布扫描结果时用的工作区。不创建工作区。 */
  publishWorkspaceId(): string {
    return this.activeWorkspaceId() ?? '';
  }

  workspaceRootIds(workspaceId: string): string[] {
    return (this.view().prepare('SELECT root_id FROM workspace_roots WHERE workspace_id = ?').all(workspaceId) as { root_id: string }[])
      .map((row) => row.root_id);
  }

  /** 这个根在不在当前工作区，以及能切过去的另一个工作区。不改引用，不删资料。 */
  rootWorkspace(rootId: string): { name: string; inCurrent: boolean; switchTo: string | null; status: 'ok' | 'missing' | 'absent' } {
    let name = '';
    let status: 'ok' | 'missing' | 'absent' = 'absent';
    try {
      const root = this.getRoot(rootId);
      name = root.name;
      status = root.status;
    } catch {
      status = 'absent';
    }
    const current = this.activeWorkspaceId();
    const inCurrent = current ? this.workspaceRootIds(current).includes(rootId) : true;
    let switchTo: string | null = null;
    if (!inCurrent && current) {
      const hit = this.view().prepare('SELECT workspace_id FROM workspace_roots WHERE root_id = ? AND workspace_id <> ? LIMIT 1').get(rootId, current) as { workspace_id: string } | undefined;
      switchTo = hit?.workspace_id ?? null;
    }
    return { name, inCurrent, switchTo, status };
  }

  workspaceRootFallbacks(): WorkspaceRootFallback[] {
    return workspaceRootFallbacks(this.db);
  }

  private attachToActive(rootId: string) {
    const workspaceId = this.activeWorkspaceId();
    if (!workspaceId) return;
    this.db.prepare('INSERT OR IGNORE INTO workspace_roots(workspace_id, root_id) VALUES (?, ?)').run(workspaceId, rootId);
  }

  addRoot(p: string, name?: string, extensions?: readonly string[]): Root {
    return this.finishIngest(p, 'folder', name, extensions);
  }

  /** 单文件来源：挂载指向该文件，只有 rel_path='' 的一条资料，不扫描兄弟文件。extensions 不参与单文件排除。 */
  addFileSource(p: string, name?: string, extensions?: readonly string[]): Root {
    return this.finishIngest(p, 'file', name, extensions);
  }

  /** 同步返回。短事务退休后把清索引放进队列，不等待清理。 */
  removeRoot(rootId: string): void {
    this.detachRoot(rootId);
  }

  detachRoot(rootId: string): RootOpReceipt {
    return this.retireNow(rootId, 'detach');
  }

  /**
   * 短事务退休后立刻返回。磁盘移动和清索引在队列里。
   * phaseText 在移动成功之前保持「文件删除中」。
   */
  deleteRootFolder(rootId: string): RootOpReceipt {
    const receipt = this.retireNow(rootId, 'delete-disk');
    try {
      patchRootTask(this.db, receipt.taskId, { phaseText: PHASE_DELETING });
    } catch (err) {
      console.error('[root] 无法写入删除阶段', receipt.rootId, err instanceof Error ? err.message : err);
    }
    this.emitRootTasks();
    return receipt;
  }

  listRootTasks(): RootTask[] {
    this.ensureRetirement();
    return listRootTaskRows(this.db);
  }

  cancelRootTask(taskId: string): void {
    this.ensureRetirement();
    const task = this.findTask(taskId);
    if (!task) throw new NotFoundError(`任务不存在: ${taskId}`);
    patchRootTask(this.db, taskId, { state: 'cancelled' });
    this.runner.cancel(task.rootId);
    this.emitRootTasks();
  }

  retryRootTask(taskId: string): RootOpReceipt {
    this.ensureRetirement();
    const task = this.findTask(taskId);
    if (!task) throw new NotFoundError(`任务不存在: ${taskId}`);
    const phaseText = task.kind === 'delete-disk' && task.phaseText !== PHASE_DELETED ? PHASE_DELETING : task.phaseText;
    patchRootTask(this.db, task.taskId, { state: 'queued', error: null, phaseText });
    const next = this.findTask(task.taskId) ?? { ...task, state: 'queued' as const, error: null, phaseText };
    this.enqueueRootFollowUp(next, 'user');
    this.emitRootTasks();
    return this.receiptOf(next);
  }

  /**
   * 恢复当前工作区的登记。不因为原文件还在就去挪磁盘；
   * delete-disk 且原路径不在、暂存区还在时，才把暂存区移回 disk_path。
   */
  restoreRoot(rootId: string): Root {
    this.ensureRetirement();
    const workspaceId = this.retireWorkspaceId();
    const before = listRootTaskRows(this.db).find((item) => item.rootId === rootId && item.workspaceId === workspaceId) ?? null;
    const restored = restoreRootRecord(this.db, rootId, workspaceId);
    if (!restored) throw new NotFoundError('没有可恢复的退休记录');
    const row = this.db.prepare('SELECT id FROM roots WHERE id=?').get(rootId);
    if (!row) throw new NotFoundError('根目录资料已清理，无法恢复登记');
    this.db.prepare('INSERT OR IGNORE INTO workspace_roots(workspace_id, root_id) VALUES (?, ?)').run(workspaceId, rootId);
    if (before?.kind === 'delete-disk' && before.diskPath && !fs.existsSync(before.diskPath)) {
      const staging = this.stagingAbsForRootDelete(rootId);
      if (staging && fs.existsSync(staging)) {
        fs.mkdirSync(path.dirname(before.diskPath), { recursive: true });
        moveAcrossDevices(staging, before.diskPath);
        const parent = path.dirname(staging);
        if (parent !== this.stagingDir && parent.startsWith(this.stagingDir)) {
          try { fs.rmdirSync(parent); } catch { /* 目录里还有别的文件就留着 */ }
        }
      }
    }
    this.emit('roots-changed');
    this.emitRootTasks();
    this.afterMutate?.();
    return this.getRoot(rootId);
  }

  /** 进程拉起后把没跑完的退休任务重新放进队列。失败不抛出进程。 */
  resumeRootJobs(): void {
    this.ensureRetirement();
    for (const task of listRootTaskRows(this.db)) {
      if (task.state !== 'queued' && task.state !== 'running') continue;
      this.enqueueRootFollowUp(task, 'remove');
    }
  }

  /** 删除根文件夹前等待监听句柄松开。 */
  setBeforeRootDelete(fn: (abs: string) => void | Promise<void>) {
    this.beforeRootDelete = fn;
  }

  private ensureRetirement(): void {
    if (this.retirementReady) return;
    ensureRootRetirementSchema(this.db);
    this.retirementReady = true;
  }

  private ensureInstances(): void {
    ensureWorkspaceRootInstances(this.db);
  }

  private retireWorkspaceId(): string {
    return this.activeWorkspaceId() ?? this.getCurrentWorkspaceId();
  }

  private retireNow(rootId: string, kind: 'detach' | 'delete-disk'): RootOpReceipt {
    this.ensureRetirement();
    this.ensureInstances();
    const root = this.getRoot(rootId);
    const workspaceId = this.retireWorkspaceId();
    const taskId = crypto.randomUUID();
    const others = liveOtherCount(this.db, rootId, workspaceId);
    const stopShared = others === 0 || kind === 'delete-disk';
    if (stopShared) {
      this.runner.cancel(rootId);
      this.status.delete(rootId);
    }
    const retired = retireRoot(this.db, {
      rootId,
      workspaceId,
      kind,
      diskPath: root.path,
      taskId,
      markMissing: kind === 'detach' && others === 0,
    });
    this.emit('roots-changed');
    if (kind === 'detach' && others > 0) {
      patchRootTask(this.db, taskId, { state: 'done' });
    } else {
      this.enqueueRootFollowUp(retired.task, 'remove');
    }
    this.emitRootTasks();
    return this.receiptOf(retired.task, retired.generation);
  }

  private receiptOf(task: RootTask, generation = task.generation): RootOpReceipt {
    return {
      ok: true,
      rootId: task.rootId,
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      generation,
      kind: task.kind,
      hidden: true,
    };
  }

  private findTask(taskId: string): RootTask | null {
    this.ensureRetirement();
    return listRootTaskRows(this.db).find((item) => item.taskId === taskId) ?? null;
  }

  private generationMoved(task: RootTask): boolean {
    const current = this.findTask(task.taskId);
    return !current || current.generation !== task.generation;
  }

  /** 取消、关闭，或退休代次已经变了，清理就停。 */
  private taskStopped(task: RootTask): boolean {
    if (this.closed) return true;
    const current = this.findTask(task.taskId);
    if (!current) return true;
    if (current.state === 'cancelled') return true;
    return current.generation !== task.generation;
  }

  private emitRootTasks(): void {
    try {
      this.emit('root-tasks', listRootTaskRows(this.db));
    } catch (err) {
      console.error('[root-tasks] 推送失败', err instanceof Error ? err.message : err);
    }
  }

  private enqueueRootFollowUp(task: RootTask, priority: RootTaskPriority): void {
    this.rootJobs.enqueue({
      priority,
      rootId: task.rootId,
      taskId: task.taskId,
      run: async () => {
        try {
          await this.runRootFollowUp(task);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[root-task] 单根失败', task.rootId, message);
          try {
            if (!this.taskStopped(task)) patchRootTask(this.db, task.taskId, { state: 'failed', error: message });
          } catch (patchErr) {
            console.error('[root-task] 无法标记失败', task.rootId, patchErr instanceof Error ? patchErr.message : patchErr);
          }
          this.emitRootTasks();
        }
      },
    });
  }

  private async runRootFollowUp(task: RootTask): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.taskStopped(task)) return;
    const phasePatch: { state: 'running'; phaseText?: string } = { state: 'running' };
    if (task.kind === 'delete-disk' && task.phaseText !== PHASE_DELETED) phasePatch.phaseText = PHASE_DELETING;
    patchRootTask(this.db, task.taskId, phasePatch);
    this.emitRootTasks();

    let diskOk = task.kind !== 'delete-disk';
    if (task.kind === 'delete-disk') {
      const pathMissing = task.diskPath ? !fs.existsSync(task.diskPath) : true;
      const stagingLeft = pathMissing ? this.stagingAbsForRootDelete(task.rootId) : null;
      if (task.phaseText === PHASE_DELETED || (pathMissing && stagingLeft && fs.existsSync(stagingLeft))) {
        diskOk = true;
        if (!this.generationMoved(task) && task.phaseText !== PHASE_DELETED) {
          patchRootTask(this.db, task.taskId, { phaseText: PHASE_DELETED, error: null });
        }
      } else {
        diskOk = await this.performDiskDelete(task);
      }
    }
    if (!diskOk) {
      await this.cleanupQuiet(task);
      return;
    }
    if (this.taskStopped(task)) return;
    const outcome = await cleanupRetiredRoot({
      db: this.db,
      rootId: task.rootId,
      kind: task.kind,
      shouldStop: () => this.taskStopped(task),
    });
    if (this.taskStopped(task)) return;
    patchRootTask(this.db, task.taskId, {
      state: 'done',
      error: null,
      ...(task.kind === 'delete-disk' ? { phaseText: PHASE_DELETED } : {}),
    });
    if (task.kind === 'detach' && outcome === 'done') this.emit('root-purged', task.rootId);
    this.emitRootTasks();
    this.afterMutate?.();
  }

  private async performDiskDelete(task: RootTask): Promise<boolean> {
    if (task.diskPath) {
      try {
        await this.beforeRootDelete?.(task.diskPath);
      } catch (err) {
        console.error('[root] 松开监听失败', task.rootId, err instanceof Error ? err.message : err);
      }
    }
    const result = await runRootDiskDelete({
      rootId: task.rootId,
      absPath: task.diskPath,
      stagingDir: this.stagingDir,
      dataDir: this.dataDir,
      record: (detail) => this.recordRootTrash(task.rootId, detail),
    });
    if (result.ok) {
      if (!this.generationMoved(task)) patchRootTask(this.db, task.taskId, { phaseText: PHASE_DELETED, error: null });
      this.emitRootTasks();
      return true;
    }
    if (!this.taskStopped(task)) {
      patchRootTask(this.db, task.taskId, {
        state: 'failed',
        error: result.error ?? '删除失败',
        phaseText: PHASE_DELETING,
      });
      this.emitRootTasks();
    }
    return false;
  }

  private async cleanupQuiet(task: RootTask): Promise<void> {
    try {
      await cleanupRetiredRoot({
        db: this.db,
        rootId: task.rootId,
        kind: task.kind,
        shouldStop: () => this.taskStopped(task),
      });
    } catch (err) {
      console.error('[root] 清理索引失败', task.rootId, err instanceof Error ? err.message : err);
    }
  }

  private stagingAbsForRootDelete(rootId: string): string | null {
    const rows = this.db.prepare(
      "SELECT detail_json FROM op_log WHERE op='trash' AND root_id=? AND undone_at IS NULL ORDER BY id DESC",
    ).all(rootId) as { detail_json: string }[];
    for (const row of rows) {
      try {
        const detail = JSON.parse(row.detail_json) as { staging?: string; rootDelete?: boolean };
        if (!detail.rootDelete || typeof detail.staging !== 'string' || !detail.staging) continue;
        return path.join(this.dataDir, ...detail.staging.split('/'));
      } catch {
        /* 坏的操作记录跳过 */
      }
    }
    return null;
  }

  /**
   * 重映射预览：不写 root_mounts，不改资源行。新位置只用于读目标树。
   * 配对顺序在 remapPreview.ts，不走 upsertSeen。
   */
  previewRemap(rootId: string, newPath: string): RemapPreview {
    this.getRoot(rootId);
    const abs = this.assertRemapFolder(newPath, rootId);
    let oldPath: string | null = null;
    try {
      const p = this.rootPath(rootId);
      oldPath = isDir(p) ? p : null;
    } catch {
      oldPath = null;
    }
    return buildRemapPreview(this.db, rootId, oldPath, abs);
  }

  /**
   * 按用户留下的 pairs、勾上的 pathHints 和勾上的 unassigned 改挂载与 rel_path。
   * pending 保持原 ID，并标 missing_since（已有时间戳不覆盖）。不分配未勾选新文件的 UUID，不删引用。
   */
  applyRemap(rootId: string, newPath: string, preview: RemapPreview, selection: RemapSelection): Root {
    this.getRoot(rootId);
    const abs = this.assertRemapFolder(newPath, rootId);
    this.runner.cancel(rootId);
    applyRemapPreview(this.db, rootId, abs, this.machineId, preview, selection);
    this.emit('roots-changed');
    this.emit('favorites-changed');
    this.emit('fs-change', [{ rootId, relPath: '', type: 'change' }]);
    return this.getRoot(rootId);
  }

  /**
   * 旧入口。预览后只自动接受 file_key / content_hash / size_mtime，不接受 pathHint，
   * 也不为未勾选的新文件分配 UUID，不再内部 scanRoot。
   * 之后若再扫描，upsertSeen 仍是同路径优先，可能把未接受的 pathHint 绑回去。
   */
  remapRoot(rootId: string, newPath: string): Root {
    const preview = this.previewRemap(rootId, newPath);
    return this.applyRemap(rootId, newPath, preview, {
      pairIds: preview.pairs.map((p) => p.resourceId),
      pathHintIds: [],
      newRels: [],
    });
  }

  // ---------------- index ----------------

  private patchStatus(rootId: string, patch: Partial<IndexStatus>, memoryOnly = false) {
    if (this.closed) return;
    const cur: IndexStatus = this.status.get(rootId) ?? {
      rootId,
      state: 'idle',
      fileCount: 0,
      progress: 0,
      lastScanAt: null,
      lastError: null,
      watching: false,
    };
    const next = { ...cur, ...patch };
    this.status.set(rootId, next);
    const started = Date.now();
    // 扫描进度每几十个文件来一次。这时去查主库会撞上 worker 的写锁，主线程能卡住整个 busy_timeout。
    this.emit('index-status', memoryOnly ? [...this.status.values()] : this.getIndexStatus());
    stallOp('patchStatus', Date.now() - started, rootId);
  }

  getIndexStatus(): IndexStatus[] {
    return this.rootsToWatch().map((r) => {
      const s = this.view().prepare('SELECT last_scan_at, last_error, file_count FROM index_state WHERE root_id=?').get(r.id) as
        | { last_scan_at: number | null; last_error: string | null; file_count: number }
        | undefined;
      const mem = this.status.get(r.id);
      return {
        rootId: r.id,
        state: mem?.state ?? 'idle',
        progress: mem?.progress ?? 0,
        fileCount: s?.file_count ?? 0,
        lastScanAt: s?.last_scan_at ?? null,
        lastError: mem?.lastError ?? s?.last_error ?? null,
        watching: mem?.watching ?? false,
      };
    });
  }

  setWatching(rootId: string, watching: boolean) {
    this.patchStatus(rootId, { watching });
  }

  scanRoot(rootId: string) {
    if (this.closed) return Promise.resolve(null);
    const job = this.doScan(rootId);
    this.inflight.add(job);
    void job.finally(() => this.inflight.delete(job));
    return job;
  }

  private async doScan(rootId: string) {
    // 异步确认路径期间取消必须仍然有效。worker 开始新扫描时会清掉取消标记，
    // 所以这个窗口里的取消不能等到 runner.scan 再处理。
    const epoch = this.cancelEpoch.get(rootId) ?? 0;
    const capturedWorkspace = this.publishWorkspaceId();
    let capturedGeneration = 0;
    try {
      this.ensureRetirement();
      capturedGeneration = readPublishSnapshot(this.db, rootId, capturedWorkspace)?.generation ?? 0;
    } catch (e) {
      this.patchStatus(rootId, { state: 'error', lastError: (e as Error).message });
      return null;
    }
    let p: string;
    try {
      p = this.rootPath(rootId);
    } catch {
      return null;
    }
    const kind = await pathKind(p);
    if (this.rootKindOf(rootId) === 'file') {
      if (kind !== 'file') {
        this.patchStatus(rootId, { state: 'error', lastError: '文件离线或不存在' });
        return null;
      }
      // 单文件来源不遍历目录，避免把同目录的其他文件扫进来。
      // 顺带修复已登记行的 name/ext（旧版 upsertSeen 在 rel='' 时写成空），并校正 file_count。
      try {
        const st = statForIndex(p);
        if (st) upsertSeen(this.db, rootId, p, '', st);
        const now = Date.now();
        this.db
          .prepare(
            `INSERT INTO index_state(root_id, last_scan_at, last_error, file_count) VALUES (?,?,NULL,1)
             ON CONFLICT(root_id) DO UPDATE SET last_scan_at=excluded.last_scan_at, last_error=NULL, file_count=1`,
          )
          .run(rootId, now);
      } catch {
        /* 修复失败不阻断；getResource 仍有扩展名回退 */
      }
      this.patchStatus(rootId, { state: 'idle', lastError: null, fileCount: 1 });
      return null;
    }
    if (kind !== 'dir') {
      this.patchStatus(rootId, { state: 'error', lastError: '根目录离线或不存在' });
      return null;
    }
    if ((this.cancelEpoch.get(rootId) ?? 0) !== epoch) {
      this.patchStatus(rootId, { state: 'idle', lastError: '扫描已取消' });
      return { processed: 0, cancelled: true, missing: 0, renamed: 0, created: 0, changed: [] };
    }
    this.patchStatus(rootId, { state: 'scanning', progress: 0, lastError: null });
    try {
      const r = await this.runner.scan(rootId, p);
      this.patchStatus(rootId, { state: 'idle', lastError: r.cancelled ? '扫描已取消' : null });
      const emitStarted = Date.now();
      await publishRootResult(this.db, rootId, () => capturedWorkspace || this.publishWorkspaceId(), capturedGeneration, () => {
        if (!this.closed && r.changed.length) this.emit('fs-change', coalesceChanges(rootId, r.changed));
      });
      stallOp('scan-emit', Date.now() - emitStarted, `changed=${r.changed.length}`);
      return r;
    } catch (e) {
      this.patchStatus(rootId, { state: 'error', lastError: (e as Error).message });
      return null;
    }
  }

  cancelScan(rootId: string) {
    this.cancelEpoch.set(rootId, (this.cancelEpoch.get(rootId) ?? 0) + 1);
    this.runner.cancel(rootId);
  }

  async applyFsEvents(rootId: string, events: FsEvent[]) {
    const capturedWorkspace = this.publishWorkspaceId();
    this.ensureRetirement();
    const capturedGeneration = readPublishSnapshot(this.db, rootId, capturedWorkspace)?.generation ?? 0;
    const r = await this.runner.applyEvents(rootId, this.rootPath(rootId), events);
    this.patchStatus(rootId, {});
    const changed = Array.isArray(r.changed) ? r.changed : [];
    await publishRootResult(this.db, rootId, () => capturedWorkspace || this.publishWorkspaceId(), capturedGeneration, () => {
      if (changed.length && !this.closed) this.emit('fs-change', coalesceChanges(rootId, changed));
    });
    return r;
  }

  // ---------------- resources & browsing ----------------

  private ensureResource(rootId: string, rel: string): string | null {
    const abs = resolveInRoot(this.rootPath(rootId), rel);
    const st = statForIndex(abs);
    if (!st) return null;
    const existing = this.db.prepare('SELECT id, out_of_scope FROM resources WHERE root_id=? AND rel_path=?').get(rootId, rel) as
      | { id: string; out_of_scope: number }
      | undefined;
    const ext = st.kind === 'file' ? extOfName(path.basename(abs)) : '';
    if (!inAccessScope(this.accessScope(rootId), { kind: st.kind, relPath: rel, ext, outOfScope: existing?.out_of_scope === 1 })) {
      if (existing) return existing.id;
      throw new OutOfScopeError();
    }
    return upsertSeen(this.db, rootId, this.rootPath(rootId), rel, st).id;
  }

  /** 获取（必要时创建）某路径的资源 ID。筛选外的新文件不入库。 */
  resourceIdFor(rootId: string, relPath: string): string {
    const rel = normalizeRelPath(relPath);
    const id = this.ensureResource(rootId, rel);
    if (!id) throw new NotFoundError(`路径不存在: ${relPath}`);
    return id;
  }

  private accessScope(rootId: string): AccessScope {
    const row = this.db.prepare('SELECT kind, filter_json FROM roots WHERE id=?').get(rootId) as { kind?: string; filter_json?: string } | undefined;
    const workspaceId = this.activeWorkspaceId();
    const instance = workspaceId ? readInstance(this.db, workspaceId, rootId) : null;
    const filterJson = instance && !instance.hidden ? instance.filterJson : row?.filter_json;
    return {
      sourceKind: row?.kind === 'file' ? 'file' : 'folder',
      extensions: extensionsFromFilterJson(filterJson),
    };
  }

  /**
   * 批准之后的执行体。先规范化并写入 roots.filter_json，再只对这一个来源对账。
   * 监听没有单独的筛选缓存，下一次 applyEvents / reconcileScan 直接读这列。
   */
  setSourceFilter(sourceId: string, extensions: readonly string[]): { sourceId: string; extensions: string[] } {
    if (!Array.isArray(extensions)) throw new Error('extensions 必须是字符串数组');
    this.getRoot(sourceId);
    const normalized = normalizeExtensions(extensions);
    const kind = this.rootKindOf(sourceId);
    const rootPath = this.rootPath(sourceId);
    if (kind === 'folder' ? !isDir(rootPath) : !isFile(rootPath)) {
      throw new Error(kind === 'folder' ? '根目录离线或不存在' : '文件离线或不存在');
    }
    const workspaceId = this.activeWorkspaceId();
    const others = workspaceId ? liveOtherCount(this.db, sourceId, workspaceId) : 0;
    const filterJson = JSON.stringify({ extensions: normalized });
    if (workspaceId && others > 0) {
      upsertInstance(this.db, workspaceId, sourceId, { filterJson });
      return { sourceId, extensions: normalized };
    }
    this.db.prepare('UPDATE roots SET filter_json=? WHERE id=?').run(filterJson, sourceId);
    if (workspaceId) upsertInstance(this.db, workspaceId, sourceId, { filterJson });
    this.reconcileSourceFilter(sourceId, normalized);
    return { sourceId, extensions: normalized };
  }

  /** 只对账这一个来源。不扫其它来源，不改 upsertSeen 的配对顺序。 */
  private reconcileSourceFilter(sourceId: string, extensions: readonly string[]): void {
    reconcileFilter(this.db, sourceId, extensions);
  }

  private rowInScope(r: ResRow): boolean {
    return inAccessScope(this.accessScope(r.root_id), {
      kind: r.kind,
      relPath: r.rel_path,
      ext: r.ext,
      outOfScope: r.out_of_scope === 1,
    });
  }

  private assertRowInScope(r: ResRow): void {
    if (!this.rowInScope(r)) throw new OutOfScopeError();
  }

  /** 删除或移动目录前松开监视句柄。主进程在创建监听器之后装上。 */
  setBeforeMutate(fn: (abs: string) => void) {
    this.beforeMutate = fn;
  }

  /** 移动完成后再把监听挂回去。删除进行中不要重新占用目录句柄。 */
  setAfterMutate(fn: () => void) {
    this.afterMutate = fn;
  }

  /**
   * 目录树只读已经建好的索引。缺行时尝试不超过 8ms 的短写；写锁被占就先返回已有行，补写放到后台。
   * 界面不等待 busy_timeout。
   */
  listDir(rootId: string, relPath: string, opts: { showIgnored?: boolean } = {}): DirEntry[] {
    const started = Date.now();
    const out = this.listDirInner(rootId, relPath, opts);
    stallOp('listDir', Date.now() - started, `${relPath || '/'} n=${out.length}`);
    return out;
  }

  private listDirInner(rootId: string, relPath: string, opts: { showIgnored?: boolean } = {}): DirEntry[] {
    if (this.rootKindOf(rootId) === 'file') {
      normalizeRelPath(relPath);
      return [];
    }
    const rootAbs = this.rootPath(rootId);
    const rel = normalizeRelPath(relPath);
    const abs = resolveInRoot(rootAbs, rel);
    const ents = disk.readdirSync(abs, { withFileTypes: true });
    const names: Array<{ name: string; ignored: boolean; childRel: string }> = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      const ignored = isIgnoredName(e.name);
      if (ignored && !opts.showIgnored) continue;
      names.push({ name: e.name, ignored, childRel: rel ? `${rel}/${e.name}` : e.name });
    }
    const byRel = new Map<string, { id: string; kind: string; size: number; mtime_ms: number; ext: string; out_of_scope: number }>();
    for (let i = 0; i < names.length; i += 400) {
      const slice = names.slice(i, i + 400);
      const marks = slice.map(() => '?').join(',');
      const rows = this.view()
        .prepare(
          `SELECT id, rel_path, kind, size, mtime_ms, ext, out_of_scope FROM resources
           WHERE root_id=? AND missing_since IS NULL AND rel_path IN (${marks})`,
        )
        .all(rootId, ...slice.map((n) => n.childRel)) as Array<{
        id: string;
        rel_path: string;
        kind: string;
        size: number;
        mtime_ms: number;
        ext: string;
        out_of_scope: number;
      }>;
      for (const row of rows) byRel.set(row.rel_path, row);
    }
    const scope = this.accessScope(rootId);
    const out: DirEntry[] = [];
    const inline: typeof names = [];
    for (const n of names) {
      const row = byRel.get(n.childRel);
      if (!row) {
        inline.push(n);
        continue;
      }
      const kind = row.kind === 'dir' ? 'dir' : 'file';
      if (!inAccessScope(scope, { kind, relPath: n.childRel, ext: row.ext, outOfScope: row.out_of_scope === 1 })) continue;
      out.push({
        resourceId: row.id,
        rootId,
        relPath: n.childRel,
        name: n.name,
        kind,
        size: row.size,
        mtimeMs: row.mtime_ms,
        ext: row.ext,
        ...(n.ignored ? { ignored: true } : {}),
      });
    }
    if (inline.length) {
      const added = this.tryUpsertDir(rootId, rootAbs, abs, scope, inline);
      out.push(...added.entries);
      if (added.deferred.length) this.scheduleBackfill(rootId, abs, added.deferred);
    }
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'dir' ? -1 : 1));
    return out;
  }

  /** 批量解析资料 ID。已有行一次 SELECT；没有的才逐个补，并且按 8ms 让出。 */
  resourceIdsFor(rootId: string, relPaths: string[]): string[] {
    const out = relPaths.map(() => '');
    const missing: number[] = [];
    for (let i = 0; i < relPaths.length; i += 300) {
      const slice = relPaths.slice(i, i + 300);
      const marks = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT id, rel_path FROM resources WHERE root_id=? AND missing_since IS NULL AND rel_path IN (${marks})`)
        .all(rootId, ...slice) as { id: string; rel_path: string }[];
      const found = new Map(rows.map((row) => [row.rel_path, row.id]));
      for (let j = 0; j < slice.length; j += 1) {
        const id = found.get(slice[j] ?? '');
        if (id) out[i + j] = id;
        else missing.push(i + j);
      }
    }
    const started = Date.now();
    const prev = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    try {
      for (const index of missing) {
        if (Date.now() - started > 8) break;
        try {
          out[index] = this.resourceIdFor(rootId, relPaths[index] ?? '');
        } catch {
          out[index] = '';
        }
      }
    } finally {
      this.db.pragma(`busy_timeout = ${Number.isFinite(prev) && prev > 0 ? prev : 5000}`);
    }
    return out;
  }

  private tryUpsertDir(
    rootId: string,
    rootAbs: string,
    abs: string,
    scope: AccessScope,
    inline: Array<{ name: string; ignored: boolean; childRel: string }>,
  ): { entries: DirEntry[]; deferred: Array<{ name: string; ignored: boolean; childRel: string }> } {
    const entries: DirEntry[] = [];
    const deferred: Array<{ name: string; ignored: boolean; childRel: string }> = [];
    const prev = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    const started = Date.now();
    try {
      this.db.transaction(() => {
        for (const n of inline) {
          if (Date.now() - started > 8) {
            deferred.push(n);
            continue;
          }
          const st = statForIndex(path.join(abs, n.name));
          if (!st) continue;
          const ext = st.kind === 'file' ? extOfName(n.name) : '';
          if (!inAccessScope(scope, { kind: st.kind, relPath: n.childRel, ext, outOfScope: false })) continue;
          const row = upsertSeen(this.db, rootId, rootAbs, n.childRel, st);
          entries.push({
            resourceId: row.id,
            rootId,
            relPath: n.childRel,
            name: n.name,
            kind: st.kind,
            size: st.size,
            mtimeMs: st.mtimeMs,
            ext,
            ...(n.ignored ? { ignored: true } : {}),
          });
        }
      }).immediate();
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (/locked|busy/i.test(message)) {
        noteDbWait(Date.now() - started);
        return { entries: [], deferred: inline };
      }
      throw err;
    } finally {
      this.db.pragma(`busy_timeout = ${Number.isFinite(prev) && prev > 0 ? prev : 5000}`);
    }
    return { entries, deferred };
  }

  private scheduleBackfill(rootId: string, abs: string, items: Array<{ name: string; childRel: string }>) {
    for (const item of items) this.backfill.push({ rootId, rel: item.childRel, abs: path.join(abs, item.name) });
    if (this.backfillTimer || this.closed) return;
    this.backfillTimer = setTimeout(() => this.drainBackfill(), 40);
  }

  private drainBackfill() {
    this.backfillTimer = null;
    if (this.closed || this.backfill.length === 0) return;
    const batch = this.backfill.splice(0, 40);
    const started = Date.now();
    const touched: FsChangeEvent[] = [];
    const prev = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    let rest: typeof batch = [];
    try {
      this.db.transaction(() => {
        for (let i = 0; i < batch.length; i += 1) {
          const item = batch[i]!;
          if (Date.now() - started > 8) {
            rest = batch.slice(i);
            break;
          }
          const st = statForIndex(item.abs);
          if (!st) continue;
          const row = upsertSeen(this.db, item.rootId, this.rootPath(item.rootId), item.rel, st);
          touched.push({ rootId: item.rootId, relPath: item.rel, type: 'add', resourceId: row.id });
        }
      }).immediate();
    } catch (err) {
      const message = String((err as Error).message ?? err);
      if (/locked|busy/i.test(message)) {
        noteDbWait(Date.now() - started);
        rest = batch;
      } else {
        throw err;
      }
    } finally {
      this.db.pragma(`busy_timeout = ${Number.isFinite(prev) && prev > 0 ? prev : 5000}`);
    }
    if (rest.length) this.backfill.unshift(...rest);
    if (touched.length && !this.closed) this.emit('fs-change', touched);
    if (this.backfill.length && !this.closed) this.backfillTimer = setTimeout(() => this.drainBackfill(), rest.length ? 200 : 0);
  }

  private row(resourceId: string): ResRow | undefined {
    return this.db.prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as ResRow | undefined;
  }

  /** 已提交的行。打开文件和切换工作区走这里，不在扫描的写事务上睡满 busy_timeout。 */
  private visibleRow(resourceId: string): ResRow | undefined {
    return this.view().prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as ResRow | undefined;
  }

  getResource(resourceId: string): ResourceInfo | null {
    const r = this.view().prepare('SELECT * FROM resources WHERE id = ?').get(resourceId) as ResRow | undefined;
    if (!r) return this.externalResources?.resourceInfo(resourceId) ?? null; // r11-A：网络资料
    this.assertRowInScope(r);
    let exists = false;
    try {
      exists = disk.existsSync(resolveInRoot(this.rootPath(r.root_id), r.rel_path));
    } catch {
      exists = false;
    }
    const rootName = r.rel_path === '' ? this.getRoot(r.root_id).name : r.name;
    // 已登记单文件来源在旧版可能 name/ext 为空；按根名称或挂载路径回退，保留原 resourceId。
    let ext = r.ext;
    if (!ext && r.kind === 'file' && r.rel_path === '') {
      try {
        const root = this.getRoot(r.root_id);
        ext = extOfName(root.name) || extOfName(path.basename(root.path));
      } catch {
        ext = extOfName(rootName);
      }
    }
    return {
      resourceId: r.id,
      rootId: r.root_id,
      relPath: r.rel_path,
      name: rootName,
      kind: r.kind,
      size: r.size,
      mtimeMs: r.mtime_ms,
      ext,
      exists,
      readerType: readerTypeOf(ext, r.kind),
    };
  }

  /** 资源 → 已校验的绝对路径（根内、解析链接后仍在根内） */
  resolveResourcePath(resourceId: string): string {
    const r = this.visibleRow(resourceId);
    if (!r && this.externalResources?.has(resourceId)) return this.externalResources.resolvePath(resourceId); // r11-A：已缓存的直链（只读）
    if (!r) throw new NotFoundError(`资源不存在: ${resourceId}`);
    return resolveInRoot(this.rootPath(r.root_id), r.rel_path);
  }

  /** kbfile:// URL → 已校验的绝对路径。任何越界都抛 PathEscapeError */
  resolveKbfileUrl(url: string): string {
    const t = parseKbfileUrl(url);
    if (t.type === 'res') return this.resolveResourcePath(t.resourceId);
    const exists = this.view().prepare('SELECT 1 FROM roots WHERE id=?').get(t.rootId);
    if (!exists) throw new PathEscapeError('rootId 未注册');
    return resolveInRoot(this.rootPath(t.rootId), t.relPath);
  }

  readText(resourceId: string, maxBytes = TEXT_MAX_BYTES): TextContent {
    const row = this.visibleRow(resourceId);
    if (row) this.assertRowInScope(row);
    const abs = this.resolveResourcePath(resourceId);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw new Error('不是文件');
    const fd = fs.openSync(abs, 'r');
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, 0);
      return { text: decodeText(buf), truncated: st.size > maxBytes, size: st.size };
    } finally {
      fs.closeSync(fd);
    }
  }

  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (!q) return [];
    const fetchN = Math.max(1, Math.min(Math.max(limit, 1) * 5, 250));
    let rows: { resource_id: string; root_id: string; rel_path: string; name: string }[];
    if ([...q].length >= 3) {
      const phrase = '"' + q.replace(/"/g, '""') + '"';
      rows = this.db
        .prepare('SELECT resource_id, root_id, rel_path, name FROM resources_fts WHERE resources_fts MATCH ? ORDER BY rank LIMIT ?')
        .all(phrase, fetchN) as typeof rows;
    } else {
      // trigram 需要 ≥3 字符，短查询回退 LIKE
      const like = '%' + q.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
      rows = this.db
        .prepare(
          "SELECT id AS resource_id, root_id, rel_path, name FROM resources WHERE missing_since IS NULL AND out_of_scope = 0 AND rel_path <> '' AND rel_path_key LIKE ? ESCAPE '\\' LIMIT ?",
        )
        .all(like.toLowerCase(), fetchN) as typeof rows;
    }
    const scopes = new Map<string, AccessScope>();
    const hits: SearchHit[] = [];
    for (const r of rows) {
      const row = this.row(r.resource_id);
      if (row) {
        let scope = scopes.get(row.root_id);
        if (!scope) {
          scope = this.accessScope(row.root_id);
          scopes.set(row.root_id, scope);
        }
        if (!inAccessScope(scope, { kind: row.kind, relPath: row.rel_path, ext: row.ext, outOfScope: row.out_of_scope === 1 })) continue;
      }
      hits.push({ resourceId: r.resource_id, rootId: r.root_id, relPath: r.rel_path, name: r.name, kind: row?.kind ?? 'file' });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ---------------- favorites ----------------

  listFavorites(): Favorite[] {
    const rows = this.view()
      .prepare(
        `SELECT f.id, f.resource_id, f.label, f.sort_order, f.created_at, r.root_id, r.rel_path, r.name, r.kind, r.missing_since
         FROM favorites f JOIN resources r ON r.id = f.resource_id ORDER BY f.sort_order, f.id`,
      )
      .all() as any[];
    return rows.map((r) => ({
      id: r.id,
      resourceId: r.resource_id,
      rootId: r.root_id,
      relPath: r.rel_path,
      name: r.rel_path === '' ? this.getRoot(r.root_id).name : r.name,
      kind: r.kind,
      missing: r.missing_since !== null,
      label: r.label,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
    }));
  }

  addFavorite(resourceId: string, label?: string): Favorite {
    if (!this.row(resourceId)) throw new NotFoundError(`资源不存在: ${resourceId}`);
    const max = (this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) m FROM favorites').get() as { m: number }).m;
    this.db
      .prepare('INSERT INTO favorites(resource_id, label, sort_order, created_at) VALUES (?,?,?,?) ON CONFLICT(resource_id) DO NOTHING')
      .run(resourceId, label ?? null, max + 1, Date.now());
    this.emit('favorites-changed');
    return this.listFavorites().find((f) => f.resourceId === resourceId)!;
  }

  removeFavorite(id: number) {
    this.db.prepare('DELETE FROM favorites WHERE id = ?').run(id);
    this.emit('favorites-changed');
  }

  // ---------------- layout ----------------

  getLayout(key: string): unknown | null {
    const r = this.view().prepare('SELECT json FROM layout WHERE key = ?').get(key) as { json: string } | undefined;
    return r ? JSON.parse(r.json) : null;
  }

  setLayout(key: string, value: unknown) {
    const json = JSON.stringify(value);
    if (!key.startsWith(AGENT_PINNED_LAYOUT_PREFIX) && looksLikeAbsolutePath(json)) {
      // 防御：布局里不应出现绝对路径（应使用 resourceId）。固定资料是冻结稿要求的例外。
      throw new Error('布局数据中不允许保存绝对路径');
    }
    this.db
      .prepare('INSERT INTO layout(key, json, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at')
      .run(key, json, Date.now());
  }

  /** 只读列出某个前缀下的 layout 键。供固定资料恢复，不扫描资料根。 */
  layoutKeys(prefix: string): string[] {
    const escaped = String(prefix).replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const rows = this.view().prepare("SELECT key FROM layout WHERE key LIKE ? ESCAPE '\\'").all(`${escaped}%`) as { key: string }[];
    return rows.map((row) => row.key);
  }

  /**
   * 绝对路径落在哪个来源里。最长匹配的根优先。
   * 根内且资源表已有这一行才返回 resourceId；否则 null，调用方按根外单文件处理。
   */
  resolveMaterialIdentity(absPath: string): { resourceId: string; sourceId: string; relPath: string } | null {
    const target = path.resolve(absPath);
    const targetKey = target.toLowerCase();
    let best: { rootId: string; rel: string; len: number } | null = null;
    for (const root of this.listRoots()) {
      if (!root.path) continue;
      const rootPath = path.resolve(root.path);
      const rootKey = rootPath.toLowerCase();
      if (root.kind === 'file') {
        if (rootKey !== targetKey) continue;
        const row = this.view().prepare('SELECT id, rel_path FROM resources WHERE root_id=? AND missing_since IS NULL ORDER BY length(rel_path) ASC LIMIT 1').get(root.id) as { id: string; rel_path: string } | undefined;
        if (!row) return null;
        return { resourceId: row.id, sourceId: root.id, relPath: row.rel_path.replace(/\\/g, '/') };
      }
      if (targetKey !== rootKey && !targetKey.startsWith(rootKey + path.sep)) continue;
      const rel = targetKey === rootKey ? '' : target.slice(rootPath.length + 1).split(path.sep).join('/');
      if (!best || rootPath.length > best.len) best = { rootId: root.id, rel, len: rootPath.length };
    }
    if (!best) return null;
    const row = this.view().prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=? AND missing_since IS NULL').get(best.rootId, best.rel) as { id: string } | undefined;
    if (!row) return null;
    return { resourceId: row.id, sourceId: best.rootId, relPath: best.rel };
  }

  /** 点查已经提取的正文。表不存在或没有这一行时返回 null，不扫库。 */
  readIndexedExcerpt(resourceId: string): { text: string; pageTexts: string[]; pages: number } | null {
    if (!resourceId) return null;
    let rows: { text: string | null }[] = [];
    try {
      rows = this.view().prepare('SELECT page, body_text AS text FROM fts_content WHERE resource_id=? ORDER BY page').all(resourceId) as { text: string | null }[];
    } catch {
      try {
        rows = this.view().prepare('SELECT page, body AS text FROM fts_content WHERE resource_id=? ORDER BY page').all(resourceId) as { text: string | null }[];
      } catch {
        return null;
      }
    }
    const pageTexts = rows.map((row) => String(row.text ?? '')).filter((text) => text.trim());
    if (!pageTexts.length) return null;
    return { text: pageTexts.join('\n\n'), pageTexts, pages: pageTexts.length };
  }

  // ---------------- operations with preview + recovery ----------------

  /** 某个资源的操作记录（新的在前） */
  listOpsFor(resourceId: string, limit = 100): OpLogEntry[] {
    return (this.db.prepare('SELECT * FROM op_log WHERE resource_id=? ORDER BY id DESC LIMIT ?').all(resourceId, limit) as any[]).map(mapOp);
  }

  listOps(limit = 100): OpLogEntry[] {
    return (this.db.prepare('SELECT * FROM op_log ORDER BY id DESC LIMIT ?').all(limit) as any[]).map(mapOp);
  }


  private logOp(actor: string, op: string, resourceId: string | null, rootId: string, relPath: string, detail: object): number {
    return Number(
      this.db
        .prepare('INSERT INTO op_log(ts, actor, op, resource_id, root_id, rel_path, detail_json) VALUES (?,?,?,?,?,?,?)')
        .run(Date.now(), actor, op, resourceId, rootId, relPath, JSON.stringify(detail)).lastInsertRowid,
    );
  }

  /** 整根移入暂存区。relPath 为空，撤销时按根路径搬回。 */
  recordRootTrash(rootId: string, detail: {
    staging: string;
    kind: 'dir' | 'file';
    fileCount: number;
    totalBytes: number;
    rootDelete: true;
  }): number {
    const staging = detail.staging.replace(/\\/g, '/').replace(/^\/+/, '');
    return this.logOp('user', 'trash', null, rootId, '', {
      staging,
      kind: detail.kind,
      fileCount: detail.fileCount,
      totalBytes: detail.totalBytes,
      rootDelete: true,
    });
  }

  /**
   * 外部程序改动了备份范围内的文件（第 9 轮：外部程序启动前备份接入统一撤销）：
   * 把基准内容（beforeFile = 启动前备份或重启时基准里的副本）放进内容备份库，记一条 op='write' 的操作记录
   * （detail.via = 'external-app'），之后与原位编辑的保存一样可以撤销回启动前的内容。
   */
  recordExternalWrite(rootId: string, relPath: string, beforeFile: string | null, actor: string, meta: Record<string, unknown> = {}): OpLogEntry {
    const rel = normalizeRelPath(relPath);
    const row = this.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootId, rel) as { id: string } | undefined;
    // beforeFile = null：基准时文件不存在（撤销 = 删除外部程序新建的这个文件）
    const beforeHash = beforeFile ? this.putBlob(beforeFile) : null;
    const abs = resolveInRoot(this.rootPath(rootId), rel);
    const afterHash = fs.existsSync(abs) ? hashFileSync(abs) : null;
    const id = this.logOp(actor, 'write', row?.id ?? null, rootId, rel, { beforeHash, afterHash, via: 'external-app', ...meta });
    return this.listOps(1000).find((o) => o.id === id)!;
  }

  /** 内容寻址备份：blobs/<sha256 前两位>/<sha256> */
  private putBlob(abs: string): string {
    const hash = hashFileSync(abs);
    if (!hash) throw new Error('无法读取原文件做备份');
    const dst = this.blobPath(hash);
    if (!fs.existsSync(dst)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(abs, dst + '.tmp');
      fs.renameSync(dst + '.tmp', dst);
      this.db.prepare('INSERT OR IGNORE INTO blobs(hash, size, created_at) VALUES (?,?,?)').run(hash, fs.statSync(dst).size, Date.now());
    }
    return hash;
  }
  private blobPath(hash: string) {
    return path.join(this.blobDir, hash.slice(0, 2), hash);
  }

  private sync(rootId: string, events: FsEvent[]) {
    const r = applyEvents(this.db, rootId, this.rootPath(rootId), events);
    if (r.changed.length) this.emit('fs-change', coalesceChanges(rootId, r.changed));
  }

  private indexedSize(rootId: string, rel: string): { files: number; bytes: number } {
    const like = rel.replace(/[\\%_]/g, (ch) => '\\' + ch) + '/%';
    const row = this.db
      .prepare(
        `SELECT COUNT(*) files, COALESCE(SUM(size), 0) bytes FROM resources
         WHERE root_id=? AND kind='file' AND missing_since IS NULL AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`,
      )
      .get(rootId, rel, like) as { files: number; bytes: number };
    return { files: row.files, bytes: row.bytes };
  }

  previewTrash(resourceId: string): OpPreview {
    const r = this.row(resourceId);
    if (!r) throw new NotFoundError('资源不存在');
    if (r.rel_path === '') throw new Error('不能删除根目录本身');
    const abs = this.resolveResourcePath(resourceId);
    const walked = du(abs, Date.now() + 8);
    const counted = walked.partial ? this.indexedSize(r.root_id, r.rel_path) : walked;
    return {
      op: 'trash',
      resourceId,
      rootId: r.root_id,
      relPath: r.rel_path,
      kind: r.kind,
      fileCount: counted.files,
      totalBytes: counted.bytes,
      summary: `将「${r.rel_path}」移入应用暂存区（不是系统回收站），可通过操作记录恢复，保留 ${Math.round(this.stagingRetentionMs / 86400000)} 天`,
      conflicts: [],
    };
  }

  trash(resourceId: string, actor = 'user'): OpLogEntry {
    const pv = this.previewTrash(resourceId);
    const abs = this.resolveResourcePath(resourceId);
    this.beforeMutate?.(abs);
    const token = crypto.randomUUID();
    const dstDir = path.join(this.stagingDir, token);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, path.basename(abs));
    moveAcrossDevices(abs, dst);
    this.afterMutate?.();
    const id = this.logOp(actor, 'trash', resourceId, pv.rootId, pv.relPath, {
      staging: path.relative(this.dataDir, dst).split(path.sep).join('/'),
      kind: pv.kind,
      fileCount: pv.fileCount,
      totalBytes: pv.totalBytes,
    });
    this.sync(pv.rootId, [{ type: pv.kind === 'dir' ? 'unlinkDir' : 'unlink', relPath: pv.relPath }]);
    return this.listOps(1000).find((o) => o.id === id)!;
  }

  previewWrite(resourceId: string, content: string): OpPreview {
    const r = this.row(resourceId);
    if (!r || r.kind !== 'file') throw new NotFoundError('文件资源不存在');
    const abs = this.resolveResourcePath(resourceId);
    const cur = fs.existsSync(abs) ? fs.statSync(abs).size : 0;
    return {
      op: 'write',
      resourceId,
      rootId: r.root_id,
      relPath: r.rel_path,
      kind: 'file',
      fileCount: 1,
      totalBytes: Buffer.byteLength(content),
      summary: `覆盖「${r.rel_path}」（${cur} → ${Buffer.byteLength(content)} 字节）；原内容先备份到应用备份库，可撤销`,
      conflicts: [],
    };
  }

  /**
   * 覆盖写：先把原文件放入内容寻址备份库，再原子替换，写 op_log（可撤销到上一版）。
   * expectedHash：调用方打开文件时看到的内容哈希；当前文件不是这个内容时抛 ConflictError（绝不静默覆盖外部修改）。
   */
  writeText(resourceId: string, content: string | Buffer, actor = 'user', opts: { expectedHash?: string | null; meta?: Record<string, unknown> } = {}): OpLogEntry {
    const pv = this.previewWrite(resourceId, typeof content === 'string' ? content : content.toString('utf8'));
    const abs = this.resolveResourcePath(resourceId);
    if (opts.expectedHash !== undefined) {
      const cur = fs.existsSync(abs) ? hashFileSync(abs) : null;
      if (cur !== opts.expectedHash) throw new ConflictError('文件在打开后已被修改', ['文件在打开后已被外部修改']);
    }
    const beforeHash = fs.existsSync(abs) ? this.putBlob(abs) : null;
    atomicWrite(abs, content);
    const afterHash = hashFileSync(abs);
    const id = this.logOp(actor, 'write', resourceId, pv.rootId, pv.relPath, { beforeHash, afterHash, ...(opts.meta ?? {}) });
    this.sync(pv.rootId, [{ type: 'change', relPath: pv.relPath }]);
    return this.listOps(1000).find((o) => o.id === id)!;
  }

  previewMove(resourceId: string, newRelPath: string, toRootId?: string): OpPreview {
    const r = this.row(resourceId);
    if (!r) throw new NotFoundError('资源不存在');
    const to = normalizeRelPath(newRelPath);
    const destRoot = toRootId && toRootId !== r.root_id ? toRootId : r.root_id;
    const dst = resolveInRoot(this.rootPath(destRoot), to);
    const conflicts: string[] = [];
    if (r.rel_path === '') conflicts.push('根目录本身不能移动');
    if (destRoot === r.root_id && (to === r.rel_path || (r.kind === 'dir' && to.startsWith(r.rel_path + '/')))) conflicts.push('不能移动到自身或子目录');
    if (fs.existsSync(dst)) conflicts.push(`目标已存在: ${to}`);
    const cross = destRoot !== r.root_id;
    return {
      op: 'move',
      resourceId,
      rootId: r.root_id,
      relPath: r.rel_path,
      kind: r.kind,
      fileCount: 1,
      totalBytes: r.size,
      summary: cross ? `跨根移动「${r.rel_path}」→「${to}」` : `移动/重命名「${r.rel_path}」→「${to}」`,
      conflicts,
    };
  }

  move(resourceId: string, newRelPath: string, actor = 'user', toRootId?: string): OpLogEntry {
    const r = this.row(resourceId);
    if (!r) throw new NotFoundError('资源不存在');
    const destRoot = toRootId && toRootId !== r.root_id ? toRootId : r.root_id;
    const pv = this.previewMove(resourceId, newRelPath, destRoot);
    if (pv.conflicts.length) throw new ConflictError(pv.conflicts[0] ?? '无法移动', pv.conflicts);
    const to = normalizeRelPath(newRelPath);
    const src = this.resolveResourcePath(resourceId);
    const dst = resolveInRoot(this.rootPath(destRoot), to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    moveAcrossDevices(src, dst);
    this.db.transaction(() => {
      this.relocate(r.root_id, r.rel_path, to, destRoot);
    }).immediate();
    const detail = destRoot === r.root_id ? { from: r.rel_path, to } : { from: r.rel_path, to, fromRoot: r.root_id, toRoot: destRoot };
    const id = this.logOp(actor, 'move', resourceId, r.root_id, r.rel_path, detail);
    this.emit('fs-change', [{ rootId: destRoot, relPath: to, type: 'add' }]);
    return this.listOps(1000).find((o) => o.id === id)!;
  }

  /**
   * 计划已由 @kb/fileops 把字节搬到新位置时，补上本库的 resourceId 与可撤销记录。
   * 本库已经记过这次移动，或字节还在原处时，什么都不做。
   */
  adoptMove(resourceId: string, newRelPath: string, toRootId?: string, actor = 'user'): OpLogEntry | null {
    const r = this.row(resourceId);
    if (!r) return null;
    const destRoot = toRootId && toRootId !== r.root_id ? toRootId : r.root_id;
    const to = normalizeRelPath(newRelPath);
    if (r.root_id === destRoot && r.rel_path === to) return null;
    const dst = resolveInRoot(this.rootPath(destRoot), to);
    if (!fs.existsSync(dst)) return null;
    const src = resolveInRoot(this.rootPath(r.root_id), r.rel_path);
    if (path.resolve(src) !== path.resolve(dst) && fs.existsSync(src)) return null;
    this.db.transaction(() => {
      this.relocate(r.root_id, r.rel_path, to, destRoot);
    }).immediate();
    const detail = destRoot === r.root_id ? { from: r.rel_path, to } : { from: r.rel_path, to, fromRoot: r.root_id, toRoot: destRoot };
    const id = this.logOp(actor, 'move', resourceId, r.root_id, r.rel_path, detail);
    this.emit('fs-change', [{ rootId: destRoot, relPath: to, type: 'add' }]);
    return this.listOps(1000).find((o) => o.id === id) ?? null;
  }

  private relocate(rootId: string, from: string, to: string, toRootId = rootId) {
    const rows = this.db
      .prepare(`SELECT id, rel_path FROM resources WHERE root_id=? AND (rel_path=? OR rel_path LIKE ? ESCAPE '\\')`)
      .all(rootId, from, from.replace(/[\\%_]/g, (m) => '\\' + m) + '/%') as { id: string; rel_path: string }[];
    for (const r of rows) {
      const np = to + r.rel_path.slice(from.length);
      const name = np.split('/').pop()!;
      const destRoot = toRootId;
      this.db.prepare('UPDATE resources SET root_id=?, rel_path=?, rel_path_key=?, name=?, ext=?, updated_at=? WHERE id=?').run(destRoot, np, np.toLowerCase(), name, extOfNameIfFile(this.row(r.id)!.kind, name), Date.now(), r.id);
      this.db.prepare('DELETE FROM resources_fts WHERE resource_id=?').run(r.id);
      this.db.prepare('INSERT INTO resources_fts(resource_id, root_id, rel_path, name) VALUES (?,?,?,?)').run(r.id, destRoot, np, name);
    }
  }

  /** 撤销预览：列出冲突（目标位置已被占用 / 文件在操作后又被修改） */
  previewUndo(opId: number): OpPreview & { opId: number } {
    const op = this.listOps(100000).find((o) => o.id === opId);
    if (!op) throw new NotFoundError('操作不存在');
    if (op.undoneAt) throw new Error('该操作已撤销');
    const rootAbs = this.rootPath(op.rootId);
    const conflicts: string[] = [];
    let summary = '';
    if (op.op === 'trash') {
      if (fs.existsSync(resolveInRoot(rootAbs, op.relPath))) conflicts.push(`原位置已有同名条目: ${op.relPath}`);
      if (!fs.existsSync(path.join(this.dataDir, String(op.detail.staging)))) conflicts.push('暂存区中的副本已被清理，无法恢复');
      summary = `从暂存区恢复「${op.relPath}」`;
    } else if (op.op === 'write') {
      const abs = resolveInRoot(rootAbs, op.relPath);
      const cur = fs.existsSync(abs) ? hashFileSync(abs) : null;
      if (cur !== op.detail.afterHash) conflicts.push('文件在该操作之后又被修改过；撤销会覆盖这些修改（修改会先备份）');
      if (op.detail.backupExpired) conflicts.push(BACKUP_EXPIRED_TEXT);
      else if (op.detail.beforeHash && !fs.existsSync(this.blobPath(String(op.detail.beforeHash)))) conflicts.push('备份内容缺失');
      summary = `把「${op.relPath}」恢复为写入前的内容`;
    } else if (op.op === 'move') {
      if (fs.existsSync(resolveInRoot(rootAbs, String(op.detail.from)))) conflicts.push(`原位置已被占用: ${op.detail.from}`);
      summary = `把「${op.detail.to}」移回「${op.detail.from}」`;
    } else throw new Error(`不支持撤销的操作类型: ${op.op}`);
    return {
      opId,
      op: 'undo',
      resourceId: op.resourceId ?? '',
      rootId: op.rootId,
      relPath: op.relPath,
      kind: (op.detail.kind as 'file' | 'dir') ?? 'file',
      fileCount: 1,
      totalBytes: 0,
      summary,
      conflicts,
    };
  }

  /**
   * 撤销。onConflict:
   *  - 'fail'（默认）：有冲突即抛 ConflictError
   *  - 'keep-both'：trash/move 恢复到“名称 (恢复 N)”；write 先备份当前内容再覆盖
   */
  undo(opId: number, onConflict: 'fail' | 'keep-both' = 'fail', actor = 'user'): OpLogEntry {
    const pv = this.previewUndo(opId);
    const op = this.listOps(100000).find((o) => o.id === opId)!;
    const hard = pv.conflicts.filter(isHardUndoConflict);
    if (hard.length) throw new ConflictError('无法撤销', hard);
    if (pv.conflicts.length && onConflict === 'fail') throw new ConflictError('撤销存在冲突', pv.conflicts);
    const rootAbs = this.rootPath(op.rootId);
    let detail: Record<string, unknown> = { undoOf: opId };
    let restoredRel = op.relPath;
    if (op.op === 'trash') {
      const src = path.join(this.dataDir, String(op.detail.staging));
      restoredRel = pv.conflicts.length ? freeName(rootAbs, op.relPath) : op.relPath;
      const dst = resolveInRoot(rootAbs, restoredRel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      moveAcrossDevices(src, dst);
      fs.rmSync(path.dirname(src), { recursive: true, force: true });
      // 优先按原资源 ID 复活（保持收藏/链接）
      this.db.transaction(() => {
        if (op.resourceId && restoredRel !== op.relPath) this.relocate(op.rootId, op.relPath, restoredRel);
      }).immediate();
      this.sync(op.rootId, [{ type: op.detail.kind === 'dir' ? 'addDir' : 'add', relPath: restoredRel }]);
      if (op.detail.kind === 'dir') void this.scanRoot(op.rootId);
      detail = { ...detail, restoredTo: restoredRel };
    } else if (op.op === 'write') {
      const abs = resolveInRoot(rootAbs, op.relPath);
      const currentHash = fs.existsSync(abs) ? this.putBlob(abs) : null;
      if (op.detail.beforeHash) {
        const tmp = abs + '.kbtmp-' + process.pid;
        fs.copyFileSync(this.blobPath(String(op.detail.beforeHash)), tmp);
        fs.renameSync(tmp, abs);
      } else fs.rmSync(abs, { force: true });
      this.sync(op.rootId, [{ type: 'change', relPath: op.relPath }]);
      // 有冲突（文件在那次写入后又被改过）时，被覆盖的当前内容就是 beforeHash：conflictBackup 标记让操作记录提供“恢复撤销前的内容”
      detail = { ...detail, beforeHash: currentHash, afterHash: op.detail.beforeHash ?? null, ...(pv.conflicts.length && currentHash ? { conflictBackup: true } : {}) };
    } else if (op.op === 'move') {
      const from = String(op.detail.from);
      const to = String(op.detail.to);
      const fromRoot = String(op.detail.fromRoot ?? op.rootId);
      const toRoot = String(op.detail.toRoot ?? op.rootId);
      const backAbs = this.rootPath(fromRoot);
      restoredRel = pv.conflicts.length ? freeName(backAbs, from) : from;
      fs.mkdirSync(path.dirname(resolveInRoot(backAbs, restoredRel)), { recursive: true });
      moveAcrossDevices(resolveInRoot(this.rootPath(toRoot), to), resolveInRoot(backAbs, restoredRel));
      this.db.transaction(() => this.relocate(toRoot, to, restoredRel, fromRoot)).immediate();
      this.emit('fs-change', [{ rootId: fromRoot, relPath: restoredRel, type: 'add' }]);
      detail = { ...detail, restoredTo: restoredRel };
    }
    this.db.prepare('UPDATE op_log SET undone_at=? WHERE id=?').run(Date.now(), opId);
    const id = this.logOp(actor, 'undo', op.resourceId, op.rootId, restoredRel, detail);
    return this.listOps(1000).find((o) => o.id === id)!;
  }

  /**
   * 外部程序改动的备份（op='write' 且 detail.via='external-app' 的写入前内容）保留期：与启动前备份相同（SDK DEFAULT_APP_BACKUP_LIMITS.retentionDays = 14 天）。
   * 到期：在该条记录上标 detail.backupExpired（操作记录界面显示“备份已过期，无法撤销”），
   * 再删除不再被任何未过期记录（作为写入前内容 beforeHash）引用的备份文件——内容寻址，原位编辑的保存可能共用同一份内容。
   */
  purgeExternalBackups(now = Date.now(), retentionMs = EXTERNAL_BACKUP_RETENTION_MS): { expired: number[]; blobsRemoved: number } {
    const rows = this.db.prepare("SELECT id, detail_json FROM op_log WHERE op='write' AND ts < ?").all(now - retentionMs) as { id: number; detail_json: string }[];
    const expired: number[] = [];
    const hashes = new Set<string>();
    const upd = this.db.prepare('UPDATE op_log SET detail_json=? WHERE id=?');
    this.db.transaction(() => {
      for (const r of rows) {
        const d = JSON.parse(r.detail_json) as Record<string, unknown>;
        if (d.via !== 'external-app' || d.backupExpired) continue;
        d.backupExpired = now;
        upd.run(JSON.stringify(d), r.id);
        expired.push(r.id);
        if (typeof d.beforeHash === 'string') hashes.add(d.beforeHash);
      }
    }).immediate();
    let blobsRemoved = 0;
    if (hashes.size) {
      const stillNeeded = new Set<string>();
      for (const r of this.db.prepare('SELECT detail_json FROM op_log').all() as { detail_json: string }[]) {
        const d = JSON.parse(r.detail_json) as Record<string, unknown>;
        if (d.backupExpired) continue;
        if (typeof d.beforeHash === 'string' && hashes.has(d.beforeHash)) stillNeeded.add(d.beforeHash);
      }
      for (const h of hashes) {
        if (stillNeeded.has(h) || !/^[0-9a-f]{64}$/.test(h)) continue;
        fs.rmSync(this.blobPath(h), { force: true });
        this.db.prepare('DELETE FROM blobs WHERE hash=?').run(h);
        blobsRemoved++;
      }
    }
    return { expired, blobsRemoved };
  }

  /** 操作记录界面：每条记录的撤销状态 */
  undoStateOf(op: OpLogEntry): OpLogView['undo'] {
    if (op.op === 'undo') return { state: 'unsupported', reason: '这是一条撤销记录' };
    if (op.undoneAt) return { state: 'undone' };
    if (op.detail.backupExpired) return { state: 'expired', reason: BACKUP_EXPIRED_TEXT };
    if (op.op === 'write') {
      if (op.detail.beforeHash && !fs.existsSync(this.blobPath(String(op.detail.beforeHash)))) return { state: 'missing', reason: '备份内容缺失，无法撤销' };
      return { state: 'available' };
    }
    if (op.op === 'trash') {
      if (!fs.existsSync(path.join(this.dataDir, String(op.detail.staging)))) return { state: 'missing', reason: '暂存区中的副本已被清理，无法恢复' };
      return { state: 'available' };
    }
    if (op.op === 'move') return { state: 'available' };
    return { state: 'unsupported', reason: '这类操作不支持撤销' };
  }

  /** 撤销冲突时备份下来的当前内容：能否在操作记录里恢复 */
  restoreStateOf(op: OpLogEntry): OpLogView['restore'] {
    if (op.op !== 'undo' || !op.detail.conflictBackup) return undefined;
    if (op.undoneAt) return { state: 'restored' };
    const h = String(op.detail.beforeHash ?? '');
    if (!/^[0-9a-f]{64}$/.test(h) || !fs.existsSync(this.blobPath(h))) return { state: 'missing', reason: '备份内容缺失，无法恢复' };
    return { state: 'available' };
  }

  opsView(limit = 200): OpLogView[] {
    return this.listOps(limit).map((o) => {
      const restore = this.restoreStateOf(o);
      return { ...o, undo: this.undoStateOf(o), ...(restore ? { restore } : {}) };
    });
  }

  /**
   * 恢复“撤销冲突时备份下来的内容”（撤销记录 detail.conflictBackup）：把文件写回撤销前的内容。
   * 之后文件又被改过 → 先返回 conflict 让界面确认；确认后现在的内容先进备份库，作为这条恢复记录的写入前内容（撤销这条恢复即可找回）。
   * 恢复本身记一条 op='write'（via 'restore-backup'），可以像普通写入一样撤销。
   */
  restoreUndoBackup(undoOpId: number, force = false, actor = 'user'): OpUndoResult {
    const op = this.listOps(100000).find((o) => o.id === undoOpId);
    if (!op) throw new NotFoundError('操作不存在');
    const st = this.restoreStateOf(op);
    if (!st) return { status: 'unrecoverable', detail: ['这条记录没有可恢复的备份'] };
    if (st.state === 'restored') return { status: 'unrecoverable', detail: ['已经恢复过'] };
    if (st.state !== 'available') return { status: 'unrecoverable', detail: [st.reason ?? '无法恢复'] };
    const abs = resolveInRoot(this.rootPath(op.rootId), op.relPath);
    const cur = fs.existsSync(abs) ? hashFileSync(abs) : null;
    const changed = cur !== (op.detail.afterHash ?? null);
    if (changed && !force) return { status: 'conflict', detail: [`「${op.relPath}」在那次撤销之后又被修改过；恢复会覆盖现在的内容（现在的内容会先备份：之后在操作记录里撤销这条恢复即可找回）`] };
    const currentHash = cur ? this.putBlob(abs) : null;
    const h = String(op.detail.beforeHash);
    const tmp = abs + '.kbtmp-' + process.pid;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(this.blobPath(h), tmp);
    fs.renameSync(tmp, abs);
    this.sync(op.rootId, [{ type: 'change', relPath: op.relPath }]);
    this.db.prepare('UPDATE op_log SET undone_at=? WHERE id=?').run(Date.now(), undoOpId);
    const id = this.logOp(actor, 'write', op.resourceId, op.rootId, op.relPath, { beforeHash: currentHash, afterHash: h, via: 'restore-backup', restoreOf: undoOpId });
    return { status: 'undone', op: this.listOps(1000).find((o) => o.id === id)! };
  }

  /** 操作记录界面里的撤销：冲突时先返回让界面确认；备份过期/缺失时返回 unrecoverable */
  undoFromLog(opId: number, force = false): OpUndoResult {
    try {
      return { status: 'undone', op: this.undo(opId, force ? 'keep-both' : 'fail', 'user') };
    } catch (e) {
      if (e instanceof ConflictError) return e.message === '无法撤销' ? { status: 'unrecoverable', detail: e.conflicts } : { status: 'conflict', detail: e.conflicts };
      throw e;
    }
  }

  /** 清理超过保留期的暂存区条目 */
  purgeStaging(now = Date.now()): number {
    const ops = this.db.prepare("SELECT id, ts, detail_json FROM op_log WHERE op='trash' AND undone_at IS NULL AND ts < ?").all(now - this.stagingRetentionMs) as any[];
    let n = 0;
    for (const o of ops) {
      const st = JSON.parse(o.detail_json).staging as string;
      const p = path.join(this.dataDir, st);
      if (fs.existsSync(p)) {
        fs.rmSync(path.dirname(p), { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }

  // ---------------- plugins ----------------

  /** 宿主启动时登记发现的插件（新插件默认启用；内置插件不可卸载） */
  registerPlugin(id: string, version: string, source: 'builtin' | 'user'): PluginState {
    if (!/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error(`非法插件 id: ${id}`);
    const cur = this.db.prepare('SELECT source FROM plugins WHERE id=?').get(id) as { source: string } | undefined;
    // 第三方沙箱适配器插件（source='adapter'）只由 PluginHostService 安装/卸载，渲染进程的登记不能覆盖它
    if (cur?.source === 'adapter') throw new Error(`插件 id 已被第三方适配器插件占用：${id}`);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO plugins(id, version, source, enabled, installed_at, updated_at) VALUES (?,?,?,1,?,?)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version, source=excluded.source, updated_at=excluded.updated_at`,
      )
      .run(id, version, source, now, now);
    return this.listPlugins().find((p) => p.id === id)!;
  }

  listPlugins(): PluginState[] {
    return (this.db.prepare('SELECT * FROM plugins WHERE uninstalled_at IS NULL ORDER BY source, id').all() as any[]).map((r) => ({
      id: r.id,
      version: r.version,
      source: r.source,
      enabled: !!r.enabled,
      granted: JSON.parse(r.granted_json),
      installedAt: r.installed_at,
    }));
  }

  setPluginEnabled(id: string, enabled: boolean) {
    const r = this.db.prepare('UPDATE plugins SET enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, Date.now(), id);
    if (!r.changes) throw new NotFoundError(`插件不存在: ${id}`);
  }

  pluginStorageGet(pluginId: string, key: string): unknown {
    const r = this.db.prepare('SELECT value_json FROM plugin_kv WHERE plugin_id=? AND key=?').get(pluginId, key) as { value_json: string } | undefined;
    return r ? JSON.parse(r.value_json) : null;
  }

  pluginStorageSet(pluginId: string, key: string, value: unknown) {
    const json = JSON.stringify(value ?? null);
    if (json.length > 1024 * 1024) throw new Error('单个插件存储值不能超过 1 MB');
    this.db
      .prepare(
        'INSERT INTO plugin_kv(plugin_id, key, value_json, updated_at) VALUES (?,?,?,?) ON CONFLICT(plugin_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at',
      )
      .run(pluginId, key, json, Date.now());
  }

  // ---------------- workspaces ----------------

  private wsRow(id: string) {
    const r = this.view().prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as any;
    if (!r) throw new NotFoundError(`工作区不存在: ${id}`);
    return r;
  }
  /** 项目表中某工作区的条目 */
  wsItems(id: string): WorkspaceItem[] {
    const rows = this.view().prepare('SELECT * FROM workspace_items WHERE workspace_id=? ORDER BY created_at, item_id').all(id) as any[];
    return rows.map((r) => {
      const it: WorkspaceItem = { itemId: r.item_id, sourceKind: r.source_kind, adapterId: r.adapter_id, ref: r.ref, displayMode: r.display_mode };
      if (r.state_json) it.state = JSON.parse(r.state_json);
      if (r.title) it.title = r.title;
      return it;
    });
  }
  private wsSummary(r: any): WorkspaceSummary {
    const layout = JSON.parse(r.layout_json);
    const items = this.wsItems(r.id);
    const ids = r.layout_schema >= 4 ? [...new Set(items.filter((i) => i.sourceKind === 'file').map((i) => i.ref))] : layoutResourceIds(layout);
    const itemCount = r.layout_schema >= 4 ? items.length : ids.length;
    const refIds = this.refIds(r.id);
    const rootIds = new Set<string>();
    for (const rid of [...ids, ...refIds]) {
      const row = this.visibleRow(rid);
      if (row) rootIds.add(row.root_id);
    }
    return {
      id: r.id,
      name: r.name,
      project: r.project,
      layoutSchema: r.layout_schema,
      rootIds: [...rootIds],
      panelCount: itemCount,
      refCount: refIds.length,
      favorite: r.favorite === true || r.favorite === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastOpenedAt: r.last_opened_at,
    };
  }
  /**
   * 校验并规范化要保存的工作区：schema 3（条目内联）在这里拆成 schema 4 + 项目表；
   * schema 4 的布局里不允许再带 items；条目逐个净化；面板引用的条目必须存在。
   */
  private checkLayout(layout: unknown, items: unknown[] = []): { json: string; schema: number; items: WorkspaceItem[] } {
    if (layout === null || typeof layout !== 'object') throw new Error('布局必须是对象');
    const schema0 = (layout as { schema?: unknown }).schema;
    if (typeof schema0 !== 'number' || !Number.isInteger(schema0) || schema0 < 1) throw new Error('布局缺少 schema 版本号');
    let list: WorkspaceItem[] = [];
    if (schema0 === 3) {
      const raw = (layout as { items?: unknown }).items;
      const rawCount = raw && typeof raw === 'object' ? Object.keys(raw).length : 0;
      const r = splitLegacyItems(layout);
      if (r.items.length !== rawCount) {
        const bad = Object.values(raw as Record<string, unknown>).find((x) => !sanitizeItem(x));
        throw new Error(`条目不合法: ${JSON.stringify(bad).slice(0, 120)}`);
      }
      layout = r.layout;
      list = r.items;
    } else if (schema0 >= 4) {
      if ('items' in (layout as object)) throw new Error('schema 4 的布局不应内联条目（条目存入项目表）');
      if (!Array.isArray(items)) throw new Error('条目必须是数组');
      if (items.length > 500) throw new Error('条目过多（上限 500）');
      for (const raw of items) {
        const it = sanitizeItem(raw);
        if (!it) throw new Error(`条目不合法: ${JSON.stringify(raw).slice(0, 120)}`);
        list.push(it);
      }
      const ids = new Set(list.map((i) => i.itemId));
      const dock = (layout as { dock?: SerializedDock | null }).dock;
      for (const [id, p] of Object.entries(dock?.panels ?? {})) if (!ids.has(panelItemId(id, p))) throw new Error(`面板 ${id} 引用的条目不存在`);
    }
    const schema = (layout as { schema: number }).schema;
    const json = JSON.stringify(layout);
    const itemsJson = JSON.stringify(list);
    if (Buffer.byteLength(json) + Buffer.byteLength(itemsJson) > MAX_WORKSPACE_LAYOUT_BYTES) throw new Error('布局过大（上限 512 KB）：视图状态中不应保存文件内容');
    if (looksLikeAbsolutePath(json) || looksLikeAbsolutePath(itemsJson)) throw new Error('布局数据中不允许保存绝对路径');
    return { json, schema, items: list };
  }
  /** 用 items 整体替换某工作区的项目表行（保留未变条目的 created_at） */
  private replaceItems(wsId: string, items: WorkspaceItem[]) {
    const now = Date.now();
    const keep = new Set(items.map((i) => i.itemId));
    const existing = this.db.prepare('SELECT item_id FROM workspace_items WHERE workspace_id=?').all(wsId) as { item_id: string }[];
    const del = this.db.prepare('DELETE FROM workspace_items WHERE workspace_id=? AND item_id=?');
    for (const e of existing) if (!keep.has(e.item_id)) del.run(wsId, e.item_id);
    const up = this.db.prepare(
      `INSERT INTO workspace_items(workspace_id,item_id,source_kind,adapter_id,ref,display_mode,state_json,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(workspace_id,item_id) DO UPDATE SET source_kind=excluded.source_kind, adapter_id=excluded.adapter_id, ref=excluded.ref,
         display_mode=excluded.display_mode, state_json=excluded.state_json, title=excluded.title, updated_at=excluded.updated_at`,
    );
    for (const it of items) up.run(wsId, it.itemId, it.sourceKind, it.adapterId, it.ref, it.displayMode, it.state ? JSON.stringify(it.state) : null, it.title ?? null, now, now);
  }
  private cleanName(name: string, what = '名称') {
    const n = String(name ?? '').trim();
    if (!n) throw new Error(`${what}不能为空`);
    if (n.length > 80) throw new Error(`${what}过长（最多 80 字）`);
    return n;
  }

  listWorkspaces(): WorkspaceSummary[] {
    return (this.view().prepare("SELECT * FROM workspaces ORDER BY project = '', project, name").all() as any[]).map((r) => this.wsSummary(r));
  }

  getWorkspace(id: string): WorkspaceDto {
    const r = this.wsRow(id);
    return { ...this.wsSummary(r), layout: JSON.parse(r.layout_json), items: this.wsItems(id) };
  }

  createWorkspace(name: string, project = '', layout: unknown = { schema: LAYOUT_SCHEMA_VERSION, dock: null, shell: { sidebarWidth: 280 } }, items: unknown[] = []): WorkspaceSummary {
    const chk = this.checkLayout(layout, items);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO workspaces(id, name, project, layout_json, layout_schema, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(id, this.cleanName(name), String(project ?? '').trim().slice(0, 80), chk.json, chk.schema, now, now);
      this.replaceItems(id, chk.items);
    }).immediate();
    return this.wsSummary(this.wsRow(id));
  }

  /**
   * 保存工作区：布局（schema 4）+ 条目（写入项目表，未出现的条目删除）。
   * 扫描 worker 持有写锁时，BEGIN IMMEDIATE 会在主线程里睡满 busy_timeout。
   * 这里把超时设为 0：锁空着就同步写完；锁被占就立刻返回，过 50ms 再试。
   * 这次等待不交回调用方，避免写批次把后面的切换工作区一起堵住。校验错误仍然同步抛出。
   */
  saveWorkspaceLayout(id: string, layout: unknown, items: unknown[] = []) {
    const checkStarted = Date.now();
    const chk = this.checkLayout(layout, items);
    const checkMs = Date.now() - checkStarted;
    const run = () => this.writeLayoutWhenFree(id, chk, checkMs);
    const prev = this.layoutTail.get(id);
    if (prev) {
      void this.chainLayout(id, prev.then(run, run)).catch((error) => {
        stallNote(`layout-gave-up ${id} ${String((error as Error)?.message ?? error)}`);
      });
      return;
    }
    try {
      this.commitLayout(id, chk);
      if (checkMs >= 50) stallOp('saveWorkspaceLayout.check', checkMs, id);
      return;
    } catch (err) {
      if (!isDbBusy(err)) throw err;
      void this.chainLayout(id, run()).catch((error) => {
        stallNote(`layout-gave-up ${id} ${String((error as Error)?.message ?? error)}`);
      });
    }
  }

  private chainLayout(id: string, job: Promise<void>): Promise<void> {
    this.layoutTail.set(id, job);
    void job.finally(() => {
      if (this.layoutTail.get(id) === job) this.layoutTail.delete(id);
    });
    return job;
  }

  private commitLayout(id: string, chk: { json: string; schema: number; items: WorkspaceItem[] }) {
    const prev = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    const started = Date.now();
    try {
      this.db.transaction(() => {
        const r = this.db.prepare('UPDATE workspaces SET layout_json=?, layout_schema=?, updated_at=? WHERE id=?').run(chk.json, chk.schema, Date.now(), id);
        if (!r.changes) throw new NotFoundError(`工作区不存在: ${id}`);
        this.replaceItems(id, chk.items);
      }).immediate();
      const spent = Date.now() - started;
      if (spent >= 50) stallOp('saveWorkspaceLayout.commit', spent, id);
    } catch (err) {
      if (isDbBusy(err)) noteDbWait(Date.now() - started);
      throw err;
    } finally {
      this.db.pragma(`busy_timeout = ${Number.isFinite(prev) && prev > 0 ? prev : 5000}`);
    }
  }

  /** 写锁被占时不睡在主线程上。20 秒内还拿不到锁就把这次保存失败交回去，下一次自动保存会再试。 */
  private writeLayoutWhenFree(id: string, chk: { json: string; schema: number; items: WorkspaceItem[] }, checkMs: number): Promise<void> {
    const queuedAt = Date.now();
    let tries = 0;
    let noted = false;
    const attempt = (): Promise<void> => {
      if (this.dbClosed) return Promise.reject(new Error('工作区已关闭'));
      tries += 1;
      const begin = Date.now();
      try {
        this.commitLayout(id, chk);
        if (tries > 1) stallNote(`layout-wrote tries=${tries} queuedMs=${Date.now() - queuedAt} checkMs=${checkMs}`);
        return Promise.resolve();
      } catch (err) {
        const beginMs = Date.now() - begin;
        if (!isDbBusy(err) || this.dbClosed || Date.now() - queuedAt > 20000) throw err;
        if (!noted) {
          noted = true;
          const stack = String((err as Error).stack ?? '').split('\n').slice(0, 6).join(' | ');
          stallNote(`layout-busy checkMs=${checkMs} beginMs=${beginMs} ${stack}`);
        }
        return new Promise((resolve) => setTimeout(resolve, 50)).then(attempt);
      }
    };
    return attempt();
  }

  updateWorkspace(id: string, patch: { name?: string; project?: string; favorite?: boolean }): WorkspaceSummary {
    const cur = this.wsRow(id);
    const name = patch.name !== undefined ? this.cleanName(patch.name) : cur.name;
    const project = patch.project !== undefined ? String(patch.project).trim().slice(0, 80) : cur.project;
    this.db.prepare('UPDATE workspaces SET name=?, project=?, updated_at=? WHERE id=?').run(name, project, Date.now(), id);
    if (patch.favorite !== undefined) updateWorkspaceCardFields(this.db, id, { favorite: patch.favorite });
    return this.wsSummary(this.wsRow(id));
  }

  /** 所有工作区中由这些适配器显示的条目（卸载插件对话框用） */
  countItemsByAdapters(adapterIds: string[]): { items: number; workspaces: number } {
    if (!adapterIds.length) return { items: 0, workspaces: 0 };
    const q = `SELECT COUNT(*) AS n, COUNT(DISTINCT workspace_id) AS w FROM workspace_items WHERE adapter_id IN (${adapterIds.map(() => '?').join(',')})`;
    const r = this.db.prepare(q).get(...adapterIds) as { n: number; w: number };
    return { items: r.n, workspaces: r.w };
  }

  /** 从所有工作区移除由这些适配器显示的条目及其面板（卸载时用户选择“同时移除”） */
  removeItemsByAdapters(adapterIds: string[]): number {
    if (!adapterIds.length) return 0;
    let removed = 0;
    this.db.transaction(() => {
      for (const w of this.db.prepare('SELECT id, layout_json, layout_schema FROM workspaces').all() as any[]) {
        if (w.layout_schema < 4) continue;
        const items = this.wsItems(w.id);
        const drop = new Set(items.filter((i) => adapterIds.includes(i.adapterId)).map((i) => i.itemId));
        if (!drop.size) continue;
        const layout = JSON.parse(w.layout_json) as StoredLayout;
        const dock = pruneDock(layout.dock, (itemId) => !drop.has(itemId));
        this.db.prepare('UPDATE workspaces SET layout_json=?, updated_at=? WHERE id=?').run(JSON.stringify({ ...layout, dock }), Date.now(), w.id);
        const del = this.db.prepare('DELETE FROM workspace_items WHERE workspace_id=? AND item_id=?');
        for (const itemId of drop) del.run(w.id, itemId);
        removed += drop.size;
      }
    }).immediate();
    return removed;
  }

  // ---------------- 工作资料（集合）：跨根引用原文件，添加/移除不移动、不复制 ----------------

  private refRecords(wsId: string): { id: string; at: number }[] {
    const v = this.getLayout(WS_REFS_KEY(wsId));
    return Array.isArray(v) ? (v as { id: string; at: number }[]).filter((x) => x && typeof x.id === 'string') : [];
  }
  private refIds(wsId: string): string[] {
    return this.refRecords(wsId).map((x) => x.id);
  }
  listWorkspaceRefs(wsId: string): WorkspaceRef[] {
    if (isTemporaryWorkspaceId(wsId)) return [];
    this.wsRow(wsId);
    const rootNames = new Map(this.listRoots().map((r) => [r.id, r.name]));
    return this.refRecords(wsId).map(({ id, at }) => {
      const r = this.row(id);
      const web = !r ? this.externalResources?.workspaceRef(id, at) : null; // r11-A：网络资料引用
      if (web) return web;
      const name = r?.name ?? '';
      return {
        resourceId: id,
        rootId: r?.root_id ?? '',
        rootName: (r && rootNames.get(r.root_id)) ?? '',
        relPath: r?.rel_path ?? '',
        name,
        ext: r?.ext ?? '',
        kind: (r?.kind as EntryKind) ?? 'file',
        missing: !r || r.missing_since != null || !rootNames.has(r.root_id),
        addedAt: at,
      };
    });
  }
  /** 把文件加入工作资料（幂等）。只记录资源 ID，不触碰原文件。 */
  addWorkspaceRefs(wsId: string, resourceIds: string[]): WorkspaceRef[] {
    if (isTemporaryWorkspaceId(wsId)) return [];
    this.wsRow(wsId);
    const cur = this.refRecords(wsId);
    const have = new Set(cur.map((x) => x.id));
    const now = Date.now();
    for (const id of resourceIds) {
      const r = this.row(id);
      if (!r && this.externalResources?.has(id)) {
        // r11-A：网络资料（web resourceId）可以加入工作资料（只记录 ID，不复制）
        if (!have.has(id)) (cur.push({ id, at: now }), have.add(id));
        continue;
      }
      if (!r) throw new NotFoundError(`资源不存在: ${id}`);
      if (r.kind !== 'file') throw new Error('只能把文件加入工作资料（文件夹请收藏）');
      if (!have.has(id)) {
        cur.push({ id, at: now });
        have.add(id);
      }
    }
    if (cur.length > MAX_WS_REFS) throw new Error(`工作资料过多（上限 ${MAX_WS_REFS}）`);
    this.setLayout(WS_REFS_KEY(wsId), cur);
    this.emit('refs-change', { workspaceId: wsId });
    return this.listWorkspaceRefs(wsId);
  }
  /** 从工作资料中移除引用。只删除引用记录，原文件保持原位、字节不变。 */
  removeWorkspaceRef(wsId: string, resourceId: string): WorkspaceRef[] {
    if (isTemporaryWorkspaceId(wsId)) return [];
    this.wsRow(wsId);
    this.setLayout(
      WS_REFS_KEY(wsId),
      this.refRecords(wsId).filter((x) => x.id !== resourceId),
    );
    this.emit('refs-change', { workspaceId: wsId });
    return this.listWorkspaceRefs(wsId);
  }
  /** 哪些工作区引用了这个文件（资料或标签） */
  workspacesReferencing(resourceId: string): { id: string; name: string }[] {
    const out: { id: string; name: string }[] = [];
    for (const w of this.db.prepare('SELECT id, name FROM workspaces ORDER BY name').all() as { id: string; name: string }[]) {
      const inItems = this.db.prepare("SELECT 1 FROM workspace_items WHERE workspace_id=? AND source_kind='file' AND ref=? LIMIT 1").get(w.id, resourceId);
      if (inItems || this.refIds(w.id).includes(resourceId)) out.push(w);
    }
    return out;
  }

  // ---------------- r11-C 自建目录：按当前工作区的 catalog_id 读对应套。default 仍双写旧键。不移动文件、不写 op_log ----------------

  /** 布局里记下的当前工作区。不创建工作区。写锁被占时用还没落盘的目标。 */
  private activeWorkspaceId(): string | null {
    const desired = this.desiredWorkspaceId;
    if (desired && this.view().prepare('SELECT 1 FROM workspaces WHERE id=?').get(desired)) return desired;
    const cur = this.getLayout(CURRENT_WS_KEY);
    if (typeof cur === 'string' && this.view().prepare('SELECT 1 FROM workspaces WHERE id=?').get(cur)) return cur;
    return null;
  }

  /** 空或空白的 catalog_id 视为 default。不把空值写回列。 */
  private workspaceCatalogId(id: string): string {
    const row = this.wsRow(id) as { catalog_id?: unknown };
    const cid = row.catalog_id;
    if (typeof cid !== 'string' || !cid.trim()) return DEFAULT_CATALOG_ID;
    return cid.trim();
  }

  /** 当前栏要显示的编排 ID。没有当前工作区时用 default。不改编排，不改 catalog_id。 */
  currentCatalogId(): string {
    const wsId = this.activeWorkspaceId();
    if (!wsId) return DEFAULT_CATALOG_ID;
    return this.workspaceCatalogId(wsId);
  }

  private catalogView(catalogId: string) {
    if (catalogId === DEFAULT_CATALOG_ID) return ensureDefaultCatalog(this.db, (key, value) => this.setLayout(key, value));
    return (
      readCatalogView(this.db, catalogId) ?? {
        store: emptyVfolders(),
        refs: emptyVfolderRefs(),
        virtualRootName: DEFAULT_VIRTUAL_ROOT_NAME,
      }
    );
  }

  /** 按该工作区的 catalog_id 读对应套。不改列，不改 root_mounts。 */
  catalogForWorkspace(workspaceId: string): WorkspaceCatalog {
    const catalogId = this.workspaceCatalogId(workspaceId);
    const view = this.catalogView(catalogId);
    return {
      workspaceId,
      catalogId,
      virtualRootName: view.virtualRootName,
      folders: view.store.folders.map((f) => ({ ...f })),
      refs: refsFromByFolder(view.refs.byFolder),
    };
  }

  private normalizeCatalogId(raw: unknown): string {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || id.length > 80 || /[\\/]/.test(id)) throw new Error('编排 ID 无效');
    return id;
  }

  /**
   * catalog.switch。只改指定工作区的 catalog_id。
   * 当前栏的编排 ID 就是当前工作区这一列；不是当前工作区时栏不换。
   * 不改 root_mounts、资料 ID、磁盘路径，也不改编排正文。
   */
  switchCatalog(workspaceId: string, catalogId: string): { workspaceId: string; catalogId: string } {
    this.wsRow(workspaceId);
    const id = this.normalizeCatalogId(catalogId);
    if (!catalogSelectable(this.db, id)) throw new NotFoundError(`编排不存在: ${id}`);
    this.db.prepare('UPDATE workspaces SET catalog_id=? WHERE id=?').run(id, workspaceId);
    if (this.activeWorkspaceId() === workspaceId) this.emit('vfolders-change');
    return { workspaceId, catalogId: id };
  }

  private vfolderState() {
    return this.catalogView(this.currentCatalogId());
  }
  private writeVfolders(store: VfolderStore, refs: VfolderRefs, undo?: ClassifyUndo | null) {
    const catalogId = this.currentCatalogId();
    this.db.transaction(() => {
      if (catalogId === DEFAULT_CATALOG_ID) {
        this.setLayout(VFOLDERS_KEY, store);
        this.setLayout(VFOLDER_REFS_KEY, refs);
        if (undo !== undefined) this.setLayout(VFOLDER_UNDO_KEY, undo);
      }
      saveCatalog(this.db, catalogId, store, refs, (key, value) => this.setLayout(key, value));
    }).immediate();
    this.emit('vfolders-change');
  }

  listVirtualFolders(): VirtualFolder[] {
    return this.vfolderState().store.folders.slice().sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'));
  }

  createVirtualFolder(parentId: string | null, name: string): VirtualFolder {
    const { store, refs } = this.vfolderState();
    const created = createFolder(store, parentId, name, Date.now(), crypto.randomUUID());
    this.writeVfolders(created.store, refs);
    return created.folder;
  }

  renameVirtualFolder(folderId: string, name: string): VirtualFolder {
    const { store, refs } = this.vfolderState();
    const renamed = renameFolder(store, folderId, name);
    this.writeVfolders(renamed.store, refs);
    return renamed.folder;
  }

  deleteVirtualFolder(folderId: string): { parentId: string | null } {
    const { store, refs } = this.vfolderState();
    const deleted = deleteFolder(store, refs, folderId);
    this.writeVfolders(deleted.store, deleted.refs);
    return { parentId: deleted.parentId };
  }

  moveVirtualFolder(folderId: string, newParentId: string | null, sort: number): VirtualFolder {
    const { store, refs } = this.vfolderState();
    const moved = moveFolder(store, folderId, newParentId, sort);
    this.writeVfolders(moved.store, refs);
    return moved.folder;
  }

  listVfolderMembership(resourceId: string): string[] {
    return foldersOf(this.vfolderState().refs, resourceId);
  }

  setVfolderMembership(resourceId: string, folderIds: string[]): string[] {
    if (!resourceId || typeof resourceId !== 'string') throw new Error('资源 ID 无效');
    const { store, refs } = this.vfolderState();
    const next = setMembership(refs, new Set(store.folders.map((f) => f.folderId)), resourceId, Array.isArray(folderIds) ? folderIds : []);
    this.writeVfolders(store, next);
    return foldersOf(next, resourceId);
  }

  /** 从某一个自建目录移除归属（菜单「从该目录移除」）。不关闭面板。 */
  removeVfolderMembership(resourceId: string, folderId: string | null): string[] {
    const { store, refs } = this.vfolderState();
    const next = removeFromOneFolder(refs, resourceId, folderId);
    this.writeVfolders(store, next);
    return foldersOf(next, resourceId);
  }

  /**
   * catalog.ref.add。只改当前编排的引用，含虚拟根（folderId 为空）。
   * 不写 root_mounts，不移动文件，不重扫。
   */
  addCatalogRef(catalogId: string, folderId: string | null, resourceId: string): { diskMove: false; catalogId: string; folderId: string | null; resourceId: string } {
    const id = this.normalizeCatalogId(catalogId);
    if (id !== this.currentCatalogId()) throw new Error('仅当前编排可改引用');
    const rid = typeof resourceId === 'string' ? resourceId.trim() : '';
    if (!rid || rid.length > 80 || /[\\/]/.test(rid)) throw new Error('资源 ID 无效');
    const folder = folderId == null || folderId === '' ? null : folderId.trim();
    if (folder && (folder.length > 80 || /[\\/]/.test(folder))) throw new Error('folderId 无效');
    const { store, refs } = this.vfolderState();
    if (folder && !store.folders.some((f) => f.folderId === folder)) throw new Error(`自建目录不存在: ${folder}`);
    const key = folder ?? '';
    const cur = refs.byFolder[key] ?? [];
    if (!cur.includes(rid)) this.writeVfolders(store, { v: 1, byFolder: { ...refs.byFolder, [key]: [...cur, rid] } });
    return { diskMove: false, catalogId: id, folderId: folder, resourceId: rid };
  }

  private resolveVfolderEntry(id: string): VfolderEntry {
    const row = this.row(id);
    const rootNames = new Map(this.listRoots().map((r) => [r.id, r.name]));
    if (row) {
      const missing = row.missing_since != null || !rootNames.has(row.root_id);
      return {
        resourceId: id,
        name: row.name,
        ext: row.ext,
        kind: row.kind,
        relPath: row.rel_path,
        rootId: row.root_id,
        rootName: rootNames.get(row.root_id) ?? '',
        missing,
        reader: readerTypeOf(row.ext, row.kind) === 'unsupported' ? 'unsupported' : 'ok',
        sourceKind: 'file',
      };
    }
    const web = this.lookupWebSource(id);
    if (web) {
      return {
        resourceId: id,
        name: web.title || web.url || id,
        ext: '',
        kind: 'file',
        relPath: '',
        rootId: '',
        rootName: '',
        missing: false,
        reader: 'unsupported',
        sourceKind: 'web',
        url: web.url,
      };
    }
    const stub = parseWebStubs(this.getLayout(WEB_STUBS_KEY)).items.find((s) => s.resourceId === id);
    if (stub) {
      return {
        resourceId: id,
        name: stub.title || stub.url || id,
        ext: '',
        kind: 'file',
        relPath: '',
        rootId: '',
        rootName: '',
        missing: false,
        reader: 'unsupported',
        sourceKind: 'web',
        url: stub.url,
      };
    }
    return {
      resourceId: id,
      name: id.slice(0, 8),
      ext: '',
      kind: 'file',
      relPath: '',
      rootId: '',
      rootName: '',
      missing: true,
      reader: 'unsupported',
      sourceKind: 'file',
    };
  }

  listVfolderView(folderId: string | null): VfolderView {
    const { store, refs, virtualRootName } = this.vfolderState();
    if (folderId && !store.folders.some((f) => f.folderId === folderId)) throw new NotFoundError(`自建目录不存在: ${folderId}`);
    const byId = new Map(store.folders.map((f) => [f.folderId, f]));
    const chain = parentChain(store.folders, folderId).map((id) => ({ folderId: id, name: byId.get(id)!.name }));
    const crumbs: VfolderView['crumbs'] = [{ folderId: null, name: virtualRootName }, ...chain];
    const folders = store.folders
      .filter((f) => f.parentId === folderId)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'))
      .map((f) => ({ folderId: f.folderId, parentId: f.parentId, name: f.name, sort: f.sort }));
    const entries = (refs.byFolder[folderId ?? ''] ?? []).map((id) => this.resolveVfolderEntry(id));
    return { folderId, crumbs, folders, entries };
  }

  private lookupWebSource(id: string): { url: string; title: string } | null {
    const wr = this.db.prepare('SELECT url, title FROM web_sources WHERE id=?').get(id) as { url: string; title: string } | undefined;
    return wr ?? null;
  }

  private classItems(resourceIds: string[]): ClassItem[] {
    const stubs = parseWebStubs(this.getLayout(WEB_STUBS_KEY));
    return resourceIds.filter((id) => typeof id === 'string' && id).map((id) => {
      const row = this.row(id);
      if (row) return { resourceId: id, ext: row.ext || '', kind: row.kind };
      if (this.lookupWebSource(id) || stubs.items.some((s) => s.resourceId === id)) return { resourceId: id, ext: '', kind: 'web' as const };
      return { resourceId: id, ext: '', kind: 'file' as const };
    });
  }

  classifyByType(resourceIds: string[]): { createdFolderIds: string[]; added: number } {
    const { store, refs } = this.vfolderState();
    const applied = classifyInto(store, refs, this.classItems(resourceIds), Date.now(), () => crypto.randomUUID());
    if (!applied.undo) return { createdFolderIds: [], added: 0 };
    this.writeVfolders(applied.store, applied.refs, applied.undo);
    return { createdFolderIds: applied.createdFolderIds, added: applied.added };
  }

  vfolderUndoAvailable(): boolean {
    if (this.currentCatalogId() !== DEFAULT_CATALOG_ID) return false;
    return parseUndo(this.getLayout(VFOLDER_UNDO_KEY)) != null;
  }

  undoVfolderClassify(): { restored: number; removedFolders: number } {
    if (this.currentCatalogId() !== DEFAULT_CATALOG_ID) return { restored: 0, removedFolders: 0 };
    const undo = parseUndo(this.getLayout(VFOLDER_UNDO_KEY));
    if (!undo) return { restored: 0, removedFolders: 0 };
    const { store, refs } = this.vfolderState();
    const applied = undoClassify(store, refs, undo);
    this.writeVfolders(applied.store, applied.refs, null);
    return { restored: Object.keys(undo.previous).length, removedFolders: applied.removedFolders };
  }

  rememberWebStub(stub: { resourceId: string; url: string; title: string }) {
    const resourceId = String(stub?.resourceId ?? '').trim();
    if (!resourceId || resourceId.length > 80 || /[\\/]/.test(resourceId)) throw new Error('资源 ID 无效');
    const url = String(stub?.url ?? '').trim().slice(0, 500);
    const title = String(stub?.title ?? '').trim().slice(0, 80) || url || resourceId;
    if (/[\\]/.test(title) || /^[A-Za-z]:/.test(title)) throw new Error('标题不能像磁盘路径');
    const cur = parseWebStubs(this.getLayout(WEB_STUBS_KEY));
    const store = { v: 1 as const, items: [...cur.items.filter((x) => x.resourceId !== resourceId), { resourceId, url, title }] };
    if (looksLikeAbsolutePath(JSON.stringify(store))) throw new Error('网址里不能保存本机路径');
    this.setLayout(WEB_STUBS_KEY, store);
    this.emit('vfolders-change');
  }

  /** 导出一套编排为 .kbcatalog.json 对象。不含绝对路径。 */
  exportCatalog(catalogId?: string): CatalogFile {
    return exportCatalogFromDb(this.db, catalogId);
  }

  /** 导入编排文件。校验失败或 baseDigest 冲突时不写库。 */
  importCatalog(raw: unknown): ImportCatalogResult {
    const result = importCatalogIntoDb(this.db, (key, value) => this.setLayout(key, value), raw);
    this.emit('vfolders-change');
    return result;
  }

  /** 删除工作区只删除布局记录，不涉及任何文件。至少保留一个工作区。 */
  deleteWorkspace(id: string) {
    this.wsRow(id);
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number }).n;
    if (n <= 1) throw new Error('至少需要保留一个工作区');
    this.db.prepare('DELETE FROM workspaces WHERE id=?').run(id);
    this.db.prepare('DELETE FROM layout WHERE key=?').run(WS_REFS_KEY(id));
    this.db.prepare('DELETE FROM layout WHERE key=?').run(AGENT_PINNED_LAYOUT_PREFIX + id);
    if (this.getLayout(CURRENT_WS_KEY) === id) {
      const next = this.db.prepare('SELECT id FROM workspaces ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC LIMIT 1').get() as { id: string };
      this.setLayout(CURRENT_WS_KEY, next.id);
      this.emit('vfolders-change');
    }
  }

  /** 当前工作区；第一次运行时创建“默认工作区”，并把第二轮之前保存的单一布局迁入 */
  getCurrentWorkspaceId(): string {
    if (this.desiredWorkspaceId && this.view().prepare('SELECT 1 FROM workspaces WHERE id=?').get(this.desiredWorkspaceId)) {
      return this.desiredWorkspaceId;
    }
    const cur = this.getLayout(CURRENT_WS_KEY);
    if (typeof cur === 'string' && this.view().prepare('SELECT 1 FROM workspaces WHERE id=?').get(cur)) return cur;
    const any = this.view().prepare('SELECT id FROM workspaces ORDER BY last_opened_at DESC NULLS LAST, updated_at DESC LIMIT 1').get() as { id: string } | undefined;
    let id = any?.id;
    if (!id) {
      const legacy = this.getLayout(LEGACY_DOCK_KEY);
      const ui = (this.getLayout('ui') ?? {}) as { sidebarWidth?: number };
      // 旧格式原样存入（schema 1/2），由渲染进程打开时迁移；sidebarWidth 补进 shell
      let layout: unknown = { schema: LAYOUT_SCHEMA_VERSION, dock: null, shell: { sidebarWidth: ui.sidebarWidth ?? 280 } };
      if (legacy && typeof legacy === 'object') {
        const l = legacy as Record<string, unknown>;
        layout = typeof l.schema === 'number' ? { ...l, shell: { sidebarWidth: ui.sidebarWidth ?? 280 } } : { schema: 1, ...l };
      }
      id = this.createWorkspace('默认工作区', '', layout).id;
    }
    this.setCurrentWorkspace(id);
    return id;
  }

  /**
   * 只切换当前工作区。不改编排正文，不改任何 workspaces.catalog_id，不删资料，不删引用。
   * 返回这次新纳入监听的根。调用方只对这些根做大小和修改时间比对，不重建索引。
   */
  setCurrentWorkspace(id: string): { attached: string[] } {
    this.wsRow(id);
    const previous = this.activeWorkspaceId();
    const before = new Set(previous ? this.workspaceRootIds(previous) : this.listRoots().map((root) => root.id));
    this.desiredWorkspaceId = id;
    try {
      this.commitCurrentWorkspace(id);
      if (this.workspacePersistTimer) clearTimeout(this.workspacePersistTimer);
      this.workspacePersistTimer = null;
      if (this.desiredWorkspaceId === id) this.desiredWorkspaceId = null;
    } catch (err) {
      if (!isDbBusy(err)) {
        if (this.desiredWorkspaceId === id) this.desiredWorkspaceId = null;
        throw err;
      }
      this.scheduleCurrentWorkspace(id);
    }
    this.emit('vfolders-change');
    const attached = this.workspaceRootIds(id).filter((rootId) => !before.has(rootId));
    return { attached };
  }

  /** 锁空着就同步写完。锁被占时抛出，调用方改走定时器。 */
  private commitCurrentWorkspace(id: string) {
    const prev = Number(this.db.pragma('busy_timeout', { simple: true }));
    this.db.pragma('busy_timeout = 0');
    const started = Date.now();
    try {
      this.db.transaction(() => {
        this.db.prepare('UPDATE workspaces SET last_opened_at=? WHERE id=?').run(Date.now(), id);
        this.setLayout(CURRENT_WS_KEY, id);
        claimUnownedRoots(this.db, id);
      }).immediate();
      const spent = Date.now() - started;
      if (spent >= 50) stallOp('setCurrentWorkspace', spent, id);
    } catch (err) {
      if (isDbBusy(err)) noteDbWait(Date.now() - started);
      throw err;
    } finally {
      this.db.pragma(`busy_timeout = ${Number.isFinite(prev) && prev > 0 ? prev : 5000}`);
    }
  }

  private scheduleCurrentWorkspace(id: string) {
    if (this.workspacePersistTimer) clearTimeout(this.workspacePersistTimer);
    const started = Date.now();
    const attempt = () => {
      this.workspacePersistTimer = null;
      if (this.dbClosed || this.desiredWorkspaceId !== id) return;
      try {
        this.commitCurrentWorkspace(id);
        if (this.desiredWorkspaceId === id) this.desiredWorkspaceId = null;
        stallNote(`workspace-current-wrote id=${id} queuedMs=${Date.now() - started}`);
      } catch (err) {
        if (!isDbBusy(err) || this.dbClosed || Date.now() - started > 20000) {
          stallNote(`workspace-current-fail id=${id} ${String((err as Error)?.message ?? err)}`);
          return;
        }
        this.workspacePersistTimer = setTimeout(attempt, 50);
      }
    };
    this.workspacePersistTimer = setTimeout(attempt, 50);
  }

  exportWorkspace(id: string): KbLayoutFile {
    const ws = this.getWorkspace(id);
    const resources: KbLayoutFile['resources'] = [];
    const refs = this.refIds(id);
    const rids = [...new Set([...(ws.layoutSchema >= 4 ? ws.items.filter((i) => i.sourceKind === 'file').map((i) => i.ref) : layoutResourceIds(ws.layout)), ...refs])];
    for (const rid of rids) {
      const r = this.row(rid);
      if (!r) continue;
      const root = this.db.prepare('SELECT name FROM roots WHERE id=?').get(r.root_id) as { name: string } | undefined;
      resources.push({ resourceId: rid, rootId: r.root_id, rootName: root?.name ?? '', relPath: r.rel_path, kind: r.kind });
    }
    return {
      format: 'kb-workbench.layout',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      workspace: { name: ws.name, project: ws.project },
      layoutSchema: ws.layoutSchema,
      layout: ws.layout,
      ...(ws.layoutSchema >= 4 ? { items: ws.items } : {}),
      resources,
      plugins: this.requiredPlugins(ws.layoutSchema >= 4 ? ws.items : []),
      ...(refs.length ? { refs } : {}),
      ...this.exportWebResources(refs),
      ...this.exportPinnedMaterials(id),
    };
  }

  /** 固定资料随工作区导出。本轮资料在用户数据文件里，不进导出，也不进模板。 */
  private exportPinnedMaterials(id: string): Pick<KbLayoutFile, 'agentMaterialsPinned'> {
    const pinned = this.getLayout(AGENT_PINNED_LAYOUT_PREFIX + id);
    return pinned == null ? {} : { agentMaterialsPinned: pinned };
  }

  /** r11-A：资料引用中的网络资料（按 url 重新匹配） */
  private exportWebResources(refs: string[]): Pick<KbLayoutFile, 'webResources'> {
    const ext = this.externalResources;
    if (!ext) return {};
    const recs = ext.exportRecords(refs.filter((id) => !this.row(id) && ext.has(id)));
    return recs.length ? { webResources: recs } : {};
  }

  private requiredPlugins(items: { adapterId: string }[]): NonNullable<KbLayoutFile['plugins']> {
    const owners = this.plugins.adapterOwners();
    const by = new Map<string, { id: string; name: string; version: string; adapterIds: string[] }>();
    for (const it of items) {
      const o = owners.get(it.adapterId);
      if (!o) continue;
      const e = by.get(o.id) ?? { ...o, adapterIds: [] };
      if (!e.adapterIds.includes(it.adapterId)) e.adapterIds.push(it.adapterId);
      by.set(o.id, e);
    }
    return [...by.values()];
  }

  /**
   * 导入 .kblayout.json：资源 ID 在本机存在则直接使用；否则按根 ID、再按根名称 + 相对路径重新匹配，
   * 并把布局中的旧 ID 替换为本机 ID。匹配不到的保留原 ID（打开时显示“文件不可用”）。
   */
  importWorkspace(file: unknown, nameOverride?: string): ImportResult {
    const f = file as KbLayoutFile;
    if (!f || f.format !== 'kb-workbench.layout') throw new Error('不是工作台布局文件（format 不匹配）');
    if (f.formatVersion !== 1) throw new Error(`不支持的布局文件版本 ${f.formatVersion}，请升级应用`);
    let json = JSON.stringify({ layout: f.layout, items: Array.isArray(f.items) ? f.items : [], refs: Array.isArray(f.refs) ? f.refs.filter((x) => typeof x === 'string').slice(0, MAX_WS_REFS) : [] });
    let matched = 0;
    let remapped = 0;
    const unresolved: string[] = [];
    const roots = this.listRoots();
    for (const r of Array.isArray(f.resources) ? f.resources : []) {
      if (typeof r?.resourceId !== 'string' || typeof r.relPath !== 'string') continue;
      if (this.row(r.resourceId)) {
        matched++;
        continue;
      }
      const root = roots.find((x) => x.id === r.rootId) ?? (roots.filter((x) => x.name === r.rootName).length === 1 ? roots.find((x) => x.name === r.rootName) : undefined);
      let local: string | undefined;
      if (root) {
        try {
          const norm = normalizeRelPath(r.relPath);
          const hit = this.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=? AND missing_since IS NULL').get(root.id, norm) as { id: string } | undefined;
          local = hit?.id;
        } catch {
          local = undefined;
        }
      }
      if (local) {
        json = json.split(r.resourceId).join(local);
        remapped++;
      } else unresolved.push(`${r.rootName}/${r.relPath}`);
    }
    // r11-A：网络资料按 url 重新匹配（本机已有同 url 复用其 resourceId，否则新建）
    if (this.externalResources && Array.isArray(f.webResources)) for (const [from, to] of this.externalResources.importRecords(f.webResources)) if (from !== to) json = json.split(from).join(to);
    const base = this.cleanName(nameOverride ?? f.workspace?.name ?? '导入的工作区');
    const taken = new Set(this.listWorkspaces().map((w) => w.name));
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    const parsed = JSON.parse(json) as { layout: unknown; items: unknown[]; refs: string[] };
    let ws = this.createWorkspace(name, String(f.workspace?.project ?? ''), parsed.layout, parsed.items);
    if (f.agentMaterialsPinned != null) {
      try { this.setLayout(AGENT_PINNED_LAYOUT_PREFIX + ws.id, f.agentMaterialsPinned); } catch { /* 坏的固定资料不挡住工作区导入 */ }
    }
    const okRefs = parsed.refs.filter((rid) => this.row(rid)?.kind === 'file' || (!this.row(rid) && this.externalResources?.has(rid)));
    if (okRefs.length) {
      this.addWorkspaceRefs(ws.id, okRefs);
      ws = this.wsSummary(this.wsRow(ws.id));
    }
    const installed = new Set([...this.plugins.adapterOwners().values()].map((o) => o.id));
    const missingPlugins = (Array.isArray(f.plugins) ? f.plugins : [])
      .filter((p) => p && typeof p.id === 'string' && !installed.has(p.id))
      .map((p) => ({ id: String(p.id).slice(0, 100), name: String(p.name ?? p.id).slice(0, 100), version: String(p.version ?? '').slice(0, 40) }));
    return { workspace: ws, matched, remapped, unresolved, missingPlugins };
  }

  // ---------------- theme packs（纯数据：JSON 令牌 + 受限 CSS + 布局预设 JSON） ----------------

  get themesDir() {
    return path.join(this.dataDir, 'themes');
  }

  /** 读取一个主题包文件夹（不执行任何代码）。只读取 theme.json 中声明的、位于包目录内的文件。 */
  readThemePack(dir: string, source: ThemePackDto['source']): ThemePackDto {
    const location = source === 'installed' ? path.basename(dir) : dir;
    try {
      const manifestText = fs.readFileSync(path.join(dir, 'theme.json'), 'utf8');
      const manifest = JSON.parse(manifestText.replace(/^\uFEFF/, ''));
      const files: Record<string, string> = {};
      const refs = new Set<string>();
      const c = manifest?.contributes ?? {};
      for (const t of [...(c.chromeThemes ?? []), ...(c.readingThemes ?? [])])
        for (const v of [t?.light, t?.dark]) if (typeof v?.css === 'string') refs.add(v.css);
      for (const p of c.layoutPresets ?? []) if (typeof p?.file === 'string') refs.add(p.file);
      let total = 0;
      for (const rel of refs) {
        const norm = normalizeRelPath(rel.replace(/\\/g, '/'));
        const abs = resolveInRoot(dir, norm);
        const text = fs.readFileSync(abs, 'utf8');
        if (text.length > THEME_FILE_MAX) throw new Error(`${rel} 超过 256 KB`);
        total += text.length;
        if (total > 2 * 1024 * 1024) throw new Error('主题包总大小超过 2 MB');
        files[rel] = text;
      }
      return { source, location, manifest, files };
    } catch (e) {
      return { source, location, manifest: null, files: {}, error: String((e as Error).message ?? e) };
    }
  }

  listThemePacks(devDirs: string[] = []): ThemePackDto[] {
    const out: ThemePackDto[] = [];
    if (fs.existsSync(this.themesDir))
      for (const d of fs.readdirSync(this.themesDir).sort()) {
        const abs = path.join(this.themesDir, d);
        if (isDir(abs)) out.push(this.readThemePack(abs, 'installed'));
      }
    for (const d of devDirs) out.push(this.readThemePack(path.resolve(d), 'dev'));
    return out;
  }

  /** 安装 = 复制到应用数据目录 themes/<id>（覆盖同 id 的旧版本） */
  installThemePack(srcDir: string): ThemePackDto {
    const pack = this.readThemePack(srcDir, 'dev');
    if (pack.error) throw new Error(`主题包无法读取：${pack.error}`);
    const id = (pack.manifest as { id?: unknown })?.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error('theme.json 中的 id 不合法');
    const dst = path.join(this.themesDir, id);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.writeFileSync(path.join(dst, 'theme.json'), JSON.stringify(pack.manifest, null, 2));
    for (const [rel, text] of Object.entries(pack.files)) {
      const abs = resolveInRoot(dst, normalizeRelPath(rel.replace(/\\/g, '/')));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    return this.readThemePack(dst, 'installed');
  }

  // ---------------- backup ----------------

  /** 备份元数据库（收藏、资源 ID、布局、操作记录）。root_mounts 是机器本地的，恢复到新电脑后需 remapRoot（不按同名路径自动配对）。 */
  async backupTo(file: string) {
    await this.db.backup(file);
  }
}

// ---------------- helpers ----------------

async function pathKind(p: string): Promise<'dir' | 'file' | 'other'> {
  try {
    const st = await diskPromises.stat(p);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return 'other';
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function sameReal(a: string, b: string): boolean {
  return toRelPath(a, b) === '';
}

function strictlyInside(parent: string, child: string): boolean {
  const rel = toRelPath(parent, child);
  return rel !== null && rel !== '';
}

function extOfName(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
function extOfNameIfFile(kind: string, name: string) {
  return kind === 'file' ? extOfName(name) : '';
}

/** 从任意版本的布局 JSON 中取出面板引用的资源 ID */
export function layoutResourceIds(layout: unknown): string[] {
  const l = layout as Record<string, any> | null;
  if (!l || typeof l !== 'object') return [];
  // v3：条目模型，只有 sourceKind=file 的条目引用资源
  if (typeof l.schema === 'number' && l.schema >= 3) {
    const items = l.items && typeof l.items === 'object' ? Object.values(l.items) : [];
    return [...new Set(items.filter((i: any) => i?.sourceKind === 'file' && typeof i.ref === 'string').map((i: any) => i.ref as string))];
  }
  const dock = typeof l.schema === 'number' && l.schema >= 2 ? l.dock : l;
  const panels = dock && typeof dock === 'object' ? dock.panels : null;
  if (!panels || typeof panels !== 'object') return [];
  return [...new Set(Object.values(panels).map((p: any) => p?.params?.resourceId).filter((x): x is string => typeof x === 'string'))];
}

function isDbBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_TIMEOUT') return true;
  return /locked|busy/i.test(String((err as Error)?.message ?? err));
}

function looksLikeAbsolutePath(json: string) {
  return /"(?:[A-Za-z]:\\\\|\\\\\\\\|\/(?:home|Users|mnt|media|workspace|tmp|var)\/)/.test(json);
}

export function decodeText(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // 中文 Windows 上常见的 GBK/GB18030 文本
    try {
      return new TextDecoder('gb18030').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function du(abs: string, deadline = Number.POSITIVE_INFINITY): { files: number; bytes: number; partial: boolean } {
  if (Date.now() > deadline) return { files: 0, bytes: 0, partial: true };
  const st = disk.lstatSync(abs);
  if (!st.isDirectory()) return { files: 1, bytes: st.size, partial: false };
  let files = 0;
  let bytes = 0;
  for (const e of disk.readdirSync(abs)) {
    const child = du(path.join(abs, e), deadline);
    files += child.files;
    bytes += child.bytes;
    if (child.partial) return { files, bytes, partial: true };
  }
  return { files, bytes, partial: false };
}

function coalesceChanges(rootId: string, changed: ScanChange[]): FsChangeEvent[] {
  if (changed.length <= 80) {
    return changed.map((item) => ({
      rootId,
      relPath: item.relPath,
      type: item.type,
      resourceId: item.id,
    }));
  }
  const dirs = new Set<string>();
  for (const item of changed) {
    const slash = item.relPath.lastIndexOf('/');
    dirs.add(slash < 0 ? '' : item.relPath.slice(0, slash));
  }
  return [...dirs].map((relPath) => ({ rootId, relPath, type: 'change' as const }));
}

function moveAcrossDevices(src: string, dst: string) {
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, preserveTimestamps: true, errorOnExist: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function mapOp(r: any): OpLogEntry {
  return { id: r.id, ts: r.ts, actor: r.actor, op: r.op, resourceId: r.resource_id, rootId: r.root_id, relPath: r.rel_path, detail: JSON.parse(r.detail_json), undoneAt: r.undone_at };
}

function atomicWrite(abs: string, content: string | Buffer) {
  const tmp = abs + '.kbtmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, abs);
}

function freeName(rootAbs: string, rel: string): string {
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const base = rel.slice(dir.length);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const cand = `${dir}${stem} (恢复 ${i})${ext}`;
    if (!fs.existsSync(path.join(rootAbs, ...cand.split('/')))) return cand;
  }
  throw new Error('无法找到可用的恢复文件名');
}
