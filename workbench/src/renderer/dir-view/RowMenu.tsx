import React, { useEffect } from 'react';
import { kb } from '../kb';
import { openSetKeybindingFor, SET_KEYBINDING_LABEL } from '../keybindings/contextMenu';
import { addSelection, getAgentLiveBinding } from '../agent-live/actions';
import { agentLiveMenuItems, refsForAddGesture } from '../agent-live/menu';
import { dirViewActions, type KbDragPayload } from './dnd';
import type { Ctx } from './context';

export interface MenuItem {
  id: string;
  label: string;
  disabled?: boolean;
  run: () => void;
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
        <div
          key={it.id}
          className="kb-menu-item"
          role="menuitem"
          data-command={it.id}
          aria-disabled={it.disabled ? 'true' : undefined}
          onClick={() => {
            if (it.disabled) return;
            it.run();
            onClose();
          }}
        >
          <span className="name">{it.label}</span>
        </div>
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
  missing?: boolean;
  /** 给出时表示这条是自建目录里的文件，菜单含「从该目录移除」 */
  folderId?: string | null;
  inFolder?: boolean;
  inWorkspace?: boolean;
  workspaceId?: string;
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (!o.missing && o.payload.items[0]?.entry !== 'dir-entry' && o.payload.items[0]?.entry !== 'vfolder-node') {
    items.push({
      id: 'file.openCopy',
      label: '在新面板中再打开一份',
      run: () => o.ctx.openCopy?.(o.resourceId, o.title),
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
  const drag = o.payload.items[0];
  items.push({
    id: 'keybindings.forContext',
    label: SET_KEYBINDING_LABEL,
    run: () => openSetKeybindingFor(drag?.from.kind === 'workspace-refs' ? 'workspace-ref' : 'tree-row', {
      isFile: drag?.entry === 'file',
      isWeb: drag?.sourceKind === 'web',
    }),
  });
  const binding = getAgentLiveBinding();
  if (binding && drag?.entry === 'file' && drag.sourceKind !== 'web') {
    const clicked = { resourceId: o.resourceId, absPath: '', name: o.title, relPath: drag.relPath, sourceId: drag.rootId };
    const selected = binding.host.selection();
    const refs = refsForAddGesture(clicked, selected.length ? selected : [clicked]);
    items.push(...agentLiveMenuItems(refs, (list) => { void addSelection(binding, list); }));
  }
  return items;
}
