/** 只记录本进程启动的子进程。超时结束时不碰别人的进程。 */
import fs from 'node:fs';

const owned = new Set<number>();
const recorded = new Set<number>();
let pidFile: string | null = null;
/** 数据进程把子进程 pid 交给主进程登记。主进程不设这个回调。 */
let sink: ((pid: number) => void) | null = null;

export function setOwnedPidSink(fn: ((pid: number) => void) | null) {
  sink = fn;
}

export function setOwnedPidFile(file: string) {
  pidFile = file;
  flushOwned();
}

function flushOwned() {
  if (!pidFile) return;
  try {
    fs.writeFileSync(pidFile, JSON.stringify({ pids: [...recorded] }));
  } catch {
    /* 数据目录不可写时，下一轮没有名单可清 */
  }
}

export function ownPid(pid: number | undefined | null): void {
  if (pid && pid > 0 && pid !== process.pid) {
    owned.add(pid);
    recorded.add(pid);
    flushOwned();
    sink?.(pid);
  }
}

export function disownPid(pid: number | undefined | null): void {
  if (!pid) return;
  owned.delete(pid);
  recorded.delete(pid);
  flushOwned();
}

export function killOwned(): number[] {
  const killed: number[] = [];
  for (const pid of [...owned]) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    owned.delete(pid);
    if (!alive) continue;
    try {
      process.kill(pid);
      killed.push(pid);
    } catch {
      /* 已经退出 */
    }
  }
  return killed;
}
