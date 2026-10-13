import { disk } from './disk.ts';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainThread } from 'node:worker_threads';
import type { PageText } from './store.ts';

const require = createRequire(import.meta.url);
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

export const TEXT_INDEX_CAP = 8 * 1024 * 1024;
export const PDF_INDEX_CAP = 32 * 1024 * 1024;

/** 超大或含 NUL 的文本只登记、不进正文。只嗅探前 8KB。 */
export function textIndexSkip(absPath: string, size: number): boolean {
  if (size > TEXT_INDEX_CAP) return true;
  const n = Math.min(8192, size);
  if (n <= 0) return false;
  const buf = Buffer.alloc(n);
  const fd = disk.openSync(absPath, 'r');
  try {
    disk.readSync(fd, buf, 0, n, 0);
  } finally {
    disk.closeSync(fd);
  }
  return buf.includes(0);
}

function readChunks(absPath: string, isCancelled?: () => boolean): Buffer {
  if (isCancelled?.()) throw new CancelledError();
  // 异步 readFile 走 libuv 线程池。这个进程里一批小文件会排到好几秒，父进程定时器跟着漂。
  return disk.readFileSync(absPath);
}

function decodeUtf8(buf: Buffer): string {
  return utf8Decoder.decode(buf).normalize('NFC');
}

/** pdfjs 有时会在汉字之间插入空格，检索前把这些空格收掉。 */
export function joinCjkSpaces(input: string): string {
  const re = /([\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])[ \t]+(?=[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF])/g;
  let cur = input.normalize('NFC');
  let prev = '';
  while (cur !== prev) {
    prev = cur;
    cur = cur.replace(re, '$1');
  }
  return cur;
}

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: PdfTextItem[] }> }>;
}

interface PdfLoadingTask { promise: Promise<PdfDoc>; destroy(): Promise<void>; }

let pdfjsPromise: Promise<{
  getDocument: (src: unknown) => PdfLoadingTask;
}> | null = null;

function assetDirUrl(sub: string): string {
  const pkg = require.resolve('pdfjs-dist/package.json');
  const dir = path.join(path.dirname(pkg), sub);
  let href = pathToFileURL(dir).href;
  if (!href.endsWith('/')) href += '/';
  return href;
}

async function loadPdfjs(): Promise<{
  getDocument: (src: unknown) => PdfLoadingTask;
}> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
      const pdfjs = mod as unknown as {
        getDocument: (src: unknown) => PdfLoadingTask;
        GlobalWorkerOptions?: { workerSrc: string };
      };
      if (pdfjs.GlobalWorkerOptions) {
        pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
          require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
        ).href;
      }
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

async function extractPdf(
  absPath: string,
  title: string,
  isCancelled?: () => boolean,
): Promise<PageText[]> {
  if (isCancelled?.()) throw new CancelledError();
  const data = new Uint8Array(await readChunks(absPath, isCancelled));
  if (isCancelled?.()) throw new CancelledError();
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data,
    cMapUrl: assetDirUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetDirUrl('standard_fonts'),
    useSystemFonts: false,
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      if (isCancelled?.()) throw new CancelledError();
      const page = await doc.getPage(i);
      if (isCancelled?.()) throw new CancelledError();
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      pages.push({ page: i, title, body: joinCjkSpaces(text) });
    }
    return pages;
  } finally {
    // PDFDocumentProxy in pdfjs 6 has no destroy(); the loading task owns cleanup.
    await task.destroy();
  }
}

export interface TextPage {
  /** PDF 从 1 开始；txt、md 为 0。 */
  page: number;
  text: string;
}

/** 提前加载 pdfjs，避免第一次遇到 PDF 时才付启动成本。 */
export function prepareExtractor(): Promise<void> {
  return loadPdfjs().then(() => undefined);
}

let offThread: ((absPath: string) => Promise<TextPage[]>) | null = null;

/**
 * sqlite 索引线程里不要加载 pdfjs。pdfjs 和已打开的 better-sqlite3 挤在同一个线程里时，
 * 读普通文件会拖住整个进程的定时器。PDF 交给另一个不打开数据库的线程。
 */
let pdfDelegate: ((absPath: string, relPath: string, isCancelled?: () => boolean) => Promise<PageText[]>) | null =
  null;

export function setPdfDelegate(
  fn: (absPath: string, relPath: string, isCancelled?: () => boolean) => Promise<PageText[]>,
): void {
  pdfDelegate = fn;
}

/** 由 index.ts 注册。主线程把抽文本丢进已有 worker，避免本文件反向导入 index.ts。 */
export function setExtractOffThread(fn: (absPath: string) => Promise<TextPage[]>): void {
  offThread = fn;
}

/**
 * 按页抽出正文。PDF 每页一条，page 从 1 开始；txt 和 md 一条，page 为 0。
 * 不支持的扩展名返回空数组。主线程走 worker；已经在 worker 里则直接抽，避免自己等自己。
 */
export async function extractText(absPath: string): Promise<TextPage[]> {
  const abs = path.resolve(absPath);
  if (!isMainThread) {
    const pages = await extractFile(abs, path.basename(abs));
    return pages.map((page) => ({ page: page.page, text: page.body }));
  }
  if (!offThread) throw new Error('extractText 的 worker 入口还没注册');
  return offThread(abs);
}

/** 同步读 txt / md。不走 libuv 线程池，避免一批小文件把定时器拖过几十毫秒。 */
export function readPlainFile(absPath: string, relPath: string, isCancelled?: () => boolean): PageText[] {
  const rel = relPath.replace(/\\/g, '/');
  const title = (rel.split('/').pop() ?? rel).normalize('NFC');
  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.txt' && ext !== '.md') return [];
  const size = disk.statSync(absPath).size;
  if (textIndexSkip(absPath, size)) return [];
  const body = decodeUtf8(readChunks(absPath, isCancelled));
  return [{ page: 0, title, body }];
}

export async function extractFile(
  absPath: string,
  relPath: string,
  isCancelled?: () => boolean,
): Promise<PageText[]> {
  const rel = relPath.replace(/\\/g, '/');
  const title = (rel.split('/').pop() ?? rel).normalize('NFC');
  const ext = path.extname(absPath).toLowerCase();
  if (ext === '.pdf') {
    if (pdfDelegate) return pdfDelegate(absPath, relPath, isCancelled);
    return extractPdf(absPath, title, isCancelled);
  }
  if (ext === '.txt' || ext === '.md') {
    const body = decodeUtf8(await readChunks(absPath, isCancelled));
    return [{ page: 0, title, body }];
  }
  return [];
}
