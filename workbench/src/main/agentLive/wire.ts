import { setContentArea } from '../backend/contentScope';
import { readSessionMaterials } from './materials/persist';
import { rebirthFormat } from '../../shared/rebirthFormat';
import { RebirthRepository } from '../rebirth/repository';
import { loadWriteChannelSnapshot } from '../aiWrite/service';
import { loadSkillSnapshot } from '../skills/library';
import { resolveAgentDataRoot } from '../agentPanel/paths';
import { markFromSelection } from '../../shared/agentMarks';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBridgeRoot } from '../agent-bridge/paths';
import type { RootWatchers } from '../service/watcher';
import { AGENT_PINNED_LAYOUT_PREFIX, type WorkbenchService } from '../service/WorkbenchService';
import { registerInvokeExecutor } from '../../shared/actions/registry';
import { AGENT_LIVE_ACTIONS, type LiveEvent, type LivePanel, type LiveReading, type MaterialRef } from '../../shared/agentLive/types';
import { createLiveEntryWriter, type EntryTreeNode, type LiveEntryController } from './entry';
import {
  collectLibraryTree,
  createLibraryTreeRefresh,
  hideUnopenableFilesEnabled,
  libraryTreeSignature,
  libraryTreeToEntryNodes,
  type LibraryRootInput,
  type LibraryTreeSnapshot,
} from './entry/libraryTree';
import { createAgentMarkStore, type AgentMarkStore } from '../agentMarks/store';
import { eligibilityForPath, MARK_INELIGIBLE_REASON, type AttentionDraft } from '../../shared/agentMarks';
import { createAgentMaterialsStore, onMaterialsChange, type AgentMaterialsApi } from './materials';
import { isWorkspaceId } from './materials/errors';
import { idsLosingSlot, planGuess, scenePlaybook, unassignedCount, type GuessPatch } from '../../shared/ctxPlaybook';
import { playbookFile, savedPlaybook, viewPlaybook } from './playbook/file';
import { loadPackagedPresets } from './playbook/presets';
import { peekPlanBinding } from './planBindings';
import { createRevisionHandlers, runBoundPlan, type AgentLiveRevision } from './revision';
import { createLiveRevisionLog } from './revision/log';

export interface AgentLiveWire {
  methods: Record<string, (...args: any[]) => unknown>;
  activate(workspaceId: string): Promise<void>;
  assertBoundPlan(planId: string): void;
  close(): Promise<void>;
}

interface NotedScene {
  panels?: LivePanel[];
  reading?: LiveReading | null;
}

function workspaceName(svc: WorkbenchService, workspaceId: string): string | undefined {
  try {
    return svc.getWorkspace(workspaceId).name;
  } catch {
    return undefined;
  }
}

function isTokenPath(absPath: string): boolean {
  return path.basename(absPath).toLowerCase() === 'agent-token.json';
}

/**
 * 数据进程里的工作资料。主进程不碰数据库。
 * 监视复用每个根已有的 RootWatchers，不另开整树监听。
 */
function catalogStructure(svc: WorkbenchService, workspaceId: string): EntryTreeNode[] | undefined {
  try {
    const catalog = svc.catalogForWorkspace(workspaceId);
    const folders = Array.isArray(catalog.folders) ? catalog.folders : [];
    const refs = Array.isArray(catalog.refs) ? catalog.refs : [];
    if (!folders.length && !refs.length) return undefined;

    const childrenOf = new Map<string | null, typeof folders>();
    for (const folder of folders) {
      const parent = folder.parentId ?? null;
      const list = childrenOf.get(parent) ?? [];
      list.push(folder);
      childrenOf.set(parent, list);
    }
    for (const list of childrenOf.values()) {
      list.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name, 'zh-CN'));
    }

    const refsOf = new Map<string | null, typeof refs>();
    for (const ref of refs) {
      const folderId = ref.folderId ?? null;
      const list = refsOf.get(folderId) ?? [];
      list.push(ref);
      refsOf.set(folderId, list);
    }

    const leaf = (resourceId: string): EntryTreeNode => {
      try {
        const info = svc.getResource(resourceId);
        if (info) {
          return {
            name: info.name || resourceId,
            kind: info.kind === 'dir' ? 'dir' : 'file',
            ...(info.relPath ? { relPath: info.relPath } : {}),
          };
        }
      } catch {
        /* 缺资源时仍留节点，避免编排结构空洞 */
      }
      return { name: resourceId, kind: 'file' };
    };

    const build = (folderId: string | null, name: string): EntryTreeNode => {
      const kids: EntryTreeNode[] = [];
      for (const child of childrenOf.get(folderId) ?? []) {
        kids.push(build(child.folderId, child.name));
      }
      for (const ref of refsOf.get(folderId) ?? []) {
        kids.push(leaf(ref.resourceId));
      }
      return kids.length ? { name, kind: 'dir' as const, children: kids } : { name, kind: 'dir' as const };
    };

    const rootName = catalog.virtualRootName || '自建目录';
    return [build(null, rootName)];
  } catch {
    return undefined;
  }
}
function readingKey(reading: LiveReading | null | undefined): string {
  if (!reading) return '';
  return [reading.panelId ?? '', reading.materialId ?? '', reading.resourceId ?? '', reading.absPath ?? '', reading.name ?? ''].join('\0');
}

function panelsKey(panels: LivePanel[] | undefined): string {
  if (!panels?.length) return '';
  return panels
    .map((panel) => [panel.panelId, panel.materialId ?? '', panel.resourceId ?? '', panel.absPath ?? '', panel.name ?? ''].join('\x1f'))
    .join('\x1e');
}

function sameNotedScene(a: NotedScene | undefined, b: NotedScene): boolean {
  if (!a) return false;
  return readingKey(a.reading) === readingKey(b.reading) && panelsKey(a.panels) === panelsKey(b.panels);
}

export function startAgentLive(opts: {
  svc: WorkbenchService;
  watchers: RootWatchers;
  dataDir: string;
  version: string;
  notify: (workspaceId: string) => void;
  agentDataDir?: string;
  agentAnchorDir?: string | null;
  trashItem?: (abs: string) => Promise<void>;
}): AgentLiveWire {
  const { svc, watchers, notify } = opts;
  const bridgeRoot = resolveBridgeRoot(opts.dataDir);
  const presetCatalog = loadPackagedPresets() ?? undefined;
  const scenes = new Map<string, NotedScene>();
  const resetBusy = new Set<string>();
  const pinnedPrefix = AGENT_PINNED_LAYOUT_PREFIX;

  const agentMarks: AgentMarkStore = createAgentMarkStore(path.join(opts.dataDir, 'agent-marks.json'));

  const store: AgentMaterialsApi = createAgentMaterialsStore({
    userDataDir: opts.dataDir,
    pinned: {
      read: (workspaceId) => svc.getLayout(pinnedPrefix + workspaceId),
      write: (workspaceId, value) => svc.setLayout(pinnedPrefix + workspaceId, value),
      keys: () => svc.layoutKeys(pinnedPrefix)
        .filter((key) => key.startsWith(pinnedPrefix))
        .map((key) => key.slice(pinnedPrefix.length))
        .filter(isWorkspaceId),
    },
    identity: {
      resolve: (absPath) => svc.resolveMaterialIdentity(absPath),
    },
    feed: {
      onBatch: (cb) => watchers.onBatch((rootId, batch) => {
        cb(batch.map((event) => ({ rootId, type: event.type, relPath: event.relPath })));
      }),
    },
  });

  let log!: AgentLiveRevision;
  let libraryCache: { key: string; tree: LibraryTreeSnapshot } | null = null;
  let libraryPending: { key: string; promise: Promise<LibraryTreeSnapshot> } | null = null;
  const libraryPublished = new Map<string, string>();

  function readHideUnopenable(): boolean {
    try {
      return hideUnopenableFilesEnabled(svc.getLayout('kb.sidebar.ui'));
    } catch {
      return true;
    }
  }

  function entryRoots(workspaceId: string): LibraryRootInput[] {
    let rows: ReturnType<WorkbenchService['rootsToWatch']> = [];
    try {
      const current = svc.getCurrentWorkspaceId();
      if (!workspaceId || workspaceId === current) rows = svc.rootsToWatch();
      else {
        for (const id of svc.workspaceRootIds(workspaceId)) {
          try {
            rows.push(svc.getRoot(id));
          } catch {
            /* 根已经不在 */
          }
        }
      }
    } catch {
      try {
        rows = svc.rootsToWatch();
      } catch {
        rows = [];
      }
    }
    return rows.map((root) => ({
      name: root.name,
      path: root.path,
      kind: root.kind,
      status: root.status,
    }));
  }

  function libraryKey(workspaceId: string, hide: boolean, roots: readonly LibraryRootInput[]): string {
    const body = roots.map((root) => [root.name, root.path, root.kind ?? '', root.status ?? ''].join('\u001f')).join('\u001e');
    return `${workspaceId}\0${hide ? '1' : '0'}\0${body}`;
  }

  function loadLibraryTree(workspaceId: string): Promise<LibraryTreeSnapshot> {
    const hide = readHideUnopenable();
    const roots = entryRoots(workspaceId);
    const key = libraryKey(workspaceId, hide, roots);
    if (libraryCache?.key === key) return Promise.resolve(libraryCache.tree);
    if (libraryPending?.key === key) return libraryPending.promise;
    const promise = collectLibraryTree(roots, { hideUnopenableFiles: hide }).then(
      (tree) => {
        if (libraryPending?.promise === promise) {
          libraryCache = { key, tree };
          libraryPending = null;
        }
        return tree;
      },
      () => {
        if (libraryPending?.promise === promise) libraryPending = null;
        const empty: LibraryTreeSnapshot = {
          hideUnopenableFiles: hide,
          maxDepth: 6,
          maxEntries: 5000,
          roots: [],
          errors: [{ path: '.', message: 'read-failed' }],
        };
        return empty;
      },
    );
    libraryPending = { key, promise };
    return promise;
  }

  const entry: LiveEntryController = createLiveEntryWriter({
    bridgeRoot,
    appVersion: opts.version,
    loadScene: async (workspaceId) => {
      const noted = scenes.get(workspaceId);
      const libraryTree = await loadLibraryTree(workspaceId);
      libraryPublished.set(workspaceId, libraryTreeSignature(libraryTree));
      const catalog = catalogStructure(svc, workspaceId);
      const attention = agentMarks.signals();
      const writeChannel = loadWriteChannelSnapshot(entryRoots(workspaceId).map((root) => ({ path: root.path, name: root.name })));
      const dataRoot = resolveAgentDataRoot()?.root ?? opts.agentDataDir;
      const skillSnap = dataRoot ? loadSkillSnapshot(dataRoot) : {};
      const materials = store.list(workspaceId);
      const playbook = scenePlaybook(viewPlaybook(playbookFile(bridgeRoot, workspaceId)), materials);
      return {
        workspaceName: workspaceName(svc, workspaceId),
        materials,
        panels: noted?.panels,
        reading: noted?.reading ?? null,
        structure: [...libraryTreeToEntryNodes(libraryTree), ...(catalog ?? [])],
        libraryTree,
        ...(attention.length ? { attention } : {}),
        ...(writeChannel ? { writeChannel } : {}),
        ...(skillSnap.skillDistill ? { skillDistill: true as const } : {}),
        ...(skillSnap.skills?.length ? { skills: skillSnap.skills } : {}),
        ...(playbook ? { playbook } : {}),
      };
    },
    readIndexedText: (material) => (material.resourceId ? svc.readIndexedExcerpt(material.resourceId) : null),
    extractText: async (material) => {
      if (!material.absPath || isTokenPath(material.absPath)) return null;
      try {
        const mod = await import('@kb/indexer') as {
          extractText?: (absPath: string) => Promise<Array<{ text?: string }>>;
        };
        if (typeof mod.extractText !== 'function') return null;
        const pages = await mod.extractText(material.absPath);
        const pageTexts = (pages ?? []).map((page) => page.text ?? '').filter((text) => text.trim());
        if (!pageTexts.length) return null;
        return { text: pageTexts.join('\n\n'), pageTexts, pages: pageTexts.length };
      } catch {
        return null;
      }
    },
    onContentReady: (workspaceId, materialIds) => {
      const key = `${workspaceId}\0${materialIds.join(',')}`;
      if (resetBusy.has(key)) return;
      resetBusy.add(key);
      void log.append(workspaceId, [{ type: 'snapshot.reset', workspaceId, materialIds }]).finally(() => {
        resetBusy.delete(key);
      });
    },
    isCurrent: (workspaceId) => log.currentPointer().workspaceId === workspaceId,
  });

  log = createLiveRevisionLog({
    bridgeRoot,
    appVersion: opts.version,
    entryWriter: entry,
  });

  const contentWorkspaces = new Set<string>([...Object.keys(readSessionMaterials(path.join(opts.dataDir, 'agent-live-state.json')).byWorkspace), svc.getCurrentWorkspaceId(), ...svc.layoutKeys(pinnedPrefix).map((key) => key.slice(pinnedPrefix.length))]);
  const ensureContentSource = (abs: string) => {
    if (!abs || !fs.existsSync(abs)) return;
    const roots = svc.listRoots();
    if (roots.some((root) => {
      const rel = path.relative(root.path, abs);
      return root.kind === 'file' ? rel === '' : rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    })) return;
    try {
      if (fs.statSync(abs).isDirectory()) svc.addRoot(abs);
      else svc.addFileSource(abs);
      watchers.sync();
    } catch (error) { console.error('[content-scope] 登记资料来源失败', error); }
  };
  const syncContentMaterials = () => {
    const rows = [...contentWorkspaces].flatMap((id) => store.list(id));
    for (const row of rows) ensureContentSource(row.absPath);
    setContentArea(svc, 'agent-materials', {
      resourceIds: rows.flatMap((row) => row.resourceId ? [row.resourceId] : []),
      paths: rows.map((row) => row.absPath).filter(Boolean),
    });
  };
  syncContentMaterials();
  let repositoryKey = '';
  const syncRepository = () => {
    const dataRoot = resolveAgentDataRoot()?.root ?? opts.agentDataDir;
    if (!dataRoot) return;
    let repoRoot = path.join(dataRoot, 'rebirth');
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(repoRoot, 'settings.json'), 'utf8'));
      if (settings.archive?.mode === 'dir' && typeof settings.archive.dir === 'string') repoRoot = settings.archive.dir;
    } catch { /* default repository */ }
    if (!fs.existsSync(repoRoot)) return;
    if (repositoryKey === repoRoot) return;
    repositoryKey = repoRoot;
    ensureContentSource(repoRoot);
    setContentArea(svc, 'agent-repository', { paths: [repoRoot] });
  };
  syncRepository();
  const contentRepositoryTimer = setInterval(syncRepository, 1000);
  contentRepositoryTimer.unref();
  const stopEvents = onMaterialsChange(store, (event) => {
    if (event.workspaceId) contentWorkspaces.add(event.workspaceId);
    syncContentMaterials();
    const workspaceId = event.workspaceId;
    if (!workspaceId) return;
    if (event.type === 'session.cleared') agentMarks.onRoundReset(event.type);
    notify(workspaceId);
    void log.append(workspaceId, [event as LiveEvent]).catch((err) => {
      console.error('[agent-live] 修订日志没有记下资料变化', err);
    });
  });

  const onCatalogChange = () => {
    let workspaceId = '';
    try {
      workspaceId = svc.getCurrentWorkspaceId();
    } catch {
      return;
    }
    if (!isWorkspaceId(workspaceId)) return;
    const key = `catalog\0${workspaceId}`;
    if (resetBusy.has(key)) return;
    resetBusy.add(key);
    void log.append(workspaceId, [{ type: 'snapshot.reset', workspaceId }]).finally(() => {
      resetBusy.delete(key);
    });
  };
  svc.on('vfolders-change', onCatalogChange);

  let liveClosed = false;
  let libraryRewriteRunning = false;
  let libraryRewriteAgain = false;

  async function rewriteLibraryEntry(): Promise<void> {
    if (libraryRewriteRunning) {
      libraryRewriteAgain = true;
      return;
    }
    libraryRewriteRunning = true;
    try {
      do {
        libraryRewriteAgain = false;
        libraryCache = null;
        libraryPending = null;
        if (liveClosed) return;
        let workspaceId = '';
        try {
          workspaceId = svc.getCurrentWorkspaceId();
        } catch {
          return;
        }
        if (!isWorkspaceId(workspaceId)) return;
        const tree = await loadLibraryTree(workspaceId);
        if (liveClosed) return;
        if (libraryPublished.get(workspaceId) === libraryTreeSignature(tree)) continue;
        await log.append(workspaceId, [{ type: 'snapshot.reset', workspaceId }]);
      } while (libraryRewriteAgain && !liveClosed);
    } finally {
      libraryRewriteRunning = false;
    }
  }

  // 根的增删和改挂载走 roots-changed。目录里的增删改名走监听已经分好类的 fs-change，不另开 watcher。
  const stopLibraryRoots = createLibraryTreeRefresh({
    subscribe: (listener) => {
      const onFs = (events: Array<{ type?: string }> | undefined) => {
        if (!Array.isArray(events)) return;
        const structural = events.some((event) => {
          const type = event?.type;
          return type === 'add' || type === 'unlink' || type === 'addDir' || type === 'unlinkDir';
        });
        if (structural) listener();
      };
      svc.on('roots-changed', listener);
      svc.on('fs-change', onFs);
      return () => {
        svc.off('roots-changed', listener);
        svc.off('fs-change', onFs);
      };
    },
    refresh: () => {
      void rewriteLibraryEntry().catch((err) => {
        console.error('[agent-live] 资料树没有刷新', err);
      });
    },
  });

  async function ensureWorkspaceEntry(workspaceId: string): Promise<string> {
    if (!entry.cached(workspaceId)) await entry.startup(workspaceId, log.current(workspaceId));
    await log.whenReady();
    await entry.whenIdle();
    return entry.entryPath(workspaceId);
  }

  async function refreshCurrent(workspaceId: string): Promise<string> {
    const rev = await log.setActiveWorkspace(workspaceId, workspaceName(svc, workspaceId));
    if (!entry.cached(workspaceId)) await entry.startup(workspaceId, rev);
    await log.whenReady();
    await entry.whenIdle();
    return path.join(bridgeRoot, 'live', 'current', 'ENTRY.md');
  }

  const revision = createRevisionHandlers(log);
  const stopExecutors = [
    registerInvokeExecutor(AGENT_LIVE_ACTIONS.getContent, (ctx) => revision.getContent(ctx.args)),
    registerInvokeExecutor(AGENT_LIVE_ACTIONS.getDiff, (ctx) => revision.getDiff(ctx.args)),
    registerInvokeExecutor(AGENT_LIVE_ACTIONS.copyBridgeLink, async () => {
      const absPath = await refreshCurrent(svc.getCurrentWorkspaceId());
      return { status: 'success' as const, result: { absPath } };
    }),
    registerInvokeExecutor(AGENT_LIVE_ACTIONS.copyWorkspaceLink, async (ctx) => {
      const requested = typeof ctx.args?.workspaceId === 'string' ? ctx.args.workspaceId : '';
      const workspaceId = requested || svc.getCurrentWorkspaceId();
      const absPath = await ensureWorkspaceEntry(workspaceId);
      return { status: 'success' as const, result: { absPath } };
    }),
  ];

  function roundPaths(): string[] {
    let workspaceId = '';
    try {
      workspaceId = svc.getCurrentWorkspaceId();
    } catch {
      return [];
    }
    if (!isWorkspaceId(workspaceId)) return [];
    const paths: string[] = [];
    for (const row of store.list(workspaceId)) {
      if (row.absPath) paths.push(row.absPath);
    }
    try {
      for (const ref of svc.listWorkspaceRefs(workspaceId)) {
        if (ref.missing || ref.sourceKind === 'web') continue;
        try {
          const abs = svc.resolveResourcePath(ref.resourceId);
          if (abs) paths.push(abs);
        } catch {
          /* 解析不到的引用不算在本轮里 */
        }
      }
    } catch {
      /* 工作区不在时只看 Agent 资料 */
    }
    return paths;
  }

  function republishMarks(): void {
    let workspaceId = '';
    try {
      workspaceId = svc.getCurrentWorkspaceId();
    } catch {
      return;
    }
    if (!isWorkspaceId(workspaceId)) return;
    void log.append(workspaceId, [{ type: 'snapshot.reset', workspaceId }]).catch((err) => {
      console.error('[agent-marks] 快照没有刷新', err);
    });
  }

  function touchPlaybook(workspaceId: string): void {
    if (!isWorkspaceId(workspaceId)) return;
    notify(workspaceId);
    void log.append(workspaceId, [{ type: 'snapshot.reset', workspaceId }]).catch((err) => {
      console.error('[agent-live] 剧本没有刷新快照', err);
    });
  }

  function placeGuess(workspaceId: string, patch: GuessPatch): void {
    if (patch.purpose) store.setPurpose(workspaceId, patch.materialId, patch.purpose);
    store.setPlace(workspaceId, patch.materialId, { slotId: patch.slotId, mount: patch.mount, delivery: patch.delivery });
  }

  function guessFresh(workspaceId: string, before: Set<string>): void {
    if (!isWorkspaceId(workspaceId)) return;
    const state = viewPlaybook(playbookFile(bridgeRoot, workspaceId));
    if (!state.enabled) return;
    const fresh = store.list(workspaceId).filter((row) => !before.has(row.materialId));
    const reading = scenes.get(workspaceId)?.reading;
    const patches = planGuess(state, fresh, { materialId: reading?.materialId, absPath: reading?.absPath });
    if (!patches.length) return;
    for (const patch of patches) placeGuess(workspaceId, patch);
    touchPlaybook(workspaceId);
  }

  const methods: Record<string, (...args: any[]) => unknown> = {
    agentLiveList: (workspaceId: string) => store.list(String(workspaceId)),
    agentLiveAdd: (workspaceId: string, ref: MaterialRef, extra?: { purpose?: string; index?: number }) => {
      const id = String(workspaceId);
      const before = new Set(store.list(id).map((row) => row.materialId));
      const result = store.add(id, ref, extra);
      if (result === 'added') guessFresh(id, before);
      return result;
    },
    agentLiveAddMany: (workspaceId: string, refs: MaterialRef[]) => {
      const id = String(workspaceId);
      const before = new Set(store.list(id).map((row) => row.materialId));
      const list = Array.isArray(refs) ? refs : [];
      const result = list.map((ref) => store.add(id, ref));
      guessFresh(id, before);
      return result;
    },
    agentLiveRemove: (workspaceId: string, materialId: string) => {
      store.remove(String(workspaceId), String(materialId));
    },
    agentLiveReorder: (workspaceId: string, order: string[]) => {
      store.reorder(String(workspaceId), Array.isArray(order) ? order.map(String) : []);
    },
    agentLiveSetPurpose: (workspaceId: string, materialId: string, purpose: string | null) => {
      store.setPurpose(String(workspaceId), String(materialId), purpose == null ? null : String(purpose));
    },
    agentLivePin: (workspaceId: string, materialId: string) => {
      store.pin(String(workspaceId), String(materialId));
    },
    agentLiveUnpin: (workspaceId: string, materialId: string) => {
      store.unpin(String(workspaceId), String(materialId));
    },
    agentLiveClearSession: (workspaceId: string) => store.clearSession(String(workspaceId)),
    agentLiveRelocate: (workspaceId: string, materialId: string, ref: MaterialRef) => {
      store.relocate(String(workspaceId), String(materialId), ref);
    },
    agentLiveEntryPath: async (which: string, workspaceId?: string) => {
      const id = String(workspaceId || svc.getCurrentWorkspaceId());
      if (which === 'workspace') return ensureWorkspaceEntry(id);
      return refreshCurrent(id);
    },
    agentLivePlaybookGet: (workspaceId: string) => viewPlaybook(playbookFile(bridgeRoot, String(workspaceId))),
    agentLivePlaybookSet: (workspaceId: string, patch: Parameters<typeof savedPlaybook>[1]) => {
      const id = String(workspaceId);
      const saved = savedPlaybook(playbookFile(bridgeRoot, id), patch ?? {}, presetCatalog);
      for (const materialId of idsLosingSlot(store.list(id), saved.removedSlotIds)) {
        store.setPlace(id, materialId, { slotId: null });
      }
      touchPlaybook(id);
      return saved.state;
    },
    agentLivePlaybookGuess: (workspaceId: string) => {
      const id = String(workspaceId);
      const state = viewPlaybook(playbookFile(bridgeRoot, id));
      const rows = store.list(id);
      if (!state.enabled) return { assigned: 0, unassigned: unassignedCount(state, rows) };
      const reading = scenes.get(id)?.reading;
      const patches = planGuess(state, rows, { materialId: reading?.materialId, absPath: reading?.absPath });
      for (const patch of patches) placeGuess(id, patch);
      if (patches.length) touchPlaybook(id);
      return { assigned: patches.length, unassigned: unassignedCount(state, store.list(id)) };
    },
    agentLiveMaterialPlace: (workspaceId: string, materialId: string, patch: { slotId?: string | null; mount?: string | null; delivery?: string | null; summary?: string | null }) => {
      const id = String(workspaceId);
      const changed = store.setPlace(id, String(materialId), {
        ...(patch && 'slotId' in patch ? { slotId: patch.slotId ?? null } : {}),
        ...(patch && 'mount' in patch ? { mount: patch.mount as 'always' | 'auto' | 'agent' | 'manual' | null } : {}),
        ...(patch && 'delivery' in patch ? { delivery: patch.delivery as 'full' | 'summary' | 'index' | 'path' | null } : {}),
        ...(patch && 'summary' in patch ? { summary: patch.summary ?? null } : {}),
      });
      if (changed) touchPlaybook(id);
    },
    agentLiveNoteScene: (scene: { workspaceId?: string; panels?: LivePanel[]; reading?: LiveReading | null }) => {
      const workspaceId = String(scene?.workspaceId ?? '');
      if (!isWorkspaceId(workspaceId)) return;
      const reading = scene?.reading && isTokenPath(scene.reading.absPath ?? '') ? null : scene?.reading ?? null;
      const panels = Array.isArray(scene?.panels) ? scene.panels : undefined;
      const next: NotedScene = { panels, reading };
      const prev = scenes.get(workspaceId);
      scenes.set(workspaceId, next);
      if (sameNotedScene(prev, next)) return;
      const event: LiveEvent = {
        type: 'reading.changed',
        workspaceId,
        ...(reading?.panelId ? { panelId: reading.panelId } : {}),
        ...(reading?.materialId ? { materialId: reading.materialId } : {}),
        ...(reading && reading.resourceId !== undefined ? { resourceId: reading.resourceId } : {}),
        ...(reading?.absPath ? { absPath: reading.absPath } : {}),
      };
      void log.append(workspaceId, [event]).catch((err) => {
        console.error('[agent-live] revision log failed to record reading.changed', err);
      });
    },
    'agentMarks.rebirthRefresh': (root:string) => {
      const repo=new RebirthRepository(root);
      agentMarks.refreshRebirth(id=>{try {
        const doc=repo.read(id),file=repo.file(id),source=fs.readFileSync(file,'utf8');let cursor=source.indexOf('---',3)+3;
        const blocks=doc.blocks.map(b=>{const heading=rebirthFormat.serialize([b]).split('\n')[0];const h=source.indexOf(heading,cursor);const start=source.indexOf(b.body,h+heading.length);cursor=start+b.body.length;return {...b,start};});
        return {file,title:doc.meta.title,source,blocks};
      }catch{return null;}});republishMarks();
    },
    agentMarksList: () => agentMarks.list(),
    agentMarksAdd: (input: AttentionDraft) => {
      if (input?.rebirth) {
        const root = resolveAgentDataRoot()?.root ?? opts.agentDataDir;
        if (!root) throw new Error('无法创建 Agent 数据目录');
        const repo = new RebirthRepository(root);
        const doc = repo.read(input.rebirth.id);
        const block = doc.blocks.find(b => b.idx === input.rebirth!.blockIdx);
        if (!block) throw new Error('重生块不存在');
        const source = fs.readFileSync(repo.file(input.rebirth.id), 'utf8');
        // Locate this particular block, including duplicate bodies.
        let cursor = source.indexOf('---', 3) + 3;
        let at = -1;
        for (const b of doc.blocks) { const heading = rebirthFormat.serialize([b]).split('\n')[0]; const h = source.indexOf(heading, cursor); at = source.indexOf(b.body, h + heading.length); cursor = at + b.body.length; if (b.idx === block.idx) break; }
        const start = Number(input.startOffset), end = Number(input.endOffset);
        if (at < 0 || start < 0 || end > block.body.length || block.body.slice(start,end) !== input.text) throw new Error('标红选区无法对应到块原文');
        const placed = markFromSelection(source, repo.file(input.rebirth.id), at+start, at+end, '', '');
        if (!placed) throw new Error('标红选区不合法');
        const row = agentMarks.add({...placed, rebirth:{id:input.rebirth.id,no:doc.meta.no,title:doc.meta.title,blockIdx:block.idx}});
        republishMarks(); return row;
      }
      const absPath = typeof input?.absPath === 'string' ? input.absPath : '';
      const gate = eligibilityForPath(absPath, roundPaths());
      if (!gate.ok) throw new Error(gate.reason || MARK_INELIGIBLE_REASON);
      const row = agentMarks.add(input);
      republishMarks();
      return row;
    },
    agentMarksUnmark: (input: { absPath?: string; start?: number; end?: number }) => {
      const rows = agentMarks.unmark(String(input?.absPath ?? ''), Number(input?.start), Number(input?.end));
      republishMarks();
      return rows;
    },
    agentMarksClear: () => {
      agentMarks.clearAll();
      republishMarks();
    },
    agentMarksRetention: () => agentMarks.retention(),
    agentMarksSetRetention: (mode: string) => {
      if (mode !== 'round' && mode !== 'manual') throw new Error('未知的标红保留方式');
      return agentMarks.setRetention(mode);
    },
    agentMarksEligible: (absPath: string) => eligibilityForPath(String(absPath ?? ''), roundPaths()),
  };

  try {
    const current = svc.getCurrentWorkspaceId();
    if (current) void refreshCurrent(current).catch((err) => console.error('[agent-live] 启动入口失败', err));
  } catch (err) {
    console.error('[agent-live] 启动时没有当前工作区', err);
  }

  return {
    methods,
    activate: (workspaceId) => refreshCurrent(String(workspaceId)).then(() => undefined),
    assertBoundPlan(planId: string) {
      const binding = peekPlanBinding(planId);
      if (!binding) return;
      const checked = runBoundPlan(binding, {
        activeWorkspaceId: (() => {
          try { return svc.getCurrentWorkspaceId(); } catch { return undefined; }
        })(),
        readFile: (absPath) => {
          try { return fs.readFileSync(absPath); } catch { return null; }
        },
      }, () => true);
      if (checked === true || !checked || typeof checked !== 'object') return;
      const message = checked.error?.message || '原文件内容已变化，请重新读取后再提交';
      try {
        const file = path.join(bridgeRoot, 'responses', `${binding.requestId}.json`);
        if (fs.existsSync(file)) {
          const prev = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
          prev.status = 'conflict';
          prev.suggestedAction = 're-read';
          prev.error = checked.error;
          prev.updatedAt = new Date().toISOString();
          fs.writeFileSync(file, `${JSON.stringify(prev, null, 2)}\n`, 'utf8');
        }
      } catch (err) {
        console.error('[agent-live] 冲突响应没有写上', err);
      }
      throw new Error(message);
    },
    async close() {
      liveClosed = true;
      stopLibraryRoots();
      svc.off('vfolders-change', onCatalogChange);
      clearInterval(contentRepositoryTimer);
      stopEvents();
      for (const stop of stopExecutors) stop();
      await log.close();
      await store.close();
      await entry.whenIdle();
    },
  };
}
