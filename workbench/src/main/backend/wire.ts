import { mark as startupMark } from '../startupTrace';
/**
 * 主进程后端装配（第 10 轮）：把 @kb/* 接到 Search / Plan / Sync / Agent。
 * @kb 包为 ESM（含 worker），全部动态 import。
 */
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { WorkbenchService } from '../service/WorkbenchService';
import { LocalFileOps } from './fileOps';
import { OperationService, LocalPlanService } from './operations';
import { KbPlanAdapter } from './planAdapter';
import { HybridSearch, KbSearch, LocalSearch, RemappingSearch, DegradedSearch, fromIndexerGrouped, type SearchBackend } from './search';
import { KbSync, LocalSync, type SyncBackend } from './sync';
import { openKbStack, ensureWorkbenchContentIndex, type KbStack, type KbStackDeps } from './kbStack';
import { startAgentServer, type AgentServerInfo } from './agentServer';
import { mountFileAgentBridge } from '../agent-bridge/startFromWire';
import type { RunningBridge } from '../agent-bridge/pump';
import { setIndexHealth, getIndexHealth, type IndexHealth } from './indexHealth';
import { LiveContentIndex, type CompactTextIndexFn } from './liveContent';
import { installIndexerHost } from '../indexerHost';
import { ownPid } from '../ownedPids';
import { noteContentBodyReads, markContentIndexDone } from '../runtimeStats';
import { readPublishSnapshot } from '../service/rootGeneration';
import { publishRootResult } from '../service/rootScheduler';

export interface BackendBundle {
  stack: KbStack | null;
  fileOps: LocalFileOps;
  ops: OperationService;
  search: SearchBackend;
  sync: SyncBackend;
  agent: AgentServerInfo | null;
  /** r11-G 文件桥。没有时准空。 */
  fileAgentBridge: RunningBridge | null;
  /** r11-E：索引是否走 @kb/indexer（正文可搜） */
  getHealth(): IndexHealth;
  onRootAdded(rootId: string, name: string, localPath: string): void;
  onRootRemoved(rootId: string): void;
  indexContent(rootId: string, localPath: string, opts?: { existingOnly?: boolean }): void;
  /** 这段承诺结束前，实时正文索引只攒事件，不在主进程写全文。 */
  holdLiveIndex(done: Promise<unknown>): void;
  whenContentSettled(): Promise<void>;
  close(): Promise<void>;
}

let compactLive: CompactTextIndexFn = () => ({ ok: false, steps: 0 });

async function loadKbDeps(): Promise<KbStackDeps> {
  // 必须在 import('@kb/indexer') 之前注入 fork（打包态 utilityProcess）
  const host = installIndexerHost();
  startupMark('main:indexer-host-' + host.mode);
  const Database = (await import('better-sqlite3')).default;
  const iw = await import('@kb/identity-watch');
  const indexer = await import('@kb/indexer');
  const compactFn = (indexer as { compactTextIndexUntilWritable?: CompactTextIndexFn }).compactTextIndexUntilWritable;
  if (typeof compactFn === 'function') compactLive = compactFn;
  indexer.onIndexerChild((pid) => ownPid(pid));
  const fileops = await import('@kb/fileops');
  const plan = await import('@kb/plan');
  const sync = await import('@kb/sync');
  return {
    Database,
    migrateIdentity: iw.migrate,
    setMount: iw.setMount,
    machineId: iw.machineId,
    resolveInsideRoot: iw.resolveInsideRoot as KbStackDeps['resolveInsideRoot'],
    ensureResource: iw.ensureResource,
    migrateIndexer: indexer.migrate,
    searchGrouped: indexer.searchGrouped,
    startIndex: indexer.startIndex,
    indexOne: indexer.indexOne,
    removeOne: indexer.removeOne,
    closeIndexer: indexer.closeIndexer,
    createFileOps: fileops.createFileOps,
    createPlanService: plan.createPlanService,
    createSync: sync.createSync,
  };
}

export async function wireBackend(svc: WorkbenchService, userDataDir: string): Promise<BackendBundle> {
  const fileOps = new LocalFileOps(svc);
  let stack: KbStack | null = null;
  let plans: LocalPlanService | KbPlanAdapter;
  let search: SearchBackend;
  let sync: SyncBackend;
  let kbDeps: KbStackDeps | null = null;
  let live: LiveContentIndex | null = null;

  try {
    startupMark('main:wire-load-kb');
    if (process.env.KB_FORCE_INDEXER_FAIL === '1') {
      throw new Error('KB_FORCE_INDEXER_FAIL=1：强制全文索引不可用（e2e）');
    }
    kbDeps = await loadKbDeps();
    startupMark('main:wire-kb-loaded');
    stack = openKbStack(userDataDir, kbDeps);
    startupMark('main:wire-stack-open');
    const adapter = new KbPlanAdapter(stack.plans);
    plans = adapter;
    const mainDb = (svc as unknown as { db: Database.Database }).db;
    kbDeps.migrateIndexer(mainDb);
    const sg = kbDeps.searchGrouped;
    const primary = new KbSearch((db, q, o) => fromIndexerGrouped(sg(db as Database.Database, q, o)), mainDb);
    const modulesSearch = new RemappingSearch(
      new KbSearch((_db, q, o) => fromIndexerGrouped(stack!.searchGrouped(q, o)), stack.db),
      (rootId, relPath) => {
        try {
          return svc.resourceIdFor(rootId, relPath);
        } catch {
          return null;
        }
      },
    );
    search = new HybridSearch(primary, new HybridSearch(modulesSearch, new LocalSearch(svc)));
    // The workbench watcher owns live updates; a modules worker has a separate DB
    // and cannot inherit the main process utilityProcess host.
    sync = new LocalSync(svc);
    live = new LiveContentIndex(svc, mainDb, kbDeps.indexOne!, kbDeps.removeOne!, undefined, compactLive);
    svc.on('fs-change', live.enqueue);
    setIndexHealth({
      engine: 'kb-indexer',
      contentSearch: true,
      reason: undefined,
      scannedFiles: 0,
      contentIndexedFiles: 0,
    });
  } catch (e) {
    console.error('[backend] @kb 栈启动失败，回退 Local*：', e);
    stack = null;
    kbDeps = null;
    plans = new LocalPlanService(svc, fileOps);
    search = new DegradedSearch(new LocalSearch(svc), true);
    sync = new LocalSync(svc);
    setIndexHealth({
      engine: 'local-fallback',
      contentSearch: false,
      reason: String((e as Error)?.message ?? e).slice(0, 500),
      scannedFiles: 0,
      contentIndexedFiles: 0,
    });
  }

  const ops = new OperationService(svc, plans);

  if (stack) {
    for (const r of svc.listRoots()) {
      try {
        stack.mirrorRoot(r.id, r.name, r.path);
      } catch (err) {
        console.error('[backend] mirrorRoot', r.id, err);
      }
    }
  }

  let closing = false;
  const startup: Promise<unknown>[] = [];
  const contentJobs: Promise<unknown>[] = [];
  const bundle: BackendBundle = {
    stack,
    fileOps,
    ops,
    search,
    sync,
    agent: null,
    fileAgentBridge: null,
    getHealth: () => getIndexHealth(),
    onRootAdded(rootId, name, localPath) {
      try {
        stack?.mirrorRoot(rootId, name, localPath);
      } catch (err) {
        console.error('[backend] onRootAdded', err);
      }
    },
    onRootRemoved(rootId) {
      try {
        stack?.removeRoot(rootId);
      } catch (err) {
        console.error('[backend] onRootRemoved', err);
      }
    },
    holdLiveIndex(done) {
      live?.hold(done);
    },
    whenContentSettled() {
      return Promise.allSettled(contentJobs).then(() => {
        markContentIndexDone();
      });
    },
    indexContent(rootId, localPath, opts) {
      if (closing) return;
      const capturedWorkspace = svc.publishWorkspaceId();
      let capturedGeneration = 0;
      try {
        capturedGeneration = readPublishSnapshot(svc.db, rootId, capturedWorkspace)?.generation ?? 0;
      } catch (err) {
        console.error('[backend] indexContent 代次', err);
        return;
      }
      const job = (async () => {
        const verdict = await publishRootResult(
          svc.db,
          rootId,
          () => capturedWorkspace || svc.publishWorkspaceId(),
          capturedGeneration,
          () => { /* 代次不符时不写入，也不补 workspace_roots */ },
        );
        if (verdict !== 'applied' || closing || !kbDeps) return;
        const mainDb = (svc as unknown as { db: Database.Database }).db;
        const dbPath = path.join(userDataDir, 'workbench.db');
        const resolve = opts?.existingOnly
          ? (rid: string, rel: string) => {
              const row = mainDb.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=? AND missing_since IS NULL').get(rid, rel) as { id: string } | undefined;
              if (!row) throw new Error('不在已确认的重映射结果中');
              return row.id;
            }
          : (rid: string, rel: string) => svc.resourceIdFor(rid, rel);
        const resolveMany = opts?.existingOnly
          ? (rid: string, rels: string[]) => rels.map((rel) => {
              try { return resolve(rid, rel); } catch { return ''; }
            })
          : (rid: string, rels: string[]) => svc.resourceIdsFor(rid, rels);
        const started = ensureWorkbenchContentIndex(kbDeps, mainDb, dbPath, rootId, localPath, resolve, resolveMany);
        live?.track(started.done);
        const result = await started.done;
        noteContentBodyReads(result.bodyReads ?? 0);
      })();
      contentJobs.push(job.catch((err) => console.error('[backend] indexContent', err)));
    },
    async close() {
      closing = true;
      await Promise.allSettled(startup);
      if (live) { svc.off('fs-change', live.enqueue); await live.close(); }
      await bundle.fileAgentBridge?.close().catch(() => {});
      await bundle.agent?.close().catch(() => {});
      await stack?.close().catch(() => {});
    },
  };
  // ---- r11-G 文件 Agent 桥。只追加启动钩子。不给 AgentOps 加 approve，不在这里打开数据库。
  startup.push(mountFileAgentBridge({
    userDataDir,
    svc,
    ops,
    getIndexHealth: () => getIndexHealth(),
  }).then((bridge) => {
    bundle.fileAgentBridge = bridge;
  }).catch((err) => console.error('[agent-bridge] 启动失败', err)));
  startup.push(startAgentServer({ dataDir: userDataDir, ops, agentName: 'http' })
    .then((a) => {
      bundle.agent = a;
      console.log(`[agent] loopback ${a.url} token → ${a.tokenFile}`);
    })
    .catch((e) => console.error('[agent] 启动失败', e)));
  return bundle;
}
