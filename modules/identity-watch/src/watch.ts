import fs from 'node:fs';
import path from 'node:path';
import { getMount, snapshotById, type Db } from './db.ts';
import { runJob } from './engine.ts';
import { detectFileSystem } from './fsinfo.ts';
import type { ResourceChange, ResourceSnapshot, WatchHandle } from './types.ts';

/** 订阅探活用的临时文件。scanTree 会跳过这个前缀，避免它变成资料。 */
export const WATCH_ARM_PREFIX = '.kb-watch-arm-';

export interface WatchOptions {
  debounceMs?: number;
}

function diffSnapshots(
  before: Map<string, ResourceSnapshot>,
  after: Map<string, ResourceSnapshot>,
): ResourceChange[] {
  const events: ResourceChange[] = [];
  const ids = new Set<string>([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const prev = before.get(id) ?? null;
    const next = after.get(id) ?? null;
    if (!prev && next) {
      if (next.missing === 0) events.push({ type: 'create', resourceId: id, before: null, after: next });
      continue;
    }
    if (!prev || !next) continue;
    if (prev.missing === 0 && next.missing === 1) {
      events.push({ type: 'delete', resourceId: id, before: prev, after: next });
      continue;
    }
    if (prev.missing === 1 && next.missing === 0) {
      events.push({
        type: prev.relPath !== next.relPath ? 'rename-move' : 'create',
        resourceId: id,
        before: prev,
        after: next,
      });
      continue;
    }
    if (next.missing === 1) continue;
    if (prev.relPath !== next.relPath) {
      events.push({ type: 'rename-move', resourceId: id, before: prev, after: next });
      continue;
    }
    if (
      prev.size !== next.size ||
      prev.mtimeMs !== next.mtimeMs ||
      prev.contentHash !== next.contentHash ||
      prev.fsFileId !== next.fsFileId ||
      prev.kind !== next.kind
    ) {
      events.push({ type: 'modify', resourceId: id, before: prev, after: next });
    }
  }
  return events;
}

interface Backend {
  backend: 'parcel' | 'chokidar';
  unsubscribe(): Promise<void>;
}

async function startBackend(dir: string, onEvents: () => void): Promise<Backend> {
  let parcelError: unknown;
  try {
    const parcel = (await import('@parcel/watcher')) as {
      subscribe?: (
        directory: string,
        callback: (err: Error | null, events: { type: string; path: string }[]) => void,
      ) => Promise<{ unsubscribe: () => Promise<void> }>;
      default?: {
        subscribe?: (
          directory: string,
          callback: (err: Error | null, events: { type: string; path: string }[]) => void,
        ) => Promise<{ unsubscribe: () => Promise<void> }>;
      };
    };
    const subscribe = parcel.subscribe ?? parcel.default?.subscribe;
    if (typeof subscribe !== 'function') throw new Error('@parcel/watcher has no subscribe');
    const sub = await subscribe(dir, (err, events) => {
      // 缓冲区溢出时 parcel 报错且事件已经丢了。必须对账，不能把错误吃掉。
      if (err) {
        onEvents();
        return;
      }
      if (!events?.length) return;
      onEvents();
    });
    return { backend: 'parcel', unsubscribe: () => sub.unsubscribe() };
  } catch (error) {
    parcelError = error;
  }

  try {
    const chokidar = (await import('chokidar')) as {
      watch?: (directory: string, options: Record<string, unknown>) => Closable;
      default?: { watch?: (directory: string, options: Record<string, unknown>) => Closable };
    };
    const watch = chokidar.watch ?? chokidar.default?.watch;
    if (typeof watch !== 'function') throw new Error('chokidar has no watch');
    const watcher = watch(dir, {
      ignoreInitial: true,
      awaitWriteFinish: false,
      followSymlinks: false,
    });
    watcher.on('all', () => onEvents());
    await new Promise<void>((resolve, reject) => {
      watcher.once('ready', () => resolve());
      watcher.once('error', (error: unknown) => reject(error));
    });
    return {
      backend: 'chokidar',
      unsubscribe: () => watcher.close(),
    };
  } catch (error) {
    throw new Error(`watcher unavailable; parcel: ${String(parcelError)}; chokidar: ${String(error)}`);
  }
}

interface Closable {
  on(event: string, cb: (...args: unknown[]) => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  close(): Promise<void>;
}

export async function watchRoot(
  db: Db,
  rootId: string,
  onResourceChanged: (event: ResourceChange) => void,
  options: WatchOptions = {},
): Promise<WatchHandle> {
  const debounceMs = options.debounceMs ?? 50;
  const mount = getMount(db, rootId);
  const caps = detectFileSystem(mount);
  let closed = false;
  let accept = false;
  let pending = false;
  let timer: NodeJS.Timeout | null = null;
  let flushing: Promise<void> | null = null;
  let callbackError: Error | null = null;

  const shot = () => snapshotById(db, rootId);

  const flush = async (): Promise<void> => {
    if (closed) return;
    if (flushing) {
      pending = true;
      await flushing;
      return;
    }
    flushing = (async () => {
      do {
        pending = false;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (closed) return;
        const before = shot();
        runJob(db, rootId, { caps });
        const after = shot();
        for (const event of diffSnapshots(before, after)) {
          try {
            onResourceChanged(event);
          } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            throw callbackError;
          }
        }
      } while (pending && !closed);
    })();
    try {
      await flushing;
    } finally {
      flushing = null;
    }
    if (pending && !closed) await flush();
  };

  const schedule = () => {
    if (closed) return;
    pending = true;
    if (!accept) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush().catch((error: unknown) => {
        callbackError = error instanceof Error ? error : new Error(String(error));
      });
    }, debounceMs);
  };

  let backendEvents = 0;
  const noteBackend = () => {
    backendEvents += 1;
    schedule();
  };
  const backend = await startBackend(mount, noteBackend);
  // subscribe() 返回时，Windows 的 ReadDirectoryChanges 可能还没开始投递。
  // 立刻写入的文件约有一半收不到事件，whenIdle 会以为没有待处理变更，一直空转到超时。
  const probe = path.join(mount, `${WATCH_ARM_PREFIX}${process.pid}`);
  let armed = false;
  for (let attempt = 0; attempt < 10 && !armed; attempt += 1) {
    const seen = backendEvents;
    fs.writeFileSync(probe, 'arm');
    const until = Date.now() + 250;
    while (backendEvents === seen && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    fs.rmSync(probe, { force: true });
    if (backendEvents !== seen) armed = true;
  }
  if (!armed) {
    await backend.unsubscribe();
    throw new Error('文件监视已订阅，但探测文件的事件没有送达');
  }
  runJob(db, rootId, { caps });
  accept = true;
  if (pending) schedule();

  async function whenIdle(): Promise<void> {
    const deadline = Date.now() + 60_000;
    let quiet = 0;
    while (Date.now() < deadline) {
      if (callbackError) throw callbackError;
      if (timer || pending || flushing) {
        quiet = 0;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        await flush();
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, debounceMs + 50));
      if (!timer && !pending && !flushing) {
        quiet += 1;
        if (quiet >= 2) return;
      } else quiet = 0;
    }
    throw new Error('timed out waiting for the watcher to go idle');
  }

  return {
    backend: backend.backend,
    flush,
    whenIdle,
    async close() {
      closed = true;
      accept = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await backend.unsubscribe();
      if (flushing) {
        try {
          await flushing;
        } catch {
          /* 关闭时忽略未完成的刷新错误，调用方已拿到 callbackError */
        }
      }
    },
  };
}
