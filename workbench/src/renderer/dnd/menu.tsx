import React, { useSyncExternalStore } from 'react';
import { commands } from '../plugin-host/registry';

export interface MenuSubject {
  resourceId: string;
  name: string;
  rootId: string;
  relPath: string;
  kind: 'file' | 'dir';
  folderId?: string;
}

let subject: MenuSubject | null = null;
let pos: { x: number; y: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dndSubject(): MenuSubject | null {
  return subject;
}

export function showDndMenu(x: number, y: number, next: MenuSubject) {
  subject = next;
  pos = { x, y };
  emit();
}

export function DndContextMenu() {
  const tick = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => pos,
  );
  if (!tick || !subject) return null;
  const items = [
    { id: 'tree.moveTo', label: '移动到…' },
    { id: 'refs.addToFolder', label: '加入此目录' },
    ...(subject.folderId ? [{ id: 'refs.removeFromFolder', label: '从该目录移除' }] : []),
    { id: 'refs.removeFromWorkspace', label: '从本工作区移除' },
  ];
  return (
    <div className="kb-popover menu" data-testid="dnd-menu" style={{ position: 'fixed', left: tick.x, top: tick.y, zIndex: 40 }} onMouseDown={(e) => e.stopPropagation()}>
      {items.map((it) => (
        <div
          key={it.id}
          className="kb-menu-item"
          data-testid={`dnd-menu-${it.id}`}
          onClick={() => {
            pos = null;
            emit();
            void commands.get(it.id)?.run();
          }}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}

export function closeDndMenu() {
  pos = null;
  emit();
}
