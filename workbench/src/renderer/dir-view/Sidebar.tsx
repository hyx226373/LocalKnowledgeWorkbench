import { RootActionButton } from './RootActionButton';
import { useReadableFiles } from './readableFiles';
import { useSidebarPrefs } from '../drawer/sidebarPrefs';
import React, { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { LoadingLabel } from '../ui/LoadingLabel';
import { pluginHost } from '../plugin-host/host';
import { commands, panels } from '../plugin-host/registry';
import { dialogs } from '../ui/dialogs';
import { editorStatus } from '../editorStatus';
import type { DirEntry, Favorite, Root, WorkspaceRef } from '../../shared/types';
import type { RootOpKind } from '../../shared/rootTask';
import { dirRefreshKey } from '../../shared/fsScope';
import { AppCtx, PaneCtx, type Ctx } from './context';
import { NewFileDrawer } from './newFileDrawer';
import { dispatchTreeKey, hideConfirmSpec, runConfirmedAction, trashConfirmSpec } from './diskActions';
import { openHiddenItemsDialog } from './hiddenItems';
import { beginDrag, bindDrop, endDrag, getDragPayload, type KbDragPayload } from './dnd';
import { commitTreeFileDrag } from '../nativeDrag/commit';
import { nativeNodePath, nativeTreeDragPath } from '../nativeDrag/paths';
import { clearTreeMulti, prepareTreeDrag, subscribeTreeMulti, toggleTreeMulti, treeItemSelected } from '../nativeDrag/treeDrag';
import { RootOverflowMenu } from './RootOverflowMenu';
import { rootMoreMenuItems } from './rootMoreMenu';
import { fileMenu, RowMenu } from './RowMenu';
import { RootTaskDock, hideRoot, revealRoot, rootHideKey, rootIpcMessage, setRootOpError, useHiddenRootIds, useRootOpError } from '../tasks/RootTaskDock';
import { ModuleHead } from '../drawer/ModuleHead';
import { ChevronRightIcon, FileTextIcon, GripVerticalIcon, MinusIcon, OpenRightIcon, PlusIcon, StarIcon, TreeGlyph } from '../ui/shellMarks';
import { AgentAddIconButton } from '../agent-live/addIconButton';
import { useCommitDocTab } from '../dnd/docTabDrop';
import { handleDocTabDragOver, handleDocTabDrop, hasDocTabMime } from '../dnd/docTabDrag';
import { runDrop } from '../dnd/session';
import '../drawer/module.css';

const DETACH_TITLE = '从工作区移除（不删除文件）';

function nodePaths(rootId: string, relPath: string, kind: string): string[] {
  const abs = nativeTreeDragPath(rootId, relPath, kind);
  return abs ? [abs] : [];
}

function useTreeMulti(resourceId: string): boolean {
  return useSyncExternalStore(subscribeTreeMulti, () => treeItemSelected(resourceId), () => false);
}

/** 文件模式：dragstart 先 preventDefault，再立刻 startDrag。文件夹和多选走同一条通道。路径模式写 text/plain。 */
function dragTreeFile(e: Parameters<typeof beginDrag>[0], seed: KbDragPayload, paths: readonly string[]) {
  const prepared = prepareTreeDrag(getDragPayload(seed), paths);
  commitTreeFileDrag(e, prepared.payload, prepared.paths, () => {
    if (!e.dataTransfer) return;
    beginDrag(e, prepared.payload);
  });
}

function onTreePrimaryClick(event: React.MouseEvent, seed: KbDragPayload, activate: () => void) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    event.stopPropagation();
    toggleTreeMulti(getDragPayload(seed));
    return;
  }
  clearTreeMulti();
  activate();
}
const EMPTY_ENTRIES: DirEntry[] = [];
const opBusy = new Set<string>();

async function pathForConfirm(resourceId: string, fallback: string): Promise<string> {
  try {
    const abs = await kb.resourceAbsPath(resourceId);
    if (abs) return abs;
  } catch {
    /* 确认框仍用调用方给出的路径 */
  }
  return fallback;
}

async function hideTreeEntry(ctx: Ctx, rootId: string, relPath: string, resourceId: string, fallback: string): Promise<void> {
  const abs = await pathForConfirm(resourceId, fallback);
  try {
    const result = await runConfirmedAction((spec) => dialogs.confirm(spec), hideConfirmSpec(abs), () => kb.hideFromRoot(rootId, relPath));
    if (result === 'done') ctx.notify?.(`已从根目录移除，不删除磁盘文件：${abs}`);
  } catch (err) {
    ctx.notify?.(err instanceof Error ? err.message : String(err));
  }
}

async function trashTreeEntry(ctx: Ctx, rootId: string, relPath: string, resourceId: string, fallback: string): Promise<void> {
  const abs = await pathForConfirm(resourceId, fallback);
  try {
    const result = await runConfirmedAction((spec) => dialogs.confirm(spec), trashConfirmSpec(abs), () => kb.trashInsideRoot(rootId, relPath));
    if (result === 'done') ctx.notify?.(`已移到回收站：${abs}`);
  } catch (err) {
    ctx.notify?.(err instanceof Error ? err.message : String(err));
  }
}

function onTreeKeyDown(event: React.KeyboardEvent, relPath: string, open: () => void, hideFromRoot: () => void) {
  if (event.key === 'Delete' || event.key === 'Del') {
    event.preventDefault();
    event.stopPropagation();
  }
  dispatchTreeKey(event.key, relPath, { open, hideFromRoot });
}

async function runRootOp(root: Root, kind: RootOpKind, reload: () => void): Promise<void> {
  const hideKey = rootHideKey(root);
  if (opBusy.has(hideKey)) return;
  opBusy.add(hideKey);
  try {
    const name = root.name;
    const dirty = editorStatus.isDirty(root.resourceId);
    const ok = kind === 'detach'
      ? await dialogs.confirm({
          title: `从工作区移除「${name}」？`,
          body: '只解除这个工作区的登记。磁盘上的文件保留，不会被删除或移动。索引会在后台清理。',
          ok: '从工作区移除',
        })
      : await dialogs.confirm({
          ...trashConfirmSpec(root.path),
          body: `将把「${root.path}」移到回收站。其他工作区若也登记了这个路径，磁盘上的文件会一起移走，那些工作区里的条目会显示为缺失。`,
        });
    if (!ok) return;
    if (dirty) {
      const go = await dialogs.confirm({
        title: '有未保存的修改',
        body: `「${name}」有还没保存的修改。修改会保留为草稿（下次打开这个文件时恢复），但不会写入文件。`,
        ok: kind === 'detach' ? '从工作区移除' : '移到回收站',
        cancel: kind === 'detach' ? '先不移除' : '先不删除',
        danger: true,
      });
      if (!go) return;
    }
    // 确认之后、IPC await 之前先从列表拿掉。不等任务结束。
    hideRoot(hideKey);
    setRootOpError(null);
    try {
      if (kind === 'detach') await kb.detachRoot(root.id);
      else await kb.deleteRootFolder(root.id);
    } catch (e) {
      revealRoot(hideKey);
      setRootOpError(rootIpcMessage(e));
      return;
    }
    reload();
  } finally {
    opBusy.delete(hideKey);
  }
}

const ACCESS_SCOPE_NOTE = '范围外的文件不建索引、不显示、agent 不可见';

function parseExtensions(raw: string): string[] {
  return raw.split(/[,，\s]+/).map((s) => s.trim().replace(/^\./, '')).filter(Boolean);
}

function useRegistry<T>(reg: { subscribe(cb: () => void): () => void; getVersion(): number }, get: () => T): T {
  const v = useSyncExternalStore((cb) => reg.subscribe(cb), () => reg.getVersion());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(get, [v]);
}

// ---------------- tree ----------------

// ns：展开状态命名空间。收藏区与目录树中的同一资源各自独立展开
export const TreeRow = React.memo(function TreeRow({ entry, depth, ns = '' }: { entry: DirEntry; depth: number; ns?: string }) {
  const ctx = useContext(AppCtx);
  const pane = useContext(PaneCtx);
  const expanded = pane?.expanded ?? ctx.expanded;
  const setExpanded = pane?.setExpanded ?? ctx.setExpanded;
  const ekey = ns + entry.resourceId;
  const isOpen = expanded.has(ekey);
  const multi = useTreeMulti(entry.resourceId);
  const fav = ctx.favIds.has(entry.resourceId);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const activate = () => {
    pane?.select(entry.resourceId);
    if (entry.kind === 'dir') setExpanded(ekey, !isOpen);
    else ctx.open(entry.resourceId, entry.name);
  };
  const payload: KbDragPayload = {
    v: 1,
    items: [{
      resourceId: entry.resourceId,
      sourceKind: 'file',
      from: { kind: 'root', rootId: entry.rootId, relPath: entry.relPath },
      entry: entry.kind === 'dir' ? 'dir-entry' : 'file',
    }],
  };
  return (
    <>
      <div
        className={'kb-tree-row' + (entry.ignored ? ' ignored' : '')}
        data-testid="tree-row"
        data-ignored={entry.ignored ? '1' : undefined}
        data-relpath={entry.relPath}
        data-kind={entry.kind}
        data-entry={entry.kind === 'dir' ? 'dir-entry' : 'file'}
        data-resource-id={entry.resourceId}
        data-drag-over={over ? 'true' : undefined}
        data-multiselect={multi ? 'true' : undefined}
        tabIndex={0}
        draggable
        aria-selected={entry.kind === 'file' && ctx.activeResourceId === entry.resourceId ? 'true' : undefined}
        style={{ paddingLeft: `calc(var(--kb-space-3) + ${depth} * 16px)` }}
        onClick={(e) => onTreePrimaryClick(e, payload, activate)}
        onKeyDown={(e) => onTreeKeyDown(e, entry.relPath, activate, () => void hideTreeEntry(ctx, entry.rootId, entry.relPath, entry.resourceId, entry.relPath))}
        title={entry.relPath}
        onDragStart={(e) => dragTreeFile(e, payload, nodePaths(entry.rootId, entry.relPath, entry.kind))}
        onDragEnd={() => { setOver(false); endDrag(); }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        {...bindDrop({ kind: 'root', rootId: entry.rootId, relPath: entry.relPath }, setOver)}
      >
        <span className={"kb-chev" + (entry.kind === "dir" && isOpen ? " open" : "")} aria-hidden="true">{entry.kind === "dir" ? <ChevronRightIcon width={16} height={16} /> : null}</span>
        <TreeGlyph kind={entry.kind === 'dir' ? 'dir' : 'file'} open={entry.kind === 'dir' && isOpen} ext={entry.ext} />
        <span className="name">{entry.name}</span>
        {entry.kind === 'file' && (
          <span
            className={'act' + (ctx.refIds.has(entry.resourceId) ? ' on' : '')}
            data-testid="ref-toggle"
            title={ctx.refIds.has(entry.resourceId) ? '已在本工作的资料中（点击移除引用，不影响原文件）' : '加入本工作的资料（只记录引用，不移动、不复制原文件）'}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggleRef(entry.resourceId);
            }}
          >
            {ctx.refIds.has(entry.resourceId) ? <MinusIcon /> : <PlusIcon />}
          </span>
        )}
        {entry.kind === 'file' && (
          <span
            className="act"
            data-testid="open-right"
            title="在右侧分栏打开"
            onClick={(e) => {
              e.stopPropagation();
              ctx.open(entry.resourceId, entry.name, 'right');
            }}
          >
            <OpenRightIcon />
          </span>
        )}
        {(entry.kind === 'file' || entry.kind === 'dir') && (
          <AgentAddIconButton
            testId="agent-add-tree"
            kind={entry.kind === 'dir' ? 'dir' : 'file'}
            refs={[{ resourceId: entry.resourceId, absPath: '', name: entry.name, relPath: entry.relPath, sourceId: entry.rootId }]}
          />
        )}
        <span
          className={'act' + (fav ? ' on' : '')}
          data-testid="fav-toggle"
          title={fav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleFav(entry.resourceId);
          }}
        >
          <StarIcon filled={fav} />
        </span>
      </div>
      {entry.kind === 'dir' && isOpen && <DirChildren rootId={entry.rootId} relPath={entry.relPath} depth={depth + 1} ns={ns} />}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={fileMenu({
            ctx,
            resourceId: entry.resourceId,
            title: entry.name,
            payload,
            absPath: nativeNodePath(entry.rootId, entry.relPath, entry.kind) ?? undefined,
            inWorkspace: entry.kind === 'file' && ctx.refIds.has(entry.resourceId),
            workspaceId: ctx.workspaceId,
            onHideFromRoot: () => void hideTreeEntry(ctx, entry.rootId, entry.relPath, entry.resourceId, entry.relPath),
            onTrash: () => void trashTreeEntry(ctx, entry.rootId, entry.relPath, entry.resourceId, entry.relPath),
          })}
        />
      )}
    </>
  );
});

export const DirChildren = React.memo(function DirChildren({ rootId, relPath, depth, ns = '' }: { rootId: string; relPath: string; depth: number; ns?: string }) {
  const { fsVersion, fsEvents } = useContext(AppCtx);
  const refreshKey = dirRefreshKey(rootId, relPath, fsVersion, fsEvents ?? []);
  const [localKey, setLocalKey] = useState(refreshKey);
  const idle = refreshKey.endsWith('|0');
  if (refreshKey !== localKey && (!idle || !localKey.startsWith(`${rootId}|${relPath}|`))) setLocalKey(refreshKey);
  const [items, setItems] = useState<DirEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    kb.listDir(rootId, relPath).then(
      (r) => {
        setItems(r);
        setErr(null);
      },
      (e) => setErr(String(e?.message ?? e)),
    );
  }, [rootId, relPath, localKey]);
  const visibleItems = useReadableFiles(items ?? EMPTY_ENTRIES);
  if (err) return <div className="kb-error">无法读取：{err}</div>;
  if (!items) return <LoadingLabel testId="dir-loading" />;
  if (visibleItems.length === 0) return <div className="kb-tree-row empty" style={{ paddingLeft: `calc(var(--kb-space-3) + ${depth} * 16px + 16px)` }}>（空）</div>;
  return (
    <div className="kb-tree-children">
      {visibleItems.map((e) => (
        <TreeRow key={e.resourceId} entry={e} depth={depth} ns={ns} />
      ))}
    </div>
  );
});

export function RootNode({ root, reload }: { root: Root; reload: () => void }) {
  const ctx = useContext(AppCtx);
  const pane = useContext(PaneCtx);
  const expanded = pane?.expanded ?? ctx.expanded;
  const setExpanded = pane?.setExpanded ?? ctx.setExpanded;
  const isFileSource = root.kind === 'file';
  const isOpen = !isFileSource && expanded.has(root.resourceId);
  const multi = useTreeMulti(root.resourceId);
  const fav = ctx.favIds.has(root.resourceId);
  const [over, setOver] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterNote, setFilterNote] = useState('');
  const fileExt = isFileSource
    ? (root.name.includes('.') ? root.name.slice(root.name.lastIndexOf('.') + 1).toLowerCase() : '')
    : '';
  const [scopeOpen, setScopeOpen] = useState(false);
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(null);
  const activate = () => {
    // 单文件来源：按 resourceId 打开阅读器，绝不走目录展开 / listDir。
    if (isFileSource) {
      pane?.select(root.resourceId);
      if (root.status === 'ok' && root.resourceId) ctx.open(root.resourceId, root.name);
      return;
    }
    setExpanded(root.resourceId, !expanded.has(root.resourceId));
  };
  const payload: KbDragPayload = {
    v: 1,
    items: [{
      resourceId: root.resourceId,
      sourceKind: 'file',
      from: { kind: 'roots-list' },
      entry: isFileSource ? 'file' : 'dir-entry',
      rootId: root.id,
      name: root.name,
      relPath: '',
    }],
  };
  return (
    <>
      <div
        className="kb-tree-row root-row"
        data-testid="root-row"
        onContextMenu={(e) => {
          e.preventDefault();
          setRootMenu({ x: e.clientX, y: e.clientY });
        }}
        data-root-id={root.id}
        data-root-name={root.name}
        data-kind={isFileSource ? 'file' : 'folder'}
        data-entry={isFileSource ? 'file' : 'dir-entry'}
        data-resource-id={root.resourceId}
        data-drag-over={over ? 'true' : undefined}
        data-multiselect={multi ? 'true' : undefined}
        tabIndex={0}
        draggable
        aria-selected={isFileSource && ctx.activeResourceId === root.resourceId ? 'true' : undefined}
        onClick={(e) => onTreePrimaryClick(e, payload, activate)}
        onKeyDown={(e) => onTreeKeyDown(e, '', activate, () => undefined)}
        title={root.path || root.name}
        onDragStart={(e) => dragTreeFile(e, payload, root.path ? [root.path] : [])}
        onDragEnd={() => { setOver(false); endDrag(); }}
        {...(isFileSource ? {} : bindDrop({ kind: 'root', rootId: root.id, relPath: '' }, setOver))}
      >
        {isFileSource ? (
          <span className="kb-chev kb-chev-empty" aria-hidden="true" />
        ) : (
          <span className={"kb-chev" + (isOpen ? " open" : "")} aria-hidden="true"><ChevronRightIcon width={16} height={16} /></span>
        )}
        <TreeGlyph kind={isFileSource ? 'file' : 'root'} open={!isFileSource && isOpen} ext={fileExt} />
        <span className="name" title={root.name}>
          {root.name}
          {isFileSource && <span className="p kb-file-source-badge" data-testid="file-source-label">单文件来源</span>}
          {root.status === 'missing' && <span className="danger">（离线）</span>}
        </span>
        {isFileSource && root.status === 'ok' && (
          <span
            className={'act' + (ctx.refIds.has(root.resourceId) ? ' on' : '')}
            data-testid="ref-toggle"
            title={ctx.refIds.has(root.resourceId) ? '已在本工作的资料中（点击移除引用，不影响原文件）' : '加入本工作的资料（只记录引用，不移动、不复制原文件）'}
            onClick={(e) => {
              e.stopPropagation();
              ctx.toggleRef(root.resourceId);
            }}
          >
            {ctx.refIds.has(root.resourceId) ? <MinusIcon /> : <PlusIcon />}
          </span>
        )}
        {isFileSource && root.status === 'ok' && (
          <span
            className="act"
            data-testid="open-right"
            title="在右侧分栏打开"
            onClick={(e) => {
              e.stopPropagation();
              ctx.open(root.resourceId, root.name, 'right');
            }}
          >
            <OpenRightIcon />
          </span>
        )}
        {isFileSource && root.status === 'ok' && (
          <AgentAddIconButton
            testId="agent-add-root"
            refs={[{ resourceId: root.resourceId, absPath: '', name: root.name, relPath: '', sourceId: root.id }]}
          />
        )}
        {!isFileSource && root.status === 'ok' && (
          <AgentAddIconButton
            testId="agent-add-root-dir"
            kind="dir"
            refs={[{ resourceId: root.resourceId, absPath: '', name: root.name, relPath: '', sourceId: root.id }]}
          />
        )}
        <span
          className={'act' + (fav ? ' on' : '')}
          data-testid="fav-toggle"
          title={fav ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            ctx.toggleFav(root.resourceId);
          }}
        >
          <StarIcon filled={fav} />
        </span>
        <RootActionButton kind="detach" title={DETACH_TITLE} onActivate={() => void runRootOp(root, 'detach', reload)} />
        <RootOverflowMenu
          rootId={root.id}
          onRestoreAll={() => {
            void kb.restoreAllHidden(root.id).then(
              () => reload(),
              (err: unknown) => ctx.notify?.(err instanceof Error ? err.message : String(err)),
            );
          }}
          onError={(message) => ctx.notify?.(message)}
        />
      </div>
      {root.kind !== 'file' && (
        <button
          type="button"
          className="kb-linkish kb-scope-pill"
          data-testid="source-filter-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setScopeOpen((v) => !v);
          }}
        >
          范围
        </button>
      )}
      {root.kind !== 'file' && scopeOpen && (
        <div className="kb-add-menu" data-testid="source-filter-row" onClick={(e) => e.stopPropagation()}>
          <p>{ACCESS_SCOPE_NOTE}</p>
          <input
            className="kb-input"
            data-testid="source-filter-extensions"
            placeholder="访问范围，如 md, pdf"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className="kb-linkish"
            data-testid="source-filter-set"
            title={ACCESS_SCOPE_NOTE}
            onClick={async (e) => {
              e.stopPropagation();
              const extensions = parseExtensions(filterText);
              const result = await commands.get('source.filter.set')?.run({ sourceId: root.id, extensions });
              const status = result && typeof result === 'object' && 'status' in result ? String((result as { status: unknown }).status) : '';
              setFilterNote(status === 'awaiting_approval' ? '待批准' : '');
            }}
          >
            设置访问范围
          </button>
          {filterNote && <span data-testid="source-filter-pending">{filterNote}</span>}
        </div>
      )}
      {isOpen && root.status === 'ok' && root.kind !== 'file' && <DirChildren rootId={root.id} relPath="" depth={1} />}
      {rootMenu && (
        <RowMenu
          x={rootMenu.x}
          y={rootMenu.y}
          onClose={() => setRootMenu(null)}
          items={fileMenu({
            ctx,
            resourceId: root.resourceId,
            title: root.name,
            payload,
            absPath: root.path,
            workspaceId: ctx.workspaceId,
            onTrash: () => void runRootOp(root, 'delete-disk', reload),
          })}
        />
      )}
    </>
  );
}

// ---------------- sidebar ----------------

const BENCH_REORDER_MIME = 'application/x-kb-bench-reorder';

/** “本工作的资料”：跨根引用原文件的集合。添加/移除只改引用记录，不移动、不复制原文件 */
export function WorkspaceRefs({ refs, openRids, onRemove, onOpenAll, workspaceId = '' }: { refs: WorkspaceRef[]; openRids: Set<string>; onRemove: (r: WorkspaceRef) => void; onOpenAll: () => void; workspaceId?: string }) {
  const ctx = useContext(AppCtx);
  const [menu, setMenu] = useState<{ x: number; y: number; resource: WorkspaceRef } | null>(null);
  const [over, setOver] = useState(false);
  const [overRow, setOverRow] = useState<string | null>(null);
  const ws = workspaceId || ctx.workspaceId || '';
  const resourceDrop = bindDrop({ kind: 'workspace-refs', workspaceId: ws }, setOver);
  const commitTab = useCommitDocTab(ws);

  const onReorder = (draggedRid: string, beforeRid: string | null) => {
    if (!draggedRid || draggedRid === beforeRid) return;
    const currentIds = refs.map((x) => x.resourceId);
    const without = currentIds.filter((id) => id !== draggedRid);
    const targetIndex = beforeRid ? without.indexOf(beforeRid) : without.length;
    void runDrop(
      { kind: 'workbench-order', workspaceId: ws, ids: currentIds, index: targetIndex },
      {
        v: 1,
        items: [{
          resourceId: draggedRid,
          sourceKind: 'file',
          entry: 'file',
          from: { kind: 'workspace-refs', workspaceId: ws },
        }],
      },
    );
  };

  return (
    <section
      className="kb-section kb-module"
      data-testid="ws-refs"
      data-drag-over={over ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!hasDocTabMime(event.dataTransfer.types)) return;
        event.preventDefault();
      }}
      onDragOver={(event) => {
        if (handleDocTabDragOver(event)) {
          setOver(true);
          return;
        }
        resourceDrop.onDragOver(event);
      }}
      onDragLeave={(event) => {
        if (hasDocTabMime(event.dataTransfer.types)) {
          if (event.currentTarget.contains(event.relatedTarget as Node)) return;
          event.currentTarget.removeAttribute('data-drop-active');
          setOver(false);
          return;
        }
        resourceDrop.onDragLeave(event);
      }}
      onDrop={(event) => {
        const hit = handleDocTabDrop(event);
        if (hit.claimed) {
          setOver(false);
          if (hit.payload) void commitTab('bench', hit.payload);
          return;
        }
        resourceDrop.onDrop(event);
      }}
    >
      <ModuleHead
        title="工作台资料"
        testId="bench-module-h"
        acts={
          refs.length > 0 ? (
            <button type="button" className="kb-linkish" data-testid="ws-refs-open-all" title="在标签中打开全部资料（已打开的不重复打开）" onClick={onOpenAll}>
              全部打开
            </button>
          ) : null
        }
      />
      {refs.length === 0 ? (
        <p className="kb-module-empty">在目录树中把文件加入本工作</p>
      ) : (
        <div
          className="kb-quiet-list"
          role="listbox"
          aria-label="本工作的资料"
          onDragOver={(e) => {
            if ([...e.dataTransfer.types].includes(BENCH_REORDER_MIME)) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
            }
          }}
          onDrop={(e) => {
            const draggedRid = e.dataTransfer.getData(BENCH_REORDER_MIME);
            if (draggedRid) {
              e.preventDefault();
              e.stopPropagation();
              setOverRow(null);
              onReorder(draggedRid, null);
            }
          }}
        >
          {refs.map((r) => {
            const openRef = () => {
              if (!r.missing) ctx.open(r.resourceId, r.name);
            };
            const rowTitle = r.sourceKind === 'web' ? (r.url ?? '') : r.missing ? '原文件已不在原处（可能被删除、移出根或根已移除）。引用保留，可点“修复…”重新定位' : `${r.rootName}/${r.relPath}`;
            const sub = r.sourceKind === 'web' ? `网络 · ${(r.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}` : `${r.rootName}${r.relPath.includes('/') ? '/' + r.relPath.slice(0, r.relPath.lastIndexOf('/')) : ''}`;
            const dragSeed: KbDragPayload = { v: 1, items: [{ resourceId: r.resourceId, sourceKind: r.sourceKind === 'web' ? 'web' : 'file', from: { kind: 'workspace-refs', workspaceId: workspaceId || ctx.workspaceId || '' }, entry: r.kind === 'dir' ? 'dir-entry' : 'file', rootId: r.rootId, relPath: r.relPath, name: r.name }] };
            const outPaths = r.missing || r.sourceKind === 'web' ? [] : nodePaths(r.rootId, r.relPath, r.kind);
            return (
              <div
                key={r.resourceId}
                className="kb-ref-row"
                role="option"
                data-testid="ws-ref-row"
                data-resource-id={r.resourceId}
                data-relpath={r.relPath}
                data-root-id={r.rootId}
                data-open={openRids.has(r.resourceId) ? 'true' : undefined}
                aria-selected={ctx.activeResourceId === r.resourceId ? 'true' : 'false'}
                aria-disabled={r.missing ? 'true' : undefined}
                tabIndex={0}
                draggable
                data-missing={r.missing ? 'true' : undefined}
                data-source-kind={r.sourceKind === 'web' ? 'web' : undefined}
                data-drag-over={overRow === r.resourceId ? 'true' : undefined}
                title={rowTitle}
                onClick={(e) => {
                  const el = e.target instanceof Element ? e.target : null;
                  if (el?.closest('[data-testid="ws-ref-open"], [data-testid="ws-ref-remove"], [data-testid="ws-ref-repair"], [data-testid="ws-ref-reorder-grip"]')) return;
                  openRef();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
                  openRef();
                }}
                onDragStart={(e) => dragTreeFile(e, dragSeed, outPaths)}
                onDragEnd={() => endDrag()}
                onDragOver={(e) => {
                  if ([...e.dataTransfer.types].includes(BENCH_REORDER_MIME)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = 'move';
                    setOverRow(r.resourceId);
                  }
                }}
                onDragLeave={() => setOverRow((cur) => (cur === r.resourceId ? null : cur))}
                onDrop={(e) => {
                  const draggedRid = e.dataTransfer.getData(BENCH_REORDER_MIME);
                  if (draggedRid) {
                    e.preventDefault();
                    e.stopPropagation();
                    setOverRow(null);
                    onReorder(draggedRid, r.resourceId);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ x: e.clientX, y: e.clientY, resource: r });
                }}
              >
                <button
                  type="button"
                  className="al-grip kb-ref-grip"
                  draggable
                  title="拖动排序"
                  aria-label="拖动排序"
                  data-testid="ws-ref-reorder-grip"
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData(BENCH_REORDER_MIME, r.resourceId);
                  }}
                >
                  <GripVerticalIcon />
                </button>
                <button
                  type="button"
                  className="kb-ref-main"
                  tabIndex={-1}
                  draggable
                  title={rowTitle}
                  onDragStart={(e) => {
                    dragTreeFile(e, dragSeed, outPaths);
                    e.stopPropagation();
                  }}
                  onDragEnd={() => endDrag()}
                >
                  <TreeGlyph kind={r.sourceKind === 'web' ? 'web' : 'file'} ext={r.ext} />
                  <span className="kb-ref-name">{r.name || r.relPath || r.resourceId}</span>
                  <span className="kb-ref-sub">{sub}</span>
                </button>
                {r.missing && (
                  <span className="act act--text" data-testid="ws-ref-repair" title="失效的引用不会自动清理：打开“修复路径”重新定位原文件（或移除引用）" onClick={(e) => { e.stopPropagation(); void kb.openMigration('repair'); }}>
                    修复…
                  </span>
                )}
                <button type="button" className="kb-linkish" data-testid="ws-ref-open" title="打开" disabled={!!r.missing} onClick={() => openRef()}>打开</button>
                <button type="button" className="kb-linkish danger" data-testid="ws-ref-remove" title="从本工作的资料中移除（不删除、不移动原文件）" onClick={(e) => { e.stopPropagation(); onRemove(r); }}>移除引用</button>
              </div>
            );
          })}
        </div>
      )}
      {menu && (
        <RowMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={fileMenu({
            ctx,
            resourceId: menu.resource.resourceId,
            title: menu.resource.name,
            missing: menu.resource.missing,
            absPath: menu.resource.rootId ? (nativeNodePath(menu.resource.rootId, menu.resource.relPath ?? '', 'file') ?? undefined) : undefined,
            inWorkspace: true,
            workspaceId: workspaceId || ctx.workspaceId,
            payload: { v: 1, items: [{ resourceId: menu.resource.resourceId, sourceKind: menu.resource.sourceKind === 'web' ? 'web' : 'file', from: { kind: 'workspace-refs', workspaceId: workspaceId || ctx.workspaceId || '' }, entry: 'file', rootId: menu.resource.rootId, relPath: menu.resource.relPath, name: menu.resource.name }] },
          })}
        />
      )}
    </section>
  );
}

export function AddRoot({ reload, roots }: { reload: () => void; roots?: Root[] }) {
  const ctx = useContext(AppCtx);
  const pane = useContext(PaneCtx);
  const [input, setInput] = useState('');
  const [extensions, setExtensions] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [fileOpen, setFileOpen] = useState(false);
  const add = async (p: string | null) => {
    if (!p) return;
    try {
      setErr(null);
      const list = parseExtensions(extensions);
      const r = await kb.addRoot(p.trim(), undefined, list.length ? list : undefined);
      setInput('');
      ctx.setExpanded(r.resourceId, true);
      reload();
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method 'kb': (Error: )?/, ''));
    }
  };
  const addFile = async () => {
    try {
      setErr(null);
      const picked = await kb.pickFile();
      if (!picked) return;
      const r = await kb.addFileSource(picked);
      ctx.setExpanded(r.resourceId, true);
      reload();
    } catch (e) {
      setErr(String((e as Error).message).replace(/^Error invoking remote method 'kb': (Error: )?/, ''));
    }
  };
  return (
    <>
      <button type="button" className="kb-linkish kb-add-choice" data-testid="pick-folder" onClick={async () => add(await kb.pickFolder())}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6.2h3.6L7 4.6h7V13H2V6.2z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        选择文件夹注册为根…
      </button>
      <button type="button" className="kb-linkish kb-add-choice" data-testid="pick-file" onClick={() => void addFile()}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5h5.2L13 6.2V13.5H4V2.5zM9 2.8V6h3.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" /></svg>
        选择单个文件注册为来源…
      </button>
      <button
        type="button"
        className="kb-linkish kb-add-choice"
        data-testid="new-file"
        aria-expanded={fileOpen}
        aria-controls="new-file-drawer"
        onClick={() => setFileOpen((open) => !open)}
      >
        新建文件…
      </button>
      {fileOpen ? (
        <NewFileDrawer
          roots={roots}
          onCancel={() => setFileOpen(false)}
          onCreated={(created) => {
            setFileOpen(false);
            for (const id of created.expandIds) {
              if (!id) continue;
              ctx.setExpanded(id, true);
              pane?.setExpanded(id, true);
            }
            reload();
            ctx.open(created.resourceId, created.name);
          }}
        />
      ) : null}
      <p className="kb-scope-note" data-testid="access-scope-note">{ACCESS_SCOPE_NOTE}</p>
      <input
        className="kb-input"
        data-testid="root-extensions"
        placeholder="文件夹访问范围，如 md, pdf（可空）"
        value={extensions}
        onChange={(e) => setExtensions(e.target.value)}
      />
      <input
        className="kb-input"
        data-testid="root-path-input"
        placeholder="或输入文件夹路径，回车添加"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && add(input)}
      />
      {err && <div className="kb-error" data-testid="add-root-error">{err}</div>}
    </>
  );
}

/** 网络资料和插件改由资料抽屉的 slot 各挂一次。这里再画会变成两份列表。 */
const DRAWER_OWNED_PANELS = new Set(['web.resources', 'workbench.plugins']);

export function SidebarPlugins() {
  const sidePanels = useRegistry(panels, () => panels.all().filter((p) => p.location === 'sidebar' && !DRAWER_OWNED_PANELS.has(p.id)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)));
  return (
    <>
      {sidePanels.map((p) => {
        const P = p.component;
        return (
          <section className="kb-section" key={p.id} data-testid={`panel-${p.id}`}>
            <h3 className="kb-section-title">{p.title}</h3>
            <P api={pluginHost.apiFor(p.owner)} />
          </section>
        );
      })}
    </>
  );
}

export function FavoritesSection({ favorites }: { favorites: Favorite[] }) {
  const ctx = useContext(AppCtx);
  return (
    <section className="kb-section kb-module" data-testid="favorites">
      <ModuleHead title="收藏" testId="fav-module-h" />
      {favorites.length === 0 && <p className="kb-module-empty">点击收藏按钮收藏文件或文件夹</p>}
      <div className="kb-quiet-list">
        {favorites.map((f) =>
          f.kind === 'dir' && !f.missing ? (
            <TreeRow
              key={f.id}
              depth={0}
              ns="fav:"
              entry={{ resourceId: f.resourceId, rootId: f.rootId, relPath: f.relPath, name: f.label || f.name, kind: 'dir', size: 0, mtimeMs: 0, ext: '' }}
            />
          ) : (
            <div
              key={f.id}
              className="kb-quiet-item"
              data-testid="fav-row"
              data-relpath={f.relPath}
              tabIndex={0}
              aria-disabled={f.missing ? 'true' : undefined}
              aria-selected={ctx.activeResourceId === f.resourceId ? 'true' : undefined}
              title={f.missing ? '文件已不在原处（可能被删除或移出根）' : f.relPath}
              onClick={() => ctx.open(f.resourceId, f.name)}
              onKeyDown={(e) => onTreeKeyDown(
                e,
                f.relPath,
                () => ctx.open(f.resourceId, f.name),
                () => void hideTreeEntry(ctx, f.rootId, f.relPath, f.resourceId, f.relPath),
              )}
            >
              {f.kind === 'dir' ? (
                <TreeGlyph kind="dir" />
              ) : (
                <FileTextIcon className={'kb-file-ic icon-file icon-' + (f.name.includes('.') ? f.name.slice(f.name.lastIndexOf('.') + 1).toLowerCase() : 'file')} />
              )}
              <span className="kb-quiet-name">{f.label || f.name}</span>
              <button type="button" className="kb-linkish" title="取消收藏" onClick={(e) => { e.stopPropagation(); ctx.toggleFav(f.resourceId); }}>
                取消
              </button>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

export function RootsSection({ roots, reload }: { roots: Root[]; reload: () => void }) {
  const prefs = useSidebarPrefs();
  const ctx = useContext(AppCtx);
  const [addOpen, setAddOpen] = useState(false);
  return (
    <section className="kb-section kb-module grow" data-testid="roots-section">
      <ModuleHead
        title="根目录"
        testId="roots-module-h"
        addOpen={addOpen}
        onAddToggle={() => setAddOpen((v) => !v)}
        addMenu={<AddRoot reload={reload} roots={roots} />}
        moreItems={rootMoreMenuItems(prefs, ctx.showIgnored, ctx.setShowIgnored, () => {
          void openHiddenItemsDialog({
            load: () => kb.listHiddenItems(),
            restore: async (item) => {
              await kb.restoreHidden(item.rootId, item.relPath);
              reload();
            },
          }).catch((err: unknown) => ctx.notify?.(err instanceof Error ? err.message : String(err)));
        })}
      />
      <label className="kb-toggle" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} title="node_modules、.git、$RECYCLE.BIN 等默认不显示、不索引">
        <input type="checkbox" data-testid="toggle-show-ignored" checked={ctx.showIgnored} onChange={(e) => ctx.setShowIgnored(e.target.checked)} />
        显示被忽略的项
      </label>
      <RootDirectoryBody roots={roots} reload={reload} adding={addOpen} />
    </section>
  );
}

export function RootDirectoryBody({ roots, reload, adding = false }: { roots: Root[]; reload: () => void; adding?: boolean }) {
  const hidden = useHiddenRootIds();
  const opError = useRootOpError();
  const seenRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = new Set(roots.map((r) => rootHideKey(r)));
    const prev = seenRef.current;
    seenRef.current = ids;
    // 切工作区会卸掉侧栏。重新挂上时服务端列表已经是那个工作区的实例，列表里还有的就不要继续藏。
    // 同一次确认里的隐藏不走这里：侧栏还在，prev 已经含有这个实例。
    if (!prev) {
      for (const id of hidden) {
        if (ids.has(id)) revealRoot(id);
      }
      return;
    }
    for (const id of hidden) {
      if (!prev.has(id) && ids.has(id)) revealRoot(id);
    }
  }, [roots, hidden]);
  const readableRoots = useReadableFiles(roots);
  const shown = readableRoots.filter((r) => !hidden.has(rootHideKey(r)));
  return (
    <>
      <RootTaskDock
        onReveal={(id) => {
          revealRoot(id);
          reload();
        }}
      />
      {opError ? (
        <div className="kb-error" data-testid="root-op-error">
          {opError}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <div className="kb-module-empty" data-testid="roots-empty-cta">
          <p className="kb-empty-lead">还没有根目录。</p>
          <p className="kb-empty-sub">添加文件夹或单文件来源后即可使用目录树。</p>
          {adding ? null : <AddRoot reload={reload} roots={roots} />}
        </div>
      ) : (
        shown.map((r) => (
          <RootNode key={r.id} root={r} reload={reload} />
        ))
      )}
    </>
  );
}

export function Sidebar({ roots, favorites, reload, refsSlot }: { roots: Root[]; favorites: Favorite[]; reload: () => void; refsSlot?: React.ReactNode }) {
  return (
    <>
      {refsSlot}
      <FavoritesSection favorites={favorites} />
      <RootsSection roots={roots} reload={reload} />
    </>
  );
}
