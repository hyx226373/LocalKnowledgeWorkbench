/**
 * 磐石 @kb/* 运行时栈（第 10 轮）。
 * 依赖由 wire.ts 动态 import 后注入，避免 CJS bundle require ESM。
 */
import fs from 'node:fs';
import path from 'node:path';
import { reopenAfterIoError } from '../service/openRetry';
import type Database from 'better-sqlite3';
import type { FileOps } from '@kb/fileops';
import type { PlanService } from '@kb/plan';
import type { SyncController } from '@kb/sync';
import type { GroupedSearchResult, IndexJob } from '@kb/indexer';

export interface KbStackDeps {
  Database: typeof import('better-sqlite3');
  migrateIdentity: (db: Database.Database) => void;
  setMount: (db: Database.Database, rootId: string, localPath: string) => void;
  machineId: () => string;
  resolveInsideRoot: (db: Database.Database, rootId: string, relPath: string) => { rootId: string; relPath: string; absPath: string; resourceId: string | null };
  ensureResource: (db: Database.Database, rootId: string, relPath: string) => string;
  migrateIndexer: (db: Database.Database) => void;
  searchGrouped: (db: Database.Database, query: string, opts?: { limit?: number; rootIds?: string[] }) => GroupedSearchResult;
  startIndex: (opts: {
    rootId: string;
    localPath: string;
    dbPath: string;
    resolveResourceId: (rootId: string, relPath: string) => string;
    resolveResourceIds?: (rootId: string, relPaths: string[]) => string[];
    mode?: 'full' | 'incremental';
  }) => IndexJob;
  indexOne?: typeof import('@kb/indexer').indexOne;
  removeOne?: typeof import('@kb/indexer').removeOne;
  closeIndexer: () => Promise<void>;
  createFileOps: (deps: {
    db: Database.Database;
    dataDir: string;
    resolveInsideRoot: KbStackDeps['resolveInsideRoot'];
    ensureResource: KbStackDeps['ensureResource'];
    onMoved: () => void;
  }) => FileOps;
  createPlanService: (deps: { db: Database.Database; fileOps: FileOps }) => PlanService;
  createSync: (deps: { db: Database.Database; dbPath: string; resolveLocalPath: (rootId: string) => string }) => SyncController;
}

export interface KbStack {
  db: Database.Database;
  dbPath: string;
  dataDir: string;
  fileOps: FileOps;
  plans: PlanService;
  sync: SyncController;
  searchGrouped: (query: string, o?: { limit?: number; rootIds?: string[] }) => GroupedSearchResult;
  mirrorRoot(rootId: string, name: string, localPath: string): void;
  removeRoot(rootId: string): void;
  resolveLocalPath(rootId: string): string;
  close(): Promise<void>;
}

const STACK_PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** 上次进程被杀掉时，索引子进程可能还映射着 modules 库。第一次 journal_mode 会 IOERR_TRUNCATE。 */
function openStackDb(Database: KbStackDeps['Database'], dbPath: string): Database.Database {
  let last: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      try { fs.rmSync(`${dbPath}-shm`, { force: true }); } catch { /* 还有人映射着就等下一次 */ }
      Atomics.wait(STACK_PAUSE, 0, 0, 80);
    }
    const db = new Database(dbPath, { timeout: 200 });
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      return db;
    } catch (err) {
      last = err;
      try { db.close(); } catch { /* 连接已经坏了 */ }
      const message = String((err as Error).message ?? err);
      if (!reopenAfterIoError(message, attempt)) throw err;
    }
  }
  throw last;
}

export function openKbStack(userDataDir: string, deps: KbStackDeps): KbStack {
  const dataDir = path.join(userDataDir, 'kb-modules');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'modules.sqlite');
  const db = openStackDb(deps.Database, dbPath);
  deps.migrateIdentity(db);
  deps.migrateIndexer(db);
  const fileOps = deps.createFileOps({
    db,
    dataDir,
    resolveInsideRoot: deps.resolveInsideRoot,
    ensureResource: deps.ensureResource,
    onMoved: () => {},
  });
  fileOps.migrate();
  const plans = deps.createPlanService({ db, fileOps });
  plans.migrate();
  const mid = deps.machineId();
  const sync = deps.createSync({
    db,
    dbPath,
    resolveLocalPath: (rootId) => {
      const row = db.prepare('SELECT local_path FROM root_mounts WHERE root_id=? AND machine_id=?').get(rootId, mid) as { local_path: string } | undefined;
      if (!row?.local_path) throw new Error(`modules 栈未挂载根 ${rootId}`);
      return row.local_path;
    },
  });

  function mirrorRoot(rootId: string, name: string, localPath: string) {
    const abs = path.resolve(localPath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw new Error(`根路径无效: ${abs}`);
    const existing = db.prepare('SELECT id FROM roots WHERE id=?').get(rootId);
    if (!existing) db.prepare('INSERT INTO roots (id, name, created_at) VALUES (?, ?, ?)').run(rootId, name, Date.now());
    else db.prepare('UPDATE roots SET name=? WHERE id=?').run(name, rootId);
    deps.setMount(db, rootId, abs);
  }

  function removeRoot(rootId: string) {
    db.prepare('DELETE FROM root_mounts WHERE root_id=?').run(rootId);
    db.prepare('DELETE FROM roots WHERE id=?').run(rootId);
  }

  return {
    db,
    dbPath,
    dataDir,
    fileOps,
    plans,
    sync,
    searchGrouped: (query, o) => deps.searchGrouped(db, query, o),
    mirrorRoot,
    removeRoot,
    resolveLocalPath: (rootId) => {
      const row = db.prepare('SELECT local_path FROM root_mounts WHERE root_id=? AND machine_id=?').get(rootId, mid) as { local_path: string } | undefined;
      if (!row?.local_path) throw new Error(`modules 栈未挂载根 ${rootId}`);
      return row.local_path;
    },
    async close() {
      try {
        await deps.closeIndexer();
      } catch {
        /* ignore */
      }
      db.close();
    },
  };
}

export function ensureWorkbenchContentIndex(
  deps: Pick<KbStackDeps, 'migrateIndexer' | 'startIndex'>,
  db: Database.Database,
  dbPath: string,
  rootId: string,
  localPath: string,
  resolveResourceId: (rootId: string, relPath: string) => string,
  resolveResourceIds?: (rootId: string, relPaths: string[]) => string[],
) {
  deps.migrateIndexer(db);
  return deps.startIndex({
    rootId,
    localPath,
    dbPath,
    resolveResourceId,
    resolveResourceIds,
    mode: 'incremental',
  });
}
