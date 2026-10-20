import { MAX_BLOCKS } from './limits';
import { MSG } from './messages';
import { isRemoteTarget, resolvePart } from './rels';
import type { Asset, Block, DocModel } from './types';
import { FormatFail } from './types';
import { attrOf, childArray, decodeBasicEntities, decodeXml, parseOrdered, tagOf, type XNode } from './xml';

/**
 * EPUB 按 spine 顺序收成 flow。目录标题补在没有同文标题的章节前面。
 * 不跑脚本，不取包外地址。图片只引用包内文件。
 */

interface Item {
  href: string;
  path: string | null;
  media: string;
  props: string;
  remote: boolean;
}

interface TocEntry {
  path: string;
  fragment: string;
  title: string;
  level: number;
  used: boolean;
}

const CONTAINERS = new Set(['div', 'section', 'article', 'blockquote', 'figure', 'figcaption', 'header', 'footer', 'main', 'aside', 'center']);
const SKIP_TEXT = new Set(['script', 'style', 'nav', 'annotation', 'note', 'rt', 'rp', 'iframe', 'object', 'embed']);

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

function inlineText(nodes: XNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node['#text'] === 'string') {
      out += decodeBasicEntities(node['#text']);
      continue;
    }
    const tag = tagOf(node);
    if (!tag || SKIP_TEXT.has(tag) || tag === 'img' || tag === 'image') continue;
    if (tag === 'br' || tag === 'line-break') {
      out += '\n';
      continue;
    }
    if (tag === 'tab') {
      out += '\t';
      continue;
    }
    out += inlineText(childArray(node));
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

function normalizeZipPath(value: string): string {
  let text = value.trim().replace(/\\/g, '/');
  try {
    text = decodeURIComponent(text);
  } catch {
    // 非法 % 序列按原样查找。
  }
  return text.replace(/^\/+/, '').replace(/^\.\//, '');
}

function resolveHref(fromPart: string, href: string): { path: string | null; fragment: string; remote: boolean } {
  const trimmed = href.trim();
  if (!trimmed) return { path: null, fragment: '', remote: false };
  const hash = trimmed.indexOf('#');
  const before = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
  const fragment = hash >= 0 ? trimmed.slice(hash + 1) : '';
  const query = before.indexOf('?');
  const raw = query >= 0 ? before.slice(0, query) : before;
  if (!raw) return { path: fromPart, fragment, remote: false };
  if (isRemoteTarget(raw)) return { path: null, fragment, remote: true };
  const path = raw.startsWith('/') ? normalizeZipPath(raw) : resolvePart(fromPart, normalizeZipPath(raw));
  if (!path || path.split('/').includes('..')) return { path: null, fragment, remote: false };
  return { path, fragment, remote: false };
}

export function isEpubPackage(files: Map<string, Uint8Array>): boolean {
  const mime = files.get('mimetype');
  if (mime && decodeXml(mime).replace(/^\uFEFF/, '').trim().startsWith('application/epub+zip')) return true;
  return files.has('META-INF/container.xml');
}

function opfPathOf(files: Map<string, Uint8Array>): string {
  const container = files.get('META-INF/container.xml');
  if (container) {
    const nodes = parseOrdered(decodeXml(container));
    let full = '';
    const visit = (list: XNode[]) => {
      for (const node of list) {
        if (!full && tagOf(node) === 'rootfile') full = attrOf(node, 'full-path');
        visit(childArray(node));
      }
    };
    visit(nodes);
    if (full) {
      const path = normalizeZipPath(full);
      if (!path || !files.has(path)) throw new FormatFail('corrupt', MSG.corrupt);
      return path;
    }
  }
  const found = [...files.keys()].find((name) => name.toLowerCase().endsWith('.opf'));
  if (!found) throw new FormatFail('corrupt', MSG.corrupt);
  return found;
}

function readPackage(files: Map<string, Uint8Array>, opfPath: string): { manifest: Map<string, Item>; spine: string[]; tocId: string } {
  const manifest = new Map<string, Item>();
  const spine: string[] = [];
  let tocId = '';
  const visit = (nodes: XNode[]) => {
    for (const node of nodes) {
      const tag = tagOf(node);
      if (tag === 'item') {
        const id = attrOf(node, 'id');
        const href = attrOf(node, 'href');
        if (id && href) {
          const resolved = resolveHref(opfPath, href);
          manifest.set(id, { href, path: resolved.path, media: attrOf(node, 'media-type').toLowerCase(), props: attrOf(node, 'properties').toLowerCase(), remote: resolved.remote });
        }
      } else if (tag === 'spine') {
        if (!tocId) tocId = attrOf(node, 'toc');
      } else if (tag === 'itemref') {
        const idref = attrOf(node, 'idref');
        if (idref) spine.push(idref);
      }
      visit(childArray(node));
    }
  };
  visit(parseOrdered(decodeXml(files.get(opfPath)!)));
  return { manifest, spine, tocId };
}

function findTocNav(nodes: XNode[]): XNode | undefined {
  let fallback: XNode | undefined;
  const visit = (list: XNode[]): XNode | undefined => {
    for (const node of list) {
      if (tagOf(node) === 'nav') {
        const type = attrOf(node, 'type').toLowerCase().split(/\s+/);
        if (type.includes('toc')) return node;
        fallback ??= node;
      }
      const nested = visit(childArray(node));
      if (nested) return nested;
    }
    return undefined;
  };
  return visit(nodes) ?? fallback;
}

function firstList(node: XNode | undefined): XNode | undefined {
  if (!node) return undefined;
  for (const child of childArray(node)) {
    const tag = tagOf(child);
    if (tag === 'ol' || tag === 'ul') return child;
    const nested = firstList(child);
    if (nested) return nested;
  }
  return undefined;
}

function readNavList(list: XNode, level: number, from: string, out: TocEntry[], warnings: string[]): void {
  for (const node of childArray(list)) {
    if (tagOf(node) !== 'li') continue;
    const anchor = childArray(node).find((child) => tagOf(child) === 'a');
    if (anchor) {
      const title = clean(inlineText(childArray(anchor)));
      const resolved = resolveHref(from, attrOf(anchor, 'href'));
      if (resolved.remote) {
        if (!warnings.includes(MSG.externalRel)) warnings.push(MSG.externalRel);
      } else if (title && resolved.path) {
        out.push({ path: resolved.path, fragment: resolved.fragment, title, level: Math.min(6, Math.max(1, level)), used: false });
      }
    }
    for (const child of childArray(node)) {
      const tag = tagOf(child);
      if (tag === 'ol' || tag === 'ul') readNavList(child, level + 1, from, out, warnings);
    }
  }
}

function readNcx(nodes: XNode[], from: string, out: TocEntry[]): void {
  const visit = (list: XNode[], level: number) => {
    for (const node of list) {
      if (tagOf(node) !== 'navPoint') {
        visit(childArray(node), level);
        continue;
      }
      const label = childArray(node).find((child) => tagOf(child) === 'navLabel');
      const textNode = label ? childArray(label).find((child) => tagOf(child) === 'text') : undefined;
      const title = clean(inlineText(textNode ? childArray(textNode) : []));
      const content = childArray(node).find((child) => tagOf(child) === 'content');
      const resolved = resolveHref(from, attrOf(content, 'src'));
      if (title && resolved.path && !resolved.remote) {
        out.push({ path: resolved.path, fragment: resolved.fragment, title, level: Math.min(6, Math.max(1, level)), used: false });
      }
      visit(
        childArray(node).filter((child) => tagOf(child) === 'navPoint'),
        level + 1,
      );
    }
  };
  visit(nodes, 1);
}

function tocOf(files: Map<string, Uint8Array>, item: Item | undefined, warnings: string[]): TocEntry[] {
  if (!item?.path) return [];
  const bytes = files.get(item.path);
  if (!bytes) return [];
  const nodes = parseOrdered(decodeXml(bytes));
  const out: TocEntry[] = [];
  const ncx = item.media.includes('ncx') || item.media.includes('dtbncx') || item.path.toLowerCase().endsWith('.ncx');
  if (ncx) {
    readNcx(nodes, item.path, out);
    return out;
  }
  const nav = findTocNav(nodes);
  const list = firstList(nav);
  if (list) readNavList(list, 1, item.path, out, warnings);
  return out;
}

function isHtml(item: Item): boolean {
  if (item.media.includes('ncx') || item.media.includes('dtbncx') || item.path?.toLowerCase().endsWith('.ncx')) return false;
  if (item.media.includes('html')) return true;
  return /\.(xhtml|html|htm)$/i.test(item.path ?? item.href);
}

function isImage(item: Item): boolean {
  if (item.media.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.path ?? item.href);
}

function headingLevel(tag: string): number {
  const match = /^h([1-6])$/.exec(tag);
  return match ? Number(match[1]) : 0;
}

function startsWithTitle(nodes: XNode[], title: string): boolean {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) {
      if (typeof node['#text'] === 'string' && clean(decodeBasicEntities(node['#text']))) return false;
      continue;
    }
    if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') continue;
    const level = headingLevel(tag);
    if (level) return clean(inlineText(childArray(node))) === title;
    if (CONTAINERS.has(tag) || tag === 'body' || tag === 'html') return startsWithTitle(childArray(node), title);
    return false;
  }
  return false;
}

interface ChapterCtx {
  files: Map<string, Uint8Array>;
  from: string;
  blocks: Block[];
  assets: Asset[];
  warnings: string[];
  cache: Map<string, string>;
  frags: Map<string, TocEntry>;
  stop: boolean;
}

function push(ctx: ChapterCtx, block: Block): void {
  if (ctx.stop) return;
  ctx.stop = !pushBlock(ctx.blocks, ctx.warnings, block);
}

function takeImage(ctx: ChapterCtx, src: string, alt: string): Block | null {
  if (isRemoteTarget(src)) {
    if (!ctx.warnings.includes(MSG.externalRel)) ctx.warnings.push(MSG.externalRel);
    return null;
  }
  const resolved = resolveHref(ctx.from, src);
  if (resolved.remote) {
    if (!ctx.warnings.includes(MSG.externalRel)) ctx.warnings.push(MSG.externalRel);
    return null;
  }
  if (!resolved.path) return null;
  const cached = ctx.cache.get(resolved.path);
  if (cached) return alt ? { type: 'image', assetId: cached, alt } : { type: 'image', assetId: cached };
  const bytes = ctx.files.get(resolved.path);
  if (!bytes) return null;
  const id = `img-${ctx.assets.length + 1}`;
  ctx.assets.push({ id, mime: mimeOf(resolved.path), bytes });
  ctx.cache.set(resolved.path, id);
  return alt ? { type: 'image', assetId: id, alt } : { type: 'image', assetId: id };
}

function emitImages(ctx: ChapterCtx, node: XNode): void {
  const walk = (current: XNode) => {
    if (ctx.stop) return;
    const tag = tagOf(current);
    if (!tag || SKIP_TEXT.has(tag)) return;
    if (tag === 'img' || tag === 'image') {
      const block = takeImage(ctx, attrOf(current, 'src') || attrOf(current, 'href'), clean(attrOf(current, 'alt')));
      if (block) push(ctx, block);
      return;
    }
    for (const child of childArray(current)) walk(child);
  };
  walk(node);
}

function emitList(ctx: ChapterCtx, list: XNode, ordered: boolean): void {
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
    const tag = tagOf(child);
    if (tag !== 'li' && tag !== 'list-item') continue;
    const nested: XNode[] = [];
    const own: XNode[] = [];
    for (const grand of childArray(child)) {
      const grandTag = tagOf(grand);
      if (grandTag === 'ul' || grandTag === 'ol' || grandTag === 'list') nested.push(grand);
      else own.push(grand);
    }
    const text = clean(inlineText(own));
    if (text) items.push(text);
    emitImages(ctx, child);
    if (nested.length) {
      flush();
      for (const item of nested) {
        const nestedTag = tagOf(item);
        emitList(ctx, item, nestedTag === 'ol');
      }
    }
  }
  flush();
}

function cellsOf(row: XNode): string[] {
  const cells: string[] = [];
  const visit = (node: XNode) => {
    for (const child of childArray(node)) {
      const tag = tagOf(child);
      if (!tag) continue;
      if (tag === 'table') continue;
      if (tag === 'td' || tag === 'th' || tag === 'table-cell') {
        cells.push(clean(inlineText(childArray(child))));
        continue;
      }
      visit(child);
    }
  };
  visit(row);
  return cells;
}

function emitTable(ctx: ChapterCtx, table: XNode): void {
  const rows: string[][] = [];
  const visit = (node: XNode) => {
    for (const child of childArray(node)) {
      const tag = tagOf(child);
      if (!tag || tag === 'table') continue;
      if (tag === 'tr' || tag === 'table-row') {
        const cells = cellsOf(child);
        if (cells.length) rows.push(cells);
        continue;
      }
      visit(child);
    }
  };
  visit(table);
  if (rows.length) push(ctx, { type: 'table', rows });
}

function noteFragment(ctx: ChapterCtx, node: XNode): void {
  const id = attrOf(node, 'id') || attrOf(node, 'name');
  if (!id) return;
  const entry = ctx.frags.get(id);
  if (!entry || entry.used) return;
  entry.used = true;
  const level = headingLevel(tagOf(node) ?? '');
  if (level && clean(inlineText(childArray(node))) === entry.title) return;
  push(ctx, { type: 'heading', level: entry.level, text: entry.title });
}

function emitBlocks(ctx: ChapterCtx, nodes: XNode[]): void {
  for (const node of nodes) {
    if (ctx.stop) return;
    const tag = tagOf(node);
    if (!tag) continue;
    noteFragment(ctx, node);
    if (ctx.stop) return;
    if (SKIP_TEXT.has(tag) || tag === 'link' || tag === 'meta' || tag === 'base' || tag === 'head') continue;
    const level = headingLevel(tag);
    if (level || tag === 'p') {
      const text = clean(inlineText(childArray(node)));
      if (text) push(ctx, level ? { type: 'heading', level, text } : { type: 'paragraph', text });
      emitImages(ctx, node);
    } else if (tag === 'ul' || tag === 'ol') {
      emitList(ctx, node, tag === 'ol');
    } else if (tag === 'table') {
      emitTable(ctx, node);
    } else if (tag === 'pre') {
      const text = clean(inlineText(childArray(node)));
      if (text) push(ctx, { type: 'code', text });
    } else if (tag === 'img' || tag === 'image') {
      emitImages(ctx, node);
    } else if (CONTAINERS.has(tag)) {
      emitBlocks(ctx, childArray(node));
    } else {
      const text = clean(inlineText(childArray(node)));
      if (text) push(ctx, { type: 'paragraph', text });
      else emitBlocks(ctx, childArray(node));
    }
  }
}

function parseChapter(files: Map<string, Uint8Array>, item: Item, entries: TocEntry[], blocks: Block[], assets: Asset[], warnings: string[], cache: Map<string, string>): void {
  if (!item.path) return;
  const bytes = files.get(item.path);
  if (!bytes) throw new FormatFail('corrupt', MSG.corrupt);
  const nodes = parseOrdered(decodeXml(bytes));
  const body = findFirst(nodes, 'body');
  const content = body ? childArray(body) : nodes;
  const whole = entries.find((entry) => entry.path === item.path && !entry.fragment && !entry.used);
  if (whole && !startsWithTitle(content, whole.title)) {
    if (!pushBlock(blocks, warnings, { type: 'heading', level: whole.level, text: whole.title })) return;
  }
  if (whole) whole.used = true;
  const frags = new Map<string, TocEntry>();
  for (const entry of entries) {
    if (entry.path === item.path && entry.fragment && !frags.has(entry.fragment)) frags.set(entry.fragment, entry);
  }
  emitBlocks({ files, from: item.path, blocks, assets, warnings, cache, frags, stop: false }, content);
}

export function parseEpub(files: Map<string, Uint8Array>, warnings: string[]): DocModel {
  const opfPath = opfPathOf(files);
  const { manifest, spine, tocId } = readPackage(files, opfPath);
  const nav =
    [...manifest.values()].find((item) => item.props.split(/\s+/).includes('nav')) ??
    (tocId ? manifest.get(tocId) : undefined) ??
    [...manifest.values()].find((item) => item.media.includes('dtbncx') || item.media.includes('ncx') || item.path?.toLowerCase().endsWith('.ncx'));
  const toc = tocOf(files, nav, warnings);
  const blocks: Block[] = [];
  const assets: Asset[] = [];
  const cache = new Map<string, string>();
  const navPath = nav?.path;
  const ids = spine.filter((id) => {
    const item = manifest.get(id);
    if (!item) return false;
    if (navPath && item.path === navPath && spine.some((other) => other !== id)) return false;
    return true;
  });
  for (const id of ids) {
    if (blocks.length >= MAX_BLOCKS) break;
    const item = manifest.get(id);
    if (!item) continue;
    if (item.remote) {
      if (!warnings.includes(MSG.externalRel)) warnings.push(MSG.externalRel);
      continue;
    }
    if (isHtml(item)) parseChapter(files, item, toc, blocks, assets, warnings, cache);
    else if (isImage(item) && item.path) {
      const block = takeImage({ files, from: opfPath, blocks, assets, warnings, cache, frags: new Map(), stop: false }, item.href, '');
      if (block && !pushBlock(blocks, warnings, block)) break;
    }
  }
  return { kind: 'flow', blocks, assets, warnings };
}
