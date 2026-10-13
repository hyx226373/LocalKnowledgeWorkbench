import fs from 'node:fs';
import path from 'node:path';
import { resolveBridgeRoot } from '../agent-bridge/paths';
import type { RootWatchers } from '../service/watcher';
import { AGENT_PINNED_LAYOUT_PREFIX, type WorkbenchService } from '../service/WorkbenchService';
import { registerInvokeExecutor } from '../../shared/actions/registry';
import { AGENT_LIVE_ACTIONS, type LiveEvent, type LivePanel, type LiveReading, type MaterialRef } from '../../shared/agentLive/types';
import { createLiveEntryWriter, type LiveEntryController } from './entry';
import { createAgentMaterialsStore, onMaterialsChange, type AgentMaterialsApi } from './materials';
import { isWorkspaceId } from './materials/errors';
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
export function startAgentLive(opts: {
  svc: WorkbenchService;
  watchers: RootWatchers;
  dataDir: string;
  version: string;
  notify: (workspaceId: string) => void;
}): AgentLiveWire {
  const { svc, watchers, notify } = opts;
  const bridgeRoot = resolveBridgeRoot(opts.dataDir);
  const scenes = new Map<string, NotedScene>();
  const resetBusy = new Set<string>();
  const pinnedPrefix = AGENT_PINNED_LAYOUT_PREFIX;

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
  const entry: LiveEntryController = createLiveEntryWriter({
    bridgeRoot,
    appVersion: opts.version,
    loadScene: (workspaceId) => {
      const noted = scenes.get(workspaceId);
      return {
        workspaceName: workspaceName(svc, workspaceId),
        materials: store.list(workspaceId),
        panels: noted?.panels,
        reading: noted?.reading ?? null,
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

  const stopEvents = onMaterialsChange(store, (event) => {
    const workspaceId = event.workspaceId;
    if (!workspaceId) return;
    notify(workspaceId);
    void log.append(workspaceId, [event as LiveEvent]).catch((err) => {
      console.error('[agent-live] 修订日志没有记下资料变化', err);
    });
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

  const methods: Record<string, (...args: any[]) => unknown> = {
    agentLiveList: (workspaceId: string) => store.list(String(workspaceId)),
    agentLiveAdd: (workspaceId: string, ref: MaterialRef, extra?: { purpose?: string; index?: number }) =>
      store.add(String(workspaceId), ref, extra),
    agentLiveAddMany: (workspaceId: string, refs: MaterialRef[]) => {
      const list = Array.isArray(refs) ? refs : [];
      return list.map((ref) => store.add(String(workspaceId), ref));
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
    agentLiveNoteScene: (scene: { workspaceId?: string; panels?: LivePanel[]; reading?: LiveReading | null }) => {
      const workspaceId = String(scene?.workspaceId ?? '');
      if (!isWorkspaceId(workspaceId)) return;
      const reading = scene?.reading && isTokenPath(scene.reading.absPath ?? '') ? null : scene?.reading ?? null;
      scenes.set(workspaceId, {
        panels: Array.isArray(scene?.panels) ? scene.panels : undefined,
        reading,
      });
    },
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
      stopEvents();
      for (const stop of stopExecutors) stop();
      await log.close();
      await store.close();
      await entry.whenIdle();
    },
  };
}
