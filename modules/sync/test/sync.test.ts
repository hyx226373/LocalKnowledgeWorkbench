import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { createRoot, migrate as migrateIdentity, setMount } from '@kb/identity-watch';
import { migrate as migrateIndex, search, tokenizerKind } from '@kb/indexer';
import { bigramTokenize } from '../src/bigram.ts';
import { createSync, type SyncHandle } from '../src/index.ts';
import { makeTemp, removeDir, startLagProbe, writePdf } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof BetterSqlite3;

function openKb(dbPath: string): BetterSqlite3.Database {
  const db = new Database(dbPath);
  migrateIdentity(db);
  migrateIndex(db);
  return db;
}

async function expectIdle(handle: SyncHandle, label: string): Promise<void> {
  const started = Date.now();
  await handle.whenIdle();
  const elapsed = Date.now() - started;
  expect(elapsed, `${label} whenIdle ${elapsed}ms`).toBeLessThan(8000);
}

function copyMany(dir: string, count: number): Promise<void> {
  const script = `
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const n = Number(process.argv[3]);
fs.mkdirSync(dir, { recursive: true });
const sab = new Int32Array(new SharedArrayBuffer(4));
for (let i = 0; i < n; i++) {
  const id = String(i).padStart(4, '0');
  fs.writeFileSync(path.join(dir, 'n' + id + '.txt'), 'mark' + id + 'word\\n', 'utf8');
  if (i % 16 === 15) Atomics.wait(sab, 0, 0, 40);
}
`;
  const file = path.join(path.dirname(dir), 'copy-batch.cjs');
  writeFileSync(file, script, 'utf8');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, dir, String(count)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`copy exited ${code}: ${err}`));
    });
  });
}

function poisonBody(db: BetterSqlite3.Database, resourceId: string, poisonWord: string): void {
  const kind = tokenizerKind(db);
  const cols = (db.prepare(`PRAGMA table_info(fts_content)`).all() as Array<{ name: string }>).map(
    (col) => col.name,
  );
  const rows = db
    .prepare(`SELECT rowid AS rowid, ${cols.join(', ')} FROM fts_content WHERE resource_id = ?`)
    .all(resourceId) as Array<Record<string, unknown>>;
  const del = db.prepare(`DELETE FROM fts_content WHERE rowid = ?`);
  const insert = db.prepare(
    `INSERT INTO fts_content (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  );
  const tx = db.transaction(() => {
    for (const row of rows) {
      const copy: Record<string, unknown> = { ...row };
      if (kind === 'bigram') {
        const raw = `${String(copy.body_text ?? '')}\n${poisonWord}`;
        copy.body_text = raw;
        copy.body = bigramTokenize(raw);
      } else {
        copy.body = `${String(copy.body ?? '')}\n${poisonWord}`;
      }
      del.run(copy.rowid);
      insert.run(...cols.map((name) => copy[name] ?? null));
    }
  });
  tx();
}

describe('应用外改文件', () => {
  const tmp = makeTemp('kb-sync-fs-');
  const root = path.join(tmp, 'root');
  const dbPath = path.join(tmp, 'kb.sqlite');
  mkdirSync(root, { recursive: true });
  const db = openKb(dbPath);
  const rootId = createRoot(db, { name: '资料' });
  setMount(db, rootId, root);
  const sync = createSync({
    db,
    dbPath,
    resolveLocalPath: () => root,
  });
  let handle: SyncHandle;

  afterAll(async () => {
    try {
      handle?.cancel();
      if (handle) await handle.done;
    } catch {
      // 已经结束
    }
    try {
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it('新建、修改、改名、删除 md 和 pdf，8 秒内能搜到', async () => {
    handle = sync.startSync(rootId);
    const phases: string[] = [];
    handle.onProgress((progress) => {
      phases.push(progress.phase);
      expect(typeof progress.seen).toBe('number');
      expect(typeof progress.pending).toBe('number');
      expect(typeof progress.dirty).toBe('boolean');
      expect(progress.currentFile === null || typeof progress.currentFile === 'string').toBe(true);
    });
    expect(sync.startSync(rootId)).toBe(handle);

    await writePdf(path.join(root, 'warmup.pdf'), 'WarmupWordPdf');
    writeFileSync(path.join(root, 'warmup.md'), 'WarmupWordMd\n', 'utf8');
    await handle.whenIdle();
    expect(phases).toContain('reconcile');
    expect(phases).toContain('index');
    expect(search(db, 'WarmupWordPdf', { limit: 3, rootIds: [rootId] }).length).toBeGreaterThan(0);
    expect(search(db, 'WarmupWordMd', { limit: 3, rootIds: [rootId] }).length).toBeGreaterThan(0);
    rmSync(path.join(root, 'warmup.pdf'));
    rmSync(path.join(root, 'warmup.md'));
    await handle.whenIdle();

    const mdPath = path.join(root, 'note.md');
    const pdfPath = path.join(root, 'doc.pdf');
    writeFileSync(mdPath, 'MdCreateWord\n笔记正文甲乙\n', 'utf8');
    await writePdf(pdfPath, 'PdfCreateWord');
    await expectIdle(handle, 'create');

    const mdHit = search(db, '笔记正文甲乙', { limit: 5, rootIds: [rootId] });
    const pdfHit = search(db, 'PdfCreateWord', { limit: 5, rootIds: [rootId] });
    expect(mdHit.length, 'md create').toBeGreaterThan(0);
    expect(pdfHit.length, 'pdf create').toBeGreaterThan(0);
    const mdId = mdHit[0]!.resourceId;
    const pdfId = pdfHit[0]!.resourceId;
    expect(mdHit[0]!.title).toBe('note.md');
    expect(pdfHit[0]!.title).toBe('doc.pdf');

    writeFileSync(mdPath, 'MdModifyWord\n笔记正文甲乙\n', 'utf8');
    await writePdf(pdfPath, 'PdfModifyWord');
    await expectIdle(handle, 'modify');
    expect(search(db, 'MdCreateWord', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(search(db, 'PdfCreateWord', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(search(db, 'MdModifyWord', { limit: 5, rootIds: [rootId] })[0]?.resourceId).toBe(mdId);
    expect(search(db, 'PdfModifyWord', { limit: 5, rootIds: [rootId] })[0]?.resourceId).toBe(pdfId);

    poisonBody(db, mdId, 'PoisonKeepWord');
    expect(search(db, 'PoisonKeepWord', { limit: 5, rootIds: [rootId] })[0]?.resourceId).toBe(mdId);

    mkdirSync(path.join(root, '归档'), { recursive: true });
    const mdNext = path.join(root, '归档', '新笔记.md');
    const pdfNext = path.join(root, '归档', '新文档.pdf');
    renameSync(mdPath, mdNext);
    renameSync(pdfPath, pdfNext);
    await expectIdle(handle, 'rename');

    const mdRenamed = search(db, '笔记正文甲乙', { limit: 5, rootIds: [rootId] });
    const pdfRenamed = search(db, 'PdfModifyWord', { limit: 5, rootIds: [rootId] });
    expect(mdRenamed[0]?.resourceId).toBe(mdId);
    expect(pdfRenamed[0]?.resourceId).toBe(pdfId);
    expect(mdRenamed[0]?.title).toBe('新笔记.md');
    expect(pdfRenamed[0]?.title).toBe('新文档.pdf');
    expect(search(db, 'PoisonKeepWord', { limit: 5, rootIds: [rootId] })[0]?.resourceId).toBe(mdId);
    const mdRow = db
      .prepare(`SELECT rel_path AS relPath FROM indexer_files WHERE resource_id = ?`)
      .get(mdId) as { relPath: string };
    const pdfRow = db
      .prepare(`SELECT rel_path AS relPath FROM indexer_files WHERE resource_id = ?`)
      .get(pdfId) as { relPath: string };
    expect(mdRow.relPath).toBe('归档/新笔记.md');
    expect(pdfRow.relPath).toBe('归档/新文档.pdf');

    rmSync(mdNext);
    rmSync(pdfNext);
    await expectIdle(handle, 'delete');
    expect(search(db, '笔记正文甲乙', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(search(db, 'MdModifyWord', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(search(db, 'PdfModifyWord', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(search(db, 'PoisonKeepWord', { limit: 5, rootIds: [rootId] })).toEqual([]);
    expect(
      db.prepare(`SELECT 1 AS ok FROM indexer_files WHERE resource_id = ?`).get(mdId),
    ).toBeUndefined();
    expect(
      db.prepare(`SELECT 1 AS ok FROM indexer_files WHERE resource_id = ?`).get(pdfId),
    ).toBeUndefined();
  });
});

describe('一次复制 1000 个文件', () => {
  const tmp = makeTemp('kb-sync-bulk-');
  const root = path.join(tmp, 'root');
  const dbPath = path.join(tmp, 'kb.sqlite');
  mkdirSync(root, { recursive: true });
  const db = openKb(dbPath);
  const rootId = createRoot(db, { name: '批量' });
  setMount(db, rootId, root);
  const sync = createSync({
    db,
    dbPath,
    resolveLocalPath: () => root,
  });
  let handle: SyncHandle | undefined;

  afterAll(async () => {
    try {
      handle?.cancel();
      if (handle) await handle.done;
    } catch {
      // 已经结束
    }
    try {
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it('主线程 setInterval(20ms) 漂移不超过 50ms，标记词都能搜到', async () => {
    const probe = startLagProbe(20);
    handle = sync.startSync(rootId);
    await copyMany(root, 1000);
    await handle.whenIdle();
    const lag = probe.stop();
    console.log(
      `SYNC_LAG ${JSON.stringify({ maxLagMs: Number(lag.maxDrift.toFixed(2)), atMs: Number(lag.atMs.toFixed(1)) })}`,
    );
    expect(
      lag.maxDrift,
      `主线程 setInterval(20ms) 最大漂移 ${lag.maxDrift.toFixed(2)} ms`,
    ).toBeLessThanOrEqual(50);

    const indexed = db.prepare(`SELECT COUNT(*) AS n FROM indexer_files WHERE root_id = ?`).get(rootId) as {
      n: number;
    };
    expect(indexed.n).toBe(1000);
    for (let i = 0; i < 1000; i += 1) {
      const id = String(i).padStart(4, '0');
      const hits = search(db, `mark${id}word`, { limit: 3, rootIds: [rootId] });
      expect(hits.length, `mark${id}word`).toBeGreaterThan(0);
      expect(hits[0]?.title).toBe(`n${id}.txt`);
    }
  });
});

describe('取消后能续上', () => {
  const tmp = makeTemp('kb-sync-cancel-');
  const root = path.join(tmp, 'root');
  const dbPath = path.join(tmp, 'kb.sqlite');
  mkdirSync(root, { recursive: true });
  const db = openKb(dbPath);
  const rootId = createRoot(db, { name: '取消' });
  setMount(db, rootId, root);
  const sync = createSync({
    db,
    dbPath,
    resolveLocalPath: () => root,
  });
  const handles: SyncHandle[] = [];

  afterAll(async () => {
    for (const handle of handles) {
      try {
        handle.cancel();
        await handle.done;
      } catch {
        // 已经结束
      }
    }
    try {
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it('立刻 cancel 得到 cancelled，索引不损坏，再次同步后全部可搜', async () => {
    for (let i = 0; i < 6; i += 1) {
      const id = String(i).padStart(4, '0');
      writeFileSync(path.join(root, `c${id}.txt`), `cancel${id}word\n`, 'utf8');
    }
    const first = sync.startSync(rootId);
    handles.push(first);
    first.cancel();
    const stopped = await first.done;
    expect(stopped.status).toBe('cancelled');
    expect(() => search(db, 'cancel0000word', { limit: 5, rootIds: [rootId] })).not.toThrow();
    assertIndexIntact(db);

    const second = sync.startSync(rootId);
    handles.push(second);
    expect(second).not.toBe(first);
    await second.whenIdle();
    for (let i = 0; i < 6; i += 1) {
      const id = String(i).padStart(4, '0');
      const hits = search(db, `cancel${id}word`, { limit: 3, rootIds: [rootId] });
      expect(hits.length, `cancel${id}word`).toBeGreaterThan(0);
      expect(hits[0]?.title).toBe(`c${id}.txt`);
    }
    assertIndexIntact(db);
  });
});

/** PASSIVE 不重置 WAL。监视连接还在时，PRAGMA integrity_check 会误报 fts_short 校验和。 */
function assertIndexIntact(db: BetterSqlite3.Database): void {
  db.pragma('wal_checkpoint(RESTART)');
  db.prepare(`INSERT INTO fts_content(fts_content) VALUES ('integrity-check')`).run();
  db.prepare(`INSERT INTO fts_short(fts_short) VALUES ('integrity-check')`).run();
  const rows = db.prepare(`PRAGMA integrity_check`).all() as Array<{ integrity_check: string }>;
  expect(rows.map((row) => row.integrity_check)).toEqual(['ok']);
}
