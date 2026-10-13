import fs from 'node:fs';
import { LOOSE_WATCH_LIMIT } from './errors';
import { pathKey } from './identity';

/**
 * 只对根目录以外的单个文件调用 fs.watch。
 * 不监视目录，不用 chokidar。上限 200，多出来的靠 reconcile 的 stat。
 */
export class LooseFileWatch {
  private readonly watches = new Map<string, { watcher: fs.FSWatcher; absPath: string }>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly debounceMs: number,
    private readonly onChange: (absPath: string) => void,
  ) {}

  get size(): number {
    return this.watches.size;
  }

  arm(absPath: string): void {
    const key = pathKey(absPath);
    if (this.watches.has(key)) return;
    if (this.watches.size >= LOOSE_WATCH_LIMIT) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(absPath);
    } catch {
      return;
    }
    if (!st.isFile()) return;
    try {
      const watcher = fs.watch(absPath, { persistent: false }, () => this.schedule(absPath));
      watcher.on('error', () => {
        this.disarm(absPath);
        this.schedule(absPath);
      });
      this.watches.set(key, { watcher, absPath });
    } catch {
      /* 系统拒绝时留给 reconcile */
    }
  }

  disarm(absPath: string): void {
    const key = pathKey(absPath);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    const entry = this.watches.get(key);
    if (!entry) return;
    this.watches.delete(key);
    try {
      entry.watcher.close();
    } catch {
      /* 已经关掉 */
    }
  }

  close(): void {
    for (const absPath of [...this.watches.values()].map((entry) => entry.absPath)) this.disarm(absPath);
  }

  private schedule(absPath: string): void {
    const key = pathKey(absPath);
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    const fire = () => {
      this.timers.delete(key);
      this.onChange(absPath);
    };
    if (this.debounceMs <= 0) {
      queueMicrotask(fire);
      return;
    }
    const timer = setTimeout(fire, this.debounceMs);
    timer.unref?.();
    this.timers.set(key, timer);
  }
}
