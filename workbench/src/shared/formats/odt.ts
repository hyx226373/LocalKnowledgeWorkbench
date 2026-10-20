import { MAX_BLOCKS } from './limits';
import { MSG } from './messages';
import { isRemoteTarget } from './rels';
import type { Asset, Block, DocModel } from './types';
import { FormatFail } from './types';
import { attrOf, childArray, decodeBasicEntities, decodeXml, parseOrdered, tagOf, type XNode } from './xml';

/**
 * ODT 收成 flow。图片只留包内路径，包外链接丢掉且不取。
 * 不跑脚本。列表是否有序看 list-style，不看样式名猜。
 */

const SKIP = new Set(['script', 'annotation', 'note', 'deletion', 'tracked-changes', 'change-info']);
const MAX_REPEAT = 32;

function pushBlock(blocks: Block[], warnings: string[], block: Block): boolean {
  if (blocks.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return false;
  }
  blocks.push(block);
  return true;
}

function clean(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function repeatCount(node: XNode, name: string, warnings: string[]): number {
  const raw = attrOf(node, name);
  if (!raw) return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return 1;
  if (value > MAX_REPEAT) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return MAX_REPEAT;
  }
  return Math.floor(value);
}

function inlineText(nodes: XNode[], warnings: string[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node['#text'] === 'string') {
      out += decodeBasicEntities(node['#text']);
      continue;
    }
    const tag = tagOf(node);
    if (!tag || SKIP.has(tag) || tag === 'image' || tag === 'frame' || tag === 'object') continue;
    if (tag === 'br' || tag === 'line-break') {
      out += '\n';
      continue;
    }
    if (tag === 'tab') {
      out += '\t';
      continue;
    }
    if (tag === 's') {
      const count = repeatCount(node, 'c', warnings);
      out += ' '.repeat(count);
      continue;
    }
    if (tag === 'p' || tag === 'h') {
      const piece = inlineText(childArray(node), warnings);
      if (!piece) continue;
      if (out && !out.endsWith('\n')) out += '\n';
      out += piece;
      continue;
    }
    out += inlineText(childArray(node), warnings);
  }
  return out;
}

function findFirst(nodes: XNode[], tag: string): XNode | undefined {
  for (const node of nodes) {
    if (tagOf(node) === tag) return node;
    const nested = findFirst(childArray(node), tag);
    if (nested) return nested;
  }
  return undefined;
}

function mimeOf(name: string): string {
  switch (name.split('.').pop()?.toLowerCase()) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    case 'bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

function packagePath(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || isRemoteTarget(trimmed)) return null;
  const bare = trimmed.split('#')[0]?.split('?')[0] ?? '';
  let decoded = bare.trim();
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // 非法 % 序列按原样查找。
  }
  const path = decoded.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  if (!path || path.split('/').includes('..')) return null;
  return path;
}

export function isOdtPackage(files: Map<string, Uint8Array>): boolean {
  const mime = files.get('mimetype');
  if (mime) {
    const text = decodeXml(mime).replace(/^\uFEFF/, '').trim();
    if (text === 'application/vnd.oasis.opendocument.text' || text === 'application/vnd.oasis.opendocument.text-template') return true;
    if (text.startsWith('application/vnd.oasis.opendocument.')) return false;
  }
  const content = files.get('content.xml');
  if (!content) return false;
  const head = decodeXml(content.subarray(0, Math.min(content.length, 128 * 1024))).toLowerCase();
  if (head.includes('office:spreadsheet') || head.includes('office:presentation') || head.includes('office:chart')) return false;
  return /<office:text[\s>]/.test(head);
}

function headingFromStyle(name: string): number {
  const decoded = name.replace(/_20_/g, ' ').replace(/_/g, ' ').trim();
  const match = /^(?:heading|标题)\s*([1-6])$/i.exec(decoded);
  return match ? Number(match[1]) : 0;
}

function orderedStyles(files: Map<string, Uint8Array>): Set<string> {
  const ordered = new Set<string>();
  for (const name of ['content.xml', 'styles.xml']) {
    const bytes = files.get(name);
    if (!bytes) continue;
    let nodes: XNode[] = [];
    try {
      nodes = parseOrdered(decodeXml(bytes));
    } catch (error) {
      if (name === 'content.xml') throw error;
      continue;
    }
    const visit = (list: XNode[]) => {
      for (const node of list) {
        if (tagOf(node) === 'list-style') {
          const styleName = attrOf(node, 'name');
          const level = childArray(node).find((child) => {
            const value = attrOf(child, 'level');
            return value === '' || value === '1';
          });
          if (styleName && level && tagOf(level) === 'list-level-style-number') ordered.add(styleName);
        }
        visit(childArray(node));
      }
    };
    visit(nodes);
  }
  return ordered;
}

function noteRemotes(nodes: XNode[], warnings: string[]): void {
  const visit = (list: XNode[]) => {
    for (const node of list) {
      const tag = tagOf(node);
      if (!tag || SKIP.has(tag)) continue;
      const href = attrOf(node, 'href');
      if (href && isRemoteTarget(href) && !warnings.includes(MSG.externalRel)) warnings.push(MSG.externalRel);
      visit(childArray(node));
    }
  };
  visit(nodes);
}

interface Ctx {
  files: Map<string, Uint8Array>;
  blocks: Block[];
  assets: Asset[];
  warnings: string[];
  cache: Map<string, string>;
  ordered: Set<string>;
  stop: boolean;
}

function push(ctx: Ctx, block: Block): void {
  if (ctx.stop) return;
  ctx.stop = !pushBlock(ctx.blocks, ctx.warnings, block);
}

function takeImage(ctx: Ctx, href: string, alt: string): Block | null {
  if (isRemoteTarget(href)) {
    if (!ctx.warnings.includes(MSG.externalRel)) ctx.warnings.push(MSG.externalRel);
    return null;
  }
  const path = packagePath(href);
  if (!path) return null;
  const cached = ctx.cache.get(path);
  if (cached) return alt ? { type: 'image', assetId: cached, alt } : { type: 'image', assetId: cached };
  const bytes = ctx.files.get(path);
  if (!bytes) return null;
  const id = `img-${ctx.assets.length + 1}`;
  ctx.assets.push({ id, mime: mimeOf(path), bytes });
  ctx.cache.set(path, id);
  return alt ? { type: 'image', assetId: id, alt } : { type: 'image', assetId: id };
}

function emitImages(ctx: Ctx, node: XNode): void {
  const walk = (current: XNode) => {
    if (ctx.stop) return;
    const tag = tagOf(current);
    if (!tag || SKIP.has(tag) || tag === 'table' || tag === 'list') return;
    if (tag === 'image') {
      const block = takeImage(ctx, attrOf(current, 'href') || attrOf(current, 'src'), clean(attrOf(current, 'name')));
      if (block) push(ctx, block);
      return;
    }
    for (const child of childArray(current)) walk(child);
  };
  walk(node);
}

function emitList(ctx: Ctx, list: XNode): void {
  const ordered = ctx.ordered.has(attrOf(list, 'style-name'));
  let items: string[] = [];
  const flush = () => {
    if (!items.length || ctx.stop) {
      items = [];
      return;
    }
    push(ctx, { type: 'list', ordered, items });
    items = [];
  };
  for (const child of childArray(list)) {
    if (ctx.stop) return;
    if (tagOf(child) !== 'list-item') continue;
    const nested: XNode[] = [];
    const own: XNode[] = [];
    for (const grand of childArray(child)) {
      if (tagOf(grand) === 'list') nested.push(grand);
      else own.push(grand);
    }
    const text = clean(inlineText(own, ctx.warnings));
    if (text) items.push(text);
    emitImages(ctx, child);
    if (nested.length) {
      flush();
      for (const item of nested) emitList(ctx, item);
    }
  }
  flush();
}

function cellsOf(row: XNode, warnings: string[]): string[] {
  const cells: string[] = [];
  const visit = (node: XNode) => {
    for (const child of childArray(node)) {
      const tag = tagOf(child);
      if (!tag || tag === 'table') continue;
      if (tag === 'table-cell' || tag === 'covered-table-cell') {
        const text = tag === 'covered-table-cell' ? '' : clean(inlineText(childArray(child), warnings));
        const times = repeatCount(child, 'number-columns-repeated', warnings);
        for (let i = 0; i < times; i++) cells.push(text);
        continue;
      }
      visit(child);
    }
  };
  visit(row);
  return cells;
}

function emitTable(ctx: Ctx, table: XNode): void {
  const rows: string[][] = [];
  const visit = (node: XNode) => {
    for (const child of childArray(node)) {
      const tag = tagOf(child);
      if (!tag || tag === 'table') continue;
      if (tag === 'table-row') {
        const cells = cellsOf(child, ctx.warnings);
        if (cells.length) {
          const times = repeatCount(child, 'number-rows-repeated', ctx.warnings);
          for (let i = 0; i < times; i++) rows.push([...cells]);
        }
        continue;
      }
      visit(child);
    }
  };
  visit(table);
  if (rows.length) push(ctx, { type: 'table', rows });
}

function levelOf(node: XNode, tag: string): number {
  if (tag === 'h') {
    const outline = Number(attrOf(node, 'outline-level'));
    if (Number.isFinite(outline) && outline >= 1) return Math.min(6, Math.floor(outline));
    return headingFromStyle(attrOf(node, 'style-name')) || 1;
  }
  return headingFromStyle(attrOf(node, 'style-name'));
}

function emitBlocks(ctx: Ctx, nodes: XNode[]): void {
  for (const node of nodes) {
    if (ctx.stop) return;
    const tag = tagOf(node);
    if (!tag || SKIP.has(tag)) continue;
    if (tag === 'h' || tag === 'p') {
      const text = clean(inlineText(childArray(node), ctx.warnings));
      const level = levelOf(node, tag);
      if (text) push(ctx, level ? { type: 'heading', level, text } : { type: 'paragraph', text });
      emitImages(ctx, node);
    } else if (tag === 'list') {
      emitList(ctx, node);
    } else if (tag === 'table') {
      emitTable(ctx, node);
    } else if (tag === 'frame' || tag === 'image') {
      emitImages(ctx, node);
    } else {
      emitBlocks(ctx, childArray(node));
    }
  }
}

function officeText(nodes: XNode[]): XNode | undefined {
  const body = findFirst(nodes, 'body');
  if (!body) return findFirst(nodes, 'text');
  return childArray(body).find((node) => tagOf(node) === 'text') ?? body;
}

export function parseOdt(files: Map<string, Uint8Array>, warnings: string[]): DocModel {
  const content = files.get('content.xml');
  if (!content) throw new FormatFail('corrupt', MSG.corrupt);
  const nodes = parseOrdered(decodeXml(content));
  const text = officeText(nodes);
  if (!text) throw new FormatFail('corrupt', MSG.corrupt);
  noteRemotes(childArray(text), warnings);
  const ctx: Ctx = {
    files,
    blocks: [],
    assets: [],
    warnings,
    cache: new Map(),
    ordered: orderedStyles(files),
    stop: false,
  };
  emitBlocks(ctx, childArray(text));
  return { kind: 'flow', blocks: ctx.blocks, assets: ctx.assets, warnings };
}
