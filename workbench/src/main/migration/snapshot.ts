/**
 * 元数据库的一致快照与整表替换（导出、导入前备份、导入、回退共用）。
 * - 快照：VACUUM INTO（单条语句在一个读事务里完成：WAL 模式下其他连接——索引 worker——同时写入也不影响快照的一致性），
 *   不直接复制正在写的 workbench.db / -wal 文件。
 * - 替换：ATTACH 源库，在一个 IMMEDIATE 事务里清空并重新填充目标表（defer_foreign_keys + foreign_key_check），
 *   失败整体回滚；FTS 索引按 resources 重建。
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import type { DB } from '../service/db';

export function vacuumInto(db: DB, file: string) {
  fs.rmSync(file, { force: true });
  db.prepare('VACUUM INTO ?').run(file);
}

export function integrityCheck(file: string): string {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = d.pragma('integrity_check') as { integrity_check: string }[];
    return rows.map((r) => r.integrity_check).join('; ');
  } finally {
    d.close();
  }
}

export function userVersion(file: string): number {
  const d = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return d.pragma('user_version', { simple: true }) as number;
  } finally {
    d.close();
  }
}

interface TableInfo {
  /** 普通表（不含 sqlite_* 与 FTS 影子表） */
  tables: string[];
  virtual: string[];
}

export function listTables(db: DB, schema = 'main'): TableInfo {
  const rows = db.prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type='table'`).all() as { name: string; sql: string | null }[];
  const virtual = rows.filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')).map((r) => r.name);
  const shadow = (n: string) => virtual.some((v) => n.startsWith(v + '_'));
  const tables = rows.filter((r) => !r.name.startsWith('sqlite_') && !virtual.includes(r.name) && !shadow(r.name)).map((r) => r.name);
  return { tables, virtual };
}

export function columns(db: DB, table: string, schema = 'main'): string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${q(table)})`).all() as { name: string }[]).map((r) => r.name);
}

export function q(id: string) {
  return '"' + id.replace(/"/g, '""') + '"';
}

/** 依据 resources 重建文件名/路径全文索引（规则与 indexer.setFts 相同：根本身与缺失的资源不进索引） */
export function rebuildFts(db: DB) {
  db.exec(`DELETE FROM resources_fts;
    INSERT INTO resources_fts(resource_id, root_id, rel_path, name)
      SELECT id, root_id, rel_path, name FROM resources WHERE missing_since IS NULL AND rel_path <> '';`);
}

export interface ReplaceOptions {
  /** 要替换的表；省略 = 两边都有的所有普通表 */
  tables?: string[];
  /** 替换后、提交前在同一事务内执行（导入：写 root_mounts、调整 missing_since） */
  inTransaction?: (db: DB) => void;
  /** layout 表中保留目标库原值、不被源覆盖的键 */
  keepLayoutKey?: RegExp;
}

/** 用 srcFile 的内容整表替换 db 中的表（单事务，失败回滚）。返回每张表写入的行数。 */
export function replaceTablesFrom(db: DB, srcFile: string, opts: ReplaceOptions = {}): Record<string, number> {
  db.prepare('ATTACH DATABASE ? AS kbsrc').run(srcFile);
  try {
    const mainT = new Set(listTables(db, 'main').tables);
    const srcT = new Set(listTables(db, 'kbsrc').tables);
    const wanted = (opts.tables ?? [...mainT]).filter((t) => mainT.has(t));
    const counts: Record<string, number> = {};
    db.transaction(() => {
      db.pragma('defer_foreign_keys = ON');
      for (const t of wanted) {
        if (t === 'layout' && opts.keepLayoutKey) {
          const keep = opts.keepLayoutKey;
          const del = db.prepare('DELETE FROM main.layout WHERE key=?');
          for (const r of db.prepare('SELECT key FROM main.layout').all() as { key: string }[]) if (!keep.test(r.key)) del.run(r.key);
        } else db.exec(`DELETE FROM main.${q(t)}`);
      }
      for (const t of wanted) {
        if (!srcT.has(t)) {
          counts[t] = 0;
          continue;
        }
        const srcCols = new Set(columns(db, t, 'kbsrc'));
        const cols = columns(db, t, 'main').filter((c) => srcCols.has(c)).map(q).join(', ');
        if (t === 'layout' && opts.keepLayoutKey) {
          const keep = opts.keepLayoutKey;
          const keyIdx = cols.split(', ').indexOf('"key"');
          const ins = db.prepare(`INSERT OR REPLACE INTO main.layout(${cols}) VALUES (${cols.split(', ').map(() => '?').join(', ')})`);
          let n = 0;
          for (const r of db.prepare(`SELECT ${cols} FROM kbsrc.layout`).raw().all() as unknown[][]) {
            if (keep.test(String(r[keyIdx]))) continue;
            ins.run(...r);
            n++;
          }
          counts[t] = n;
        } else counts[t] = db.prepare(`INSERT INTO main.${q(t)}(${cols}) SELECT ${cols} FROM kbsrc.${q(t)}`).run().changes;
      }
      opts.inTransaction?.(db);
      rebuildFts(db);
      const bad = db.pragma('foreign_key_check') as unknown[];
      if (bad.length) throw new Error(`外键检查失败（${bad.length} 处），已回滚：${JSON.stringify(bad.slice(0, 3))}`);
    }).immediate();
    return counts;
  } finally {
    db.prepare('DETACH DATABASE kbsrc').run();
  }
}
