/**
 * 控制台打开。面板仍走 dockview 的 addPanel 和现有 panelManager.float，
 * 不另写一套布局，也不按 resourceId 合并「再开一份」。
 */
import type { WorkspaceItem } from '../../../shared/items';
import type { DirEntry, ResourceInfo, Root } from '../../../shared/types';
import { groupOpenPlan, isKnownOpenAs, resolveConsoleRef, type ConsoleIndex, type ConsoleIndexItem } from '../../../shared/consoleSchema';
import { VIEW_HOST_COMPONENT, makeFileItem } from '../../plugin-host/layoutModel';
import type { OpenGroupResult } from '../commands';
import { shouldReusePanel } from './reuse';

export interface ConsoleDock {
  readonly activePanel: { id: string } | undefined;
  readonly panels: ReadonlyArray<{ id: string }>;
  getPanel(id: string): { id: string; api: { setActive(): void } } | undefined;
  addPanel(panel: {
    id: string;
    component: string;
    title: string;
    params: { itemId: string };
    position?: { referencePanel: string; direction: 'left' | 'right' | 'above' | 'below' };
  }): void;
}

export interface ConsoleOpenHost {
  getDock(): ConsoleDock | null;
  items: { current: Record<string, WorkspaceItem> };
  /** 现有自由窗口。D 若另有浮窗 API，对齐点仍是这里。 */
  panelManager: { float(id: string): void };
  kb: {
    getResource(resourceId: string): Promise<ResourceInfo | null>;
    listRoots(): Promise<Root[]>;
    listDir(rootId: string, relPath: string): Promise<DirEntry[]>;
    consoleResolvePath(rootId: string, relPath: string): Promise<string>;
  };
  adapters: {
    get(id: string): { sourceKinds?: readonly string[] } | undefined;
    best(target: { sourceKind: 'file'; resource: ResourceInfo }): { id: string } | undefined;
  };
  expand(id: string): void;
  reveal?(relPath: string): void;
}

const SPLIT_DIRECTION: Record<string, 'left' | 'right' | 'above' | 'below'> = {
  'split-left': 'left',
  'split-right': 'right',
  'split-up': 'above',
  'split-down': 'below',
};

function clean(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

async function pool<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let cursor = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));
  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => lane()));
}

function scheduleReveal(reveal: (() => void) | undefined) {
  if (!reveal) return;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(reveal));
  else setTimeout(reveal, 0);
}

export function createConsoleOpener(host: ConsoleOpenHost) {
  async function revealResource(resourceId: string): Promise<void> {
    const resource = await host.kb.getResource(resourceId);
    if (!resource || !resource.exists) throw new Error(`找不到资源 ${resourceId}`);
    const root = (await host.kb.listRoots()).find((item) => item.id === resource.rootId);
    if (!root) throw new Error('找不到资料根');
    host.expand(root.resourceId);
    const parts = resource.relPath.split('/').filter(Boolean);
    const expandCount = resource.kind === 'dir' ? parts.length : Math.max(0, parts.length - 1);
    let parent = '';
    for (let i = 0; i < expandCount; i += 1) {
      const rel = parent ? `${parent}/${parts[i]}` : parts[i];
      const entries = await host.kb.listDir(root.id, parent);
      const dir = entries.find((entry) => entry.relPath === rel && entry.kind === 'dir');
      if (!dir) throw new Error(`侧栏里找不到 ${rel}`);
      host.expand(dir.resourceId);
      parent = rel;
    }
    scheduleReveal(() => host.reveal?.(resource.relPath));
  }

  function adapterFor(item: ConsoleIndexItem, resource: ResourceInfo): string {
    const requested = item.targetPanel?.adapterId;
    if (requested) {
      const found = host.adapters.get(requested);
      if (!found) throw new Error(`找不到适配器 ${requested}`);
      if (found.sourceKinds?.includes('web') && !found.sourceKinds.includes('file')) {
        throw new Error(`网页适配器 ${requested} 尚未接到控制台打开（A 未合入）。本条不打开`);
      }
      return requested;
    }
    return host.adapters.best({ sourceKind: 'file', resource })?.id ?? 'builtin.unsupported';
  }

  async function openItem(item: ConsoleIndexItem): Promise<void> {
    if (!isKnownOpenAs(item.openAs)) throw new Error(`未知打开方式 ${item.openAs}`);
    const resolved = await resolveConsoleRef(item.ref, async (rootId, relPath) => {
      try {
        return await host.kb.consoleResolvePath(rootId, relPath);
      } catch (error) {
        throw new Error(clean(error));
      }
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    const dock = host.getDock();
    const targetId = item.targetPanel?.itemId;
    if (targetId && dock?.getPanel(targetId)) {
      dock.getPanel(targetId)?.api.setActive();
      return;
    }
    if (item.openAs === 'reveal-only') {
      await revealResource(resolved.resourceId);
      return;
    }
    if (!dock) throw new Error('工作区还没准备好');
    const resource = await host.kb.getResource(resolved.resourceId);
    if (!resource || !resource.exists) throw new Error(`找不到资源 ${resolved.resourceId}`);
    if (resource.kind !== 'file') throw new Error(`「${resource.name}」是目录，不能开成面板`);
    const panels = dock.panels.map((panel) => {
      const opened = host.items.current[panel.id];
      return { itemId: panel.id, resourceId: opened?.sourceKind === 'file' ? opened.ref : undefined };
    });
    const reuse = shouldReusePanel({ openAs: item.openAs, resourceId: resolved.resourceId, panels });
    if (reuse.kind === 'focus') {
      dock.getPanel(reuse.itemId)?.api.setActive();
      return;
    }
    const file: WorkspaceItem = makeFileItem(resolved.resourceId, adapterFor(item, resource));
    host.items.current[file.itemId] = file;
    const direction = SPLIT_DIRECTION[item.openAs];
    const active = dock.activePanel;
    dock.addPanel({
      id: file.itemId,
      component: VIEW_HOST_COMPONENT,
      title: item.title || resource.name,
      params: { itemId: file.itemId },
      position: direction && active ? { referencePanel: active.id, direction } : undefined,
    });
    if (item.openAs === 'float') host.panelManager.float(file.itemId);
  }

  async function openGroup(index: ConsoleIndex): Promise<OpenGroupResult> {
    const plan = groupOpenPlan(index);
    const ok: string[] = [];
    const failed: OpenGroupResult['failed'] = plan.skipped.map((item) => ({ id: item.id, reason: item.reason }));
    const runOne = async (item: ConsoleIndexItem) => {
      try {
        await openItem(item);
        ok.push(item.id);
      } catch (error) {
        failed.push({ id: item.id, reason: clean(error) });
      }
    };
    if ((index.openGroup?.mode ?? 'sequential') === 'sequential') {
      for (const item of plan.run) await runOne(item);
    } else {
      await pool(plan.run, index.openGroup?.maxConcurrent ?? 8, runOne);
    }
    return { ok, failed };
  }

  return { openItem, openGroup };
}
