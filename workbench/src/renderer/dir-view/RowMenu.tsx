import React, { useEffect } from 'react';
import { kb } from '../kb';
import { openSetKeybindingFor, SET_KEYBINDING_LABEL } from '../keybindings/contextMenu';
import { addRefsMaybeDir, getAgentLiveBinding } from '../agent-live/actions';
import { agentLiveMenuItems, refsForAddGesture } from '../agent-live/menu';
import { dirViewActions, getDragPayload, type DragFrom, type KbDragItem, type KbDragPayload } from './dnd';
import type { Ctx } from './context';
import { appendRootDiskItems } from './diskActions';
import { nativeNodePath, toWindowsPath } from '../nativeDrag/paths';

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
  run: () => void | Promise<void>;
}

export async function copyToClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* fallback to execCommand */
  }
  if (typeof document !== 'undefined') {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
    } finally {
      document.body.removeChild(textarea);
    }
  }
}

export function resolveItemPathSync(item: {
  resourceId?: string;
  rootId?: string;
  relPath?: string;
  entry?: string;
  absPath?: string;
  from?: DragFrom;
}): string | null {
  if (item.absPath) return toWindowsPath(item.absPath);
  const rootId = item.rootId ?? (item.from?.kind === 'root' ? item.from.rootId : undefined);
  const rel = typeof item.relPath === 'string' ? item.relPath : item.from?.kind === 'root' ? item.from.relPath : '';
  if (rootId) {
    const node = nativeNodePath(rootId, rel, item.entry);
    if (node) return toWindowsPath(node);
  }
  if (item.relPath && (/^[a-zA-Z]:[\\/]/.test(item.relPath) || item.relPath.startsWith('\\\\'))) {
    return toWindowsPath(item.relPath);
  }
  return null;
}

export async function resolveItemPath(item: {
  resourceId?: string;
  rootId?: string;
  relPath?: string;
  entry?: string;
  absPath?: string;
  from?: DragFrom;
}): Promise<string | null> {
  const sync = resolveItemPathSync(item);
  if (sync) return sync;
  if (item.resourceId && typeof kb !== 'undefined' && typeof kb.resourceAbsPath === 'function') {
    try {
      const p = await kb.resourceAbsPath(item.resourceId);
      if (p) return toWindowsPath(p);
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function RowMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDown = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [onClose]);
  return (
    <div className="kb-popover" data-testid="dirview-menu" role="menu" style={{ position: 'fixed', left: x, top: y, zIndex: 4000, minWidth: 200, padding: '4px 0' }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it) => (
        it.separator ? (
          <div key={it.id} className="menu-sep" role="separator" data-testid="menu-sep" />
        ) : (
          <div
            key={it.id}
            className={'kb-menu-item' + (it.danger ? ' danger' : '')}
            role="menuitem"
            data-command={it.id}
            aria-disabled={it.disabled ? 'true' : undefined}
            onClick={() => {
              if (it.disabled) return;
              void it.run();
              onClose();
            }}
          >
            <span className="name">{it.label}</span>
          </div>
        )
      ))}
    </div>
  );
}

/** 文件 / 目录条目的右键。两种移除的文案必须不同，行为默认也不同。 */
export function fileMenu(o: {
  ctx: Ctx;
  resourceId: string;
  title: string;
  payload: KbDragPayload;
  absPath?: string;
  missing?: boolean;
  /** 给出时表示这条是自建目录里的文件，菜单含「从该目录移除」 */
  folderId?: string | null;
  inFolder?: boolean;
  inWorkspace?: boolean;
  workspaceId?: string;
  onHideFromRoot?: () => void;
  onTrash?: () => void;
}): MenuItem[] {
  const items: MenuItem[] = [];
  const drag = o.payload.items[0];
  const report = (work: Promise<unknown>) => {
    void work.catch((err: unknown) => o.ctx.notify?.(err instanceof Error ? err.message : String(err)));
  };
  const isFolder = drag?.entry === 'dir-entry' || drag?.entry === 'vfolder-node';
  const binding = getAgentLiveBinding();
  const liveSelected = binding?.host?.selection?.() ?? [];
  const hasMultiLiveSelection =
    liveSelected.length > 1 && liveSelected.some((ref) => ref.resourceId === o.resourceId);

  let targetItems: readonly KbDragItem[] = o.payload.items;
  if (targetItems.length <= 1) {
    const custom = getDragPayload(o.payload);
    if (custom.items.length > 1) {
      targetItems = custom.items;
    }
  }
  if (targetItems.length <= 1 && hasMultiLiveSelection) {
    targetItems = liveSelected.map((ref) => ({
      resourceId: ref.resourceId ?? '',
      sourceKind: 'file' as const,
      from: { kind: 'root' as const, rootId: ref.sourceId ?? '', relPath: ref.relPath ?? '' },
      entry: isFolder ? ('dir-entry' as const) : ('file' as const),
      absPath: ref.absPath,
      rootId: ref.sourceId ?? undefined,
      relPath: ref.relPath,
      name: ref.name,
    }));
  }

  if (!o.missing && drag?.entry !== 'dir-entry' && drag?.entry !== 'vfolder-node') {
    items.push({
      id: 'file.openCopy',
      label: '在新面板中再打开一份',
      run: () => o.ctx.openCopy?.(o.resourceId, o.title),
    });
  }
  if (!o.missing && drag?.entry === 'file' && drag.sourceKind !== 'web') {
    items.push({
      id: 'file.openDefault',
      label: '用默认程序打开',
      run: () => report(kb.openWithDefaultApp(o.resourceId)),
    });
    items.push({
      id: 'file.showInFolder',
      label: '在资源管理器中显示',
      run: () => report(kb.showInFolder(o.resourceId)),
    });
  }
  if (drag && drag.sourceKind !== 'web' && drag.entry !== 'vfolder-node') {
    const copyLabel = isFolder ? '复制文件夹路径' : '复制文件路径';
    const copyId = isFolder ? 'dir.copyPath' : 'file.copyPath';
    items.push({
      id: copyId,
      label: copyLabel,
      run: () => {
        return (async () => {
          try {
            const paths: string[] = [];
            for (const item of targetItems) {
              const p =
                item === drag && o.absPath
                  ? toWindowsPath(o.absPath)
                  : await resolveItemPath(item);
              if (p) paths.push(p);
            }
            if (!paths.length && o.absPath) {
              paths.push(toWindowsPath(o.absPath));
            }
            if (!paths.length && o.resourceId && typeof kb !== 'undefined' && typeof kb.resourceAbsPath === 'function') {
              try {
                const p = await kb.resourceAbsPath(o.resourceId);
                if (p) paths.push(toWindowsPath(p));
              } catch {
                /* ignore */
              }
            }
            const unique = Array.from(new Set(paths.filter(Boolean)));
            if (unique.length > 0) {
              await copyToClipboard(unique.join('\n'));
            }
          } catch (err) {
            report(Promise.reject(err));
          }
        })();
      },
    });
  }
  if (o.inFolder) {
    items.push({
      id: 'refs.removeFromFolder',
      label: '从该目录移除',
      run: () => {
        const folderId = o.folderId ?? null;
        if (dirViewActions.removeFromFolder) {
          dirViewActions.removeFromFolder(o.resourceId, folderId);
          return;
        }
        void kb.removeVfolderMembership(o.resourceId, folderId);
      },
    });
  }
  if (o.inWorkspace && o.workspaceId) {
    items.push({
      id: 'refs.removeFromWorkspace',
      label: '从本工作区移除',
      run: () => {
        if (dirViewActions.removeFromWorkspace) {
          dirViewActions.removeFromWorkspace(o.resourceId, o.workspaceId!);
          return;
        }
        o.ctx.removeWorkspaceRef?.(o.resourceId);
      },
    });
  }
  items.push({
    id: 'tree.moveTo',
    label: '移动到…',
    disabled: !dirViewActions.moveTo,
    run: () => dirViewActions.moveTo?.(o.payload),
  });
  items.push({
    id: 'refs.addToFolder',
    label: '加入自建目录…',
    disabled: !dirViewActions.addToFolder,
    run: () => dirViewActions.addToFolder?.(o.payload),
  });
  // r11-B：资料行右键菜单增加「设置快捷键…」。
  items.push({
    id: 'keybindings.forContext',
    label: SET_KEYBINDING_LABEL,
    run: () => openSetKeybindingFor(drag?.from.kind === 'workspace-refs' ? 'workspace-ref' : 'tree-row', {
      isFile: drag?.entry === 'file',
      isWeb: drag?.sourceKind === 'web',
    }),
  });
  if (binding && drag && drag.sourceKind !== 'web') {
    const entry = drag.entry;
    const asDir = entry === 'dir-entry' || entry === 'vfolder-node';
    const asFile = entry === 'file';
    if (asFile || asDir) {
      const rootId = drag.rootId ?? (drag.from.kind === 'root' ? drag.from.rootId : undefined);
      const relPath =
        typeof drag.relPath === 'string'
          ? drag.relPath
          : drag.from.kind === 'root'
            ? drag.from.relPath
            : undefined;
      const clicked = {
        resourceId: o.resourceId,
        absPath: '',
        name: o.title,
        ...(relPath !== undefined ? { relPath } : {}),
        ...(rootId ? { sourceId: rootId } : {}),
      };
      const selected = binding.host.selection();
      const refs = refsForAddGesture(clicked, selected.length ? selected : [clicked]);
      items.push(
        ...agentLiveMenuItems(refs, (list) => {
          void addRefsMaybeDir(binding, list, { asDir });
        }),
      );
    }
  }
  const from = drag?.from;
  const rel = from?.kind === 'root' ? from.relPath : '';
  const disk = !o.missing && !!drag && drag.sourceKind !== 'web' && (from?.kind === 'root' || from?.kind === 'roots-list');
  if (disk) {
    appendRootDiskItems(items, {
      showHide: from?.kind === 'root' && rel !== '',
      showTrash: true,
      onHide: o.onHideFromRoot,
      onTrash: o.onTrash,
    });
  }
  insertGroupSep(items, ['file.showInFolder', 'file.copyPath', 'dir.copyPath'], 'sep.reveal');
  insertGroupSep(items, ['refs.removeFromFolder', 'refs.removeFromWorkspace', 'tree.moveTo'], 'sep.move');
  return items;
}

/** 只在已有菜单项之间插入分隔，不改顺序，也不插到「从根目录移除」和回收站分隔线之间。 */
function insertGroupSep(items: MenuItem[], ids: string[], sepId: string) {
  const index = items.findIndex((item) => ids.includes(item.id));
  if (index <= 0) return;
  if (items[index - 1]?.separator) return;
  items.splice(index, 0, { id: sepId, label: '', separator: true, run: () => undefined });
}
