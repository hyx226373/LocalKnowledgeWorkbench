import type { RootTask } from '../../shared/rootTask';

export const ROOT_TASK_NOTICE_MS = 2500;
const completed = (task: RootTask) => task.state === 'done' || task.state === 'cancelled';

/** A terminal row is visible only during its current notice window. */
export function visibleRootTasks(tasks: readonly RootTask[], dismissed: ReadonlySet<string>, activeId: string | null): RootTask[] {
  return tasks.filter((task) => !completed(task) || (task.taskId === activeId && !dismissed.has(task.taskId)));
}

/** Session-only UI state. Initial list results dismiss historical terminal tasks. */
export function createRootTaskVisibility(onChange: (tasks: RootTask[]) => void) {
  const dismissed = new Set<string>();
  const seenCompleted = new Set<string>();
  let tasks: RootTask[] = [];
  let activeId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => onChange(visibleRootTasks(tasks, dismissed, activeId));
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    accept(next: RootTask[], historical = false) {
      tasks = next;
      const fresh = next.filter((task) => completed(task) && !seenCompleted.has(task.taskId));
      for (const task of fresh) {
        seenCompleted.add(task.taskId);
        if (historical) dismissed.add(task.taskId);
      }
      if (!historical && fresh.length) {
        // Snapshot order may differ from completion order; ties use the last row.
        const newest = fresh.reduce((a, b) => a.updatedAt > b.updatedAt ? a : b);
        if (activeId) dismissed.add(activeId);
        for (const task of fresh) if (task.taskId !== newest.taskId) dismissed.add(task.taskId);
        activeId = newest.taskId;
        clearTimer();
        timer = setTimeout(() => {
          if (activeId) dismissed.add(activeId);
          activeId = null;
          timer = undefined;
          publish();
        }, ROOT_TASK_NOTICE_MS);
      }
      publish();
    },
    dispose: clearTimer,
  };
}
