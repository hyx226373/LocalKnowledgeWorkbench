import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PathEscapeError,
  ReconcileCancelledError,
  createRoot,
  detectFileSystem,
  ensureResource,
  exportPortable,
  getResource,
  importPortable,
  listResources,
  migrate,
  reconcile,
  remapRoot,
  resolveInsideRoot,
  setMount,
  updateLocation,
  watchRoot,
} from '../src/index.ts';
import type { ResourceChange, WatchHandle } from '../src/index.ts';
import { closeWatches, createFix, liveAt, makeJunction, mtimeMsOf, restoreMtimes, waitUntil, type Fix } from './helpers.ts';

const fixes: Fix[] = [];
const watches: WatchHandle[] = [];

function fix(): Fix {
  const created = createFix();
  fixes.push(created);
  return created;
}

afterEach(async () => {
  await closeWatches(watches);
  watches.length = 0;
  while (fixes.length > 0) fixes.pop()?.cleanup();
});

function writeStable(absPath: string, body: string, when = new Date('2020-06-01T00:00:00.000Z')): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, body);
  fs.utimesSync(absPath, when, when);
}

describe('identity rules', () => {
  it('keeps the id when a file is renamed, moved into a subdirectory, and moved back while watching', async () => {
    const fx = fix();
    console.log('FS_CAPS=' + JSON.stringify(detectFileSystem(fx.root)));
    const events: ResourceChange[] = [];
    const handle = await watchRoot(fx.db, fx.rootId, (event) => events.push(event));
    watches.push(handle);
    console.log('WATCH_BACKEND=' + handle.backend);
    const file = path.join(fx.root, 'a.txt');
    fs.writeFileSync(file, 'alpha');
    await waitUntil(handle, () => liveAt(listResources(fx.db, fx.rootId), 'a.txt') != null);
    const id = liveAt(listResources(fx.db, fx.rootId), 'a.txt')?.id;
    expect(id).toBeTruthy();
    expect(events.some((event) => event.type === 'create' && event.resourceId === id)).toBe(true);

    fs.mkdirSync(path.join(fx.root, 'sub'));
    fs.renameSync(file, path.join(fx.root, 'sub', 'a.txt'));
    await waitUntil(handle, () => getResource(fx.db, id as string)?.relPath === 'sub/a.txt');
    expect(events.some((event) => event.type === 'rename-move' && event.resourceId === id && event.after?.relPath === 'sub/a.txt')).toBe(true);
    expect(getResource(fx.db, id as string)?.missing).toBe(0);

    fs.renameSync(path.join(fx.root, 'sub', 'a.txt'), file);
    await waitUntil(handle, () => getResource(fx.db, id as string)?.relPath === 'a.txt');
    expect(getResource(fx.db, id as string)?.id).toBe(id);
    expect(getResource(fx.db, id as string)?.missing).toBe(0);
  });

  it('keeps the id across rename, move, and move-back when only reconcile runs', async () => {
    const fx = fix();
    fs.writeFileSync(path.join(fx.root, 'a.txt'), 'alpha');
    const id = ensureResource(fx.db, fx.rootId, 'a.txt');
    fs.mkdirSync(path.join(fx.root, 'sub'));
    fs.renameSync(path.join(fx.root, 'a.txt'), path.join(fx.root, 'sub', 'a.txt'));
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, id)?.relPath).toBe('sub/a.txt');
    expect(getResource(fx.db, id)?.missing).toBe(0);
    fs.renameSync(path.join(fx.root, 'sub', 'a.txt'), path.join(fx.root, 'a.txt'));
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, id)?.relPath).toBe('a.txt');
    expect(getResource(fx.db, id)?.missing).toBe(0);
  });

  it('does not swap ids when two same-size files are renamed at once', async () => {
    const fx = fix();
    const when = new Date('2021-01-01T00:00:00.000Z');
    writeStable(path.join(fx.root, 'a.txt'), 'SAME-CONTENT', when);
    writeStable(path.join(fx.root, 'b.txt'), 'SAME-CONTENT', when);
    const idA = ensureResource(fx.db, fx.rootId, 'a.txt');
    const idB = ensureResource(fx.db, fx.rootId, 'b.txt');
    const inoA = getResource(fx.db, idA)?.fsFileId;
    const inoB = getResource(fx.db, idB)?.fsFileId;
    expect(inoA).toBeTruthy();
    expect(inoB).toBeTruthy();
    expect(inoA).not.toBe(inoB);
    const raw = fx.db.prepare(`SELECT typeof(fs_file_id) AS t FROM resources WHERE id = ?`).get(idA) as { t: string };
    expect(raw.t).toBe('text');

    const tmp = path.join(fx.root, 'a.txt.swap');
    fs.renameSync(path.join(fx.root, 'a.txt'), tmp);
    fs.renameSync(path.join(fx.root, 'b.txt'), path.join(fx.root, 'a.txt'));
    fs.renameSync(tmp, path.join(fx.root, 'b.txt'));
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, idA)?.relPath).toBe('b.txt');
    expect(getResource(fx.db, idA)?.fsFileId).toBe(inoA);
    expect(getResource(fx.db, idB)?.relPath).toBe('a.txt');
    expect(getResource(fx.db, idB)?.fsFileId).toBe(inoB);
  });

  it('does not swap ids when the watcher observes the same double rename', async () => {
    const fx = fix();
    const handle = await watchRoot(fx.db, fx.rootId, () => undefined);
    watches.push(handle);
    const when = new Date('2021-02-01T00:00:00.000Z');
    writeStable(path.join(fx.root, 'a.txt'), 'SAME-CONTENT', when);
    writeStable(path.join(fx.root, 'b.txt'), 'SAME-CONTENT', when);
    await waitUntil(handle, () => liveAt(listResources(fx.db, fx.rootId), 'a.txt') != null && liveAt(listResources(fx.db, fx.rootId), 'b.txt') != null);
    const idA = liveAt(listResources(fx.db, fx.rootId), 'a.txt')?.id as string;
    const idB = liveAt(listResources(fx.db, fx.rootId), 'b.txt')?.id as string;
    const inoA = getResource(fx.db, idA)?.fsFileId;
    const inoB = getResource(fx.db, idB)?.fsFileId;
    const tmp = path.join(fx.root, 'a.txt.swap');
    fs.renameSync(path.join(fx.root, 'a.txt'), tmp);
    fs.renameSync(path.join(fx.root, 'b.txt'), path.join(fx.root, 'a.txt'));
    fs.renameSync(tmp, path.join(fx.root, 'b.txt'));
    await waitUntil(handle, () => getResource(fx.db, idA)?.relPath === 'b.txt' && getResource(fx.db, idB)?.relPath === 'a.txt');
    expect(getResource(fx.db, idA)?.fsFileId).toBe(inoA);
    expect(getResource(fx.db, idB)?.fsFileId).toBe(inoB);
  });

  it('marks a deleted row missing and does not reuse its id for a same-name new file', async () => {
    const fx = fix();
    const file = path.join(fx.root, 'a.txt');
    fs.writeFileSync(file, 'AAAA');
    const id = ensureResource(fx.db, fx.rootId, 'a.txt');
    fs.unlinkSync(file);
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, id)?.missing).toBe(1);
    expect(fx.db.prepare(`SELECT id FROM resources WHERE id = ?`).get(id)).toBeTruthy();

    fs.writeFileSync(file, 'BBBB');
    await reconcile(fx.db, fx.rootId);
    const live = liveAt(listResources(fx.db, fx.rootId), 'a.txt');
    expect(live?.id).toBeTruthy();
    expect(live?.id).not.toBe(id);
    expect(getResource(fx.db, id)?.missing).toBe(1);
    const bundle = JSON.stringify(exportPortable(fx.db, fx.rootId));
    expect(bundle).not.toContain('//missing');
    expect(bundle).not.toContain('fs_file_id');
  });

  it('does the same when the watcher sees the delete and the new file', async () => {
    const fx = fix();
    const events: ResourceChange[] = [];
    const handle = await watchRoot(fx.db, fx.rootId, (event) => events.push(event));
    watches.push(handle);
    const file = path.join(fx.root, 'a.txt');
    fs.writeFileSync(file, 'AAAA');
    await waitUntil(handle, () => liveAt(listResources(fx.db, fx.rootId), 'a.txt') != null);
    const id = liveAt(listResources(fx.db, fx.rootId), 'a.txt')?.id as string;
    fs.unlinkSync(file);
    await waitUntil(handle, () => getResource(fx.db, id)?.missing === 1);
    expect(events.some((event) => event.type === 'delete' && event.resourceId === id)).toBe(true);
    fs.writeFileSync(file, 'BBBB');
    await waitUntil(handle, () => liveAt(listResources(fx.db, fx.rootId), 'a.txt')?.id !== id);
    const live = liveAt(listResources(fx.db, fx.rootId), 'a.txt');
    expect(live?.id).not.toBe(id);
    expect(getResource(fx.db, id)?.missing).toBe(1);
  });

  it('follows a copied file by size+mtime+hash and refuses hash-only', async () => {
    const fx = fix();
    writeStable(path.join(fx.root, 'only.txt'), 'unique-payload-one');
    const id = ensureResource(fx.db, fx.rootId, 'only.txt');
    const snap = getResource(fx.db, id);
    expect(snap?.contentHash).toBeTruthy();
    fs.mkdirSync(path.join(fx.root, 'nested'));
    const moved = path.join(fx.root, 'nested', 'moved.txt');
    fs.copyFileSync(path.join(fx.root, 'only.txt'), moved);
    fs.utimesSync(moved, (snap?.mtimeMs as number) / 1000, (snap?.mtimeMs as number) / 1000);
    expect(mtimeMsOf(moved)).toBe(snap?.mtimeMs);
    fs.unlinkSync(path.join(fx.root, 'only.txt'));
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, id)?.relPath).toBe('nested/moved.txt');
    expect(getResource(fx.db, id)?.missing).toBe(0);
    expect(getResource(fx.db, id)?.contentHash).toBe(snap?.contentHash);
    expect(getResource(fx.db, id)?.mtimeMs).toBe(snap?.mtimeMs);
    expect(getResource(fx.db, id)?.fsFileId).not.toBe(snap?.fsFileId);

    const shifted = path.join(fx.root, 'shifted.txt');
    fs.copyFileSync(moved, shifted);
    fs.utimesSync(shifted, ((snap?.mtimeMs as number) + 60_000) / 1000, ((snap?.mtimeMs as number) + 60_000) / 1000);
    fs.unlinkSync(moved);
    await reconcile(fx.db, fx.rootId);
    expect(getResource(fx.db, id)?.missing).toBe(1);
    expect(liveAt(listResources(fx.db, fx.rootId), 'shifted.txt')?.id).not.toBe(id);
  });

  it('keeps every id when the whole root is copied and remapped', async () => {
    const fx = fix();
    const caps = detectFileSystem(fx.root);
    expect(caps.name).toBe('NTFS');
    expect(caps.fileIdReliable).toBe(true);
    writeStable(path.join(fx.root, 'notes', 'a.md'), '甲');
    writeStable(path.join(fx.root, 'notes', 'sub', 'b.md'), '乙');
    writeStable(path.join(fx.root, 'same-a.txt'), 'DUP', new Date('2022-02-02T00:00:00.000Z'));
    writeStable(path.join(fx.root, 'same-b.txt'), 'DUP', new Date('2022-02-02T00:00:00.000Z'));
    await reconcile(fx.db, fx.rootId);
    const before = listResources(fx.db, fx.rootId).filter((row) => !row.displaced);
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((row) => row.missing === 0)).toBe(true);
    const dest = path.join(fx.dir, 'copy');
    fs.cpSync(fx.root, dest, { recursive: true });
    restoreMtimes(dest, before);
    for (const row of before.filter((item) => item.kind === 'file')) {
      expect(mtimeMsOf(path.join(dest, ...row.relPath.split('/')))).toBe(row.mtimeMs);
    }
    const bundle = exportPortable(fx.db, fx.rootId);
    const json = JSON.stringify(bundle);
    expect(json).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(json.toLowerCase()).not.toContain(path.basename(fx.dir).toLowerCase());
    expect(json).not.toContain('local_path');
    expect(json).not.toContain('fs_file_id');
    const phases: string[] = [];
    const result = await remapRoot(fx.db, fx.rootId, dest, {
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(phases.length).toBeGreaterThan(0);
    expect(result.fileIdReliable).toBe(true);
    const after = listResources(fx.db, fx.rootId).filter((row) => !row.displaced);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    expect(after.every((row) => row.missing === 0)).toBe(true);
    for (const row of before) {
      const next = after.find((item) => item.id === row.id);
      expect(next?.relPath).toBe(row.relPath);
      expect(next?.contentHash).toBe(row.contentHash);
      expect(next?.mtimeMs).toBe(row.mtimeMs);
      expect(next?.size).toBe(row.size);
      if (row.fsFileId) expect(next?.fsFileId).not.toBe(row.fsFileId);
    }
    const mount = fx.db.prepare(`SELECT local_path FROM root_mounts WHERE root_id = ?`).get(fx.rootId) as { local_path: string };
    expect(path.resolve(mount.local_path).toLowerCase()).toBe(fs.realpathSync(dest).toLowerCase());

    const db2 = new Database(path.join(fx.dir, 'imported.sqlite'));
    try {
      migrate(db2);
      importPortable(db2, bundle);
      const mounts = db2.prepare(`SELECT local_path FROM root_mounts WHERE root_id = ?`).all(fx.rootId);
      expect(mounts).toEqual([]);
      expect(listResources(db2, fx.rootId).map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    } finally {
      db2.close();
    }
  });

  it('reuses an existing id for case and slash variants, and updates a live file in place', async () => {
    const fx = fix();
    fs.mkdirSync(path.join(fx.root, 'Foo'));
    fs.writeFileSync(path.join(fx.root, 'Foo', 'Bar.MD'), 'inside');
    const id = ensureResource(fx.db, fx.rootId, 'Foo/Bar.MD');
    expect(ensureResource(fx.db, fx.rootId, 'foo\\bar.md')).toBe(id);
    expect(ensureResource(fx.db, fx.rootId, 'Foo//Bar.MD')).toBe(id);
    const resolved = resolveInsideRoot(fx.db, fx.rootId, 'Foo\\Bar.MD');
    expect(resolved.resourceId).toBe(id);
    expect(resolved.relPath.toLowerCase()).toBe('foo/bar.md');
    expect(resolved.absPath.toLowerCase().startsWith(fs.realpathSync(fx.root).toLowerCase())).toBe(true);
    const before = getResource(fx.db, id);
    fs.writeFileSync(path.join(fx.root, 'Foo', 'Bar.MD'), 'inside-edited');
    expect(ensureResource(fx.db, fx.rootId, 'Foo/Bar.MD')).toBe(id);
    expect(getResource(fx.db, id)?.missing).toBe(0);
    expect(getResource(fx.db, id)?.mtimeMs).not.toBe(before?.mtimeMs);
  });

  it('keeps the id when a same-path file is replaced and the inode changes', async () => {
    const fx = fix();
    const file = path.join(fx.root, 'note.txt');
    fs.writeFileSync(file, 'old-bytes');
    const id = ensureResource(fx.db, fx.rootId, 'note.txt');
    const beforeId = getResource(fx.db, id)?.fsFileId;
    expect(beforeId).toBeTruthy();
    const tmp = path.join(fx.root, 'note.txt.saving');
    fs.writeFileSync(tmp, 'replaced-by-editor');
    fs.unlinkSync(file);
    fs.renameSync(tmp, file);
    const ino = fs.statSync(file, { bigint: true }).ino.toString(10);
    expect(ino).not.toBe('0');
    expect(ino).not.toBe(beforeId);
    await reconcile(fx.db, fx.rootId);
    const after = getResource(fx.db, id);
    expect(after?.id).toBe(id);
    expect(after?.missing).toBe(0);
    expect(after?.relPath).toBe('note.txt');
    expect(after?.fsFileId).toBe(ino);
    const live = listResources(fx.db, fx.rootId).filter((row) => row.relPath === 'note.txt' && row.missing === 0);
    expect(live.map((row) => row.id)).toEqual([id]);
  });
});

describe('resolveInsideRoot', () => {
  it('rejects traversal, absolute paths, NUL, and an outside junction', async () => {
    const fx = fix();
    const outside = path.join(fx.dir, 'outside-secret');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret-marker');
    const junction = path.join(fx.root, 'junc-out');
    makeJunction(junction, outside);

    const escapes = [
      '../outside-secret/secret.txt',
      'Foo\\..\\..\\outside-secret\\secret.txt',
      'FOO/../../outside-secret/secret.txt',
      'junc-out',
      'junc-out/secret.txt',
      'junc-out\\secret.txt',
      'C:\\Windows\\notepad.exe',
      'foo\0bar',
    ];
    for (const rel of escapes) {
      let returned: string | undefined;
      try {
        returned = resolveInsideRoot(fx.db, fx.rootId, rel).absPath;
      } catch (error) {
        expect(error).toBeInstanceOf(PathEscapeError);
        expect((error as Error).message.toLowerCase()).not.toContain('outside-secret');
      }
      expect(returned).toBeUndefined();
    }

    await reconcile(fx.db, fx.rootId);
    const dumped = JSON.stringify(listResources(fx.db, fx.rootId));
    expect(dumped.toLowerCase()).not.toContain('secret');

    const sym = path.join(fx.root, 'sym-out');
    try {
      fs.symlinkSync(outside, sym, 'dir');
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      console.log('SYMLINK_CREATE_FAIL=' + message);
      return;
    }
    expect(() => resolveInsideRoot(fx.db, fx.rootId, 'sym-out')).toThrow(PathEscapeError);
    expect(() => resolveInsideRoot(fx.db, fx.rootId, 'sym-out/secret.txt')).toThrow(PathEscapeError);
    console.log('SYMLINK_PROBE=rejected');
  });
});

describe('watcher burst and cancel', () => {
  it('reports all 500 created files', async () => {
    const fx = fix();
    const seen = new Set<string>();
    const handle = await watchRoot(fx.db, fx.rootId, (event) => seen.add(event.resourceId));
    watches.push(handle);
    console.log('WATCH_BACKEND_500=' + handle.backend);
    for (let i = 0; i < 500; i += 1) {
      fs.writeFileSync(path.join(fx.root, `n${String(i).padStart(3, '0')}.txt`), `body-${i}\n`);
    }
    const deadline = Date.now() + 40_000;
    let missing: string[] = [];
    while (Date.now() < deadline) {
      await handle.whenIdle();
      missing = [];
      const rows = listResources(fx.db, fx.rootId);
      for (let i = 0; i < 500; i += 1) {
        const rel = `n${String(i).padStart(3, '0')}.txt`;
        const row = liveAt(rows, rel);
        if (!row || !seen.has(row.id)) missing.push(rel);
      }
      if (missing.length === 0) break;
    }
    expect(missing).toEqual([]);
  });

  it('stops a reconcile within one second of abort', async () => {
    const fx = fix();
    detectFileSystem(fx.root);
    for (let i = 0; i < 40; i += 1) fs.writeFileSync(path.join(fx.root, `c${i}.txt`), `c${i}`);
    await reconcile(fx.db, fx.rootId);
    const ac = new AbortController();
    const pending = reconcile(fx.db, fx.rootId, { signal: ac.signal, interFileDelayMs: 150 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(ReconcileCancelledError);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('simulated non-NTFS fallback does not trust fs_file_id and does not match on hash alone', async () => {
    const fx = fix();
    writeStable(path.join(fx.root, 'origin.txt'), 'fallback-unique');
    const id = ensureResource(fx.db, fx.rootId, 'origin.txt');
    const snap = getResource(fx.db, id);
    fs.renameSync(path.join(fx.root, 'origin.txt'), path.join(fx.root, 'renamed.txt'));
    await reconcile(fx.db, fx.rootId, { forceFileIdReliable: false, forceFileSystemName: 'FAT32' });
    expect(getResource(fx.db, id)?.relPath).toBe('renamed.txt');
    expect(getResource(fx.db, id)?.missing).toBe(0);
    expect(getResource(fx.db, id)?.fsFileId).toBeNull();

    const again = path.join(fx.root, 'other.txt');
    fs.copyFileSync(path.join(fx.root, 'renamed.txt'), again);
    fs.utimesSync(again, ((snap?.mtimeMs as number) + 60_000) / 1000, ((snap?.mtimeMs as number) + 60_000) / 1000);
    fs.unlinkSync(path.join(fx.root, 'renamed.txt'));
    await reconcile(fx.db, fx.rootId, { forceFileIdReliable: false, forceFileSystemName: 'FAT32' });
    expect(getResource(fx.db, id)?.missing).toBe(1);
    expect(liveAt(listResources(fx.db, fx.rootId), 'other.txt')?.id).not.toBe(id);
  });
});

function expectPartialUniqueOnly(db: Database.Database): void {
  const table = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resources'`).get() as { sql: string };
  expect(table.sql.toLowerCase()).not.toMatch(/unique\s*\(\s*root_id\s*,\s*rel_path/);
  const list = db.prepare(`PRAGMA index_list(resources)`).all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  expect(list.filter((row) => row.origin === 'u')).toEqual([]);
  const partial = list.filter((row) => row.unique === 1 && row.partial === 1);
  expect(partial.map((row) => row.name)).toEqual(['idx_resources_live_path']);
  const cols = db.prepare(`PRAGMA index_info(idx_resources_live_path)`).all() as { name: string }[];
  expect(cols.map((col) => col.name)).toEqual(['root_id', 'rel_path_key']);
  const index = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_resources_live_path'`).get() as { sql: string };
  const text = index.sql.replace(/"/g, '').replace(/\s+/g, ' ').toLowerCase();
  expect(text).toContain('create unique index');
  expect(text).toContain('on resources(root_id, rel_path_key)');
  expect(text).toContain('where missing = 0');
}

describe('v1.1 roots, partial unique index, and updateLocation', () => {
  it('keeps a missing same.txt and allocates a new id for different content', async () => {
    const fx = fix();
    const file = path.join(fx.root, 'same.txt');
    fs.writeFileSync(file, 'old-body');
    const oldId = ensureResource(fx.db, fx.rootId, 'same.txt');
    fs.unlinkSync(file);
    await reconcile(fx.db, fx.rootId);
    const stored = fx.db.prepare(`SELECT rel_path, missing FROM resources WHERE id = ?`).get(oldId) as {
      rel_path: string;
      missing: number;
    };
    expect(stored).toEqual({ rel_path: 'same.txt', missing: 1 });
    expect(resolveInsideRoot(fx.db, fx.rootId, 'same.txt').resourceId).toBeNull();

    fs.writeFileSync(file, 'new-body-different');
    const newId = ensureResource(fx.db, fx.rootId, 'same.txt');
    expect(newId).not.toBe(oldId);
    const rows = fx.db
      .prepare(`SELECT id, rel_path, missing FROM resources WHERE root_id = ? ORDER BY missing, id`)
      .all(fx.rootId) as { id: string; rel_path: string; missing: number }[];
    expect(rows).toEqual([
      { id: newId, rel_path: 'same.txt', missing: 0 },
      { id: oldId, rel_path: 'same.txt', missing: 1 },
    ]);
    expect(rows.some((row) => row.rel_path.includes('//'))).toBe(false);
    const listed = listResources(fx.db, fx.rootId).filter((row) => row.relPath === 'same.txt');
    expect(listed.map((row) => row.id).sort()).toEqual([oldId, newId].sort());
    expect(listed.find((row) => row.id === oldId)?.displaced).toBe(true);
    expect(listed.find((row) => row.id === newId)?.missing).toBe(0);
    expect(resolveInsideRoot(fx.db, fx.rootId, 'same.txt').resourceId).toBe(newId);

    const bundle = exportPortable(fx.db, fx.rootId);
    expect(JSON.stringify(bundle)).not.toContain('//missing');
    const db2 = new Database(path.join(fx.dir, 'roundtrip.sqlite'));
    try {
      migrate(db2);
      importPortable(db2, bundle);
      const again = db2
        .prepare(`SELECT id, rel_path, missing FROM resources ORDER BY missing, id`)
        .all() as { id: string; rel_path: string; missing: number }[];
      expect(again).toEqual([
        { id: newId, rel_path: 'same.txt', missing: 0 },
        { id: oldId, rel_path: 'same.txt', missing: 1 },
      ]);
    } finally {
      db2.close();
    }
  });

  it('createRoot does not mount; setMount is the only local_path writer', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-id-root-'));
    const db = new Database(path.join(dir, 'meta.sqlite'));
    try {
      migrate(db);
      migrate(db);
      expectPartialUniqueOnly(db);
      const id = createRoot(db, { id: 'fixed-root', name: '资料' });
      expect(id).toBe('fixed-root');
      expect(db.prepare(`SELECT COUNT(*) AS n FROM root_mounts`).get()).toEqual({ n: 0 });
      const generated = createRoot(db, { name: '另一个' });
      expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(db.prepare(`SELECT local_path FROM root_mounts`).all()).toEqual([]);
      const root = path.join(dir, 'root');
      expect(() => setMount(db, id, path.join(dir, 'nope'))).toThrow(/directory/);
      expect(() => setMount(db, 'no-such-root', root)).toThrow(/unknown root/);
      expect(db.prepare(`SELECT COUNT(*) AS n FROM root_mounts`).get()).toEqual({ n: 0 });
      fs.mkdirSync(root);
      setMount(db, id, root);
      const mount = db.prepare(`SELECT root_id, local_path FROM root_mounts`).all() as { root_id: string; local_path: string }[];
      expect(mount.map((row) => row.root_id)).toEqual([id]);
      expect(path.resolve(mount[0].local_path).toLowerCase()).toBe(fs.realpathSync(root).toLowerCase());
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('migrate drops legacy UNIQUE(root_id, rel_path) and restores //missing paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-id-mig-'));
    const db = new Database(path.join(dir, 'old.sqlite'));
    try {
      db.exec(`
        CREATE TABLE roots (
          id TEXT PRIMARY KEY,
          name TEXT,
          created_at INTEGER
        );
        CREATE TABLE root_mounts (
          root_id TEXT NOT NULL,
          machine_id TEXT NOT NULL,
          local_path TEXT NOT NULL,
          updated_at INTEGER,
          PRIMARY KEY (root_id, machine_id)
        );
        CREATE TABLE resources (
          id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL,
          rel_path TEXT NOT NULL,
          rel_path_key TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('file', 'dir')),
          size INTEGER,
          mtime_ms INTEGER,
          content_hash TEXT,
          fs_file_id TEXT,
          missing INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER,
          updated_at INTEGER,
          UNIQUE (root_id, rel_path),
          UNIQUE (root_id, rel_path_key)
        );
        INSERT INTO resources (
          id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash, fs_file_id, missing, created_at, updated_at
        ) VALUES
          ('live', 'r1', 'same.txt', 'same.txt', 'file', 4, 1, 'aaa', NULL, 0, 1, 1),
          ('old', 'r1', '//missing/old/same.txt', '//missing/old/same.txt', 'file', 4, 1, 'bbb', NULL, 1, 1, 1);
      `);
      migrate(db);
      migrate(db);
      expectPartialUniqueOnly(db);
      const rows = db.prepare(`SELECT id, rel_path, missing FROM resources ORDER BY id`).all();
      expect(rows).toEqual([
        { id: 'live', rel_path: 'same.txt', missing: 0 },
        { id: 'old', rel_path: 'same.txt', missing: 1 },
      ]);
      db.prepare(
        `INSERT INTO resources (
          id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash, fs_file_id, missing, created_at, updated_at
        ) VALUES ('older', 'r1', 'same.txt', 'same.txt', 'file', 1, 1, 'ccc', NULL, 1, 1, 1)`,
      ).run();
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM resources WHERE rel_path = 'same.txt'`).get() as { n: number }).n,
      ).toBe(3);
      expect(() => {
        db.prepare(
          `INSERT INTO resources (
            id, root_id, rel_path, rel_path_key, kind, size, mtime_ms, content_hash, fs_file_id, missing, created_at, updated_at
          ) VALUES ('other', 'r1', 'same.txt', 'same.txt', 'file', 1, 1, 'ddd', NULL, 0, 1, 1)`,
        ).run();
      }).toThrow(/UNIQUE/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('updateLocation keeps the id, clears missing, and does not insert', async () => {
    const fx = fix();
    fs.writeFileSync(path.join(fx.root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(fx.root, 'b.txt'), 'beta');
    const idA = ensureResource(fx.db, fx.rootId, 'a.txt');
    const idB = ensureResource(fx.db, fx.rootId, 'b.txt');
    const before = { rootId: fx.rootId, relPath: 'a.txt' };
    expect(() => updateLocation(fx.db, 'no-such', before, { rootId: fx.rootId, relPath: 'c.txt' })).toThrow(/unknown resource/);
    expect(() => updateLocation(fx.db, idA, { rootId: fx.rootId, relPath: 'nope.txt' }, { rootId: fx.rootId, relPath: 'c.txt' })).toThrow(
      /before\.relPath/,
    );
    expect(() => updateLocation(fx.db, idA, before, { rootId: 'other-root', relPath: 'c.txt' })).toThrow(/after\.rootId/);
    expect(() => updateLocation(fx.db, idA, { rootId: fx.rootId, relPath: '../x' }, { rootId: fx.rootId, relPath: 'c.txt' })).toThrow(
      PathEscapeError,
    );
    expect(() => updateLocation(fx.db, idA, before, { rootId: fx.rootId, relPath: 'b.txt' })).toThrow(/already uses/);
    expect(getResource(fx.db, idA)?.relPath).toBe('a.txt');
    expect(getResource(fx.db, idB)?.relPath).toBe('b.txt');

    fs.unlinkSync(path.join(fx.root, 'a.txt'));
    await reconcile(fx.db, fx.rootId);
    expect(fx.db.prepare(`SELECT rel_path, missing FROM resources WHERE id = ?`).get(idA)).toEqual({
      rel_path: 'a.txt',
      missing: 1,
    });
    const meta = fx.db
      .prepare(`SELECT root_id, size, mtime_ms, content_hash, fs_file_id FROM resources WHERE id = ?`)
      .get(idA);
    updateLocation(fx.db, idA, { rootId: fx.rootId, relPath: 'A.TXT' }, { rootId: fx.rootId, relPath: 'Gone.TXT' });
    expect(
      fx.db.prepare(`SELECT root_id, size, mtime_ms, content_hash, fs_file_id FROM resources WHERE id = ?`).get(idA),
    ).toEqual(meta);
    expect(fx.db.prepare(`SELECT id, rel_path, rel_path_key, missing FROM resources WHERE id = ?`).get(idA)).toEqual({
      id: idA,
      rel_path: 'Gone.TXT',
      rel_path_key: 'gone.txt',
      missing: 0,
    });
    const ids = fx.db.prepare(`SELECT id FROM resources`).all() as { id: string }[];
    expect(ids.map((row) => row.id).sort()).toEqual([idA, idB].sort());
    expect(JSON.stringify(fx.db.prepare(`SELECT rel_path FROM resources`).all())).not.toContain('//missing');
  });

  it('updateLocation moves a row onto another existing root and keeps the id', () => {
    const fx = fix();
    const rootBDir = path.join(fx.dir, 'root-b');
    fs.mkdirSync(rootBDir);
    const rootB = createRoot(fx.db, { name: '根B' });
    setMount(fx.db, rootB, rootBDir);
    fs.writeFileSync(path.join(fx.root, 'a.txt'), 'alpha');
    fs.writeFileSync(path.join(rootBDir, 'taken.txt'), 'taken');
    const idA = ensureResource(fx.db, fx.rootId, 'a.txt');
    const idTaken = ensureResource(fx.db, rootB, 'taken.txt');
    const meta = fx.db
      .prepare(`SELECT size, mtime_ms, content_hash, fs_file_id FROM resources WHERE id = ?`)
      .get(idA);
    const countBefore = (fx.db.prepare(`SELECT COUNT(*) AS n FROM resources`).get() as { n: number }).n;

    const wrongBefore = fx.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(idA);
    expect(() =>
      updateLocation(fx.db, idA, { rootId: rootB, relPath: 'a.txt' }, { rootId: rootB, relPath: 'z.txt' }),
    ).toThrow(/before\.rootId/);
    expect(fx.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(idA)).toEqual(wrongBefore);

    const clashBefore = fx.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(idA);
    expect(() =>
      updateLocation(fx.db, idA, { rootId: fx.rootId, relPath: 'a.txt' }, { rootId: rootB, relPath: 'taken.txt' }),
    ).toThrow(/already uses/);
    expect(fx.db.prepare(`SELECT * FROM resources WHERE id = ?`).get(idA)).toEqual(clashBefore);
    expect(getResource(fx.db, idTaken)?.relPath).toBe('taken.txt');
    expect(getResource(fx.db, idTaken)?.rootId).toBe(rootB);

    updateLocation(fx.db, idA, { rootId: fx.rootId, relPath: 'a.txt' }, { rootId: rootB, relPath: 'from-a.txt' });
    expect(getResource(fx.db, idA)?.id).toBe(idA);
    expect(getResource(fx.db, idA)?.rootId).toBe(rootB);
    expect(getResource(fx.db, idA)?.relPath).toBe('from-a.txt');
    expect(getResource(fx.db, idA)?.missing).toBe(0);
    expect(
      fx.db.prepare(`SELECT id FROM resources WHERE root_id = ? AND id = ? AND missing = 0`).get(fx.rootId, idA),
    ).toBeUndefined();
    expect(
      fx.db.prepare(`SELECT size, mtime_ms, content_hash, fs_file_id FROM resources WHERE id = ?`).get(idA),
    ).toEqual(meta);
    expect((fx.db.prepare(`SELECT COUNT(*) AS n FROM resources`).get() as { n: number }).n).toBe(countBefore);
  });
});
