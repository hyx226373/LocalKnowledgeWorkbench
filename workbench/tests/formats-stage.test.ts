import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { bindPptCfb } from '../scripts/ppt-cfb-binding.mjs';

vi.mock('../src/renderer/kb', () => ({
  kb: {
    registerPlugin: async (id: string, version: string, source: 'builtin' | 'user') => ({
      id,
      version,
      source,
      enabled: true,
      granted: {},
      installedAt: 1,
    }),
    setPluginEnabled: async () => {},
  },
}));

import { checkStateForSave } from '../src/shared/adapter-sdk/policy';
import { MSG } from '../src/shared/formats/messages';
import type { DocModel } from '../src/shared/formats/types';
import type { AdapterContribution, AdapterTarget } from '../src/renderer/plugin-host/types';
import { makeFileItem, resolveItemAdapter } from '../src/renderer/plugin-host/layoutModel';
import { adapters } from '../src/renderer/plugin-host/registry';
import { pluginHost } from '../src/renderer/plugin-host/host';
import formatsPlugin from '../src/renderer/plugins/builtin-formats';
import { parseRequest } from '../src/renderer/plugins/builtin-formats/format.worker';
import { startFormatParse, type FormatWorkerPort } from '../src/renderer/plugins/builtin-formats/parseClient';
import { FormatStage, persistFormatState, scrollRatio } from '../src/renderer/plugins/builtin-formats/stage';
import { showNoReaderBadge } from '../src/renderer/dir-view/noReaderBadge';
import type { ResourceInfo } from '../src/shared/types';
import { contentTypes, inputOf, rels, zipOffice } from './formats-samples';

const root = path.join(__dirname, '..');

function resource(name: string, extra: Partial<ResourceInfo> = {}): ResourceInfo {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return {
    resourceId: 'r-' + name,
    rootId: 'root',
    relPath: name,
    name,
    kind: 'file',
    size: 4,
    mtimeMs: 1,
    ext,
    exists: true,
    readerType: 'unsupported',
    ...extra,
  };
}

function target(name: string, extra: Partial<ResourceInfo> = {}): AdapterTarget {
  return { sourceKind: 'file', resource: resource(name, extra) };
}

function tinyDocx(): Uint8Array {
  return zipOffice({
    '[Content_Types].xml': contentTypes([
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>你好</w:t></w:r></w:p></w:body></w:document>`,
  });
}

const flowDoc: DocModel = {
  kind: 'flow',
  warnings: [MSG.layoutLost],
  assets: [{ id: 'img-1', mime: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }],
  blocks: [
    { type: 'heading', level: 1, text: '标题' },
    { type: 'paragraph', text: '段落' },
    { type: 'list', ordered: false, items: ['甲', '乙'] },
    { type: 'table', rows: [['格', '值']] },
    { type: 'code', text: 'code()' },
    { type: 'image', assetId: 'img-1', alt: '图' },
    { type: 'unsupported', text: '公式' },
  ],
};

function renderStage(props: Partial<Parameters<typeof FormatStage>[0]> & { doc?: DocModel }) {
  return renderToStaticMarkup(
    createElement(FormatStage, {
      state: {},
      onState: () => {},
      ...props,
    }),
  );
}

describe('版式舞台', () => {
  it('flow 用阅读区令牌画出块，并显示警告', () => {
    const html = renderStage({ doc: flowDoc, state: { scale: 1.25, scroll: 0.4 } });
    expect(html).toContain('class="kb-reading reader format"');
    expect(html).toContain('class="kb-md"');
    expect(html).toContain('class="kb-table"');
    expect(html).toContain('data-testid="format-warnings"');
    expect(html).toContain(MSG.layoutLost);
    expect(html).toContain('标题');
    expect(html).toContain('段落');
    expect(html).toContain('<li>甲</li>');
    expect(html).toContain('code()');
    expect(html).toContain('data-asset-id="img-1"');
    expect(html).toContain('data-testid="format-unsupported-block"');
    expect(html).toContain('公式');
    expect(html).toContain('data-kind="flow"');
    expect(html).toContain('data-scale="1.25"');
    expect(html).toContain('data-scroll="0.4"');
    expect(html).toContain('--content-zoom:1.25');
  });

  it('段落里的粗斜体用 strong 和 em', () => {
    const html = renderStage({
      doc: {
        kind: 'flow',
        warnings: [],
        assets: [],
        blocks: [
          {
            type: 'paragraph',
            text: '你好粗体斜体',
            runs: [{ text: '你好' }, { text: '粗体', bold: true }, { text: '斜体', italic: true }],
          },
        ],
      },
    });
    expect(html).toContain('你好');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
  });

  it('sheets / slides / paged 按状态显示当前一张', () => {
    const sheets = renderStage({
      doc: {
        kind: 'sheets',
        warnings: [],
        assets: [],
        sheets: [
          { name: '一', rows: [['A1']] },
          { name: '二', rows: [['B9']] },
        ],
      },
      state: { sheet: 2 },
    });
    expect(sheets).toContain('data-testid="format-sheets"');
    expect(sheets).toContain('data-sheet="2"');
    expect(sheets).toContain('B9');
    expect(sheets).not.toContain('A1');
    expect(sheets).toContain('一');
    expect(sheets).toContain('二');
    expect(sheets).toContain('class="kb-table"');

    const slides = renderStage({
      doc: {
        kind: 'slides',
        warnings: ['扩展名与文件内容不一致，已按实际内容打开。'],
        assets: [],
        slides: [
          { blocks: [{ type: 'paragraph', text: '第一张' }] },
          { blocks: [{ type: 'paragraph', text: '第二张' }], notes: '讲稿' },
        ],
      },
      state: { slide: 2 },
    });
    expect(slides).toContain('data-slide="2"');
    expect(slides).toContain('第二张');
    expect(slides).not.toContain('第一张');
    expect(slides).toContain('data-testid="format-notes"');
    expect(slides).toContain('讲稿');
    expect(slides).toContain('扩展名与文件内容不一致');

    const paged = renderStage({
      doc: {
        kind: 'paged',
        warnings: [],
        assets: [],
        pages: [{ blocks: [{ type: 'paragraph', text: '页一' }] }, { blocks: [{ type: 'paragraph', text: '页二' }] }],
      },
      state: { page: 2 },
    });
    expect(paged).toContain('data-page="2"');
    expect(paged).toContain('页二');
    expect(paged).not.toContain('页一');
  });

  it('encrypted / too-large / timeout 用中文说明，并给出在资源管理器中显示', () => {
    for (const code of ['encrypted', 'too-large', 'timeout'] as const) {
      const html = renderStage({ failure: { code, message: MSG[code === 'too-large' ? 'tooLarge' : code] } });
      expect(html).toContain(`data-code="${code}"`);
      expect(html).toContain(MSG[code === 'too-large' ? 'tooLarge' : code]);
      expect(html).toContain('在资源管理器中显示');
      expect(html).not.toContain('password');
    }
  });

  it('损坏且没有中间结构时只显示说明；有部分结果时照常画并带警告', () => {
    const bare = renderStage({ failure: { code: 'corrupt', message: MSG.corrupt } });
    expect(bare).toContain(MSG.corrupt);
    expect(bare).toContain('在资源管理器中显示');
    expect(bare).not.toContain('data-testid="format-stage"');

    const partial = renderStage({
      doc: { kind: 'flow', blocks: [{ type: 'paragraph', text: '残留段落' }], assets: [], warnings: [] },
      failure: { code: 'corrupt', message: MSG.corrupt },
    });
    expect(partial).toContain('残留段落');
    expect(partial).toContain('data-testid="format-warnings"');
    expect(partial).toContain(MSG.corrupt);
  });

  it('状态只留下 page / sheet / slide / scroll / scale', () => {
    expect(persistFormatState({ page: 2.8, sheet: 0, slide: 4, scroll: 2, scale: 9, password: 'secret', text: '正文' } as never)).toEqual({
      page: 2,
      sheet: 1,
      slide: 4,
      scroll: 1,
      scale: 3,
    });
    expect(JSON.stringify(persistFormatState({ page: 1 }))).not.toMatch(/password|正文|secret/);
    expect(checkStateForSave(persistFormatState({ slide: 3, scroll: 0.2, body: 'x'.repeat(3000) } as never)).ok).toBe(true);
    expect(scrollRatio(25, 125, 25)).toBe(0.25);
    expect(scrollRatio(0, 10, 0)).toBeUndefined();
  });
});

describe('builtin.formats 注册与目录徽章', () => {
  beforeAll(async () => {
    adapters.register('builtin.readers', {
      id: 'builtin.unsupported',
      title: '文件信息',
      sourceKinds: ['file'],
      displayMode: 'in-app-reader',
      match: (item: AdapterTarget) => (item.sourceKind === 'file' && item.resource.kind === 'file' ? 1 : 0),
      component: () => null,
    } as AdapterContribution);
    await pluginHost.load([{ module: formatsPlugin, source: 'builtin' }]);
  });

  afterEach(async () => {
    if (pluginHost.get('builtin.formats')?.status !== 'active') await pluginHost.setEnabled('builtin.formats', true);
  });

  it('与内置阅读器并列，优先级 100，可禁用', async () => {
    const rec = pluginHost.get('builtin.formats');
    expect(rec?.status).toBe('active');
    expect(rec?.canDisable).toBe(true);
    expect(rec?.source).toBe('builtin');
    expect(formatsPlugin.manifest.id).toBe('builtin.formats');
    const extensions = formatsPlugin.manifest.contributes?.adapters?.flatMap((adapter) => adapter.match?.extensions ?? []);
    expect(extensions).toEqual(['docx', 'wps', 'xlsx', 'et', 'pptx', 'dps', 'epub', 'odt', 'rtf', 'ofd']);

    expect(adapters.best(target('a.docx'))?.id).toBe('builtin.formats.docx');
    expect(adapters.best(target('a.wps'))?.id).toBe('builtin.formats.docx');
    expect(adapters.best(target('a.xlsx'))?.id).toBe('builtin.formats.xlsx');
    expect(adapters.best(target('a.et'))?.id).toBe('builtin.formats.xlsx');
    expect(adapters.best(target('a.pptx'))?.id).toBe('builtin.formats.pptx');
    expect(adapters.best(target('a.dps'))?.id).toBe('builtin.formats.pptx');
    expect(adapters.best(target('a.epub'))?.id).toBe('builtin.formats.epub');
    expect(adapters.best(target('a.odt'))?.id).toBe('builtin.formats.odt');
    expect(adapters.best(target('a.rtf'))?.id).toBe('builtin.formats.rtf');
    expect(adapters.best(target('a.ofd'))?.id).toBe('builtin.formats.ofd');
    expect(adapters.best(target('a.ofd'))?.title).toBe('版式');
    for (const name of ['a.docx', 'a.xlsx', 'a.pptx', 'a.epub', 'a.odt', 'a.rtf', 'a.ofd']) {
      const adapter = adapters.best(target(name));
      expect(adapter?.displayMode).toBe('in-app-reader');
      expect(adapter?.owner).toBe('builtin.formats');
      expect(adapter?.match(target(name))).toBe(100);
      expect(adapter?.stateSchemaVersion).toBe(1);
    }
    expect(adapters.get('builtin.formats.docx')?.match(target('a.xlsx'))).toBe(0);
    expect(adapters.get('builtin.formats.docx')?.match({ sourceKind: 'web', url: 'https://example.com' })).toBe(0);
    expect(adapters.best(target('a.pdf'))?.id).toBe('builtin.unsupported');

    const saved = adapters.get('builtin.formats.docx')?.serializeState?.({ page: 3, scale: 1.2, password: 'secret', text: '正文' } as never);
    expect(saved).toEqual({ page: 3, scale: 1.2 });
    expect(checkStateForSave(saved).ok).toBe(true);
    expect(adapters.get('builtin.formats.docx')?.restoreState?.({ sheet: 2, token: 'abc' })).toEqual({ sheet: 2 });

    await pluginHost.setEnabled('builtin.formats', false);
    expect(pluginHost.get('builtin.formats')?.status).toBe('disabled');
    expect(adapters.get('builtin.formats.docx')).toBeUndefined();
    const resolved = resolveItemAdapter(
      makeFileItem('res-docx', 'builtin.formats.docx', 'item-docx'),
      (id) => adapters.get(id),
      () => undefined,
      (id) => pluginHost.adapterOwnerStatus(id),
    );
    expect(resolved.kind === 'placeholder' && resolved.reason).toBe('adapter-disabled');
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'docx', missing: false, sourceKind: 'file' })).toBe(true);
  });

  it('目录徽章在 adapters.best 不是 builtin.unsupported 时不显示', () => {
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'docx', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'WPS', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'epub', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'odt', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'rtf', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'ofd', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'bin', missing: false, sourceKind: 'file' })).toBe(true);
    expect(showNoReaderBadge({ reader: 'ok', ext: 'docx', missing: false, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: 'docx', missing: true, sourceKind: 'file' })).toBe(false);
    expect(showNoReaderBadge({ reader: 'unsupported', ext: '', missing: false, sourceKind: 'web' })).toBe(true);
  });
});

describe('解析 Worker', () => {
  it('把 docx 交给 Worker 入口，超时则停掉 Worker', async () => {
    let terminated = false;
    const bridge: FormatWorkerPort = {
      onmessage: null,
      onerror: null,
      terminate() {
        terminated = true;
      },
      postMessage(message) {
        void parseRequest(message.input).then((result) => {
          this.onmessage?.({ data: { id: message.id, result } });
        });
      },
    };
    const parsed = await startFormatParse(inputOf('docx', tinyDocx(), '你好.docx'), {
      timeoutMs: 5000,
      createWorker: () => bridge,
    }).promise;
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.doc.kind !== 'flow') throw new Error('expected flow');
    expect(parsed.doc.blocks).toContainEqual({ type: 'paragraph', text: '你好' });
    expect(terminated).toBe(true);

    let hung = false;
    const hanging: FormatWorkerPort = {
      onmessage: null,
      onerror: null,
      terminate() {
        hung = true;
      },
      postMessage() {},
    };
    const timed = await startFormatParse(inputOf('docx', tinyDocx()), { timeoutMs: 30, createWorker: () => hanging }).promise;
    expect(timed).toEqual({ ok: false, code: 'timeout', message: MSG.timeout });
    expect(hung).toBe(true);
  });

  it('跳过 pdf.js worker 自启的 ready 握手，只认解析结果', async () => {
    const bridge: FormatWorkerPort = {
      onmessage: null,
      onerror: null,
      terminate() {},
      postMessage(message) {
        // 真实 Worker 里 pdf.js 的 WorkerMessageHandler 一加载就先发这条
        this.onmessage?.({ data: { sourceName: 'worker', targetName: 'main', action: 'ready', data: null } as never });
        void parseRequest(message.input).then((result) => {
          this.onmessage?.({ data: { id: message.id, result } });
        });
      },
    };
    const parsed = await startFormatParse(inputOf('docx', tinyDocx(), '你好.docx'), { timeoutMs: 5000, createWorker: () => bridge }).promise;
    expect(parsed.ok).toBe(true);
  });

  it('在 worker_threads 里解析同一份 docx', async () => {
    const dir = mkdtempSync(path.join(root, '.tmp-format-worker-'));
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
      writeFileSync(
        boot,
        `const { parentPort } = require('node:worker_threads');
const { parseRequest } = require('./format.worker.cjs');
parentPort.on('message', (data) => {
  if (!data || !data.input || !data.input.bytes) return;
  Promise.resolve(parseRequest(data.input)).then((result) => parentPort.postMessage({ id: data.id, result }));
});
`,
      );
      const worker = new Worker(boot);
      const result = await new Promise<{ ok: boolean; doc?: { kind: string; blocks: { text?: string }[] } }>((resolve, reject) => {
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(new Error('worker timeout'));
        }, 15000);
        worker.once('message', (message) => {
          clearTimeout(timer);
          resolve(message.result);
        });
        worker.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        worker.postMessage({ id: 1, input: inputOf('docx', tinyDocx(), '你好.docx') });
      });
      await worker.terminate();
      expect(result.ok).toBe(true);
      expect(result.doc?.kind).toBe('flow');
      expect(result.doc?.blocks).toContainEqual({ type: 'paragraph', text: '你好' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
