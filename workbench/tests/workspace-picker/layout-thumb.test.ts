import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LayoutThumb, observeThumbEnter, type LayoutThumbProps } from '../../src/renderer/workspace-picker/LayoutThumb';
import { WORKSPACE_CARD_CLASS, layoutThumbModel, type LayoutThumbModel } from '../../src/shared/workspacePicker';

interface FixtureWs {
  id: string;
  favorite: boolean;
  thumb: LayoutThumbModel;
}

const samples = JSON.parse(readFileSync(path.join(process.cwd(), 'tests/fixtures/workspace-picker-samples.json'), 'utf8')) as {
  workspaces: FixtureWs[];
};

function ws(id: string): FixtureWs {
  const found = samples.workspaces.find((item) => item.id === id);
  if (!found) throw new Error(`fixture missing ${id}`);
  return found;
}

function markup(model: LayoutThumbModel, extra?: Omit<LayoutThumbProps, 'model'>): string {
  return renderToStaticMarkup(createElement(LayoutThumb, { model, ...extra }));
}

function nodeChunk(html: string, id: string): string {
  const marker = `data-node-id="${id}"`;
  const at = html.indexOf(marker);
  expect(at, id).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<div', at);
  const next = html.indexOf('data-node-id=', at + marker.length);
  const end = next === -1 ? html.length : html.lastIndexOf('<div', next);
  return html.slice(open, end);
}

function styleOf(html: string, id: string): string {
  const chunk = nodeChunk(html, id);
  const match = chunk.match(/style="([^"]*)"/);
  return match?.[1] ?? '';
}

function nameOf(html: string, id: string): string {
  const chunk = nodeChunk(html, id);
  const match = chunk.match(/class="kb-ws-thumb-name">([^<]*)</);
  return match?.[1] ?? '';
}

function cacheKeyOf(html: string): string {
  const match = html.match(/data-cache-key="([^"]*)"/);
  return match?.[1] ?? '';
}

function leafModel(width: number, title: string): LayoutThumbModel {
  return layoutThumbModel({
    layout: {
      dock: {
        grid: {
          root: { type: 'leaf', size: 1, data: { views: ['a'], activeView: 'a', id: 'g' } },
          width,
          height: 90,
          orientation: 'HORIZONTAL',
        },
        panels: {
          a: { id: 'a', contentComponent: 'view', params: { itemId: 'a' } },
        },
      },
    },
    items: [{ itemId: 'a', sourceKind: 'file', title }],
    thumbVersion: 0,
  });
}

describe('LayoutThumb', () => {
  it('卡片根使用约定的三个 class 名', () => {
    expect(WORKSPACE_CARD_CLASS).toEqual({ root: 'kb-ws-card', selected: 'is-selected', favorite: 'is-favorite' });
    const html = markup(ws('ws-empty').thumb, { selected: true, favorite: true });
    expect(html.startsWith('<div class="kb-ws-card is-selected is-favorite"')).toBe(true);
    const plain = markup(ws('ws-empty').thumb);
    expect(plain.startsWith('<div class="kb-ws-card"')).toBe(true);
    expect(plain).not.toContain('is-selected');
    expect(plain).not.toContain('is-favorite');
  });

  it('空布局零节点', () => {
    const emptyLayout = layoutThumbModel({ layout: { dock: null }, items: [], thumbVersion: 0 });
    expect(emptyLayout.nodes).toEqual([]);
    const fromLayout = markup(emptyLayout);
    expect(fromLayout).toContain('data-node-count="0"');
    expect(fromLayout).not.toContain('data-node-id');
    expect(fromLayout).not.toContain('kb-ws-thumb-node');

    const sample = ws('ws-empty');
    expect(sample.thumb.nodes).toEqual([]);
    const fromSample = markup(sample.thumb);
    expect(fromSample).toContain('data-node-count="0"');
    expect(fromSample).not.toContain('kb-ws-thumb-node');
    expect(fromSample).toContain('aspect-ratio:1.777');
  });

  it('最大化节点铺满，其余节点按归一化矩形', () => {
    const maximized = layoutThumbModel({
      layout: {
        dock: {
          grid: {
            root: { type: 'leaf', size: 1, data: { views: ['a'], activeView: 'a', id: 'g' } },
            width: 160,
            height: 90,
            orientation: 'HORIZONTAL',
          },
          panels: { a: { id: 'a', contentComponent: 'view', title: '甲', params: { itemId: 'a' } } },
        },
        windows: { gridMaximized: 'a' },
      },
      items: [{ itemId: 'a', sourceKind: 'file', title: '甲' }],
      thumbVersion: 0,
    });
    expect(maximized.nodes[0]?.flags.maximized).toBe(true);
    expect(styleOf(markup(maximized), 'a')).toBe('left:0%;top:0%;width:100%;height:100%');

    const english = markup(ws('ws-english').thumb);
    expect(nodeChunk(english, 'e1')).toContain('data-maximized="true"');
    expect(nodeChunk(english, 'e1')).toContain('is-maximized');
    expect(styleOf(english, 'e1')).toBe('left:0%;top:0%;width:100%;height:100%');
    expect(nodeChunk(english, 'e2')).toContain('data-hidden="true"');
    expect(nodeChunk(english, 'e2')).toContain('is-hidden');
    expect(styleOf(english, 'e2')).toBe('left:62%;top:0%;width:38%;height:100%');

    const mixed = markup(ws('ws-mixed').thumb);
    expect(styleOf(mixed, 'p-md')).toBe('left:0%;top:0%;width:50%;height:100%');
    expect(styleOf(mixed, 'p-pdf')).toBe('left:50%;top:0%;width:50%;height:50%');
    expect(styleOf(mixed, 'p-web')).toBe('left:50%;top:50%;width:25%;height:50%');
    expect(styleOf(mixed, 'p-app')).toBe('left:75%;top:50%;width:25%;height:50%');
    for (const key of ['markdown', 'pdf', 'web', 'app']) {
      expect(mixed).toContain(`data-icon-key="${key}"`);
    }
  });

  it('超过 8 个码位截断，emoji 不按 UTF-16 拦腰截', () => {
    const base = ws('ws-long').thumb.nodes[0]!;
    const nine = '一二三四五六七八九';
    const text: LayoutThumbModel = {
      cacheKey: 'cut-text',
      aspect: 16 / 9,
      nodes: [{ ...base, shortName: nine }],
    };
    expect(nameOf(markup(text), 'only')).toBe('一二三四五六七八');
    expect(markup(text)).not.toContain('九');

    const faces = '😀'.repeat(9);
    const emoji: LayoutThumbModel = {
      cacheKey: 'cut-emoji',
      aspect: 16 / 9,
      nodes: [{ ...base, id: 'emo', shortName: faces }],
    };
    const shown = nameOf(markup(emoji), 'emo');
    expect(shown).toBe('😀'.repeat(8));
    expect(Array.from(shown)).toHaveLength(8);
    expect(markup(emoji)).not.toContain('😀'.repeat(9));

    const exact = '一二三四五六七八';
    const keep: LayoutThumbModel = {
      cacheKey: 'cut-keep',
      aspect: 16 / 9,
      nodes: [{ ...base, shortName: exact }],
    };
    expect(nameOf(markup(keep), 'only')).toBe(exact);
  });

  it('缓存键随布局变、不随选中或收藏变', () => {
    const wide = leafModel(160, '甲');
    const narrow = leafModel(80, '甲');
    const renamed = leafModel(160, '完全不同的标题');
    expect(wide.cacheKey).toMatch(/^[0-9a-f]{64}$/);
    expect(narrow.cacheKey).not.toBe(wide.cacheKey);
    expect(renamed.cacheKey).toBe(wide.cacheKey);

    expect(cacheKeyOf(markup(wide))).toBe(wide.cacheKey);
    expect(cacheKeyOf(markup(wide, { selected: true }))).toBe(wide.cacheKey);
    expect(cacheKeyOf(markup(wide, { selected: true, favorite: true }))).toBe(wide.cacheKey);
    expect(cacheKeyOf(markup(wide, { favorite: true }))).toBe(wide.cacheKey);
    expect(cacheKeyOf(markup(narrow, { selected: true, favorite: true }))).toBe(narrow.cacheKey);
    expect(cacheKeyOf(markup(narrow, { selected: true }))).not.toBe(wide.cacheKey);
  });

  it('视口外不调用生成函数；相交才调用一次', () => {
    const generate = vi.fn();
    const target = { nodeType: 1 } as Element;
    const other = { nodeType: 1 } as Element;
    class FakeIO {
      static last: FakeIO | undefined;
      cb: IntersectionObserverCallback;
      disconnected = false;
      constructor(cb: IntersectionObserverCallback) {
        this.cb = cb;
        FakeIO.last = this;
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    const stop = observeThumbEnter(target, 'cache-1', generate, FakeIO as unknown as typeof IntersectionObserver);
    expect(generate).not.toHaveBeenCalled();
    const fire = (intersecting: boolean, el: Element | null) => {
      FakeIO.last!.cb(
        [{ isIntersecting: intersecting, target: el } as IntersectionObserverEntry],
        FakeIO.last as unknown as IntersectionObserver,
      );
    };
    fire(false, target);
    expect(generate).not.toHaveBeenCalled();
    fire(true, other);
    expect(generate).not.toHaveBeenCalled();
    fire(true, target);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith('cache-1');
    expect(FakeIO.last!.disconnected).toBe(true);
    fire(true, target);
    expect(generate).toHaveBeenCalledTimes(1);
    stop();

    observeThumbEnter(target, 'cache-2', generate, undefined);
    expect(generate).toHaveBeenCalledTimes(1);

    markup(ws('ws-empty').thumb, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('样例画出图标键、短名、收起与未知占位', () => {
    const webs = markup(ws('ws-webs').thumb);
    expect(nodeChunk(webs, 'w2')).toContain('data-collapsed="true"');
    expect(nodeChunk(webs, 'w2')).toContain('is-collapsed');
    expect(nameOf(webs, 'w1')).toBe('大纲');
    expect(nodeChunk(webs, 'w1')).toContain('data-collapsed="false"');

    const unknown = markup(ws('ws-unknown').thumb);
    const chunk = nodeChunk(unknown, 'u');
    expect(chunk).toContain('data-kind="unknown"');
    expect(chunk).toContain('data-unknown="true"');
    expect(chunk).toContain('data-icon-key="unknown"');
    expect(chunk).toContain('class="kb-ws-thumb-placeholder"');
    expect(chunk).toContain('>未知<');
    expect(nameOf(unknown, 'u')).toBe('未知');

    const host = markup(ws('ws-host').thumb);
    expect(nodeChunk(host, 'npp')).toContain('data-kind="native-host"');
    expect(nodeChunk(host, 'npp')).toContain('data-icon-key="native"');
    expect(nameOf(host, 'npp')).toBe('记事本');
    expect(styleOf(host, 'npp')).toBe('left:5%;top:5%;width:90%;height:90%');
  });

  it('组件不截图、不读正文、不启动应用；样式只有几何', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/LayoutThumb.tsx'), 'utf8');
    const css = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/layoutThumb.css'), 'utf8');
    expect(src).not.toMatch(/webSnapshot\s*\(/);
    expect(src).not.toContain('webSnapshot');
    expect(src).not.toMatch(/from\s+['"](?:node:)?fs['"]/);
    expect(src).not.toMatch(/from\s+['"](?:node:)?child_process['"]/);
    expect(src).not.toMatch(/from\s+['"]electron['"]/);
    expect(src).not.toContain('appLaunch');
    expect(src).not.toContain('host.attach');
    expect(src).not.toContain('readFile');
    expect(css).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/text-overflow:\s*ellipsis/);
    expect(css).toMatch(/max-width:\s*8em/);
    expect(css).not.toMatch(/--kb-/);
    expect(css).not.toMatch(/display:\s*none/);
    expect(css).not.toMatch(/visibility:\s*hidden/);
    expect(src + css).not.toContain('汇报');
  });
});
