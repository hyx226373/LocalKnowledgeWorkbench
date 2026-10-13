import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { markTextIndexVersion, migrate, TEXT_INDEX_VERSION } from '../src/migrate.ts';
import { openDatabase } from '../src/sqlite.ts';
import { IndexStore } from '../src/store.ts';
import type { SqliteDb } from '../src/types.ts';

const dirs: string[] = [];
const dbs: SqliteDb[] = [];

function changes(db: SqliteDb): number {
  return (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
}

function openTemp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'kb-idle-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'index.sqlite'));
  dbs.push(db);
  migrate(db);
  return db;
}

afterEach(async () => {
  while (dbs.length) {
    try { dbs.pop()!.close(); } catch { /* 已经关过 */ }
  }
  while (dirs.length) {
    const dir = dirs.pop()!;
    for (let i = 0; i < 6; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
});

describe('路径和版本文本没变就不写', () => {
  it('upsertRoot 的 local_path 相同则不写 updated_at', () => {
    const db = openTemp();
    const store = new IndexStore(db);
    store.upsertRoot('root-a', 'D:\\notes');
    db.prepare('UPDATE indexer_roots SET updated_at = 100 WHERE root_id = ?').run('root-a');
    const before = changes(db);
    store.upsertRoot('root-a', 'D:\\notes');
    const same = db.prepare('SELECT local_path, updated_at FROM indexer_roots WHERE root_id = ?').get('root-a') as {
      local_path: string;
      updated_at: number;
    };
    expect(same).toEqual({ local_path: 'D:\\notes', updated_at: 100 });
    expect(changes(db)).toBe(before);

    store.upsertRoot('root-a', 'D:\\other');
    const moved = db.prepare('SELECT local_path, updated_at FROM indexer_roots WHERE root_id = ?').get('root-a') as {
      local_path: string;
      updated_at: number;
    };
    expect(moved.local_path).toBe('D:\\other');
    expect(moved.updated_at).not.toBe(100);
    expect(changes(db)).toBeGreaterThan(before);

    store.upsertRoot('root-b', 'D:\\notes');
    const other = db.prepare('SELECT local_path FROM indexer_roots WHERE root_id = ?').get('root-b') as { local_path: string };
    expect(other.local_path).toBe('D:\\notes');
  });

  it('markTextIndexVersion 已经是 2 则不写', () => {
    const db = openTemp();
    expect(TEXT_INDEX_VERSION).toBe('2');
    db.prepare(`INSERT INTO indexer_meta(key, value) VALUES ('text_index_version', '2')`).run();
    const seeded = changes(db);
    markTextIndexVersion(db);
    expect(changes(db)).toBe(seeded);
    expect((db.prepare(`SELECT value FROM indexer_meta WHERE key = 'text_index_version'`).get() as { value: string }).value).toBe('2');

    db.prepare(`UPDATE indexer_meta SET value = '1' WHERE key = 'text_index_version'`).run();
    const edited = changes(db);
    markTextIndexVersion(db);
    expect(changes(db)).toBeGreaterThan(edited);
    expect((db.prepare(`SELECT value FROM indexer_meta WHERE key = 'text_index_version'`).get() as { value: string }).value).toBe('2');
    const again = changes(db);
    markTextIndexVersion(db);
    expect(changes(db)).toBe(again);
  });
});
