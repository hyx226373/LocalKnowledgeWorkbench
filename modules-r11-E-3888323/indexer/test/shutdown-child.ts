import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { closeIndexer, migrate, startIndex } from '../src/index.ts';
import { openDatabase } from '../src/sqlite.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'kb-indexer-shutdown-'));
const corpus = path.join(tmp, 'corpus');
const dbPath = path.join(tmp, 'index.sqlite');
mkdirSync(corpus);
writeFileSync(path.join(corpus, 'a.txt'), '关闭索引测试甲乙丙丁\n', 'utf8');
const db = openDatabase(dbPath);

try {
  migrate(db);
  const result = await startIndex({
    rootId: 'root-shutdown',
    localPath: corpus,
    dbPath,
    resolveResourceId: () => 'res-shutdown',
  }).done;
  if (result.status !== 'completed' || result.errors.length > 0) {
    throw new Error(`index ${result.status} ${JSON.stringify(result.errors)}`);
  }
  await closeIndexer();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
} catch (err) {
  console.error(err);
  try {
    db.close();
  } catch {
    // 已经关过
  }
  process.exit(1);
}
