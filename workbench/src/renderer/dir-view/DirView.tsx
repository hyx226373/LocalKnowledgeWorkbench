import React, { forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import type { Favorite, Root, VfolderView, WorkspaceRef } from '../../shared/types';
import { AppCtx, PaneCtx } from './context';
import { LoadingLabel } from '../ui/LoadingLabel';
import { AddRoot, DirChildren, RootDirectoryBody, WorkspaceRefs } from './Sidebar';
import { ModuleHead } from '../drawer/ModuleHead';
import { rootHideKey, useHiddenRootIds } from '../tasks/RootTaskDock';
import { beginDrag, bindDrop, endDrag, type DragFrom, type KbDragPayload } from './dnd';
import { fileMenu, RowMenu, type MenuItem } from './RowMenu';
import { catalogHeadings, clampSplit, virtualRootTitle, type DirViewPane, type DirViewState, type DirViewTarget } from './model';
import { ChevronRightIcon, TreeGlyph } from '../ui/shellMarks';
import { adapters } from '../plugin-host/registry';
import { showNoReaderBadge } from './noReaderBadge';

export interface DirViewHandle {
  toggleDual: () => void;
  focus: (side: 'left' | 'right') => void;
  swap: () => void;
  newFolder: () => void;
  renameFolder: () => void;
  deleteFolder: () => void;
}

export interface DirViewProps {
  roots: Root[];
  favorites: Favorite[];
  reload: () => void;
  refs: WorkspaceRef[];
  openRids: Set<string>;
  onRemove: (r: WorkspaceRef) => void;
  onOpenAll: () => void;
  workspaceId: string;
  /** 根目录名单还没到时，侧栏和目录都显示加载中 */
  phase?: 'loading' | 'ready';
  dirView: DirViewState;
  setDirView: (fn: (d: DirViewState) => DirViewState) => void;
}

function targetOf(pane: DirViewPane): DirViewTarget {
  const catalogId = pane.catalogId ? { catalogId: pane.catalogId } : {};
  if (pane.kind === 'root') return { kind: 'root', rootId: pane.rootId, relPath: pane.relPath, ...catalogId };
  if (pane.kind === 'vfolder') return { kind: 'vfolder', folderId: pane.folderId, ...catalogId };
  return { kind: 'workspace-refs', workspaceId: pane.workspaceId, ...catalogId };
}

function selectedFolderId(pane: DirViewPane): string | null {
  const hit = (pane.selected ?? []).find((s) => s.startsWith('folder:'));
  return hit ? hit.slice('folder:'.length) : pane.kind === 'vfolder' ? pane.folderId : null;
}

export const DirViewHost = forwardRef<DirViewHandle, DirViewProps>(function DirViewHost(props, ref) {
  const { roots, favorites, reload, refs, openRids, onRemove, onOpenAll, workspaceId, dirView, setDirView, phase = 'ready' } = props;
  const ctx = useContext(AppCtx);
  const [active, setActive] = useState<'left' | 'right'>('left');
  const [liveSplit, setLiveSplit] = useState<number | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);

  const patchPane = useCallback(
    (side: 'left' | 'right', fn: (p: DirViewPane) => DirViewPane) => {
      setDirView((d) => ({ ...d, [side]: fn(d[side]) }));
    },
    [setDirView],
  );

  const askName = useCallback(async (title: string, value = '') => {
    const r = await dialogs.prompt({ title, fields: [{ name: 'name', label: '名称', value }], ok: '确定' });
    return r?.name?.trim() ?? null;
  }, []);

  const createIn = useCallback(
    async (side: 'left' | 'right') => {
      const pane = side === 'left' ? dirView.left : dirView.right;
      const parentId = pane.kind === 'vfolder' ? pane.folderId : null;
      const name = await askName('新建自建目录');
      if (!name) return;
      try {
        const folder = await kb.createVirtualFolder(parentId, name);
        if (pane.kind !== 'vfolder') {
          patchPane(side, (p) => ({ ...p, kind: 'vfolder', folderId: parentId, selected: [`folder:${folder.folderId}`] }) as DirViewPane);
        } else {
          patchPane(side, (p) => ({ ...p, selected: [`folder:${folder.folderId}`] }));
        }
        ctx.notify?.(`已新建自建目录「${folder.name}」`);
      } catch (e) {
        ctx.notify?.(String((e as Error).message ?? e));
      }
    },
    [askName, ctx, dirView.left, dirView.right, patchPane],
  );

  const renameSelected = useCallback(
    async (side: 'left' | 'right') => {
      const pane = side === 'left' ? dirView.left : dirView.right;
      const folderId = selectedFolderId(pane);
      if (!folderId) {
        ctx.notify?.('先选中一个自建目录');
        return;
      }
      const cur = (await kb.listVirtualFolders()).find((f) => f.folderId === folderId);
      const name = await askName('重命名自建目录', cur?.name ?? '');
      if (!name) return;
      try {
        await kb.renameVirtualFolder(folderId, name);
      } catch (e) {
        ctx.notify?.(String((e as Error).message ?? e));
      }
    },
    [askName, ctx, dirView.left, dirView.right],
  );

  const deleteSelected = useCallback(
    async (side: 'left' | 'right') => {
      const pane = side === 'left' ? dirView.left : dirView.right;
      const folderId = selectedFolderId(pane);
      if (!folderId) {
        ctx.notify?.('先选中一个自建目录');
        return;
      }
      const ok = await dialogs.confirm({
        title: '删除这个自建目录？',
        body: '只删除归类。子目录会上移一层，里面的资料改挂到上一级。原文件不会被移动或删除，已打开的面板也不会关闭。',
        ok: '删除目录',
        danger: true,
      });
      if (!ok) return;
      try {
        const r = await kb.deleteVirtualFolder(folderId);
        patchPane(side, (p) => (p.kind === 'vfolder' && p.folderId === folderId ? { ...p, folderId: r.parentId, selected: [] } : { ...p, selected: (p.selected ?? []).filter((s) => s !== `folder:${folderId}`) }));
      } catch (e) {
        ctx.notify?.(String((e as Error).message ?? e));
      }
    },
    [ctx, dirView.left, dirView.right, patchPane],
  );

  useImperativeHandle(
    ref,
    () => ({
      toggleDual() {
        setDirView((d) => {
          if (d.dual) return { ...d, dual: false };
          let left = d.left;
          if (left.kind === 'root' && !left.rootId && roots[0]) left = { ...left, kind: 'root', rootId: roots[0].id, relPath: '' };
          const right = d.right?.kind ? d.right : { kind: 'vfolder' as const, folderId: null };
          return { ...d, dual: true, left, right, split: clampSplit(d.split) };
        });
      },
      focus(side) {
        setActive(side);
      },
      swap() {
        setDirView((d) => ({ ...d, left: d.right, right: d.left }));
      },
      newFolder() {
        void createIn(active);
      },
      renameFolder() {
        void renameSelected(active);
      },
      deleteFolder() {
        void deleteSelected(active);
      },
    }),
    [active, createIn, deleteSelected, renameSelected, roots, setDirView],
  );

  const onSashDown = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = hostRef.current?.getBoundingClientRect();
    if (!box) return;
    const axis = dirView.axis;
    const ratioOf = (ev: MouseEvent) => {
      const raw = axis === 'column' ? (ev.clientY - box.top) / Math.max(1, box.height) : (ev.clientX - box.left) / Math.max(1, box.width);
      return clampSplit(raw);
    };
    const move = (ev: MouseEvent) => setLiveSplit(ratioOf(ev));
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      const split = ratioOf(ev);
      setLiveSplit(null);
      setDirView((d) => ({ ...d, split }));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (phase === 'loading') {
    return <LoadingLabel testId="sidebar-loading" />;
  }

  if (!dirView.dual) return null;

  const split = liveSplit ?? dirView.split;
  return (
    <>
      <div className="dirview" data-testid="dirview" data-axis={dirView.axis} ref={hostRef}>
        <Pane
          side="left"
          pane={dirView.left}
          active={active === 'left'}
          flex={split}
          roots={roots}
          favorites={favorites}
          reload={reload}
          refs={refs}
          openRids={openRids}
          onRemove={onRemove}
          onOpenAll={onOpenAll}
          workspaceId={workspaceId}
          onActivate={() => setActive('left')}
          patch={(fn) => patchPane('left', fn)}
          onNew={() => void createIn('left')}
          onRename={() => void renameSelected('left')}
          onDelete={() => void deleteSelected('left')}
        />
        <div className="dirview-sash" data-testid="dirview-sash" data-dragging={liveSplit != null ? 'true' : undefined} onMouseDown={onSashDown} />
        <Pane
          side="right"
          pane={dirView.right}
          active={active === 'right'}
          flex={1 - split}
          roots={roots}
          favorites={favorites}
          reload={reload}
          refs={refs}
          openRids={openRids}
          onRemove={onRemove}
          onOpenAll={onOpenAll}
          workspaceId={workspaceId}
          onActivate={() => setActive('right')}
          patch={(fn) => patchPane('right', fn)}
          onNew={() => void createIn('right')}
          onRename={() => void renameSelected('right')}
          onDelete={() => void deleteSelected('right')}
        />
      </div>
      <div className="dirview-tools">
        <button type="button" className="kb-button kb-button--ghost" data-testid="dirview-single" onClick={() => setDirView((d) => ({ ...d, dual: false }))}>
          单栏
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="dirview-axis" onClick={() => setDirView((d) => ({ ...d, axis: d.axis === 'row' ? 'column' : 'row' }))}>
          {dirView.axis === 'row' ? '上下' : '左右'}
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="dirview-swap" onClick={() => setDirView((d) => ({ ...d, left: d.right, right: d.left }))}>
          对调
        </button>
      </div>
    </>
  );
});

function Pane(props: {
  side: 'left' | 'right';
  pane: DirViewPane;
  active: boolean;
  flex: number;
  roots: Root[];
  favorites: Favorite[];
  reload: () => void;
  refs: WorkspaceRef[];
  openRids: Set<string>;
  onRemove: (r: WorkspaceRef) => void;
  onOpenAll: () => void;
  workspaceId: string;
  onActivate: () => void;
  patch: (fn: (p: DirViewPane) => DirViewPane) => void;
  onNew: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const ctx = useContext(AppCtx);
  const hiddenRoots = useHiddenRootIds();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [undoOn, setUndoOn] = useState(false);
  const target = targetOf(props.pane);
  const dropTarget: DragFrom = props.pane.kind === 'root' && !props.pane.rootId ? { kind: 'roots-list' } : target.kind === 'root' ? { kind: 'root', rootId: target.rootId, relPath: target.relPath } : target.kind === 'vfolder' ? { kind: 'vfolder', folderId: target.folderId } : { kind: 'workspace-refs', workspaceId: target.workspaceId };

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = props.pane.scrollTop ?? 0;
    // 只在切换目标时恢复滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.pane.kind, props.pane.kind === 'root' ? props.pane.rootId + props.pane.relPath : props.pane.kind === 'vfolder' ? props.pane.folderId : props.pane.workspaceId]);

  useEffect(() => {
    let alive = true;
    kb.vfolderUndoAvailable().then((v) => alive && setUndoOn(v)).catch(() => alive && setUndoOn(false));
    return () => {
      alive = false;
    };
  }, [ctx.vfolderVersion, props.pane]);

  const onScroll = () => {
    const top = bodyRef.current?.scrollTop ?? 0;
    props.patch((p) => ({ ...p, scrollTop: top }));
  };

  const setTarget = (next: DirViewPane) => props.patch(() => ({ ...props.pane, ...next, expanded: props.pane.expanded, scrollTop: 0, selected: [] }));

  const scope = {
    side: props.side,
    expanded: new Set(props.pane.expanded ?? []),
    setExpanded: (id: string, on: boolean) => {
      props.patch((p) => {
        const s = new Set(p.expanded ?? []);
        if (on) s.add(id);
        else s.delete(id);
        return { ...p, expanded: [...s] };
      });
    },
    selected: new Set(props.pane.selected ?? []),
    select: (id: string) => props.patch((p) => ({ ...p, selected: [id] })),
  };

  const classify = async () => {
    const selected = (props.pane.selected ?? []).filter((s) => s.startsWith('res:')).map((s) => s.slice(4));
    let ids = selected;
    try {
      if (!ids.length && props.pane.kind === 'workspace-refs') ids = props.refs.filter((r) => r.resourceId).map((r) => r.resourceId);
      else if (!ids.length && props.pane.kind === 'vfolder' && props.pane.folderId) {
        const view = await kb.listVfolderView(props.pane.folderId);
        ids = view.entries.map((e) => e.resourceId);
      } else if (!ids.length) {
        const id = props.workspaceId;
        ids = id ? (await kb.listWorkspaceRefs(id)).map((r) => r.resourceId) : [];
      }
      if (!ids.length) {
        ctx.notify?.('没有可归类的资料');
        return;
      }
      const r = await kb.classifyByType(ids);
      ctx.notify?.(r.added ? `已按类型归入自建目录（${r.added} 条）` : '这些资料已经在对应的自建目录里');
    } catch (e) {
      ctx.notify?.(String((e as Error).message ?? e));
    }
  };

  const undo = async () => {
    try {
      const r = await kb.undoVfolderClassify();
      ctx.notify?.(r.restored ? `已撤销本次归类（${r.removedFolders} 个空目录已删除）` : '没有可撤销的归类');
    } catch (e) {
      ctx.notify?.(String((e as Error).message ?? e));
    }
  };

  return (
    <section
      className="dirview-pane"
      data-testid="dirview-pane"
      data-pane={props.side}
      data-kind={props.pane.kind}
      data-catalog-id={props.pane.catalogId || undefined}
      data-active={props.active ? 'true' : 'false'}
      style={{ flex: `${props.flex} 1 0` }}
      onMouseDown={props.onActivate}
    >
      <div className="dirview-bar">
        <select
          className="kb-select"
          data-testid="dirview-location"
          value={locationValue(props.pane)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'roots') setTarget({ kind: 'root', rootId: '', relPath: '' });
            else if (v.startsWith('root:')) setTarget({ kind: 'root', rootId: v.slice(5), relPath: '' });
            else if (v === 'vfolder') setTarget({ kind: 'vfolder', folderId: null });
            else if (v === 'refs') setTarget({ kind: 'workspace-refs', workspaceId: props.workspaceId });
          }}
        >
          <option value="roots">根目录</option>
          {props.roots.filter((r) => !hiddenRoots.has(rootHideKey(r)) || (props.pane.kind === 'root' && r.id === props.pane.rootId)).map((r) => (
            <option key={r.id} value={`root:${r.id}`}>
              {r.name}
            </option>
          ))}
          <option value="vfolder">全局自建目录</option>
          <option value="refs">本工作资料</option>
        </select>
      </div>
      <div className="dirview-bar">
        <button type="button" className="kb-button kb-button--ghost" data-testid="vfolder-new" title="在当前自建目录下新建" onClick={props.onNew}>
          新建
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="vfolder-rename" onClick={props.onRename}>
          重命名
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="vfolder-delete" onClick={props.onDelete}>
          删除
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="vfolder-classify" onClick={() => void classify()}>
          按类型整理到自建目录
        </button>
        <button type="button" className="kb-button kb-button--ghost" data-testid="vfolder-undo" disabled={!undoOn} onClick={() => void undo()}>
          撤销本次归类
        </button>
      </div>
      <PaneCrumbs pane={props.pane} roots={props.roots} onJump={(next) => setTarget(next)} />
      <PaneCtx.Provider value={scope}>
        <div
          className="dirview-body"
          ref={bodyRef}
          data-drag-over={over ? 'true' : undefined}
          onScroll={onScroll}
          {...bindDrop(dropTarget, setOver)}
        >
          {props.pane.kind === 'root' && !props.pane.rootId && (
            <RootsBody roots={props.roots} favorites={props.favorites} reload={props.reload} />
          )}
          {props.pane.kind === 'root' && !!props.pane.rootId && (
            <DirChildren rootId={props.pane.rootId} relPath={props.pane.relPath} depth={0} ns={`${props.side}:`} />
          )}
          {props.pane.kind === 'vfolder' && (
            <VfolderBody
              folderId={props.pane.folderId}
              onOpen={(id) => props.patch((p) => ({ ...p, kind: 'vfolder', folderId: id, selected: [] }))}
              onSelectFolder={(id) => props.patch((p) => ({ ...p, selected: [`folder:${id}`] }))}
              onSelectRes={(id) => props.patch((p) => ({ ...p, selected: [`res:${id}`] }))}
            />
          )}
          {props.pane.kind === 'workspace-refs' && (
            <RefsBody
              workspaceId={props.pane.workspaceId || props.workspaceId}
              currentId={props.workspaceId}
              refs={props.refs}
              openRids={props.openRids}
              onRemove={props.onRemove}
              onOpenAll={props.onOpenAll}
              onSelect={(id) => props.patch((p) => ({ ...p, selected: [`res:${id}`] }))}
            />
          )}
        </div>
      </PaneCtx.Provider>
    </section>
  );
}

function locationValue(pane: DirViewPane): string {
  if (pane.kind === 'vfolder') return 'vfolder';
  if (pane.kind === 'workspace-refs') return 'refs';
  if (!pane.rootId) return 'roots';
  return `root:${pane.rootId}`;
}

function PaneCrumbs({ pane, roots, onJump }: { pane: DirViewPane; roots: Root[]; onJump: (p: DirViewPane) => void }) {
  const ctx = useContext(AppCtx);
  const [view, setView] = useState<VfolderView | null>(null);
  const [headings, setHeadings] = useState<ReturnType<typeof catalogHeadings>>([]);
  useEffect(() => {
    if (pane.kind !== 'vfolder') return;
    let alive = true;
    kb.listVfolderView(pane.folderId).then((v) => alive && setView(v)).catch(() => alive && setView(null));
    kb.getLayout('library.catalogs').then((raw) => alive && setHeadings(catalogHeadings(raw))).catch(() => alive && setHeadings([]));
    return () => {
      alive = false;
    };
  }, [pane, ctx.vfolderVersion, ctx.fsVersion]);
  if (pane.kind === 'workspace-refs') {
    return (
      <div className="dirview-crumb" data-testid="dirview-crumb">
        本工作资料
      </div>
    );
  }
  if (pane.kind === 'vfolder') {
    const fallback = view?.crumbs[0]?.name ?? '自建目录';
    const rootTitle = virtualRootTitle(pane.catalogId, headings, fallback);
    const crumbs = (view?.crumbs ?? [{ folderId: null, name: rootTitle }]).map((c, i) => (i === 0 && c.folderId == null ? { ...c, name: rootTitle } : c));
    return (
      <div className="dirview-crumb" data-testid="dirview-crumb">
        {crumbs.map((c, i) => (
          <button key={`${c.folderId ?? 'root'}-${i}`} type="button" className="kb-button kb-button--ghost" onClick={() => onJump({ kind: 'vfolder', folderId: c.folderId, ...(pane.catalogId ? { catalogId: pane.catalogId } : {}) })}>
            {c.name}
          </button>
        ))}
      </div>
    );
  }
  const root = roots.find((r) => r.id === pane.rootId);
  const parts = (pane.relPath || '').split('/').filter(Boolean);
  return (
    <div className="dirview-crumb" data-testid="dirview-crumb">
      <button type="button" className="kb-button kb-button--ghost" onClick={() => onJump({ kind: 'root', rootId: '', relPath: '' })}>
        根目录
      </button>
      {root && (
        <button type="button" className="kb-button kb-button--ghost" onClick={() => onJump({ kind: 'root', rootId: root.id, relPath: '' })}>
          {root.name}
        </button>
      )}
      {parts.map((part, i) => {
        const rel = parts.slice(0, i + 1).join('/');
        return (
          <button key={rel} type="button" className="kb-button kb-button--ghost" onClick={() => onJump({ kind: 'root', rootId: pane.rootId, relPath: rel })}>
            {part}
          </button>
        );
      })}
    </div>
  );
}

function RootsBody({ roots, reload }: { roots: Root[]; favorites?: Favorite[]; reload: () => void }) {
  const [addOpen, setAddOpen] = useState(false);
  return (
    <section className="kb-section kb-module">
      <ModuleHead
        title="根目录"
        addOpen={addOpen}
        onAddToggle={() => setAddOpen((v) => !v)}
        addMenu={<AddRoot reload={reload} roots={roots} />}
      />
      <RootDirectoryBody roots={roots} reload={reload} />
    </section>
  );
}

function VfolderBody({
  folderId,
  onOpen,
  onSelectFolder,
  onSelectRes,
}: {
  folderId: string | null;
  onOpen: (id: string) => void;
  onSelectFolder: (id: string) => void;
  onSelectRes: (id: string) => void;
}) {
  const ctx = useContext(AppCtx);
  const [view, setView] = useState<VfolderView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    let alive = true;
    kb.listVfolderView(folderId).then(
      (v) => {
        if (!alive) return;
        setView(v);
        setErr(null);
      },
      (e) => alive && setErr(String((e as Error).message ?? e)),
    );
    return () => {
      alive = false;
    };
  }, [folderId, ctx.vfolderVersion, ctx.fsVersion]);
  if (err) return <div className="kb-error">{err}</div>;
  if (!view) return null;
  const empty = view.folders.length === 0 && view.entries.length === 0;
  return (
    <>
      {empty && <div className="kb-tree-row empty">这个自建目录是空的。新建子目录，或用「按类型整理到自建目录」把资料归进来。原文件留在原地。</div>}
      <div className="kb-tree-children">
        {view.folders.map((f) => (
          <VfolderNodeRow key={f.folderId} folderId={f.folderId} name={f.name} parentId={folderId} siblings={view.folders} onOpen={() => onOpen(f.folderId)} onSelect={() => onSelectFolder(f.folderId)} onMenu={(x, y, items) => setMenu({ x, y, items })} />
        ))}
        {view.entries.map((e) => (
          <VfolderFileRow key={e.resourceId} entry={e} folderId={folderId} onSelect={() => onSelectRes(e.resourceId)} onMenu={(x, y, items) => setMenu({ x, y, items })} />
        ))}
      </div>
      {menu && <RowMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </>
  );
}

function VfolderNodeRow({
  folderId,
  name,
  parentId,
  siblings,
  onOpen,
  onSelect,
  onMenu,
}: {
  folderId: string;
  name: string;
  parentId: string | null;
  siblings: { folderId: string; sort: number }[];
  onOpen: () => void;
  onSelect: () => void;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}) {
  const ctx = useContext(AppCtx);
  const [over, setOver] = useState(false);
  const payload: KbDragPayload = { v: 1, items: [{ resourceId: '', sourceKind: 'file', from: { kind: 'vfolder', folderId }, entry: 'vfolder-node' }] };
  const move = async (dir: -1 | 1) => {
    const ordered = siblings.slice().sort((a, b) => a.sort - b.sort);
    const i = ordered.findIndex((s) => s.folderId === folderId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const next = ordered.slice();
    const [row] = next.splice(i, 1);
    next.splice(j, 0, row);
    for (let n = 0; n < next.length; n++) await kb.moveVirtualFolder(next[n].folderId, parentId, n);
  };
  return (
    <div
      className="kb-tree-row vfolder-row"
      data-testid="vfolder-row"
      data-kind="vfolder-node"
      data-entry="vfolder-node"
      data-folder-id={folderId}
      data-no-abspath="true"
      title="虚拟目录（无磁盘路径）"
      data-drag-over={over ? 'true' : undefined}
      tabIndex={0}
      draggable
      onDragStart={(e) => beginDrag(e, payload)}
      onDragEnd={() => endDrag()}
      {...bindDrop({ kind: 'vfolder', folderId }, setOver)}
      onClick={() => {
        onSelect();
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        onMenu(e.clientX, e.clientY, [
          { id: 'vfolder.rename', label: '重命名', run: () => void (async () => {
            const r = await dialogs.prompt({ title: '重命名自建目录', fields: [{ name: 'name', label: '名称', value: name }], ok: '确定' });
            if (r?.name) await kb.renameVirtualFolder(folderId, r.name.trim()).catch((err) => ctx.notify?.(String(err?.message ?? err)));
          })() },
          { id: 'vfolder.delete', label: '删除', run: () => void kb.deleteVirtualFolder(folderId).catch((err) => ctx.notify?.(String((err as Error).message ?? err))) },
          { id: 'vfolder.up', label: '上移', run: () => void move(-1) },
          { id: 'vfolder.down', label: '下移', run: () => void move(1) },
        ]);
      }}
    >
      <span className="kb-chev" aria-hidden="true"><ChevronRightIcon /></span>
      <TreeGlyph kind="dir" />
      <span className="name">{name}</span>
    </div>
  );
}

function NoReaderBadge({ entry }: { entry: VfolderView['entries'][number] }) {
  useSyncExternalStore(
    (cb) => adapters.subscribe(cb),
    () => adapters.getVersion(),
    () => adapters.getVersion(),
  );
  if (!showNoReaderBadge(entry)) return null;
  return (
    <span className="p" data-testid="no-reader-badge">
      暂无阅读器
    </span>
  );
}

function VfolderFileRow({
  entry,
  folderId,
  onSelect,
  onMenu,
}: {
  entry: VfolderView['entries'][number];
  folderId: string | null;
  onSelect: () => void;
  onMenu: (x: number, y: number, items: MenuItem[]) => void;
}) {
  const ctx = useContext(AppCtx);
  const [over, setOver] = useState(false);
  const payload: KbDragPayload = {
    v: 1,
    items: [{
      resourceId: entry.resourceId,
      sourceKind: entry.sourceKind,
      from: { kind: 'vfolder', folderId },
      entry: entry.kind === 'dir' ? 'dir-entry' : 'file',
      ...(entry.rootId ? { rootId: entry.rootId, relPath: entry.relPath, name: entry.name } : { name: entry.name }),
    }],
  };
  const open = () => {
    onSelect();
    if (entry.missing) return;
    if (entry.sourceKind === 'web') {
      void Promise.resolve(ctx.openWeb?.('web.generic', entry.url)).catch(() => ctx.notify?.('暂无阅读器'));
      return;
    }
    ctx.open(entry.resourceId, entry.name);
  };
  return (
    <div
      className="kb-tree-row vfolder-row"
      data-testid="vfolder-row"
      data-kind="file"
      data-entry="file"
      data-resource-id={entry.resourceId}
      data-reader={entry.reader}
      data-missing={entry.missing ? 'true' : undefined}
      aria-disabled={entry.missing ? 'true' : undefined}
      aria-selected={ctx.activeResourceId === entry.resourceId ? 'true' : undefined}
      title={entry.missing ? '原文件已不在原处。归属保留，不会自动清理。' : entry.absPath ? `${entry.rootName ? `${entry.rootName}/${entry.relPath}` : entry.name} → ${entry.absPath}` : entry.rootName ? `${entry.rootName}/${entry.relPath}` : entry.name}
      tabIndex={0}
      draggable
      data-drag-over={over ? 'true' : undefined}
      onDragStart={(ev) => beginDrag(ev, payload)}
      onDragEnd={() => endDrag()}
      {...bindDrop({ kind: 'vfolder', folderId }, setOver)}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open()}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect();
        onMenu(
          e.clientX,
          e.clientY,
          fileMenu({
            ctx,
            resourceId: entry.resourceId,
            title: entry.name,
            payload,
            absPath: entry.absPath || undefined,
            missing: entry.missing,
            folderId,
            inFolder: true,
            inWorkspace: ctx.refIds.has(entry.resourceId),
            workspaceId: ctx.workspaceId,
          }),
        );
      }}
    >
      <span className="kb-chev" aria-hidden="true" />
      <TreeGlyph kind={entry.sourceKind === 'web' ? 'web' : entry.kind === 'dir' ? 'dir' : 'file'} ext={entry.ext} />
      <span className="name">{entry.name}</span>
      <NoReaderBadge entry={entry} />
      {entry.missing && (
        <span className="act act--text" data-testid="vfolder-repair" title="失效的引用不会自动清理" onClick={(e) => { e.stopPropagation(); void kb.openMigration('repair'); }}>
          修复…
        </span>
      )}
    </div>
  );
}

function RefsBody(props: {
  workspaceId: string;
  currentId: string;
  refs: WorkspaceRef[];
  openRids: Set<string>;
  onRemove: (r: WorkspaceRef) => void;
  onOpenAll: () => void;
  onSelect: (id: string) => void;
}) {
  const ctx = useContext(AppCtx);
  const [foreign, setForeign] = useState<WorkspaceRef[] | null>(null);
  const own = props.workspaceId === props.currentId;
  useEffect(() => {
    if (own) return;
    let alive = true;
    kb.listWorkspaceRefs(props.workspaceId).then((r) => alive && setForeign(r)).catch(() => alive && setForeign([]));
    return () => {
      alive = false;
    };
  }, [own, props.workspaceId, ctx.fsVersion, ctx.vfolderVersion]);
  const shown = own ? props.refs : foreign ?? [];
  const remove = (r: WorkspaceRef) => {
    props.onSelect(r.resourceId);
    if (own) props.onRemove(r);
    else void kb.removeWorkspaceRef(props.workspaceId, r.resourceId);
  };
  return (
    <div onClick={(e) => {
      const row = (e.target as HTMLElement).closest('[data-testid="ws-ref-row"]') as HTMLElement | null;
      if (row?.dataset.resourceId) props.onSelect(row.dataset.resourceId);
    }}>
      <WorkspaceRefs refs={shown} openRids={props.openRids} onRemove={remove} onOpenAll={props.onOpenAll} workspaceId={props.workspaceId} />
    </div>
  );
}
