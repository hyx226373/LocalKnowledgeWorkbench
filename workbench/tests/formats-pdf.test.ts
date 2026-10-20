import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { bindPptCfb } from '../scripts/ppt-cfb-binding.mjs';
import { MAX_PDF_PAGES } from '../src/shared/formats/limits';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import type { FormatInput, FormatResult } from '../src/shared/formats/types';
import { inputOf } from './formats-samples';

const root = path.join(__dirname, '..');
const samplePdfPath = '/workspace/fmt-plugin/samples/page.pdf';

function buildPdf(pageTexts: string[], encrypt = false): Uint8Array {
  const chunks: string[] = [];
  let cursor = 0;
  const offsets = [0];
  const push = (value: string) => {
    chunks.push(value);
    cursor += Buffer.byteLength(value, 'latin1');
  };
  push('%PDF-1.4\n');
  let next = 4;
  const ids = pageTexts.map(() => ({ page: next++, content: next++ }));
  const startObj = (n: number) => {
    offsets[n] = cursor;
    push(`${n} 0 obj\n`);
  };
  const endObj = () => push('endobj\n');
  startObj(1);
  push('<< /Type /Catalog /Pages 2 0 R >>\n');
  endObj();
  startObj(2);
  push(`<< /Type /Pages /Count ${pageTexts.length} /Kids [${ids.map((id) => `${id.page} 0 R`).join(' ')}] >>\n`);
  endObj();
  startObj(3);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n');
  endObj();
  pageTexts.forEach((text, index) => {
    const safe = text.replace(/[()\\]/g, (ch) => `\\${ch}`);
    const stream = `BT /F1 24 Tf 72 720 Td (${safe}) Tj ET`;
    const id = ids[index];
    if (!id) return;
    startObj(id.content);
    push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream\n`);
    endObj();
    startObj(id.page);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${id.content} 0 R /Resources << /Font << /F1 3 0 R >> >> >>\n`);
    endObj();
  });
  const xref = cursor;
  push(`xref\n0 ${next}\n`);
  push('0000000000 65535 f \n');
  for (let i = 1; i < next; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  const encryptDict = encrypt ? ' /Encrypt << /Filter /Standard /V 1 /R 2 /P -4 >>' : '';
  push(`trailer\n<< /Size ${next} /Root 1 0 R${encryptDict} >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Uint8Array(Buffer.from(chunks.join(''), 'latin1'));
}

describe('PDF 文字抽取', () => {
  it('按页抽出文字，不改画面阅读器', async () => {
    const bytes = buildPdf(['Hello PDF', 'Second page']);
    const result = await parseFormat(inputOf('pdf', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'paged') throw new Error('expected paged');
    expect(result.doc.pages.map((page) => page.blocks)).toEqual([[{ type: 'paragraph', text: 'Hello PDF' }], [{ type: 'paragraph', text: 'Second page' }]]);
    expect(result.doc.pages[0]?.width).toBeGreaterThan(0);
    expect(result.doc.assets).toEqual([]);
    const pages = await indexText(inputOf('pdf', bytes));
    expect(pages).toEqual([
      { page: 1, text: 'Hello PDF' },
      { page: 2, text: 'Second page' },
    ]);
  });

  it('坏文件是 corrupt，带加密字典是 encrypted', async () => {
    const broken = await parseFormat(inputOf('pdf', new Uint8Array(Buffer.from('%PDF-1.4\nnot a pdf'))));
    expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });
    const locked = await parseFormat(inputOf('pdf', buildPdf(['Secret'], true)));
    expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });
    expect(JSON.stringify(locked)).not.toContain('Secret');
  });

  it('超过 500 页时只留下前面的页，并给出截断说明', async () => {
    const texts = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, index) => `P${index + 1}`);
    const result = await parseFormat(inputOf('pdf', buildPdf(texts)));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'paged') throw new Error('expected paged');
    expect(result.doc.pages).toHaveLength(MAX_PDF_PAGES);
    expect(result.doc.pages[0]?.blocks).toEqual([{ type: 'paragraph', text: 'P1' }]);
    expect(result.doc.pages[MAX_PDF_PAGES - 1]?.blocks).toEqual([{ type: 'paragraph', text: `P${MAX_PDF_PAGES}` }]);
    expect(result.doc.warnings).toEqual([MSG.truncated]);
    expect(JSON.stringify(result.doc)).not.toContain(`P${MAX_PDF_PAGES + 1}`);
  });
});

describe('打包后的格式 Worker 抽 PDF', () => {
  async function bundledWorker(mode: 'browser' | 'node'): Promise<{ dir: string; worker: Worker }> {
    const dir = mkdtempSync(path.join(root, '.tmp-format-worker-pdf-'));
    const outfile = path.join(dir, 'format.worker.cjs');
    const boot = path.join(dir, 'boot.cjs');
    try {
      await build({
        absWorkingDir: root,
        entryPoints: ['src/renderer/plugins/builtin-formats/format.worker.ts'],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile,
        logLevel: 'silent',
        plugins: [
          {
            name: 'ppt-cfb',
            setup(pluginBuild) {
              pluginBuild.onLoad({ filter: /[\\/]ppt[\\/]ppt\.js$/ }, (args) => ({
                contents: bindPptCfb(readFileSync(args.path, 'utf8')),
                loader: 'js',
              }));
            },
          },
        ],
      });
      // browser：Electron 里 process.type 不是 browser 时，pdf.js 的 isNodeJS 为 false，
      // 这是渲染进程 Worker 的路径。node：isNodeJS 为 true，fake worker 会 import ./pdf.worker.mjs。
      const prelude = mode === 'browser' ? "process.type = 'worker';\n" : '';
      writeFileSync(
        boot,
        `${prelude}const { parentPort } = require('node:worker_threads');
const { parseRequest } = require('./format.worker.cjs');
parentPort.on('message', (data) => {
  if (!data || !data.input) return;
  Promise.resolve(parseRequest(data.input)).then(
    (result) => parentPort.postMessage({ id: data.id, result }),
    (error) => parentPort.postMessage({ id: data.id, error: String(error && error.stack || error) }),
  );
});
`,
      );
      return { dir, worker: new Worker(boot) };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  async function ask(worker: Worker, input: FormatInput, id: number): Promise<FormatResult> {
    const result = await new Promise<FormatResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker timeout ${id}`)), 20_000);
      const finish = (run: () => void) => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('error', onError);
        run();
      };
      const onError = (error: Error) => finish(() => reject(error));
      const onMessage = (message: { id?: number; result?: FormatResult; error?: string }) => {
        if (message.id !== id) return;
        finish(() => {
          if (message.error) reject(new Error(message.error));
          else if (message.result) resolve(message.result);
          else reject(new Error('empty worker result'));
        });
      };
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.postMessage({ id, input });
    });
    return result;
  }

  async function stop(worker: Worker, dir: string) {
    await worker.terminate();
    rmSync(dir, { recursive: true, force: true });
  }

  it('在浏览器 Worker 路径抽出样例文字、截断多页，损坏和加密文件不崩', async () => {
    const packed = await bundledWorker('browser');
    try {
      const sample = await ask(packed.worker, inputOf('pdf', new Uint8Array(readFileSync(samplePdfPath)), 'page.pdf'), 1);
      expect(sample.ok).toBe(true);
      if (!sample.ok || sample.doc.kind !== 'paged') throw new Error('expected paged');
      expect(sample.doc.pages[0]?.blocks).toEqual([{ type: 'paragraph', text: 'Hello PDF' }]);
      expect(sample.doc.pages[0]?.width).toBeGreaterThan(0);

      const texts = Array.from({ length: MAX_PDF_PAGES + 1 }, (_, index) => `P${index + 1}`);
      const truncated = await ask(packed.worker, inputOf('pdf', buildPdf(texts), 'many.pdf'), 2);
      expect(truncated.ok).toBe(true);
      if (!truncated.ok || truncated.doc.kind !== 'paged') throw new Error('expected paged');
      expect(truncated.doc.pages).toHaveLength(MAX_PDF_PAGES);
      expect(truncated.doc.pages[0]?.blocks).toEqual([{ type: 'paragraph', text: 'P1' }]);
      expect(truncated.doc.pages[MAX_PDF_PAGES - 1]?.blocks).toEqual([{ type: 'paragraph', text: `P${MAX_PDF_PAGES}` }]);
      expect(truncated.doc.warnings).toEqual([MSG.truncated]);

      const broken = await ask(packed.worker, inputOf('pdf', new Uint8Array(Buffer.from('%PDF-1.4\nnot a pdf')), 'broken.pdf'), 3);
      expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

      const locked = await ask(packed.worker, inputOf('pdf', buildPdf(['Secret'], true), 'locked.pdf'), 4);
      expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });
    } finally {
      await stop(packed.worker, packed.dir);
    }
  }, 90_000);

  it('在 Node 式打包 Worker 里也能抽出样例文字，坏文件仍是说明而不是异常', async () => {
    const packed = await bundledWorker('node');
    try {
      const sample = await ask(packed.worker, inputOf('pdf', new Uint8Array(readFileSync(samplePdfPath)), 'page.pdf'), 1);
      expect(sample.ok).toBe(true);
      if (!sample.ok || sample.doc.kind !== 'paged') throw new Error('expected paged');
      expect(sample.doc.pages[0]?.blocks).toEqual([{ type: 'paragraph', text: 'Hello PDF' }]);

      const broken = await ask(packed.worker, inputOf('pdf', new Uint8Array(Buffer.from('%PDF-1.4\ngarbage')), 'broken.pdf'), 2);
      expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });
    } finally {
      await stop(packed.worker, packed.dir);
    }
  }, 90_000);
});
