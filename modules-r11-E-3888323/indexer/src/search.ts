import { ftsHasLineStart, readTextIndexVersion, tokenizerKind, trigramStyle } from './migrate.ts';
import { makeSnippet } from './snippet.ts';
import { buildMatchQuery } from './tokenize.ts';
import type {
  GroupedHit,
  GroupedMatch,
  GroupedSearchResult,
  SearchHit,
  SearchOptions,
  SqliteDb,
} from './types.ts';

/** 每个资料最多 3 条 match，再留一点余量，避免 LIMIT 刚好卡在同一文件的块上。 */
const MATCHES_PER_FILE = 3;
const ROW_LIMIT_MARGIN = 8;

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(Math.floor(limit), 1000);
}

export function search(db: SqliteDb, query: string, opts: SearchOptions = {}): SearchHit[] {
  const limit = normalizeLimit(opts.limit);
  if (limit === 0) return [];
  const kind = tokenizerKind(db);
  const match = buildMatchQuery(query, kind, trigramStyle(db));
  if (!match) return [];

  const titleExpr = kind === 'bigram' ? 'title_text' : 'title';
  const bodyExpr = kind === 'bigram' ? 'body_text' : 'body';
  const params: Array<string | number> = [match];
  let rootSql = '';
  if (opts.rootIds) {
    if (opts.rootIds.length === 0) return [];
    rootSql = ` AND root_id IN (${opts.rootIds.map(() => '?').join(',')})`;
    params.push(...opts.rootIds);
  }
  params.push(limit);
  const sql = `
    SELECT resource_id AS resourceId,
           page AS page,
           ${titleExpr} AS title,
           ${bodyExpr} AS body,
           bm25(fts_content) AS bm
    FROM fts_content
    WHERE fts_content MATCH ?
    ${rootSql}
    ORDER BY bm
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(...params) as Array<{
    resourceId: string | null;
    page: number | string | null;
    title: string | null;
    body: string | null;
    bm: number | null;
  }>;
  return rows.map((row) => {
    const title = String(row.title ?? '');
    const body = String(row.body ?? '');
    const bm = Number(row.bm ?? 0);
    return {
      resourceId: String(row.resourceId ?? ''),
      page: Number(row.page ?? 0),
      title,
      snippet: makeSnippet(title, body, query),
      score: Number.isFinite(bm) ? -bm : 0,
    };
  });
}

function normalizeGroupLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

function codePointLength(text: string): number {
  return [...text].length;
}

function containsQuery(hay: string, needle: string): boolean {
  if (!needle) return false;
  return hay.normalize('NFC').toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

interface RawHit {
  resourceId: string;
  rootId: string;
  relPath: string;
  title: string;
  body: string;
  page: number;
  bm: number;
  lineStart: number;
  /** 只有路径命中、没有正文页。snippet 用相对路径。 */
  pathOnly?: boolean;
  /** 该 PDF 已索引的最小页码。路径单独命中时页码和锚点都用它，不另造。 */
  anchorPage?: number;
}

function sqlRowLimit(groupLimit: number): number {
  return groupLimit * MATCHES_PER_FILE + ROW_LIMIT_MARGIN;
}

function lineStartExpr(db: SqliteDb, table: string): string {
  return ftsHasLineStart(db, table) ? `${table}.line_start` : '0';
}

function rootFilter(column: string, rootIds: string[] | undefined, params: Array<string | number>): string {
  if (!rootIds) return '';
  params.push(...rootIds);
  return ` AND ${column} IN (${rootIds.map(() => '?').join(',')})`;
}

function readRows(db: SqliteDb, sql: string, params: Array<string | number>): RawHit[] {
  const rows = db.prepare(sql).all(...params) as Array<{
    resourceId: string | null;
    rootId: string | null;
    relPath: string | null;
    title: string | null;
    body: string | null;
    page: number | string | null;
    bm: number | null;
    lineStart: number | string | null;
  }>;
  return rows.map((row) => ({
    resourceId: String(row.resourceId ?? ''),
    rootId: String(row.rootId ?? ''),
    relPath: String(row.relPath ?? ''),
    title: String(row.title ?? ''),
    body: String(row.body ?? ''),
    page: Number(row.page ?? 0),
    bm: Number(row.bm ?? 0),
    lineStart: Number(row.lineStart ?? 0),
  }));
}

function queryShort(db: SqliteDb, match: string, rootIds: string[] | undefined, rowLimit: number): RawHit[] {
  const params: Array<string | number> = [match];
  const rootSql = rootFilter('root_id', rootIds, params);
  params.push(rowLimit);
  const lineSql = lineStartExpr(db, 'fts_short');
  const sql = `
    SELECT resource_id AS resourceId,
           root_id AS rootId,
           path_text AS relPath,
           title_text AS title,
           body_text AS body,
           page AS page,
           ${lineSql} AS lineStart,
           bm25(fts_short) AS bm
    FROM fts_short
    WHERE fts_short MATCH ?
    ${rootSql}
    ORDER BY bm
    LIMIT ?
  `;
  return readRows(db, sql, params);
}

function queryLong(
  db: SqliteDb,
  match: string,
  kind: 'trigram' | 'bigram',
  rootIds: string[] | undefined,
  rowLimit: number,
): RawHit[] {
  const titleExpr = kind === 'bigram' ? 'fts_content.title_text' : 'fts_content.title';
  const bodyExpr = kind === 'bigram' ? 'fts_content.body_text' : 'fts_content.body';
  const params: Array<string | number> = [match];
  const rootSql = rootFilter('fts_content.root_id', rootIds, params);
  params.push(rowLimit);
  const lineSql = lineStartExpr(db, 'fts_content');
  const sql = `
    SELECT fts_content.resource_id AS resourceId,
           fts_content.root_id AS rootId,
           indexer_files.rel_path AS relPath,
           ${titleExpr} AS title,
           ${bodyExpr} AS body,
           fts_content.page AS page,
           ${lineSql} AS lineStart,
           bm25(fts_content) AS bm
    FROM fts_content
    JOIN indexer_files ON indexer_files.resource_id = fts_content.resource_id
    WHERE fts_content MATCH ?
    ${rootSql}
    ORDER BY bm
    LIMIT ?
  `;
  return readRows(db, sql, params);
}

/** 长查询的文件名和相对路径。只 MATCH fts_short 的 title 列，不读正文。 */
function queryPath(db: SqliteDb, query: string, rootIds: string[] | undefined, rowLimit: number): RawHit[] {
  const phrase = buildMatchQuery(query, 'bigram', 'quoted');
  if (!phrase) return [];
  const params: Array<string | number> = [`title : ${phrase}`];
  const rootSql = rootFilter('root_id', rootIds, params);
  params.push(rowLimit);
  const lineSql = lineStartExpr(db, 'fts_short');
  // page 升序，这样 LIMIT 截断后仍能看到已索引的最小页，不会把 page 编成 0。
  const sql = `
    SELECT resource_id AS resourceId,
           root_id AS rootId,
           path_text AS relPath,
           title_text AS title,
           '' AS body,
           page AS page,
           ${lineSql} AS lineStart,
           bm25(fts_short) AS bm
    FROM fts_short
    WHERE fts_short MATCH ?
    ${rootSql}
    ORDER BY page, bm
    LIMIT ?
  `;
  const best = new Map<string, RawHit>();
  for (const row of readRows(db, sql, params)) {
    if (!row.resourceId) continue;
    if (!containsQuery(row.title, query) && !containsQuery(row.relPath, query)) continue;
    const prev = best.get(row.resourceId);
    if (!prev) {
      if (row.page > 0) row.anchorPage = row.page;
      best.set(row.resourceId, row);
      continue;
    }
    if (row.page > 0) prev.anchorPage = prev.anchorPage === undefined ? row.page : Math.min(prev.anchorPage, row.page);
    if (row.bm < prev.bm) {
      row.anchorPage = prev.anchorPage;
      best.set(row.resourceId, row);
    }
  }
  return [...best.values()];
}

function lineHits(body: string, query: string, lineStart: number): number[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const lines = body.normalize('NFC').split('\n');
  const found: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.replace(/\r$/, '');
    if (line.toLocaleLowerCase().includes(needle)) found.push(lineStart + i);
  }
  return found;
}

function toMatch(row: RawHit, query: string): GroupedMatch {
  if (row.pathOnly) {
    const snippet = makeSnippet(row.relPath, row.relPath, query);
    if (row.anchorPage !== undefined && row.anchorPage > 0) {
      return { page: row.anchorPage, line: null, snippet, anchor: { page: row.anchorPage } };
    }
    return { page: 0, line: 1, snippet, anchor: { line: 1 } };
  }
  const snippet = makeSnippet(row.title, row.body, query);
  if (row.page !== 0) {
    return { page: row.page, line: null, snippet, anchor: { page: row.page } };
  }
  const start = row.lineStart > 0 ? row.lineStart : 1;
  const found = lineHits(row.body, query, start);
  const line = found[0] ?? 1;
  return { page: 0, line, snippet, anchor: { line } };
}

function expandMatches(rows: RawHit[], query: string): { matches: GroupedMatch[]; truncated: boolean } {
  const found: GroupedMatch[] = [];
  const sorted = rows.slice().sort((a, b) => a.page - b.page || a.lineStart - b.lineStart);
  let titleFallback = false;
  for (const row of sorted) {
    if (row.page !== 0) {
      found.push(toMatch(row, query));
      continue;
    }
    const start = row.lineStart > 0 ? row.lineStart : 1;
    const lines = lineHits(row.body, query, start);
    if (lines.length === 0) {
      if (!titleFallback && (containsQuery(row.title, query) || containsQuery(row.relPath, query))) {
        titleFallback = true;
        found.push(toMatch(row, query));
      }
      continue;
    }
    const parts = row.body.normalize('NFC').split('\n');
    for (const line of lines) {
      const local = line - start;
      const lineText = (parts[local] ?? row.body).replace(/\r$/, '');
      found.push({
        page: 0,
        line,
        snippet: makeSnippet(row.title, lineText, query),
        anchor: { line },
      });
    }
  }
  const uniq: GroupedMatch[] = [];
  const seen = new Set<string>();
  for (const match of found) {
    const key = 'page' in match.anchor ? `p${match.anchor.page}` : `l${match.anchor.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(match);
  }
  uniq.sort((a, b) => a.page - b.page || (a.line ?? 0) - (b.line ?? 0));
  return { matches: uniq.slice(0, MATCHES_PER_FILE), truncated: uniq.length > MATCHES_PER_FILE };
}

function reindexStatus(db: SqliteDb): { required: boolean; reason: string } {
  if (readTextIndexVersion(db) === '2') return { required: false, reason: '' };
  let hasRows = false;
  try {
    const row = db.prepare('SELECT 1 AS ok FROM fts_content LIMIT 1').get() as { ok: number } | undefined;
    hasRows = !!row;
  } catch {
    hasRows = false;
  }
  if (!hasRows) return { required: false, reason: '' };
  return {
    required: true,
    reason: '全文索引还是旧版本（没有 text_index_version=2），不能按行分块，也不能按单字检索。请重新索引。',
  };
}

function withReindex<T extends { hits: GroupedHit[]; truncated: boolean }>(
  result: T,
  reindex: { required: boolean; reason: string },
): GroupedSearchResult {
  if (!reindex.required) return { ...result, reindexRequired: false };
  return { ...result, reindexRequired: true, reindexReason: reindex.reason };
}

/**
 * 按资料聚合。少于 3 个码点只 MATCH fts_short。
 * 不少于 3 个码点时，正文走 fts_content，文件名和相对路径再 MATCH fts_short.title。
 * 不会在查询时重建索引，也不对正文做 LIKE。
 */
export function searchGrouped(
  db: SqliteDb,
  query: string,
  opts: SearchOptions = {},
): GroupedSearchResult {
  const limit = normalizeGroupLimit(opts.limit);
  const q = query.trim().normalize('NFC');
  if (!q) return { hits: [], truncated: false };
  if (opts.rootIds && opts.rootIds.length === 0) return { hits: [], truncated: false };

  const reindex = reindexStatus(db);
  const kind = tokenizerKind(db);
  const shortQuery = codePointLength(q) < 3;
  const match = shortQuery
    ? buildMatchQuery(q, 'bigram', 'quoted')
    : buildMatchQuery(q, kind, trigramStyle(db));
  if (!match) return withReindex({ hits: [], truncated: false }, reindex);

  const rowLimit = sqlRowLimit(limit);
  let contentRows: RawHit[] = [];
  let pathRows: RawHit[] = [];
  try {
    contentRows = shortQuery
      ? queryShort(db, match, opts.rootIds, rowLimit)
      : queryLong(db, match, kind, opts.rootIds, rowLimit);
    pathRows = shortQuery ? [] : queryPath(db, q, opts.rootIds, rowLimit);
  } catch (err) {
    if (reindex.required) return withReindex({ hits: [], truncated: false }, reindex);
    throw err;
  }

  interface Acc {
    resourceId: string;
    rootId: string;
    relPath: string;
    title: string;
    matchKind: 'name' | 'body';
    score: number;
    rows: RawHit[];
    pathOnly: boolean;
    anchorPage?: number;
  }
  const groups = new Map<string, Acc>();
  for (const row of contentRows) {
    if (!row.resourceId) continue;
    const score = Number.isFinite(row.bm) ? -row.bm : 0;
    const name = containsQuery(row.title, q) || containsQuery(row.relPath, q);
    const acc = groups.get(row.resourceId);
    if (!acc) {
      groups.set(row.resourceId, {
        resourceId: row.resourceId,
        rootId: row.rootId,
        relPath: row.relPath,
        title: row.title,
        matchKind: name ? 'name' : 'body',
        score,
        rows: [row],
        pathOnly: false,
      });
      continue;
    }
    acc.pathOnly = false;
    if (name) acc.matchKind = 'name';
    if (score > acc.score) acc.score = score;
    acc.rows.push(row);
  }
  for (const row of pathRows) {
    const score = Number.isFinite(row.bm) ? -row.bm : 0;
    const acc = groups.get(row.resourceId);
    if (!acc) {
      groups.set(row.resourceId, {
        resourceId: row.resourceId,
        rootId: row.rootId,
        relPath: row.relPath,
        title: row.title,
        matchKind: 'name',
        score,
        rows: [],
        pathOnly: true,
        anchorPage: row.anchorPage,
      });
      continue;
    }
    acc.matchKind = 'name';
    if (score > acc.score) acc.score = score;
    if (row.anchorPage !== undefined) {
      acc.anchorPage = acc.anchorPage === undefined ? row.anchorPage : Math.min(acc.anchorPage, row.anchorPage);
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.matchKind !== b.matchKind) return a.matchKind === 'name' ? -1 : 1;
    if (a.score !== b.score) return b.score - a.score;
    if (a.relPath !== b.relPath) return a.relPath < b.relPath ? -1 : 1;
    return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
  });

  const capped = contentRows.length >= rowLimit || pathRows.length >= rowLimit;
  const hits: GroupedHit[] = ordered.slice(0, limit).map((group) => {
    const bodyRows = group.rows.filter((row) => containsQuery(row.body, q));
    const content = (bodyRows.length > 0 ? bodyRows : group.rows)
      .slice()
      .sort((a, b) => a.page - b.page || a.lineStart - b.lineStart);
    const expanded = group.pathOnly
      ? {
          matches: [
            toMatch(
              {
                resourceId: group.resourceId,
                rootId: group.rootId,
                relPath: group.relPath,
                title: group.title,
                body: group.relPath,
                page: 0,
                bm: 0,
                lineStart: 1,
                pathOnly: true,
                anchorPage: group.anchorPage,
              },
              q,
            ),
          ],
          truncated: false,
        }
      : expandMatches(content, q);
    const first = expanded.matches[0];
    return {
      resourceId: group.resourceId,
      rootId: group.rootId,
      relPath: group.relPath,
      title: group.title,
      score: group.score,
      matchKind: group.matchKind,
      page: first?.page ?? 0,
      snippet: first?.snippet ?? '',
      matches: expanded.matches,
      matchesTruncated: expanded.truncated,
    };
  });
  return withReindex({ hits, truncated: ordered.length > limit || capped }, reindex);
}
