import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCorpus, TERMS } from '../scripts/make-corpus.mjs';
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  closeIndexer,
  extractText,
  indexerReady,
  indexOne,
  migrate,
  removeOne,
  search,
  startIndex,
  tokenizerKind,
} from '../src/index.ts';
import { fileChanged } from '../src/paths.ts';
import { openDatabase } from '../src/sqlite.ts';
import { bigramTokenize, buildMatchQuery } from '../src/tokenize.ts';

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

function startLagProbe(intervalMs = 20): { stop(): { maxDrift: number; atMs: number } } {
  const origin = performance.now();
  let maxDrift = 0;
  let atMs = 0;
  let last = origin;
  const timer = setInterval(() => {
    const now = performance.now();
    const drift = now - last - intervalMs;
    if (drift > maxDrift) {
      maxDrift = drift;
      atMs = now - origin;
    }
    last = now;
  }, intervalMs);
  return {
    stop() {
      clearInterval(timer);
      return { maxDrift: Math.max(0, maxDrift), atMs };
    },
  };
}

describe('2000 corpus', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kb-indexer-full-'));
  const corpusDir = path.join(tmp, 'corpus');
  const dbPath = path.join(tmp, 'index.sqlite');
  const rootId = 'root-full';
  const resolver = createResolver();
  const db = openDatabase(dbPath);
  let manifest: Awaited<ReturnType<typeof makeCorpus>>;
  let elapsedMs = 0;
  let maxLagMs = 0;
  let indexed = 0;

  afterAll(async () => {
    try {
      await closeIndexer();
      db.close();
    } catch {
      // 已经关过
    }
    await removeDir(tmp);
  });

  it(
    '全量索引 2000 个文件，并测量主线程事件循环延迟',
    async () => {
      migrate(db);
      await indexerReady();
      manifest = await makeCorpus(corpusDir, { fileCount: 2000 });
      expect(manifest.fileCount).toBeGreaterThanOrEqual(2000);
      // 语料写完后进程是空闲的，Windows 会把第一次 20ms 定时器合并掉。先用 5ms 定时器热一下。
      await new Promise<void>((resolve) => {
        const warm = setInterval(() => {}, 5);
        setTimeout(() => {
          clearInterval(warm);
          resolve();
        }, 60);
      });
      const probe = startLagProbe(20);
      const wallStart = performance.now();
      const job = startIndex({
        rootId,
        localPath: corpusDir,
        dbPath,
        resolveResourceId: resolver.resolveResourceId,
        mode: 'full',
      });
      const result = await job.done;
      elapsedMs = performance.now() - wallStart;
      const lag = probe.stop();
      maxLagMs = lag.maxDrift;
      console.log(`INDEXER_LAG_AT ${lag.atMs.toFixed(1)}`);
      indexed = result.filesProcessed.length;
      console.log(
        `INDEXER_METRICS ${JSON.stringify({
          files: indexed,
          fileCount: manifest.fileCount,
          elapsedMs: Math.round(elapsedMs),
          maxLagMs: Number(maxLagMs.toFixed(2)),
          tokenizer: tokenizerKind(db),
          errors: result.errors,
          status: result.status,
        })}`,
      );
      expect(result.status).toBe('completed');
      expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
      expect(indexed).toBe(manifest.fileCount);
      expect(indexed).toBeGreaterThanOrEqual(2000);
      expect(
        maxLagMs,
        `主线程 setInterval(20ms) 最大漂移 ${maxLagMs.toFixed(2)} ms，全量耗时 ${elapsedMs.toFixed(0)} ms`,
      ).toBeLessThanOrEqual(50);
    },
    180000,
  );

  it('搜索青岚索引词：第一条是 PDF 第 3 页且高亮', () => {
    const hits = search(db, TERMS.pdf, { limit: 5, rootIds: [rootId] });
    expect(hits.length).toBeGreaterThan(0);
    const pdfId = resolver.resolveResourceId(rootId, manifest.pdfRelPath);
    expect(hits[0]?.resourceId).toBe(pdfId);
    expect(hits[0]?.page).toBe(3);
    expect(hits[0]?.title).toBe('qinglan.pdf');
    expect(hits[0]?.snippet).toContain(`${HIGHLIGHT_START}${TERMS.pdf}${HIGHLIGHT_END}`);
    expect(Number.isFinite(hits[0]?.score)).toBe(true);
    const pages = db
      .prepare('SELECT COUNT(*) AS n FROM fts_content WHERE resource_id = ?')
      .get(pdfId) as { n: number };
    expect(pages.n).toBe(4);
  });

  it('英文词、中文短语、只在正文里的词都能命中', () => {
    const englishId = resolver.resolveResourceId(rootId, manifest.englishRelPath);
    const phraseId = resolver.resolveResourceId(rootId, manifest.phraseRelPath);
    const bodyId = resolver.resolveResourceId(rootId, manifest.bodyOnlyRelPath);

    const english = search(db, TERMS.english, { limit: 5 });
    expect(english[0]?.resourceId).toBe(englishId);
    expect(english[0]?.snippet).toContain(`${HIGHLIGHT_START}${TERMS.english}${HIGHLIGHT_END}`);

    const phrase = search(db, TERMS.phrase, { limit: 5 });
    expect(phrase[0]?.resourceId).toBe(phraseId);
    expect(phrase[0]?.page).toBe(0);
    expect(phrase[0]?.snippet).toContain(`${HIGHLIGHT_START}${TERMS.phrase}${HIGHLIGHT_END}`);

    const body = search(db, TERMS.bodyOnly, { limit: 5 });
    expect(body[0]?.resourceId).toBe(bodyId);
    expect(body[0]?.page).toBe(0);
    expect(body[0]?.title.includes(TERMS.bodyOnly)).toBe(false);
    expect(body[0]?.snippet).toContain(`${HIGHLIGHT_START}${TERMS.bodyOnly}${HIGHLIGHT_END}`);
  });

  it('修改一个文件后，增量索引只处理这一个文件', async () => {
    const abs = path.join(corpusDir, ...manifest.englishRelPath.split('/'));
    appendFileSync(abs, '\n增量修订专有词Qx7\n', 'utf8');
    const job = startIndex({
      rootId,
      localPath: corpusDir,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
      mode: 'incremental',
    });
    const result = await job.done;
    expect(result.status).toBe('completed');
    expect(result.errors, JSON.stringify(result.errors)).toEqual([]);
    expect(result.filesProcessed).toEqual([manifest.englishRelPath]);
    const hits = search(db, '增量修订专有词Qx7', { limit: 5 });
    expect(hits[0]?.resourceId).toBe(resolver.resolveResourceId(rootId, manifest.englishRelPath));
    expect(hits[0]?.snippet).toContain(`${HIGHLIGHT_START}增量修订专有词Qx7${HIGHLIGHT_END}`);
  });
});

describe('cancel', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kb-indexer-cancel-'));

  afterAll(async () => {
    await removeDir(tmp);
  });

  it(
    '取消后 1 秒内停止，已完成部分仍可搜，再次索引能续完',
    async () => {
      const corpusDir = path.join(tmp, 'corpus');
      const dbPath = path.join(tmp, 'index.sqlite');
      const db = openDatabase(dbPath);
      try {
      migrate(db);
      const manifest = await makeCorpus(corpusDir, { fileCount: 400 });
      const resolver = createResolver();
      const rootId = 'root-cancel';
      const job = startIndex({
        rootId,
        localPath: corpusDir,
        dbPath,
        resolveResourceId: resolver.resolveResourceId,
        mode: 'full',
      });
      let cancelAt = 0;
      job.onProgress((progress) => {
        if (cancelAt === 0 && progress.processed >= 2) {
          cancelAt = performance.now();
          job.cancel();
        }
      });
      const cancelled = await job.done;
      const stopMs = performance.now() - cancelAt;
      expect(cancelAt).toBeGreaterThan(0);
      expect(cancelled.status).toBe('cancelled');
      expect(stopMs, `cancel 到结束 ${stopMs.toFixed(0)} ms`).toBeLessThan(1000);
      expect(cancelled.filesProcessed.length).toBeGreaterThan(0);
      expect(cancelled.filesProcessed.length).toBeLessThan(manifest.fileCount);

      const doneRel = cancelled.filesProcessed[0]!;
      const doneMark = manifest.marks[doneRel];
      if (doneMark) {
        const hits = search(db, doneMark, { limit: 5 });
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0]?.resourceId).toBe(resolver.resolveResourceId(rootId, doneRel));
      }

      const pendingRel = Object.keys(manifest.marks).find(
        (rel) => !cancelled.filesProcessed.includes(rel),
      );
      expect(pendingRel).toBeTruthy();
      expect(search(db, manifest.marks[pendingRel!], { limit: 5 })).toEqual([]);

      const resume = startIndex({
        rootId,
        localPath: corpusDir,
        dbPath,
        resolveResourceId: resolver.resolveResourceId,
        mode: 'incremental',
      });
      const resumed = await resume.done;
      expect(resumed.status).toBe('completed');
      expect(resumed.errors, JSON.stringify(resumed.errors)).toEqual([]);
      for (const rel of resumed.filesProcessed) {
        expect(cancelled.filesProcessed).not.toContain(rel);
      }
      const union = new Set([...cancelled.filesProcessed, ...resumed.filesProcessed]);
      expect(union.size).toBe(manifest.fileCount);
      const hits = search(db, manifest.marks[pendingRel!], { limit: 5 });
      expect(hits.length).toBeGreaterThan(0);
      console.log(
        `CANCEL_METRICS ${JSON.stringify({
          stopMs: Math.round(stopMs),
          processedBeforeStop: cancelled.filesProcessed.length,
          total: manifest.fileCount,
          resumed: resumed.filesProcessed.length,
        })}`,
      );
    } finally {
      db.close();
    }
  },
    180000,
  );
});

describe('behavior', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'kb-indexer-behavior-'));

  afterAll(async () => {
    await removeDir(tmp);
  });

  it('跳过隐藏目录、系统目录，以及额外配置的目录', async () => {
    const corpus = path.join(tmp, 'skip');
    const dbPath = path.join(tmp, 'skip.sqlite');
    const write = (rel: string, body: string) => {
      const abs = path.join(corpus, ...rel.split('/'));
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, body, 'utf8');
    };
    write('visible.md', '可见文件标记甲');
    write('.hidden/secret.md', '隐藏目录标记乙');
    write('node_modules/pkg/a.md', '依赖目录标记丙');
    write('$RECYCLE.BIN/a.txt', '回收站标记丁');
    write('System Volume Information/a.txt', '系统卷标记戊');
    write('nested/skip-me/b.md', '额外跳过标记己');
    const db = openDatabase(dbPath);
    migrate(db);
    const resolver = createResolver();
    const job = startIndex({
      rootId: 'root-skip',
      localPath: corpus,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
      skipDirNames: ['skip-me'],
    });
    const result = await job.done;
    expect(result.status).toBe('completed');
    expect(result.filesProcessed).toEqual(['visible.md']);
    expect(search(db, '可见文件标记甲')).toHaveLength(1);
    expect(search(db, '隐藏目录标记乙')).toEqual([]);
    expect(search(db, '依赖目录标记丙')).toEqual([]);
    expect(search(db, '回收站标记丁')).toEqual([]);
    expect(search(db, '系统卷标记戊')).toEqual([]);
    expect(search(db, '额外跳过标记己')).toEqual([]);
    db.close();
  });

  it('单个坏文件记错后继续，任务本身不失败', async () => {
    const corpus = path.join(tmp, 'bad');
    const dbPath = path.join(tmp, 'bad.sqlite');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(path.join(corpus, 'good.txt'), '完好文件标记庚', 'utf8');
    writeFileSync(path.join(corpus, 'bad.pdf'), 'this is not a pdf', 'utf8');
    const db = openDatabase(dbPath);
    migrate(db);
    const resolver = createResolver();
    const job = startIndex({
      rootId: 'root-bad',
      localPath: corpus,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
    });
    const result = await job.done;
    expect(result.status).toBe('completed');
    expect(result.filesProcessed).toEqual(['good.txt']);
    expect(result.errors.some((item) => item.path.replace(/\\/g, '/').endsWith('bad.pdf'))).toBe(true);
    expect(search(db, '完好文件标记庚')).toHaveLength(1);
    db.close();
  });

  it('rootIds 只返回指定根的命中', async () => {
    const dirA = path.join(tmp, 'root-a');
    const dirB = path.join(tmp, 'root-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(path.join(dirA, 'a.txt'), '根甲专有词亥', 'utf8');
    writeFileSync(path.join(dirB, 'b.txt'), '根乙专有词亥', 'utf8');
    const dbPath = path.join(tmp, 'roots.sqlite');
    const db = openDatabase(dbPath);
    migrate(db);
    const resolver = createResolver();
    const first = await startIndex({
      rootId: 'root-a',
      localPath: dirA,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
    }).done;
    const second = await startIndex({
      rootId: 'root-b',
      localPath: dirB,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
    }).done;
    expect(first.status).toBe('completed');
    expect(second.status).toBe('completed');
    const onlyA = search(db, '根甲专有词亥', { rootIds: ['root-a'] });
    const onlyB = search(db, '根乙专有词亥', { rootIds: ['root-b'] });
    expect(onlyA).toHaveLength(1);
    expect(onlyB).toHaveLength(1);
    expect(onlyA[0]?.resourceId).not.toBe(onlyB[0]?.resourceId);
    expect(search(db, '根甲专有词亥', { rootIds: [] })).toEqual([]);
    db.close();
  });

  it('removeOne 删掉命中，indexOne 能按资料 ID 再写回', async () => {
    const corpus = path.join(tmp, 'one');
    const dbPath = path.join(tmp, 'one.sqlite');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(path.join(corpus, 'note.txt'), '单文件标记壬', 'utf8');
    const db = openDatabase(dbPath);
    migrate(db);
    const resolver = createResolver();
    const rootId = 'root-one';
    const done = await startIndex({
      rootId,
      localPath: corpus,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
    }).done;
    expect(done.filesProcessed).toEqual(['note.txt']);
    const id = resolver.resolveResourceId(rootId, 'note.txt');
    expect(search(db, '单文件标记壬')).toHaveLength(1);
    removeOne(db, id);
    expect(search(db, '单文件标记壬')).toEqual([]);
    appendFileSync(path.join(corpus, 'note.txt'), '\n单文件修订癸\n', 'utf8');
    const again = await indexOne(db, id, {
      lookupPath: () => ({
        rootId,
        relPath: 'note.txt',
        absPath: path.join(corpus, 'note.txt'),
        localPath: corpus,
      }),
    });
    expect(again.relPath).toBe('note.txt');
    expect(again.pageCount).toBe(1);
    const hits = search(db, '单文件修订癸');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.resourceId).toBe(id);
    expect(hits[0]?.snippet).toContain(`${HIGHLIGHT_START}单文件修订癸${HIGHLIGHT_END}`);
    db.close();
  });

  it('没变化时增量处理零个文件，migrate 可重复调用', async () => {
    const corpus = path.join(tmp, 'same');
    const dbPath = path.join(tmp, 'same.sqlite');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(path.join(corpus, 'a.txt'), '稳定文件标记子', 'utf8');
    writeFileSync(path.join(corpus, 'b.md'), '稳定文件标记丑', 'utf8');
    const db = openDatabase(dbPath);
    migrate(db);
    migrate(db);
    const resolver = createResolver();
    const opts = {
      rootId: 'root-same',
      localPath: corpus,
      dbPath,
      resolveResourceId: resolver.resolveResourceId,
    };
    const full = await startIndex({ ...opts, mode: 'full' }).done;
    expect(full.filesProcessed.slice().sort()).toEqual(['a.txt', 'b.md']);
    const again = await startIndex({ ...opts, mode: 'incremental' }).done;
    expect(again.status).toBe('completed');
    expect(again.filesProcessed).toEqual([]);
    expect(tokenizerKind(db) === 'trigram' || tokenizerKind(db) === 'bigram').toBe(true);
    db.close();
  });

  it('extractText：PDF 按页，txt 和 md 的 page 为 0', async () => {
    const corpus = path.join(tmp, 'extract');
    const manifest = await makeCorpus(corpus, { fileCount: 0 });
    const pdfPages = await extractText(path.join(corpus, ...manifest.pdfRelPath.split('/')));
    expect(pdfPages.map((page) => page.page)).toEqual([1, 2, 3, 4]);
    expect(pdfPages[2]?.text).toContain(TERMS.pdf);
    expect(pdfPages[0]?.text.includes(TERMS.pdf)).toBe(false);
    expect(pdfPages[1]?.text.includes(TERMS.pdf)).toBe(false);
    expect(pdfPages[3]?.text.includes(TERMS.pdf)).toBe(false);
    const mdPages = await extractText(path.join(corpus, ...manifest.bodyOnlyRelPath.split('/')));
    expect(mdPages).toHaveLength(1);
    expect(mdPages[0]?.page).toBe(0);
    expect(mdPages[0]?.text).toContain(TERMS.bodyOnly);
    const txtPath = path.join(corpus, 'plain.txt');
    writeFileSync(txtPath, '纯文本页码为零', 'utf8');
    const txtPages = await extractText(txtPath);
    expect(txtPages).toEqual([{ page: 0, text: '纯文本页码为零' }]);
  });

  it('fileChanged 与 bigram 切分', () => {
    expect(fileChanged(undefined, { size: 1, mtimeMs: 1 })).toBe(true);
    expect(fileChanged({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 })).toBe(false);
    expect(fileChanged({ size: 1, mtimeMs: 2 }, { size: 2, mtimeMs: 2 })).toBe(true);
    expect(fileChanged({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 })).toBe(true);
    const grams = bigramTokenize('青岚索引词');
    expect(grams).toContain('青岚');
    expect(grams).toContain('岚索');
    expect(grams).toContain('索引');
    expect(grams).toContain('引词');
    expect(grams.split(/\s+/).filter(Boolean)).toHaveLength(9);
    expect(bigramTokenize('庚辛').split(/\s+/).filter(Boolean)).toEqual(['庚辛', '庚', '辛']);
    expect(buildMatchQuery('青岚索引词', 'bigram', 'quoted')).toBe('"青岚 岚索 索引 引词"');
    expect(buildMatchQuery('庚', 'bigram', 'quoted')).toBe('"庚"');
    expect(buildMatchQuery('庚辛', 'bigram', 'quoted')).toBe('"庚辛"');
    expect(buildMatchQuery('ZephyrIndexToken', 'bigram', 'quoted')).toBe('"ZephyrIndexToken"');
    expect(buildMatchQuery('ab', 'trigram', 'quoted')).toBeNull();
  });
});

afterAll(async () => {
  await closeIndexer();
});
