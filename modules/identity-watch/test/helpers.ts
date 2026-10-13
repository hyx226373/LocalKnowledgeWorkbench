import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createRoot, migrate, setMount } from '../src/index.ts';
import type { ResourceSnapshot, WatchHandle } from '../src/index.ts';

export interface Fix {
  dir: string;
  root: string;
  db: Database.Database;
  rootId: string;
  cleanup(): void;
}

export function createFix(): Fix {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-id-'));
  const root = path.join(dir, 'root');
  fs.mkdirSync(root);
  const db = new Database(path.join(dir, 'meta.sqlite'));
  migrate(db);
  const rootId = createRoot(db, { name: '资料' });
  setMount(db, rootId, root);
  return {
    dir,
    root,
    db,
    rootId,
    cleanup() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

export function makeJunction(link: string, target: string): void {
  // mklink 是 cmd 内建命令。参数分开传；整段再加引号会被 cmd 拆碎。
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true });
}

export async function closeWatches(watches: WatchHandle[]): Promise<void> {
  for (const watch of watches) await watch.close();
}

export async function waitUntil(handle: WatchHandle, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await handle.whenIdle();
    if (predicate()) return;
  }
  throw new Error('timed out waiting for watcher state');
}

export function mtimeMsOf(absPath: string): number {
  const st = fs.statSync(absPath, { bigint: true });
  return Number(st.mtimeNs / 1_000_000n);
}

export function restoreMtimes(destRoot: string, rows: ResourceSnapshot[]): void {
  const live = rows.filter((row) => !row.displaced && row.mtimeMs != null);
  const files = live.filter((row) => row.kind === 'file');
  const dirs = live.filter((row) => row.kind === 'dir').sort((a, b) => b.relPath.length - a.relPath.length);
  for (const row of [...files, ...dirs]) {
    const abs = path.join(destRoot, ...row.relPath.split('/'));
    const seconds = (row.mtimeMs as number) / 1000;
    fs.utimesSync(abs, seconds, seconds);
  }
}

export function liveAt(rows: ResourceSnapshot[], relPath: string): ResourceSnapshot | undefined {
  return rows.find((row) => row.relPath === relPath && row.missing === 0 && !row.displaced);
}
