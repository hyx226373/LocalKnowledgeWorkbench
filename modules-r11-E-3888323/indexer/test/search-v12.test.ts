import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  closeIndexer,
  migrate,
  search,
  searchGrouped,
  startIndex,
  tokenizerKind,
} from '../src/index.ts';
import { openDatabase } from '../src/sqlite.ts';
import { bigramTokenize } from '../src/tokenize.ts';

const PDF_WORD = '页码聚合词';
const LINE_WORD = '行号定位词';
const NAME_WORD = '文件名优先词';
const PATH_WORD = '路径目录专名';
const SHORT_WORD = '戊己';
const CHUNK_WORD = '行块定位词';
const PDF_DIR_WORD = '路径页专名';
const FONT_PATH = 'C:\\Windows\\Fonts\\simhei.ttf';

function createResolver() {
  const map = new Map<string, string>();
  function resolveResourceId(rootId: string, relPath: string): string {
    const key = `${rootId}\n${relPath.normalize('NFC').replace(/\\/g, '/').toLowerCase()}`;
    let id = map.get(key);
    if (!id) {
      id = randomUUID();
      map.set(key, id);
    }
    return id;
  }
  return { resolveResourceId };
}

async function removeDir(dir: string): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function writePagesPdf(dest: string): Promise<void> {
  const fontBytes = await readFile(FONT_PATH);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  for (let pageNo = 1; pageNo <= 7; pageNo += 1) {
    const page = pdf.addPage([595.28, 841.89]);
    const text =
      pageNo === 3 || pageNo === 7
        ? `第${pageNo}页正文里有${PDF_WORD}用于核对`
        : `第${pageNo}页只有填充说明`;
    page.drawText(text, { font, size: 18, x: 50, y: 760, color: rgb(0, 0, 0) });
  }
  writeFileSync(dest, await pdf.save());
}

async function writePlainPdf(dest: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText('placeholder body without the folder token', { x: 50, y: 760, size: 16 });
  writeFileSync(dest, await pdf.save());
}

function legacyBigram(input: string): string {
  const cjk = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g;
  return input.normalize('NFC').replace(cjk, (run) => {
    if (run.length <= 1) return ` ${run} `;
    const grams: string[] = [];
    for (let i = 0; i < run.length - 1; i += 1) grams.push(run.slice(i, i + 2));
    return ` ${grams.join(' ')} `;
  });
}

function sqliteBytes(file: string): number {
  let total = statSync(file).size;
  for (const suffix of ['-wal', '-shm']) {
    const side = `${file}${suffix}`;
    if (existsSync(side)) total += statSync(side).size;
  }
  return total;
}

describe('search v1.2', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kb-indexer-v12-'));
  const corpus = path.join(tmp, 'corpus');
  const dbPath = path.join(tmp, 'index.sqlite');
  const rootId = 'root-v12';
  const resolver = createResolver();
  const db = openDatabase(dbPath);

  beforeAll(async () => {
    mkdirSync(path.join(corpus, 'pad'), { recursive: true });
    mkdirSync(path.join(corpus, 'docs'), { recursive: true });
    mkdirSync(path.join(corpus, 'rank'), { recursive: true });
    mkdirSync(path.join(corpus, '路径目录专名'), { recursive: true });
    mkdirSync(path.join(corpus, '路径页专名'), { recursive: true });
    mkdirSync(path.join(corpus, 'misc'), { recursive: true });
    for (let i = 0; i < 2000; i += 1) {
      const name = `n-${String(i).padStart(4, '0')}.md`;
      writeFileSync(path.join(corpus, 'pad', name), 'x\n', 'utf8');
    }
    writeFileSync(path.join(corpus, 'pad', 'wuji.md'), '填充一行\n正文里写着戊己两个字\n', 'utf8');
    writeFileSync(path.join(corpus, 'docs', 'fourth-line.md'), '甲\n乙\n丙\n这里是行号定位词所在\n丁\n', 'utf8');
    writeFileSync(
      path.join(corpus, 'rank', '文件名优先词.md'),
      '这一段故意写长，只为压低正文得分。这里没有目标短语，重复说明而已。\n',
      'utf8',
    );
    writeFileSync(path.join(corpus, 'rank', 'plain-body.md'), '文件名优先词\n', 'utf8');
    writeFileSync(path.join(corpus, '路径目录专名', 'note.md'), '普通笔记，没有目标。\n', 'utf8');
    writeFileSync(path.join(corpus, 'misc', 'only-body.md'), '正文里出现路径目录专名一次\n', 'utf8');
    const chunkLines: string[] = [];
    for (let line = 1; line <= 40; line += 1) {
      chunkLines.push(line === 4 || line === 40 ? `本行有${CHUNK_WORD}` : `填充行${line}`);
    }
    writeFileSync(path.join(corpus, 'docs', 'line-4-and-40.md'), `${chunkLines.join('\n')}\n`, 'utf8');
    writeFileSync(path.join(corpus, 'pad', 'geng.md'), '庚辛\n', 'utf8');
    await writePagesPdf(path.join(corpus, 'docs', 'pages.pdf'));
    await writePlainPdf(path.join(corpus, '路径页专名', 'bare.pdf'));

    migrate(db);
    const result = await startIndex({
      rootId,
      localPath: corpus,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
      mode: 'full',
    }).done;
    expect(result.status).toBe('completed');
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.filesProcessed).toHaveLength(2010);
  }, 180000);

  afterAll(async () => {
    try {
      await closeIndexer();
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it('同一 PDF 第 3 页和第 7 页聚合成一条', () => {
    const grouped = searchGrouped(db, PDF_WORD);
    expect(grouped.truncated).toBe(false);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(1);
    const hit = grouped.hits[0]!;
    const pdfId = resolver.resolveResourceId(rootId, 'docs/pages.pdf');
    expect(hit.resourceId).toBe(pdfId);
    expect(hit.rootId).toBe(rootId);
    expect(hit.relPath).toBe('docs/pages.pdf');
    expect(hit.title).toBe('pages.pdf');
    expect(hit.page).toBe(3);
    expect(hit.matchesTruncated).toBe(false);
    expect(hit.matches.map((match) => match.page)).toEqual([3, 7]);
    expect(hit.matches.map((match) => match.line)).toEqual([null, null]);
    expect(hit.matches.map((match) => match.anchor)).toEqual([{ page: 3 }, { page: 7 }]);
    expect(hit.snippet).toContain(`${HIGHLIGHT_START}${PDF_WORD}${HIGHLIGHT_END}`);
    expect(hit.matches[0]?.snippet).toContain(`${HIGHLIGHT_START}${PDF_WORD}${HIGHLIGHT_END}`);
    expect(hit.matches[1]?.snippet).toContain(`${HIGHLIGHT_START}${PDF_WORD}${HIGHLIGHT_END}`);
    expect(searchGrouped(db, PDF_WORD, { rootIds: [] })).toEqual({ hits: [], truncated: false });

    const flat = search(db, PDF_WORD, { limit: 10 });
    expect(flat.map((item) => item.page).sort((a, b) => a - b)).toEqual([3, 7]);
    expect(flat.every((item) => item.title === 'pages.pdf')).toBe(true);

    const stored = db.prepare('SELECT COUNT(*) AS n FROM fts_content WHERE resource_id = ?').get(pdfId) as {
      n: number;
    };
    const shorts = db.prepare('SELECT COUNT(*) AS n FROM fts_short WHERE resource_id = ?').get(pdfId) as {
      n: number;
    };
    expect(stored.n).toBe(7);
    expect(shorts.n).toBe(7);
  });

  it('md 第 4 行的锚点是行号', () => {
    const grouped = searchGrouped(db, LINE_WORD);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(1);
    const hit = grouped.hits[0]!;
    expect(hit.relPath).toBe('docs/fourth-line.md');
    expect(hit.title).toBe('fourth-line.md');
    expect(hit.page).toBe(0);
    expect(hit.resourceId).toBe(resolver.resolveResourceId(rootId, 'docs/fourth-line.md'));
    expect(hit.matches).toHaveLength(1);
    expect(hit.matches[0]?.page).toBe(0);
    expect(hit.matches[0]?.line).toBe(4);
    expect(hit.matches[0]?.anchor).toEqual({ line: 4 });
    expect(hit.snippet).toContain(`${HIGHLIGHT_START}${LINE_WORD}${HIGHLIGHT_END}`);
    expect(hit.matches[0]?.snippet).toBe(hit.snippet);
  });

  it('文件名命中排在只命中正文前面', () => {
    const grouped = searchGrouped(db, NAME_WORD);
    expect(grouped.hits, JSON.stringify(grouped.hits.map((hit) => hit.relPath))).toHaveLength(2);
    expect(grouped.hits[0]?.matchKind).toBe('name');
    expect(grouped.hits[0]?.title).toBe('文件名优先词.md');
    expect(grouped.hits[0]?.relPath).toBe('rank/文件名优先词.md');
    expect(grouped.hits[0]?.title.includes(NAME_WORD)).toBe(true);
    expect(grouped.hits[1]?.matchKind).toBe('body');
    expect(grouped.hits[1]?.relPath).toBe('rank/plain-body.md');
    expect(grouped.hits[1]?.title.includes(NAME_WORD)).toBe(false);
    expect(grouped.hits[1]?.snippet).toContain(`${HIGHLIGHT_START}${NAME_WORD}${HIGHLIGHT_END}`);
  });

  it('目录名命中且排在只命中正文前面', () => {
    const grouped = searchGrouped(db, PATH_WORD);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(2);
    expect(grouped.hits[0]?.matchKind).toBe('name');
    expect(grouped.hits[0]?.relPath).toBe('路径目录专名/note.md');
    expect(grouped.hits[0]?.title).toBe('note.md');
    expect(grouped.hits[0]?.title.includes(PATH_WORD)).toBe(false);
    expect(grouped.hits[0]?.page).toBe(0);
    expect(grouped.hits[0]?.matches).toHaveLength(1);
    expect(grouped.hits[0]?.matches[0]?.page).toBe(0);
    expect(grouped.hits[0]?.matches[0]?.line).toBe(1);
    expect(grouped.hits[0]?.matches[0]?.anchor).toEqual({ line: 1 });
    expect(grouped.hits[0]?.snippet).toContain(`${HIGHLIGHT_START}${PATH_WORD}${HIGHLIGHT_END}`);
    expect(grouped.hits[1]?.matchKind).toBe('body');
    expect(grouped.hits[1]?.relPath).toBe('misc/only-body.md');
    expect(grouped.hits[1]?.title.includes(PATH_WORD)).toBe(false);
    expect(grouped.hits[1]?.snippet).toContain(`${HIGHLIGHT_START}${PATH_WORD}${HIGHLIGHT_END}`);
    const flat = search(db, PATH_WORD, { limit: 10 });
    expect(flat.map((item) => item.title)).toEqual(['only-body.md']);
  });

  it('二字查询在 300ms 内命中，trigram 的 search 仍为空', () => {
    expect(tokenizerKind(db)).toBe('trigram');
    const started = performance.now();
    const grouped = searchGrouped(db, SHORT_WORD);
    const elapsedMs = performance.now() - started;
    console.log(`SHORT_QUERY_MS ${elapsedMs.toFixed(2)}`);
    expect(elapsedMs, `searchGrouped('${SHORT_WORD}') 耗时 ${elapsedMs.toFixed(2)} ms`).toBeLessThanOrEqual(300);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(1);
    expect(grouped.truncated).toBe(false);
    expect(grouped.hits[0]?.relPath).toBe('pad/wuji.md');
    expect(grouped.hits[0]?.resourceId).toBe(resolver.resolveResourceId(rootId, 'pad/wuji.md'));
    expect(grouped.hits[0]?.title).toBe('wuji.md');
    expect(search(db, SHORT_WORD)).toEqual([]);
  });

  it('同一个词在第 4 行和第 40 行，最多 3 处且行号是原文行号', () => {
    const grouped = searchGrouped(db, CHUNK_WORD);
    expect(grouped.reindexRequired).toBe(false);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(1);
    const hit = grouped.hits[0]!;
    expect(hit.relPath).toBe('docs/line-4-and-40.md');
    expect(hit.matches.length).toBeLessThanOrEqual(3);
    expect(hit.matches.length).toBeGreaterThanOrEqual(2);
    const lines = hit.matches.map((match) => ('line' in match.anchor ? match.anchor.line : 0));
    expect(lines).toContain(4);
    expect(lines).toContain(40);
    expect(hit.matches.every((match) => match.page === 0)).toBe(true);
  });

  it('正文庚辛能被单字庚命中，不是 LIKE', () => {
    expect(search(db, '庚')).toEqual([]);
    const started = performance.now();
    const grouped = searchGrouped(db, '庚');
    const elapsedMs = performance.now() - started;
    const indexBytes = sqliteBytes(dbPath);
    console.log(`CHAR_QUERY_MS ${elapsedMs.toFixed(2)}`);
    console.log(`INDEX_BYTES ${indexBytes}`);
    expect(grouped.reindexRequired).toBe(false);
    const hit = grouped.hits.find((item) => item.relPath === 'pad/geng.md');
    expect(hit, JSON.stringify(grouped.hits.map((item) => item.relPath))).toBeTruthy();
    expect(hit?.matches.some((match) => 'line' in match.anchor)).toBe(true);
  });

  it('只命中路径的 PDF，page 和 anchor.page 是同一个已索引页', () => {
    const grouped = searchGrouped(db, PDF_DIR_WORD);
    expect(grouped.hits, JSON.stringify(grouped.hits)).toHaveLength(1);
    const hit = grouped.hits[0]!;
    expect(hit.relPath).toBe('路径页专名/bare.pdf');
    expect(hit.matchKind).toBe('name');
    expect(hit.matches).toHaveLength(1);
    const anchor = hit.matches[0]?.anchor;
    expect(anchor).toEqual({ page: hit.page });
    expect(hit.page).toBe(hit.matches[0]?.page);
    expect(hit.page).toBeGreaterThan(0);
    const pdfId = resolver.resolveResourceId(rootId, '路径页专名/bare.pdf');
    const stored = db.prepare('SELECT page FROM fts_content WHERE resource_id = ?').all(pdfId) as Array<{
      page: number;
    }>;
    expect(stored.map((row) => row.page)).toContain(hit.page);
  });
});

describe('旧索引和单字体积', () => {
  it('版本号缺失且已有 fts_content 行时要求重建', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kb-indexer-old-'));
    const db = openDatabase(path.join(dir, 'old.sqlite'));
    try {
      migrate(db);
      const version = db.prepare(`SELECT value FROM indexer_meta WHERE key = 'text_index_version'`).get();
      expect(version).toBeUndefined();
      if (tokenizerKind(db) === 'bigram') {
        db.prepare(
          `INSERT INTO fts_content (
             resource_id, page, title, body, root_id, title_text, body_text, line_start
           ) VALUES ('old-res', 0, 'old.md', '旧库正文', 'root-old', 'old.md', '旧库正文', 1)`,
        ).run();
      } else {
        db.prepare(
          `INSERT INTO fts_content (resource_id, page, title, body, root_id, line_start)
           VALUES ('old-res', 0, 'old.md', '旧库正文', 'root-old', 1)`,
        ).run();
      }
      const grouped = searchGrouped(db, '旧库正文');
      expect(grouped.reindexRequired).toBe(true);
      expect(grouped.reindexReason && grouped.reindexReason.length > 0).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('只有二字 token 时单字庚不命中，对照索引体积', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'kb-indexer-tok-'));
    const barePath = path.join(dir, 'bare.sqlite');
    const bare = openDatabase(barePath);
    try {
      migrate(bare);
      bare.prepare(`INSERT INTO indexer_meta(key, value) VALUES ('text_index_version', '2')`).run();
      bare
        .prepare(
          `INSERT INTO fts_short (
             resource_id, page, title, body, root_id, title_text, body_text, path_text, line_start
           ) VALUES ('only-bi', 0, '庚辛', '庚辛', 'root-bi', 'bi.md', '庚辛', 'bi.md', 1)`,
        )
        .run();
      const missed = searchGrouped(bare, '庚');
      expect(missed.reindexRequired).toBe(false);
      expect(missed.hits).toEqual([]);
      expect(search(bare, '庚')).toEqual([]);
    } finally {
      bare.close();
    }

    const sample = '庚辛壬癸甲乙丙丁戊己'.repeat(10);
    const n = [...sample].length;
    const oldTokens = legacyBigram(sample).split(/\s+/).filter(Boolean).length;
    const newTokens = bigramTokenize(sample).split(/\s+/).filter(Boolean).length;
    expect(oldTokens).toBe(n - 1);
    expect(newTokens).toBe(2 * n - 1);

    function fill(file: string, tokenize: (text: string) => string): number {
      const database = openDatabase(file);
      database.exec(`CREATE VIRTUAL TABLE bench USING fts5(body, tokenize = 'unicode61')`);
      const insert = database.prepare('INSERT INTO bench(body) VALUES (?)');
      const tx = database.transaction(() => {
        for (let i = 0; i < 300; i += 1) insert.run(tokenize(`${sample}${i}`));
      });
      tx();
      database.pragma('wal_checkpoint(PASSIVE)');
      database.close();
      return sqliteBytes(file);
    }
    const oldBytes = fill(path.join(dir, 'old-bi.sqlite'), legacyBigram);
    const newBytes = fill(path.join(dir, 'new-bi.sqlite'), bigramTokenize);
    console.log(
      `TOKEN_BYTES ${JSON.stringify({ n, oldTokens, newTokens, docs: 300, oldBytes, newBytes, deltaBytes: newBytes - oldBytes })}`,
    );
    expect(newBytes).toBeGreaterThan(oldBytes);
    rmSync(dir, { recursive: true, force: true });
  });
});
