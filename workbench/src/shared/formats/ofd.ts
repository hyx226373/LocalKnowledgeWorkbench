import { MAX_BLOCKS, MAX_PDF_PAGES } from './limits';
import { MSG } from './messages';
import { resolvePart } from './rels';
import type { Block, DocModel, FlowPage } from './types';
import { FormatFail } from './types';
import { attrOf, childArray, decodeBasicEntities, decodeXml, parseOrdered, tagOf, type XNode } from './xml';

/**
 * OFD（GB/T 33190）按页抽出 TextObject/TextCode，收成 paged。
 * 坐标原点在页左上，Y 向下，单位毫米。同一行按 X 接起来，行距近的合成一段。
 * 矢量、图片、复合对象只留占位。签章不读。模板页不并进正文。
 */

interface Piece {
  x: number;
  y: number;
  size: number;
  text: string;
}

interface PageScan {
  pieces: Piece[];
  box: { width: number; height: number } | null;
  vector: boolean;
  image: boolean;
  object: boolean;
}

function cleanLoc(loc: string): string {
  let text = loc.trim().replace(/\\/g, '/');
  try {
    text = decodeURIComponent(text);
  } catch {
    // 非法 % 序列按原样查找。
  }
  text = text.replace(/^\/+/, '').replace(/^\.\//, '');
  if (!text || text.split('/').includes('..')) return '';
  return text;
}

function locate(files: Map<string, Uint8Array>, baseFile: string, loc: string): string | null {
  const clean = cleanLoc(loc);
  if (!clean) return null;
  const fromBase = resolvePart(baseFile, clean);
  if (fromBase && files.has(fromBase)) return fromBase;
  const fromRoot = resolvePart('root.xml', clean);
  if (fromRoot && files.has(fromRoot)) return fromRoot;
  return null;
}

function textOf(node: XNode): string {
  let out = '';
  if (typeof node['#text'] === 'string') out += decodeBasicEntities(node['#text']);
  for (const child of childArray(node)) {
    if (typeof child['#text'] === 'string') out += decodeBasicEntities(child['#text']);
    else out += textOf(child);
  }
  return out;
}

function boxOf(value: string): { x: number; y: number; w: number; h: number } | null {
  const parts = value
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return { x: parts[0] ?? 0, y: parts[1] ?? 0, w: parts[2] ?? 0, h: parts[3] ?? 0 };
}

function num(value: string): number {
  if (!value.trim()) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function positive(value: string): number | null {
  const n = num(value);
  return n > 0 ? n : null;
}

function ctmOf(value: string): number[] | null {
  if (!value.trim()) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 6 || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.slice(0, 6);
}

function applyCtm(x: number, y: number, ctm: number[] | null): [number, number] {
  if (!ctm) return [x, y];
  const a = ctm[0] ?? 1;
  const b = ctm[1] ?? 0;
  const c = ctm[2] ?? 0;
  const d = ctm[3] ?? 1;
  const e = ctm[4] ?? 0;
  const f = ctm[5] ?? 0;
  return [a * x + c * y + e, b * x + d * y + f];
}

function rootName(files: Map<string, Uint8Array>): string | null {
  for (const name of files.keys()) {
    if (name.toLowerCase() === 'ofd.xml') return name;
  }
  return null;
}

export function isOfdPackage(files: Map<string, Uint8Array>): boolean {
  return rootName(files) != null;
}

/** 回调返回 true 时不再走进子节点。TextObject / 矢量 / 图片自己消化子节点。 */
function walk(nodes: XNode[], visit: (node: XNode, tag: string) => boolean | void): void {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (visit(node, tag) === true) continue;
    walk(childArray(node), visit);
  }
}

function piecesOf(node: XNode, warnings: string[], pieces: Piece[]): void {
  if (pieces.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return;
  }
  const boundary = boxOf(attrOf(node, 'Boundary'));
  const size = positive(attrOf(node, 'Size')) ?? (boundary && boundary.h > 0 ? boundary.h : 3.5);
  const ctm = ctmOf(attrOf(node, 'CTM'));
  const originX = boundary?.x ?? 0;
  const originY = boundary?.y ?? 0;
  walk(childArray(node), (child, tag) => {
    if (tag !== 'TextCode') return;
    if (pieces.length >= MAX_BLOCKS) {
      if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
      return true;
    }
    const text = textOf(child).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return true;
    const [lx, ly] = applyCtm(num(attrOf(child, 'X')), num(attrOf(child, 'Y')), ctm);
    pieces.push({ x: originX + lx, y: originY + ly, size, text });
    return true;
  });
}

function scanPage(nodes: XNode[], warnings: string[]): PageScan {
  const scan: PageScan = { pieces: [], box: null, vector: false, image: false, object: false };
  walk(nodes, (node, tag) => {
    if (tag === 'PhysicalBox' && !scan.box) {
      const box = boxOf(textOf(node));
      if (box && box.w > 0 && box.h > 0) scan.box = { width: box.w, height: box.h };
      return;
    }
    if (tag === 'TextObject') {
      piecesOf(node, warnings, scan.pieces);
      return true;
    }
    if (tag === 'PathObject') {
      scan.vector = true;
      return true;
    }
    if (tag === 'ImageObject') {
      scan.image = true;
      return true;
    }
    if (tag === 'CompositeObject' || tag === 'VideoObject') {
      scan.object = true;
      return true;
    }
    return;
  });
  return scan;
}

function widthOf(text: string, size: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    width += code > 0xff ? size : size * 0.5;
  }
  return width;
}

function lineTol(a: number, b: number): number {
  return Math.max(0.8, Math.max(a, b) * 0.5);
}

function joinLine(items: Piece[]): string {
  let out = '';
  let cursor = 0;
  for (const item of items) {
    if (out) {
      const gap = item.x - cursor;
      if (gap > Math.max(1.2, item.size * 0.8)) out += ' ';
    }
    out += item.text;
    cursor = item.x + widthOf(item.text, item.size);
  }
  return out.trim();
}

function paragraphs(pieces: Piece[], warnings: string[]): Block[] {
  const sorted = pieces.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: Piece[][] = [];
  for (const piece of sorted) {
    const line = lines[lines.length - 1];
    const anchor = line?.[line.length - 1];
    if (line && anchor && Math.abs(anchor.y - piece.y) <= lineTol(anchor.size, piece.size)) line.push(piece);
    else lines.push([piece]);
  }
  const blocks: Block[] = [];
  let buf: string[] = [];
  let prevY = 0;
  let prevSize = 0;
  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    if (blocks.length >= MAX_BLOCKS) {
      if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
      return;
    }
    blocks.push({ type: 'paragraph', text });
  };
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    const text = joinLine(line);
    if (!text) continue;
    const y = line[0]?.y ?? 0;
    const size = line.reduce((max, item) => Math.max(max, item.size), 0);
    if (buf.length > 0 && y - prevY > Math.max(2, Math.max(prevSize, size) * 1.5)) flush();
    buf.push(text);
    prevY = line[line.length - 1]?.y ?? y;
    prevSize = size;
  }
  flush();
  return blocks;
}

function pushExtra(blocks: Block[], warnings: string[], text: string): void {
  if (blocks.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return;
  }
  blocks.push({ type: 'unsupported', text });
}

function readPage(bytes: Uint8Array, fallback: { width: number; height: number } | null, warnings: string[]): FlowPage {
  const scan = scanPage(parseOrdered(decodeXml(bytes)), warnings);
  const blocks = paragraphs(scan.pieces, warnings);
  if (scan.vector) pushExtra(blocks, warnings, '矢量');
  if (scan.image) pushExtra(blocks, warnings, '图片');
  if (scan.object) pushExtra(blocks, warnings, '对象');
  const size = scan.box ?? fallback;
  const page: FlowPage = { blocks };
  if (size) {
    page.width = size.width;
    page.height = size.height;
  }
  return page;
}

function firstBox(nodes: XNode[]): { width: number; height: number } | null {
  let found: { width: number; height: number } | null = null;
  walk(nodes, (node, tag) => {
    if (found || tag !== 'PhysicalBox') return;
    const box = boxOf(textOf(node));
    if (box && box.w > 0 && box.h > 0) found = { width: box.w, height: box.h };
  });
  return found;
}

function docRoots(nodes: XNode[]): { docs: string[]; signed: boolean } {
  const docs: string[] = [];
  let signed = false;
  walk(nodes, (node, tag) => {
    if (tag === 'DocRoot') {
      const text = textOf(node).trim();
      if (text) docs.push(text);
      return true;
    }
    if (tag === 'Signatures') signed = true;
    return;
  });
  return { docs, signed };
}

function pageLocs(nodes: XNode[]): string[] {
  const locs: string[] = [];
  walk(nodes, (node, tag) => {
    if (tag !== 'Pages') return;
    for (const child of childArray(node)) {
      if (tagOf(child) !== 'Page') continue;
      const loc = attrOf(child, 'BaseLoc').trim();
      if (loc) locs.push(loc);
    }
    return true;
  });
  return locs;
}

export function parseOfd(files: Map<string, Uint8Array>, warnings: string[]): DocModel {
  const root = rootName(files);
  if (!root) throw new FormatFail('corrupt', MSG.corrupt);
  const rootNodes = parseOrdered(decodeXml(files.get(root)!));
  const { docs, signed } = docRoots(rootNodes);
  if (docs.length === 0) throw new FormatFail('corrupt', MSG.corrupt);
  if (signed && !warnings.includes(MSG.sealIgnored)) warnings.push(MSG.sealIgnored);

  const pages: FlowPage[] = [];
  let stopped = false;
  for (const docLoc of docs) {
    if (stopped) break;
    const docPath = locate(files, 'root.xml', docLoc);
    if (!docPath) throw new FormatFail('corrupt', MSG.corrupt);
    const docBytes = files.get(docPath);
    if (!docBytes) throw new FormatFail('corrupt', MSG.corrupt);
    const docNodes = parseOrdered(decodeXml(docBytes));
    const fallback = firstBox(docNodes);
    for (const loc of pageLocs(docNodes)) {
      if (pages.length >= MAX_PDF_PAGES) {
        if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
        stopped = true;
        break;
      }
      const pagePath = locate(files, docPath, loc);
      if (!pagePath) throw new FormatFail('corrupt', MSG.corrupt);
      const pageBytes = files.get(pagePath);
      if (!pageBytes) throw new FormatFail('corrupt', MSG.corrupt);
      pages.push(readPage(pageBytes, fallback, warnings));
    }
  }
  return { kind: 'paged', pages, assets: [], warnings };
}
