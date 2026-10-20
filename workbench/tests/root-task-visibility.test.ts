import { afterEach, expect, it, vi } from 'vitest';
import type { RootTask } from '../src/shared/rootTask';
import { createRootTaskVisibility, visibleRootTasks } from '../src/renderer/tasks/rootTaskVisibility';

const task = (taskId: string, state: RootTask['state'], updatedAt = 0): RootTask => ({
  taskId, state, updatedAt, rootId: taskId, workspaceId: 'w', generation: 0,
  kind: 'delete-disk', phaseText: state, error: null, diskPath: '/example', createdAt: 0,
});
afterEach(() => vi.useRealTimers());
it('纯函数保留排队、运行和失败行，仅展示当前且未消隐的完成行', () => {
  const tasks = [task('q', 'queued'), task('r', 'running'), task('f', 'failed'), task('d', 'done'), task('c', 'cancelled')];
  expect(visibleRootTasks(tasks, new Set(), 'd').map(t => t.taskId)).toEqual(['q', 'r', 'f', 'd']);
  expect(visibleRootTasks(tasks, new Set(['d']), 'd').map(t => t.taskId)).toEqual(['q', 'r', 'f']);
});
it('首次加载的历史完成和取消任务不显示，后续快照也不会复现', () => {
  const change = vi.fn();
  const ui = createRootTaskVisibility(change);
  const tasks = [task('d', 'done'), task('c', 'cancelled'), task('r', 'running')];
  ui.accept(tasks, true);
  ui.accept(tasks);
  expect(change.mock.lastCall?.[0]).toEqual([tasks[2]]);
  ui.dispose();
});
it('首次完成显示 2.5 秒，重复快照不会延长或重新显示', () => {
  vi.useFakeTimers();
  const change = vi.fn();
  const ui = createRootTaskVisibility(change);
  ui.accept([task('a', 'running')], true);
  ui.accept([task('a', 'done')]);
  vi.advanceTimersByTime(2000);
  ui.accept([task('a', 'done')]);
  expect(change.mock.lastCall?.[0]).toHaveLength(1);
  vi.advanceTimersByTime(500);
  expect(change.mock.lastCall?.[0]).toEqual([]);
  ui.accept([task('a', 'done')]);
  expect(change.mock.lastCall?.[0]).toEqual([]);
  ui.dispose();
});
it('新完成立即替换旧完成；取消也使用相同期限，旧行不会复现', () => {
  vi.useFakeTimers();
  const change = vi.fn();
  const ui = createRootTaskVisibility(change);
  ui.accept([task('a', 'done', 1)]);
  vi.advanceTimersByTime(1000);
  ui.accept([task('a', 'done', 1), task('b', 'cancelled', 2)]);
  expect(change.mock.lastCall?.[0].map((t: RootTask) => t.taskId)).toEqual(['b']);
  vi.advanceTimersByTime(1500);
  expect(change.mock.lastCall?.[0]).toHaveLength(1);
  vi.advanceTimersByTime(1000);
  expect(change.mock.lastCall?.[0]).toEqual([]);
  ui.dispose();
});
it('同一快照多个完成任务只显示最新一条，dispose 清理定时器', () => {
  vi.useFakeTimers();
  const change = vi.fn();
  const ui = createRootTaskVisibility(change);
  ui.accept([task('new', 'done', 10), task('old', 'done', 1)]);
  expect(change.mock.lastCall?.[0].map((t: RootTask) => t.taskId)).toEqual(['new']);
  expect(vi.getTimerCount()).toBe(1);
  ui.dispose();
  expect(vi.getTimerCount()).toBe(0);
  const calls = change.mock.calls.length;
  vi.advanceTimersByTime(2500);
  expect(change).toHaveBeenCalledTimes(calls);
});
