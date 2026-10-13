/** 外贴 27 冻结。启动器先问这个函数，再决定拉起、让路或提示上一版。 */
import type { UpdaterPhase } from './state';

export type LaunchPlan =
  | { action: 'second-instance' }
  | { action: 'defer-to-updater'; reason: string }
  | { action: 'spawn'; version: string }
  | { action: 'offer-previous'; current: string | null; previous: string; reason: string }
  | { action: 'fail'; reason: string };

const DEFER = new Set<UpdaterPhase>(['waiting-exit', 'switching', 'starting', 'verifying', 'rolling-back']);

/** 更新器正在切换时，启动器不许改 current.json。 */
export function mayLauncherWritePointer(phase: UpdaterPhase | null): boolean {
  return (
    phase === null ||
    phase === 'idle' ||
    phase === 'done' ||
    phase === 'failed' ||
    phase === 'cancelled' ||
    phase === 'ready' ||
    phase === 'preparing'
  );
}

export function planLaunch(input: {
  lockHeldByOther: boolean;
  updatePhase: UpdaterPhase | null;
  pointerError: string | null;
  current: string | null;
  previous: string | null;
  currentExeExists: boolean;
  previousExeExists: boolean;
}): LaunchPlan {
  if (input.lockHeldByOther) return { action: 'second-instance' };
  if (input.updatePhase && DEFER.has(input.updatePhase)) {
    return { action: 'defer-to-updater', reason: '更新正在进行，请查看更新器窗口' };
  }
  if (input.pointerError) {
    if (input.previous && input.previousExeExists) {
      return { action: 'offer-previous', current: input.current, previous: input.previous, reason: input.pointerError };
    }
    return { action: 'fail', reason: input.pointerError };
  }
  if (!input.current) return { action: 'fail', reason: 'current.json 不存在' };
  if (!input.currentExeExists) {
    const reason = `当前版本 ${input.current} 的主程序不存在`;
    if (input.previous && input.previousExeExists) {
      return { action: 'offer-previous', current: input.current, previous: input.previous, reason };
    }
    return { action: 'fail', reason: '当前版本无法启动，也没有上一版' };
  }
  return { action: 'spawn', version: input.current };
}
