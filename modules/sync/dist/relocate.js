import { statSync } from 'node:fs';
import { bigramTokenize, ftsShortTitle } from "./bigram.js";
import { fileTitle, normalizeRel, relKeyOf } from "./paths.js";
export { ftsShortTitle };
/**
 * 改名或移动只更新索引里的位置。不读文件内容，不重新抽正文。
 * `resource_id` 保持不变。
 */
export function relocateResource(db, input) {
    if (!input.resourceId)
        throw new Error('resourceId 不能为空');
    const relPath = normalizeRel(input.relPath);
    const title = fileTitle(relPath);
    const st = statSync(input.absPath);
    if (!st.isFile())
        throw new Error('改名目标不是文件');
    const size = st.size;
    const mtimeMs = Math.round(st.mtimeMs);
    const kind = tokenizerOf(db);
    const hasShort = tableExists(db, 'fts_short');
    const tx = db.transaction(() => {
        db.prepare(`UPDATE indexer_files
       SET rel_path = ?, rel_key = ?, size = ?, mtime_ms = ?, updated_at = ?
       WHERE resource_id = ?`).run(relPath, relKeyOf(relPath), size, mtimeMs, Date.now(), input.resourceId);
        rewriteContent(db, input.resourceId, kind, title);
        if (hasShort)
            rewriteShort(db, input.resourceId, title, relPath);
    });
    tx();
}
function tokenizerOf(db) {
    const row = db.prepare(`SELECT value FROM indexer_meta WHERE key = 'tokenizer'`).get();
    if (row?.value === 'trigram' || row?.value === 'bigram')
        return row.value;
    throw new Error('indexer_meta 缺少 tokenizer，请先 migrate');
}
function tableExists(db, name) {
    const row = db
        .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name);
    return !!row;
}
function columnsOf(db, table) {
    const rows = db.prepare(`PRAGMA table_info(${ident(table)})`).all();
    return rows.map((row) => row.name);
}
function ident(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`非法标识符: ${name}`);
    return `"${name}"`;
}
function rewriteContent(db, resourceId, kind, title) {
    rewriteRows(db, 'fts_content', resourceId, (row) => {
        if (kind === 'bigram') {
            row.title = bigramTokenize(title);
            if ('title_text' in row)
                row.title_text = title;
            return;
        }
        row.title = title;
    });
}
function rewriteShort(db, resourceId, title, relPath) {
    rewriteRows(db, 'fts_short', resourceId, (row) => {
        if ('title' in row)
            row.title = ftsShortTitle(title, relPath);
        if ('title_text' in row)
            row.title_text = title;
        if ('path_text' in row)
            row.path_text = relPath;
    });
}
/** 按 resource_id 读出每一行，删掉再插入。调用方只改位置列，正文原样留在 row 里。 */
function rewriteRows(db, table, resourceId, mutate) {
    if (!tableExists(db, table))
        return;
    const cols = columnsOf(db, table);
    if (!cols.includes('resource_id'))
        return;
    const listed = cols.map(ident).join(', ');
    const rows = db
        .prepare(`SELECT rowid AS rowid, ${listed} FROM ${ident(table)} WHERE resource_id = ?`)
        .all(resourceId);
    if (rows.length === 0)
        return;
    const del = db.prepare(`DELETE FROM ${ident(table)} WHERE rowid = ?`);
    const insert = db.prepare(`INSERT INTO ${ident(table)} (${listed}) VALUES (${cols.map(() => '?').join(', ')})`);
    for (const row of rows) {
        const copy = {};
        for (const col of cols)
            copy[col] = row[col] ?? null;
        mutate(copy);
        del.run(row.rowid);
        insert.run(...cols.map((col) => copy[col] ?? null));
    }
}
//# sourceMappingURL=relocate.js.map