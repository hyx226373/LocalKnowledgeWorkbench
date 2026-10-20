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
import { WorkbenchContentScope } from './contentScope';
import { isContentBodyIndexEnabled, readContentIndexScope } from '../../shared/contentIndexScope';
import { KbSync, LocalSync, type SyncBackend } from './sync';
import { openKbStack, ensureWorkbenchContentIndex, type KbStack, type KbStackDeps } from './kbStack';
import { startAgentServer, type AgentServerInfo } from './agentServer';
import { mountFileAgentBridge } from '../agent-bridge/startFromWire';
import type { RunningBridge } from '../agent-bridge/pump';
import { setIndexHealth, getIndexHealth, type IndexHealth } from './indexHealth';
import { LiveContentIndex, type CompactTextIndexFn } from './liveContent';
import { getIndexerFork, installIndexerHost } from '../indexerHost';
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
  /** 按当前范围对账这一根的正文标记。没有实时索引时什么也不做。 */
  reconcileContentRoot(rootId: string): void;
  /** 这段承诺结束前，实时正文索引只攒事件，不在主进程写全文。 */
  holdLiveIndex(done: Promise<unknown>): void;
  whenContentSettled(): Promise<void>;
  close(): Promise<void>;
}

/**
 * r15：@kb/indexer 有两代宿主接口。旧的读 @kb/indexer/fork 的 setIndexerFork；
 * 正式包里的 indexer 只认 setIndexerHost（host.js），不认 setIndexerFork。
 * 只注入 setIndexerFork 时，indexer 落回 child_process.fork，打包态（runAsNode fuse 关）直接抛错，
 * 整个 @kb 栈回退到仅文件名搜索。这里把已经装好的 fork 也交给 setIndexerHost。
 */
export function bridgeIndexerHost(indexer: Record<string, unknown>, mode: 'utilityProcess' | 'child_process', getFork: () => unknown = defaultGetFork): boolean {
  if (mode !== 'utilityProcess') return false;
  const setHost = indexer.setIndexerHost;
  if (typeof setHost !== 'function') return false;
  const forkFn = getFork() as ((p: string, a: string[], o: { env?: NodeJS.ProcessEnv }) => unknown) | null;
  if (typeof forkFn !== 'function') throw new Error('索引宿主未注入：拿不到 utilityProcess fork');
  (setHost as (h: { fork(scriptPath: string, env?: NodeJS.ProcessEnv): unknown }) => void)({
    fork: (scriptPath, env) => forkFn(scriptPath, [], { env }),
  });
  startupMark('main:indexer-host-bridged');
  return true;
}

export function indexerHostCandidates(baseDir: string, cwd: string): string[] {
  return [
    path.join(baseDir, '..', '..', 'node_modules', '@kb', 'indexer', 'dist', 'host.js'),
    path.join(cwd, 'resources', 'app.asar', 'node_modules', '@kb', 'indexer', 'dist', 'host.js'),
    path.join(cwd, 'node_modules', '@kb', 'indexer', 'dist', 'host.js'),
  ];
}

async function loadIndexerHostModule(mode: 'utilityProcess' | 'child_process'): Promise<Record<string, unknown> | null> {
  if (mode !== 'utilityProcess') return null;
  const fs = await import('node:fs');
  const { pathToFileURL } = await import('node:url');
  for (const file of indexerHostCandidates(__dirname, process.cwd())) {
    if (!fs.existsSync(file)) continue;
    return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as Record<string, unknown>;
  }
  // 旧版 indexer 没有 host.js，只认 setIndexerFork，installIndexerHost 已经处理。
  return null;
}

function defaultGetFork(): unknown {
  return getIndexerFork();
}

let compactLive: CompactTextIndexFn = () => ({ ok: false, steps: 0 });

function indexerStubs(): Pick<KbStackDeps, 'migrateIndexer' | 'searchGrouped' | 'startIndex' | 'closeIndexer'> {
  return {
    migrateIndexer: () => {},
    searchGrouped: () => ({ hits: [], truncated: false }),
    startIndex: () => {
      const done = Promise.resolve({
        jobId: 'content-index-off',
        status: 'completed' as const,
        processed: 0,
        total: 0,
        filesProcessed: [],
        errors: [],
        elapsedMs: 0,
        bodyReads: 0,
      });
      return { jobId: 'content-index-off', done, cancel() {}, onProgress: () => () => {} };
    },
    closeIndexer: async () => {},
  };
}

async function loadKbDeps(): Promise<KbStackDeps> {
  const Database = (await import('better-sqlite3')).default;
  const iw = await import('@kb/identity-watch');
  const fileops = await import('@kb/fileops');
  const plan = await import('@kb/plan');
  const sync = await import('@kb/sync');
  const shared = {
    Database,
    migrateIdentity: iw.migrate,
    setMount: iw.setMount,
    machineId: iw.machineId,
    resolveInsideRoot: iw.resolveInsideRoot as KbStackDeps['resolveInsideRoot'],
    ensureResource: iw.ensureResource,
    createFileOps: fileops.createFileOps,
    createPlanService: plan.createPlanService,
    createSync: sync.createSync,
  };
  // 总闸关闭时不 import @kb/indexer：它的模块顶层会拉起正文 worker。
  if (!isContentBodyIndexEnabled()) return { ...shared, ...indexerStubs() };
  // 必须在 import('@kb/indexer') 之前注入 fork（打包态 utilityProcess）
  const host = installIndexerHost();
  startupMark('main:indexer-host-' + host.mode);
  // @kb/indexer 的 index.js 在模块顶层就拉起共享 worker，所以宿主必须在 import 之前装进 host.js。
  // host.js 不在 exports 里，按安装位置找；ESM 以文件 URL 去重，index.js 里的 './host.js' 是同一实例。
  const hostModule = await loadIndexerHostModule(host.mode);
  if (hostModule) bridgeIndexerHost(hostModule, host.mode);
  const indexer = await import('@kb/indexer');
  const compactFn = (indexer as { compactTextIndexUntilWritable?: CompactTextIndexFn }).compactTextIndexUntilWritable;
  if (typeof compactFn === 'function') compactLive = compactFn;
  // D2: @kb/indexer dist may lack onIndexerChild (host API drift). Guard so loadKbDeps
  // does not throw into Local* fallback. utilityProcess path already ownPid's in indexerHost.
  const onIndexerChild = (indexer as { onIndexerChild?: (cb: (pid: number) => void) => void }).onIndexerChild;
  if (typeof onIndexerChild === 'function') onIndexerChild((pid) => ownPid(pid));
  return {
    ...shared,
    migrateIndexer: indexer.migrate,
    searchGrouped: indexer.searchGrouped,
    startIndex: indexer.startIndex,
    indexOne: indexer.indexOne,
    indexMany: typeof indexer.indexMany === 'function' ? indexer.indexMany : undefined,
    removeOne: indexer.removeOne,
    closeIndexer: indexer.closeIndexer,
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
  const contentScopes = new WorkbenchContentScope(svc);

  try {
    startupMark('main:wire-load-kb');
    if (isContentBodyIndexEnabled() && process.env.KB_FORCE_INDEXER_FAIL === '1') {
      throw new Error('KB_FORCE_INDEXER_FAIL=1：强制全文索引不可用（e2e）');
    }
    kbDeps = await loadKbDeps();
    startupMark('main:wire-kb-loaded');
    stack = openKbStack(userDataDir, kbDeps);
    startupMark('main:wire-stack-open');
    const adapter = new KbPlanAdapter(stack.plans);
    plans = adapter;
    const mainDb = (svc as unknown as { db: Database.Database }).db;
    // The workbench watcher owns live updates; a modules worker has a separate DB
    // and cannot inherit the main process utilityProcess host.
    sync = new LocalSync(svc);
    if (!isContentBodyIndexEnabled()) {
      // 文件名只走 resources_fts。不迁移、不订阅正文索引。
      search = new LocalSearch(svc);
      setIndexHealth({
        engine: 'local-fallback',
        contentSearch: false,
        reason: undefined,
        scannedFiles: 0,
        contentIndexedFiles: 0,
      });
    } else {
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
      // 正文搜索：主库没有正文命中时再问模块库；模块库仍没有时不回退到仅文件名的 LocalSearch。
      search = new HybridSearch(primary, new HybridSearch(modulesSearch, new LocalSearch(svc), false));
      live = new LiveContentIndex(svc, mainDb, kbDeps.indexOne!, kbDeps.removeOne!, undefined, compactLive, contentScopes, kbDeps.indexMany);
      svc.on('fs-change', live.enqueue);
      svc.on('content-scope-changed', live.dropOutOfScope);
      setIndexHealth({
        engine: 'kb-indexer',
        contentSearch: true,
        reason: undefined,
        scannedFiles: 0,
        contentIndexedFiles: 0,
      });
    }
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
      reasonStack: String((e as Error)?.stack ?? "").split("\n").slice(0, 12).join("\n"),
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
    reconcileContentRoot(rootId) {
      try { live?.reconcileRoot(rootId); } catch (err) { console.error('[backend] 对账正文索引', err); }
    },
    indexContent(rootId, localPath, opts) {
      if (!isContentBodyIndexEnabled()) return;
      if (closing) return;
      if (svc.listRoots().find((root) => root.id === rootId)?.kind === 'file') {
        live?.enqueue([{ rootId, relPath: '', type: 'change' }]);
        return;
      }
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
        const scope = readContentIndexScope((key) => svc.getLayout(key));
        try {
          const started = ensureWorkbenchContentIndex(kbDeps, mainDb, dbPath, rootId, localPath, resolve, resolveMany, scope, contentScopes.snapshot().get(rootId));
          live?.track(started.done);
          const result = await started.done;
          noteContentBodyReads(result.bodyReads ?? 0);
        } finally {
          try { live?.reconcileRoot(rootId); } catch (err) { console.error('[backend] 对账正文索引', err); }
        }
      })();
      contentJobs.push(job.catch((err) => console.error('[backend] indexContent', err)));
    },
    async close() {
      closing = true;
      await Promise.allSettled(startup);
      if (live) { svc.off('content-scope-changed', live.dropOutOfScope); svc.off('fs-change', live.enqueue); await live.close(); }
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
