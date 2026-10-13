/** 外贴 27 冻结。更新器被杀掉之后，只能按这张表恢复。 */
import type { UpdaterPhase } from './state';

export type RecoverAction =
  | { action: 'resume-wait' }
  | { action: 'retry-switch' }
  | { action: 'rollback-pointer' }
  | { action: 'already-done' }
  | { action: 'settled' }
  | { action: 'refuse'; reason: string };

export function decideRecovery(input: {
  phase: UpdaterPhase;
  current: string;
  fromVersion: string;
  toVersion: string | null;
  readyVersion: string | null;
}): RecoverAction {
  const to = input.toVersion;
  const onTarget = to !== null && input.current === to;
  const onSource = input.current === input.fromVersion;
  const ready = to !== null && input.readyVersion === to;

  if (input.phase === 'preparing' || input.phase === 'ready') {
    return { action: 'refuse', reason: '准备阶段由工作台继续，更新器不切换' };
  }
  if (input.phase === 'idle' || input.phase === 'done' || input.phase === 'cancelled') {
    if (onTarget && ready) return { action: 'already-done' };
    return { action: 'settled' };
  }
  if (!to) return { action: 'refuse', reason: '更新状态缺少目标版本' };

  if (input.phase === 'waiting-exit') {
    if (onSource) return { action: 'resume-wait' };
    if (onTarget && ready) return { action: 'already-done' };
    if (onTarget) return { action: 'rollback-pointer' };
    return { action: 'refuse', reason: '当前版本指针与更新状态不一致' };
  }
  if (input.phase === 'rolling-back') {
    if (onSource) return { action: 'settled' };
    if (onTarget) return { action: 'rollback-pointer' };
    return { action: 'refuse', reason: '当前版本指针与更新状态不一致' };
  }
  if (onTarget && ready) return { action: 'already-done' };
  if (onTarget) return { action: 'rollback-pointer' };
  if (onSource) return { action: 'retry-switch' };
  return { action: 'refuse', reason: '当前版本指针与更新状态不一致' };
}
