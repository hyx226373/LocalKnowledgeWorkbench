import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../modules-r11-E-3888323/indexer/src/migrate.ts';
import { openDatabase } from '../../modules-r11-E-3888323/indexer/src/sqlite.ts';
import { IndexStore, compactTextIndex } from '../../modules-r11-E-3888323/indexer/src/store.ts';

const dir = mkdtempSync(path.join(tmpdir(), 'kb-fts-chunk-'));
const db = openDatabase(path.join(dir, 'index.sqlite'));
migrate(db);
const store = new IndexStore(db);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('全文分批提交', () => {
  it('超过一批的页数能写完再整份删掉', () => {
    const pages = Array.from({ length: 300 }, (_, i) => ({
      page: 0,
      title: '笔记',
      body: `第${i}段 三角函数与状态方程`,
      lineStart: i * 20 + 1,
    }));
    store.write(
      { resourceId: 'fat', rootId: 'root', relPath: '专业课/笔记.md', size: 3000, mtimeMs: 10, pages },
      undefined,
      'batch',
    );
    const written = db.prepare('SELECT COUNT(*) AS c FROM fts_content WHERE resource_id = ?').get('fat') as { c: number };
    expect(written.c).toBe(300);
    const removed = store.removeUnseen('root', new Set());
    expect(removed).toEqual(['专业课/笔记.md']);
    const left = db.prepare('SELECT COUNT(*) AS c FROM fts_content').get() as { c: number };
    const files = db.prepare('SELECT COUNT(*) AS c FROM indexer_files').get() as { c: number };
    expect(left.c).toBe(0);
    expect(files.c).toBe(0);
    expect(compactTextIndex(db)).toBe(0);
  });
});
