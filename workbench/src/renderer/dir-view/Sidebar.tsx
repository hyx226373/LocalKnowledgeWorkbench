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
import { AppCtx, PaneCtx } from './context';
import { beginDrag, bindDrop, endDrag, type KbDragPayload } from './dnd';
import { fileMenu, RowMenu } from './RowMenu';
import { RootTaskDock, hideRoot, revealRoot, rootHideKey, rootIpcMessage, setRootOpError, useHiddenRootIds, useRootOpError } from '../tasks/RootTaskDock';
import { ModuleHead } from '../drawer/ModuleHead';
import { ChevronRightIcon, StarIcon } from '../ui/shellMarks';
import { AgentAddIconButton } from '../agent-live/addIconButton';
import '../drawer/module.css';

const DETACH_TITLE = '从工作区移除（不删除文件）';
const DELETE_TITLE = '删除磁盘上的文件夹';
const ROOT_ACT: React.CSSProperties = {
  visibility: 'visible',
  flex: 'none',
  background: 'transparent',
  border: 0,
  padding: '0 3px',
  margin: 0,
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  lineHeight: 'inherit',
};
const opBusy = new Set<string>();

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
          title: `删除磁盘上的文件夹「${name}」？`,
          body: `这会把「${root.path}」移入应用暂存区，可以从操作记录恢复。界面会马上去掉这一条。其他工作区若也登记了这个文件夹，磁盘上的文件会一起消失，那些工作区里的条目会显示为缺失。`,
          ok: '删除文件夹',
          danger: true,
        });
    if (!ok) return;
    if (dirty) {
      const go = await dialogs.confirm({
        title: '有未保存的修改',
        body: `「${name}」有还没保存的修改。修改会保留为草稿（下次打开这个文件时恢复），但不会写入文件。`,
        ok: kind === 'detach' ? '从工作区移除' : '删除文件夹',
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
export function TreeRow({ entry, depth, ns = '' }: { entry: DirEntry; depth: number; ns?: string }) {
  const ctx = useContext(AppCtx);
  const pane = useContext(PaneCtx);
  const expanded = pane?.expanded ?? ctx.expanded;
  const setExpanded = pane?.setExpanded ?? ctx.setExpanded;
  const ekey = ns + entry.resourceId;
  const isOpen = expanded.has(ekey);
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
        tabIndex={0}
        draggable
        aria-selected={entry.kind === 'file' && ctx.activeResourceId === entry.resourceId ? 'true' : undefined}
        style={{ paddingLeft: `calc(var(--kb-space-3) + ${depth} * 14px)` }}
        onClick={activate}
        onKeyDown={(e) => e.key === 'Enter' && activate()}
        title={entry.relPath}
        onDragStart={(e) => beginDrag(e, payload)}
        onDragEnd={() => { setOver(false); endDrag(); }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        {...bindDrop({ kind: 'root', rootId: entry.rootId, relPath: entry.relPath }, setOver)}
      >
        <span className={"kb-chev" + (entry.kind === "dir" && isOpen ? " open" : "")} aria-hidden="true">{entry.kind === "dir" ? <ChevronRightIcon width={14} height={14} /> : null}</span>
        <span className={'icon ' + (entry.kind === 'dir' ? 'icon-dir' : 'icon-file icon-' + entry.ext)} />
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
            {ctx.refIds.has(entry.resourceId) ? '⊖' : '⊕'}
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
            ⇥
          </span>
        )}
        {entry.kind === 'file' && (
          <AgentAddIconButton
            testId="agent-add-tree"
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
            inWorkspace: entry.kind === 'file' && ctx.refIds.has(entry.resourceId),
            workspaceId: ctx.workspaceId,
          })}
        />
      )}
    </>
  );
}

export function DirChildren({ rootId, relPath, depth, ns = '' }: { rootId: string; relPath: string; depth: number; ns?: string }) {
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
  if (err) return <div className="kb-error">无法读取：{err}</div>;
  if (!items) return <LoadingLabel testId="dir-loading" />;
  if (items.length === 0) return <div className="kb-tree-row empty" style={{ paddingLeft: `calc(var(--kb-space-3) + ${depth} * 14px + 16px)` }}>（空）</div>;
  return (
    <>
      {items.map((e) => (
        <TreeRow key={e.resourceId} entry={e} depth={depth} ns={ns} />
      ))}
    </>
  );
}

export function RootNode({ root, reload }: { root: Root; reload: () => void }) {
  const ctx = useContext(AppCtx);
  const pane = useContext(PaneCtx);
  const expanded = pane?.expanded ?? ctx.expanded;
  const setExpanded = pane?.setExpanded ?? ctx.setExpanded;
  const isFileSource = root.kind === 'file';
  const isOpen = !isFileSource && expanded.has(root.resourceId);
  const fav = ctx.favIds.has(root.resourceId);
  const [over, setOver] = useState(false);
  const [filterText, setFilterText] = useState('');
  const [filterNote, setFilterNote] = useState('');
  const fileExt = isFileSource
    ? (root.name.includes('.') ? root.name.slice(root.name.lastIndexOf('.') + 1).toLowerCase() : '')
    : '';
  const [scopeOpen, setScopeOpen] = useState(false);
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
        data-root-id={root.id}
        data-root-name={root.name}
        data-kind={isFileSource ? 'file' : 'folder'}
        data-entry={isFileSource ? 'file' : 'dir-entry'}
        data-resource-id={root.resourceId}
        data-drag-over={over ? 'true' : undefined}
        tabIndex={0}
        draggable
        aria-selected={isFileSource && ctx.activeResourceId === root.resourceId ? 'true' : undefined}
        onClick={activate}
        onKeyDown={(e) => e.key === 'Enter' && activate()}
        title={root.path || root.name}
        onDragStart={(e) => beginDrag(e, payload)}
        onDragEnd={() => { setOver(false); endDrag(); }}
        {...(isFileSource ? {} : bindDrop({ kind: 'root', rootId: root.id, relPath: '' }, setOver))}
      >
        {isFileSource ? (
          <span className="kb-chev kb-chev-empty" aria-hidden="true" />
        ) : (
          <span className={"kb-chev" + (isOpen ? " open" : "")} aria-hidden="true"><ChevronRightIcon width={14} height={14} /></span>
        )}
        <span className={'icon ' + (isFileSource ? 'icon-file' + (fileExt ? ' icon-' + fileExt : '') : 'icon-root')} />
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
            {ctx.refIds.has(root.resourceId) ? '⊖' : '⊕'}
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
            ⇥
          </span>
        )}
        {isFileSource && root.status === 'ok' && (
          <AgentAddIconButton
            testId="agent-add-root"
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
        <button
          type="button"
          className="kb-linkish"
          style={ROOT_ACT}
          data-testid="root-detach"
          title={DETACH_TITLE}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void runRootOp(root, 'detach', reload);
          }}
        >
          移除
        </button>
        <button
          type="button"
          className="kb-linkish danger"
          style={ROOT_ACT}
          data-testid="root-delete-disk"
          title={isFileSource ? '删除磁盘上的文件' : DELETE_TITLE}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            void runRootOp(root, 'delete-disk', reload);
          }}
        >
          删除
        </button>
      </div>
      {root.kind !== 'file' && (
        <button
          type="button"
          className="kb-linkish"
          data-testid="source-filter-toggle"
          style={{ marginLeft: 28 }}
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
    </>
  );
}

// ---------------- sidebar ----------------

/** “本工作的资料”：跨根引用原文件的集合。添加/移除只改引用记录，不移动、不复制原文件 */
export function WorkspaceRefs({ refs, openRids, onRemove, onOpenAll, workspaceId = '' }: { refs: WorkspaceRef[]; openRids: Set<string>; onRemove: (r: WorkspaceRef) => void; onOpenAll: () => void; workspaceId?: string }) {
  const ctx = useContext(AppCtx);
  const [menu, setMenu] = useState<{ x: number; y: number; resource: WorkspaceRef } | null>(null);
  const [over, setOver] = useState(false);
  const ws = workspaceId || ctx.workspaceId || '';
  return (
    <section className="kb-section kb-module" data-testid="ws-refs" data-drag-over={over ? 'true' : undefined} {...bindDrop({ kind: 'workspace-refs', workspaceId: ws }, setOver)}>
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
        <div className="kb-collection" role="listbox" aria-label="本工作的资料">
          {refs.map((r) => (
            <div
              key={r.resourceId}
              className="kb-collection-row"
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
              title={r.sourceKind === 'web' ? (r.url ?? '') : r.missing ? '原文件已不在原处（可能被删除、移出根或根已移除）。引用保留，可点“修复…”重新定位' : `${r.rootName}/${r.relPath}`}
              onClick={() => !r.missing && ctx.open(r.resourceId, r.name)}
              onKeyDown={(e) => e.key === 'Enter' && !r.missing && ctx.open(r.resourceId, r.name)}
              onDragStart={(e) => beginDrag(e, { v: 1, items: [{ resourceId: r.resourceId, sourceKind: r.sourceKind === 'web' ? 'web' : 'file', from: { kind: 'workspace-refs', workspaceId: workspaceId || ctx.workspaceId || '' }, entry: 'file', rootId: r.rootId, relPath: r.relPath, name: r.name }] })}
              onDragEnd={() => endDrag()}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, resource: r });
              }}
            >
              <span className={r.sourceKind === 'web' ? 'icon icon-file icon-web' : 'icon icon-file icon-' + r.ext} />
              <span className="name">{r.name || r.relPath || r.resourceId}</span>
              <span className="p">{r.sourceKind === 'web' ? `网络 · ${(r.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}` : `${r.rootName}${r.relPath.includes('/') ? '/' + r.relPath.slice(0, r.relPath.lastIndexOf('/')) : ''}`}</span>
              {r.missing && (
                <span className="act act--text" data-testid="ws-ref-repair" title="失效的引用不会自动清理：打开“修复路径”重新定位原文件（或移除引用）" onClick={(e) => { e.stopPropagation(); void kb.openMigration('repair'); }}>
                  修复…
                </span>
              )}
              <button type="button" className="kb-linkish danger" data-testid="ws-ref-remove" title="从本工作的资料中移除（不删除、不移动原文件）" onClick={(e) => { e.stopPropagation(); onRemove(r); }}>移除引用</button>
            </div>
          ))}
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
            inWorkspace: true,
            workspaceId: workspaceId || ctx.workspaceId,
            payload: { v: 1, items: [{ resourceId: menu.resource.resourceId, sourceKind: menu.resource.sourceKind === 'web' ? 'web' : 'file', from: { kind: 'workspace-refs', workspaceId: workspaceId || ctx.workspaceId || '' }, entry: 'file', rootId: menu.resource.rootId, relPath: menu.resource.relPath, name: menu.resource.name }] },
          })}
        />
      )}
    </section>
  );
}

export function AddRoot({ reload }: { reload: () => void }) {
  const ctx = useContext(AppCtx);
  const [input, setInput] = useState('');
  const [extensions, setExtensions] = useState('');
  const [err, setErr] = useState<string | null>(null);
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
      <button type="button" className="kb-linkish" data-testid="pick-folder" onClick={async () => add(await kb.pickFolder())}>
        选择文件夹注册为根…
      </button>
      <button type="button" className="kb-linkish" data-testid="pick-file" onClick={() => void addFile()}>
        选择单个文件注册为来源…
      </button>
      <p data-testid="access-scope-note">{ACCESS_SCOPE_NOTE}</p>
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
              onKeyDown={(e) => e.key === 'Enter' && ctx.open(f.resourceId, f.name)}
            >
              <StarIcon filled />
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
  const ctx = useContext(AppCtx);
  const [addOpen, setAddOpen] = useState(false);
  return (
    <section className="kb-section kb-module grow" data-testid="roots-section">
      <ModuleHead
        title="根目录"
        testId="roots-module-h"
        addOpen={addOpen}
        onAddToggle={() => setAddOpen((v) => !v)}
        addMenu={<AddRoot reload={reload} />}
        moreItems={[
          {
            id: 'show-ignored',
            label: ctx.showIgnored ? '隐藏被忽略的项' : '显示被忽略的项',
            testId: 'toggle-show-ignored-menu',
            onClick: () => ctx.setShowIgnored(!ctx.showIgnored),
          },
        ]}
      />
      <label className="kb-toggle" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }} title="node_modules、.git、$RECYCLE.BIN 等默认不显示、不索引">
        <input type="checkbox" data-testid="toggle-show-ignored" checked={ctx.showIgnored} onChange={(e) => ctx.setShowIgnored(e.target.checked)} />
        显示被忽略的项
      </label>
      <RootDirectoryBody roots={roots} reload={reload} />
    </section>
  );
}

export function RootDirectoryBody({ roots, reload }: { roots: Root[]; reload: () => void }) {
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
  const shown = roots.filter((r) => !hidden.has(rootHideKey(r)));
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
      {shown.map((r) => (
        <RootNode key={r.id} root={r} reload={reload} />
      ))}
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
