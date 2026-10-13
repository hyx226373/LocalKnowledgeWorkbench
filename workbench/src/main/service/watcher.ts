/**
 * 每个根一个监听器。事件去抖后批量交给 service.applyFsEvents（实际写库在 worker 中）。
 * Windows 用一个递归 fs.watch。chokidar 会先遍历整棵树，再给每个文件单独 fs.watch，
 * 两万个文件能把主线程堵住二十多秒。监听丢事件由启动对账扫描兜底。
 */
import fs from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { WorkbenchService } from './WorkbenchService';
import { isIgnoredName, type FsEvent } from './indexer';
import { toRelPath } from './paths';

interface WatchHandle {
  close(): void | Promise<void>;
}

/** 超过这个长度就整根重扫并清空。不保留几百万条事件。 */
export const WATCH_QUEUE_CAP = 10000;

export class RootWatchers {
  private watchers = new Map<string, WatchHandle>();
  private rootPaths = new Map<string, string>();
  private queues = new Map<string, Map<string, FsEvent>>();
  private timers = new Map<string, NodeJS.Timeout>();
  private armedAt = new Map<string, number>();
  private scanAgain = new Set<string>();
  private rescanNotBefore = new Map<string, number>();
  private rescanTimers = new Map<string, NodeJS.Timeout>();
  private selfPaths: string[] = [];
  private closing = new Map<string, Promise<void>>();
  private tally = new Map<string, number>();
  private tallyTimer: NodeJS.Timeout | undefined;
  private droppedOwn = 0;
  private batchListeners: Array<(rootId: string, batch: FsEvent[]) => void> = [];

  constructor(private svc: WorkbenchService, private debounceMs = 300, private log?: (line: string) => void) {}

  /** 消费已有去抖批次。调用发生在写索引之前，失败不影响索引。 */
  onBatch(cb: (rootId: string, batch: FsEvent[]) => void): () => void {
    this.batchListeners.push(cb);
    return () => {
      this.batchListeners = this.batchListeners.filter((item) => item !== cb);
    };
  }

  /** 自己写的数据目录和日志。这些路径落在被监听的根下面时不进队列。 */
  setSelfPaths(paths: string[]) {
    this.selfPaths = paths.filter((item) => item).map((item) => path.resolve(item).toLowerCase());
  }

  sync() {
    const roots = this.svc.rootsToWatch();
    const ids = new Set(roots.map((r) => r.id));
    for (const id of [...this.watchers.keys()]) {
      if (!ids.has(id)) void this.closeWatcher(id);
    }
    for (const r of roots) {
      if (this.watchers.has(r.id) || r.status !== 'ok') continue;
      this.rootPaths.set(r.id, path.resolve(r.path));
      this.start(r.id, r.path, r.kind === 'file');
    }
  }

  restart(rootId: string) {
    const w = this.watchers.get(rootId);
    if (w) void w.close();
    this.watchers.delete(rootId);
    this.sync();
  }

  private start(rootId: string, rootPath: string, fileRoot: boolean) {
    if (process.platform === 'win32') this.startNative(rootId, rootPath, fileRoot);
    else this.startChokidar(rootId, rootPath);
  }

  /** 一个句柄盖住整棵树。回调里只做字符串过滤，不 stat、不查库。 */
  private startNative(rootId: string, rootPath: string, fileRoot: boolean) {
    let w: fs.FSWatcher;
    try {
      w = fs.watch(rootPath, { persistent: true, recursive: !fileRoot }, (event, filename) => {
        const parsed = fileRoot ? { rel: '', outside: false } : normalizeWatchRel(filename, rootPath);
        // Windows 缓冲区溢出时文件名是空的。丢掉这条就会漏掉刚写完的文件，改成整根重扫。
        if (parsed === null) {
          this.scheduleRescan(rootId);
          return;
        }
        if (parsed.outside) {
          this.droppedOwn += 1;
          return;
        }
        if (skipRel(parsed.rel)) return;
        const rel = parsed.rel;
        this.noteIncoming(String(event || 'change'), rel);
        this.enqueue(rootId, { type: 'change', relPath: rel });
      });
    } catch {
      this.svc.setWatching(rootId, false);
      return;
    }
    w.on('error', () => this.svc.setWatching(rootId, false));
    this.watchers.set(rootId, w);
    this.svc.setWatching(rootId, true);
  }

  private startChokidar(rootId: string, rootPath: string) {
    const w = watch(rootPath, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p: string) => isIgnoredName(path.basename(p)) || /\.kbtmp-\d+$/.test(p) || /(?:^|[\\/])[^\\/]+\.asar(?:$|[\\/])/i.test(p),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    });
    w.on('all', (type, abs) => {
      if (!['add', 'change', 'unlink', 'addDir', 'unlinkDir'].includes(type)) return;
      const rel = toRelPath(rootPath, abs);
      if (rel === null || skipRel(rel)) return;
      this.noteIncoming(type, rel);
      this.enqueue(rootId, { type: type as FsEvent['type'], relPath: rel });
    });
    w.on('ready', () => this.svc.setWatching(rootId, true));
    w.on('error', () => this.svc.setWatching(rootId, false));
    this.watchers.set(rootId, w);
  }

  /** 还没刷出去的监听条数。只计数，不改队列。性能采样用它区分程序堆积和采样本身。 */
  queued(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.size;
    return n;
  }

  /** 删除目录前关掉盖住它的监听，避免句柄把文件夹留住。 */
  async release(abs: string) {
    const target = path.resolve(abs);
    const jobs: Promise<void>[] = [];
    for (const id of [...this.watchers.keys()]) {
      const remembered = this.rootPaths.get(id);
      if (!remembered) continue;
      const rootPath = path.resolve(remembered);
      const covers = target === rootPath || target.startsWith(rootPath + path.sep) || rootPath.startsWith(target + path.sep);
      if (!covers) continue;
      jobs.push(this.closeWatcher(id));
    }
    await Promise.all(jobs);
  }

  /** 同一个根只关一次。sync 和删除任务可以一起等这一个 Promise。 */
  private closeWatcher(id: string): Promise<void> {
    const pending = this.closing.get(id);
    if (pending) return pending;
    const watcher = this.watchers.get(id);
    if (!watcher) return Promise.resolve();
    this.watchers.delete(id);
    this.dropRoot(id);
    try { this.svc.setWatching(id, false); } catch { /* 状态写失败不影响松手 */ }
    const done = Promise.resolve()
      .then(() => watcher.close())
      .then(() => undefined)
      .finally(() => { this.closing.delete(id); });
    this.closing.set(id, done);
    return done;
  }

  /** 每 10 秒把事件类型和路径前缀的前 10 名写进诊断日志。只计数，不改变入队。 */
  private noteIncoming(eventType: string, rel: string) {
    if (!this.log) return;
    const parts = rel.split('/').filter(Boolean);
    const prefix = parts.length === 0 ? '(root)' : parts.slice(0, 3).join('/');
    const key = `${eventType}|${prefix}`;
    if (this.tally.has(key) || this.tally.size < 200) this.tally.set(key, (this.tally.get(key) ?? 0) + 1);
    else this.tally.set('*|other', (this.tally.get('*|other') ?? 0) + 1);
    if (this.tallyTimer) return;
    this.tallyTimer = setTimeout(() => {
      this.tallyTimer = undefined;
      const top = [...this.tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const rest = [...this.tally.values()].reduce((n, v) => n + v, 0);
      this.tally.clear();
      try {
        this.log?.(`watch-top queued=${this.queued()} n=${rest} own=${this.droppedOwn} ${top.map(([k, v]) => `${v}:${k}`).join(' | ')}`);
        this.droppedOwn = 0;
      } catch {
        /* 诊断失败不影响监听 */
      }
    }, 10000);
    this.tallyTimer.unref?.();
  }

  private isSelfWrite(rootId: string, rel: string): boolean {
    if (isOwnWatchRel(rel)) return true;
    const root = this.rootPaths.get(rootId);
    if (!root || this.selfPaths.length === 0) return false;
    const abs = path.resolve(root, ...rel.split('/')).toLowerCase();
    return this.selfPaths.some((prefix) => abs === prefix || abs.startsWith(prefix + path.sep));
  }

  private enqueue(rootId: string, e: FsEvent) {
    if (this.isSelfWrite(rootId, e.relPath)) {
      this.droppedOwn += 1;
      return;
    }
    let q = this.queues.get(rootId);
    if (!q) {
      q = new Map();
      this.queues.set(rootId, q);
    }
    if (ingestWatch(q, e).rescan) this.scanAgain.add(rootId);
    const now = Date.now();
    const wait = flushWait(now, this.armedAt.get(rootId), this.debounceMs);
    this.armedAt.set(rootId, wait.armedAt);
    clearTimeout(this.timers.get(rootId));
    this.timers.set(rootId, setTimeout(() => this.flush(rootId), wait.wait));
  }

  /** 第一次事件起算，最多等一个去抖周期就刷出。后面的事件不能把消费端一直往后推。 */
  private flush(rootId: string) {
    this.timers.delete(rootId);
    this.armedAt.delete(rootId);
    const again = this.scanAgain.has(rootId);
    this.scanAgain.delete(rootId);
    const batch = [...(this.queues.get(rootId)?.values() ?? [])];
    this.queues.set(rootId, new Map());
    if (again) {
      this.scheduleRescan(rootId);
      return;
    }
    if (batch.length) {
      for (const cb of this.batchListeners) {
        try { cb(rootId, batch); } catch { /* 资料区消费失败仍要写索引 */ }
      }
      void this.svc.applyFsEvents(rootId, batch).catch(() => undefined);
    }
  }

  private scheduleRescan(rootId: string) {
    this.scanAgain.add(rootId);
    if (this.rescanTimers.has(rootId)) return;
    const wait = Math.max(0, (this.rescanNotBefore.get(rootId) ?? 0) - Date.now());
    const timer = setTimeout(() => {
      this.rescanTimers.delete(rootId);
      this.scanAgain.delete(rootId);
      this.rescanNotBefore.set(rootId, Date.now() + 30000);
      try { this.log?.(`watch-rescan ${rootId}`); } catch { /* 诊断失败不影响重扫 */ }
      void Promise.resolve(this.svc.scanRoot(rootId)).finally(() => {
        if (!this.scanAgain.has(rootId)) return;
        this.scheduleRescan(rootId);
      });
    }, wait);
    timer.unref?.();
    this.rescanTimers.set(rootId, timer);
  }

  private dropRoot(id: string) {
    clearTimeout(this.timers.get(id));
    clearTimeout(this.rescanTimers.get(id));
    this.timers.delete(id);
    this.rescanTimers.delete(id);
    this.armedAt.delete(id);
    this.queues.delete(id);
    this.rootPaths.delete(id);
    this.scanAgain.delete(id);
    this.rescanNotBefore.delete(id);
  }

  async closeAll() {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const t of this.rescanTimers.values()) clearTimeout(t);
    clearTimeout(this.tallyTimer);
    await Promise.all([...this.watchers.values()].map((w) => w.close()));
    this.watchers.clear();
    this.queues.clear();
    this.timers.clear();
    this.rescanTimers.clear();
    this.armedAt.clear();
    this.rootPaths.clear();
    this.scanAgain.clear();
  }
}

/** 距这轮第一次入队最多再等一个去抖周期。连续事件把等待缩短到 0，而不是重新计时。 */
export function flushWait(now: number, armedAt: number | undefined, debounceMs: number): { wait: number; armedAt: number } {
  const start = armedAt ?? now;
  return { wait: Math.max(0, Math.min(debounceMs, start + debounceMs - now)), armedAt: start };
}

/**
 * 同一路径还在排队时只保留后到的那条。
 * 新路径把队列顶过上限时清空并要求重扫，不把事件留在内存里。
 */
export function ingestWatch(queue: Map<string, FsEvent>, event: FsEvent, cap = WATCH_QUEUE_CAP): { rescan: boolean } {
  if (event.type === 'unlinkDir') {
    for (const key of [...queue.keys()]) {
      if (key === event.relPath || key.startsWith(event.relPath + '/')) queue.delete(key);
    }
  }
  if (queue.has(event.relPath) || queue.size < cap) {
    queue.set(event.relPath, event);
    return { rescan: false };
  }
  queue.clear();
  return { rescan: true };
}

/**
 * Windows 有时把文件名报成 `\\?\D:\...`。折成斜杠后变成 `?/D:/...`，自写过滤和忽略规则对不上。
 * 绝对路径先剥掉前缀，再收成相对当前根的路径。不在这个根里的返回 outside，调用方丢掉。
 * 文件名为空时返回 null，表示缓冲区溢出，要整根重扫。
 */
export function normalizeWatchRel(filename: string | Buffer | null, rootPath: string): { rel: string; outside: boolean } | null {
  if (filename == null) return null;
  let text = Buffer.isBuffer(filename) ? filename.toString('utf8') : filename;
  text = text.replace(/\0/g, '');
  if (!text) return null;
  text = text.replace(/^\\\\\?\\UNC\\/i, '//').replace(/^\\\\\?\\/i, '');
  text = text.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
  if (/^\?\/unc\//i.test(text)) text = '//' + text.slice(6);
  else if (text.startsWith('?/')) text = text.slice(2);
  const absolute = /^[A-Za-z]:\//.test(text) || text.startsWith('//');
  if (!absolute) return { rel: text, outside: false };
  const abs = path.resolve(text);
  const root = path.resolve(rootPath);
  const absKey = abs.toLowerCase();
  const rootKey = root.toLowerCase();
  if (absKey !== rootKey && !absKey.startsWith(rootKey + path.sep.toLowerCase())) return { rel: '', outside: true };
  if (absKey === rootKey) return { rel: '', outside: true };
  return { rel: abs.slice(root.length).replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/'), outside: false };
}

/** 忽略名、临时文件和 .asar 不进入队列。父目录被忽略时，子路径一起丢掉。 */
export function skipRel(rel: string): boolean {
  if (!rel) return false;
  const parts = rel.split('/');
  if (parts.some((part) => isIgnoredName(part))) return true;
  const base = parts[parts.length - 1] ?? '';
  if (/\.kbtmp-\d+$/.test(base)) return true;
  return /(?:^|\/)[^/]+\.asar(?:\/|$)/i.test(rel);
}

const OWN_DIRS = new Set([
  'cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache',
  'gpupersistentcache', 'grshadercache', 'shadercache', 'blob_storage',
  'session storage', 'local storage', 'network', 'service worker',
]);

/** 程序自己的库、锁和缓存目录不进队列。普通笔记、日志和工作树源码仍要索引。 */
export function isOwnWatchRel(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((part) => OWN_DIRS.has(part.toLowerCase()) || part.toLowerCase() === 'agent-bridge')) return true;
  const base = (parts[parts.length - 1] ?? '').toLowerCase();
  if (/^workbench\.db(-wal|-shm|-journal)?$/.test(base)) return true;
  if (base === 'startup-trace.json' || base === 'instance.lock' || base === 'child-pids.json') return true;
  return false;
}
