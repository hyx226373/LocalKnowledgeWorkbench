import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { MAX_PDF_PAGES } from './limits';
import { MSG } from './messages';
import type { FormatInput, FormatResult } from './types';
import { FormatFail } from './types';

type PdfjsWorkerGlobal = typeof globalThis & {
  pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler };
};

// pdf.js 6.3 的 getDocument 已经没有 disableWorker。PDFWorker（legacy/build/pdf.mjs）
// 在 Node 里把 workerSrc 设成 "./pdf.worker.mjs" 再动态 import；浏览器里没设 workerSrc
// 就直接失败。格式解析自己已经在 Worker 里，包旁边没有这个文件。
// 把 legacy worker 的 WorkerMessageHandler 挂到 globalThis.pdfjsWorker 后，
// PDFWorker.#mainThreadWorkerMessageHandler 命中，走同线程 fake worker（LoopbackPort）。
// 这个模块只从格式 Worker 和测试进来。PdfView 用的是另一份 pdfjs-dist 构建，不经过这里。
const pdfjsScope = globalThis as PdfjsWorkerGlobal;
pdfjsScope.pdfjsWorker = { WorkerMessageHandler };

/** 加密字典在文件头或尾部。正文里的同名文字不在这里。 */
function markedEncrypted(bytes: Uint8Array): boolean {
  const latin = (start: number, length: number) => Buffer.from(bytes.subarray(start, Math.min(bytes.length, start + length))).toString('latin1');
  const head = latin(0, 4096);
  const tail = latin(Math.max(0, bytes.length - 8192), 8192);
  return /\/Encrypt\b/.test(head) || /\/Encrypt\b/.test(tail);
}

function isPassword(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error ? String(error.name) : '';
  const message = 'message' in error ? String(error.message) : '';
  return name === 'PasswordException' || /password|encrypt/i.test(message);
}

type PdfTextItem = { str: string; hasEOL?: boolean };

function pageText(items: unknown[]): string {
  const lines: string[] = [];
  let line = '';
  for (const item of items) {
    if (!item || typeof item !== 'object' || !('str' in item)) continue;
    const text = item as PdfTextItem;
    line += text.str;
    if (text.hasEOL) {
      lines.push(line);
      line = '';
    }
  }
  if (line) lines.push(line);
  return lines.join('\n').trim();
}

/** 只抽文字，不改现有 PdfView。失败不把 pdf.js 的内部信息带出去。 */
export async function parsePdfText(input: FormatInput): Promise<FormatResult> {
  if (markedEncrypted(input.bytes)) return { ok: false, code: 'encrypted', message: MSG.encrypted };
  const task = getDocument({
    data: input.bytes.slice(),
    useSystemFonts: false,
  });
  try {
    const doc = await task.promise;
    const warnings: string[] = [];
    const count = Math.min(doc.numPages, MAX_PDF_PAGES);
    if (doc.numPages > MAX_PDF_PAGES) warnings.push(MSG.truncated);
    const pages: { blocks: { type: 'paragraph'; text: string }[]; width: number; height: number }[] = [];
    for (let n = 1; n <= count; n++) {
      const page = await doc.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const text = pageText(content.items);
      pages.push({
        blocks: text ? [{ type: 'paragraph', text }] : [],
        width: view.width,
        height: view.height,
      });
    }
    return { ok: true, doc: { kind: 'paged', pages, assets: [], warnings } };
  } catch (error) {
    if (error instanceof FormatFail) throw error;
    if (isPassword(error)) return { ok: false, code: 'encrypted', message: MSG.encrypted };
    return { ok: false, code: 'corrupt', message: MSG.corrupt };
  } finally {
    await task.destroy();
  }
}
