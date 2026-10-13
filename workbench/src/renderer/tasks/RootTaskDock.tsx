import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import type { RootTask } from '../../shared/rootTask';

const hiddenIds = new Set<string>();
let hiddenSnap: ReadonlySet<string> = new Set();
const hiddenListeners = new Set<() => void>();

let opError: string | null = null;
const errorListeners = new Set<() => void>();

function emitHidden() {
  hiddenSnap = new Set(hiddenIds);
  hiddenListeners.forEach((l) => l());
}

/** 同一资料源在两个工作区是两条实例。乐观隐藏必须用实例 id，不能用共享的 source id。 */
export function rootHideKey(root: { id: string; workspaceRootId?: string | null }): string {
  return root.workspaceRootId || root.id;
}

export function hideRoot(id: string) {
  if (hiddenIds.has(id)) return;
  hiddenIds.add(id);
  emitHidden();
}

export function revealRoot(id: string) {
  if (!hiddenIds.delete(id)) return;
  emitHidden();
}

export function useHiddenRootIds(): ReadonlySet<string> {
  return useSyncExternalStore(
    (cb) => {
      hiddenListeners.add(cb);
      return () => hiddenListeners.delete(cb);
    },
    () => hiddenSnap,
  );
}

export function setRootOpError(next: string | null) {
  if (opError === next) return;
  opError = next;
  errorListeners.forEach((l) => l());
}

export function useRootOpError(): string | null {
  return useSyncExternalStore(
    (cb) => {
      errorListeners.add(cb);
      return () => errorListeners.delete(cb);
    },
    () => opError,
  );
}

export function rootIpcMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  return raw.replace(/^Error invoking remote method 'kb': (Error: )?/, '');
}

function asTasks(value: unknown): RootTask[] {
  return Array.isArray(value) ? (value as RootTask[]) : [];
}

function inProgress(state: RootTask['state']): boolean {
  return state === 'queued' || state === 'running';
}

export function RootTaskDock({ onReveal }: { onReveal?: (rootId: string) => void }) {
  const [tasks, setTasks] = useState<RootTask[]>([]);
  useEffect(() => {
    let alive = true;
    let seenEvent = false;
    const off = kb.onRootTasks((next) => {
      if (!alive) return;
      seenEvent = true;
      setTasks(asTasks(next));
    });
    kb.listRootTasks().then(
      (list) => {
        if (!alive || seenEvent) return;
        setTasks(asTasks(list));
      },
      () => {
        if (!alive || seenEvent) return;
        setTasks([]);
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, []);

  const restore = (task: RootTask) => {
    void kb.restoreRoot(task.rootId).then(
      () => {
        setRootOpError(null);
        onReveal?.(task.rootId);
      },
      (e) => setRootOpError(rootIpcMessage(e)),
    );
  };

  return (
    <div data-testid="root-task-dock">
      {tasks.map((t) => (
        <div key={t.taskId} data-task-id={t.taskId} data-root-id={t.rootId} data-state={t.state} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 12px', whiteSpace: 'normal' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            {t.phaseText}
            {t.error ? <span className="danger"> {t.error}</span> : null}
          </span>
          {t.state === 'failed' ? (
            <button type="button" className="kb-button kb-button--ghost kb-button--small" data-testid="root-task-restore" onClick={() => restore(t)}>
              恢复
            </button>
          ) : null}
          {inProgress(t.state) ? (
            <button
              type="button"
              className="kb-button kb-button--ghost kb-button--small"
              data-testid="root-task-cancel"
              onClick={() => {
                void kb.cancelRootTask(t.taskId).catch((e) => setRootOpError(rootIpcMessage(e)));
              }}
            >
              取消
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
