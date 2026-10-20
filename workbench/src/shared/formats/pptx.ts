import { MAX_BLOCKS, MAX_SLIDES } from './limits';
import { MSG } from './messages';
import { readRels, relMap, resolvePart, type Rel } from './rels';
import type { Asset, Block, DocModel } from './types';
import { FormatFail } from './types';
import { attrOf, childArray, decodeXml, findTag, parseOrdered, tagOf, type XNode } from './xml';

/**
 * 直接读 presentationml。pptxtojson 会交出 HTML，而且打不开测试用的最小包。
 * 幻灯片仍收成 blocks，不走 HTML。
 */

function textOf(nodes: XNode[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (tag === 't') {
      for (const child of childArray(node)) if (typeof child['#text'] === 'string') out += child['#text'];
    } else if (tag === 'tab') out += '\t';
    else if (tag === 'br') out += '\n';
    else out += textOf(childArray(node));
  }
  return out;
}

function findDesc(node: XNode | undefined, tag: string): XNode | undefined {
  if (!node) return undefined;
  for (const child of childArray(node)) {
    if (tagOf(child) === tag) return child;
    const nested = findDesc(child, tag);
    if (nested) return nested;
  }
  return undefined;
}

function pushBlock(blocks: Block[], warnings: string[], block: Block): boolean {
  if (blocks.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return false;
  }
  blocks.push(block);
  return true;
}

function slideRids(xml: string): string[] {
  const ids: string[] = [];
  const re = /<[\w.:-]*sldId\b([^>]*)\/?>/gi;
  for (const match of xml.matchAll(re)) {
    const rid = /\br:id\s*=\s*"([^"]+)"/i.exec(match[1] ?? '')?.[1];
    if (rid) ids.push(rid);
  }
  return ids;
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
    case 'emf':
      return 'image/emf';
    case 'wmf':
      return 'image/wmf';
    default:
      return 'application/octet-stream';
  }
}

function assetBlock(relId: string, fromPart: string, rels: Map<string, Rel>, files: Map<string, Uint8Array>, assets: Asset[], cache: Map<string, string>): Block | null {
  const cached = cache.get(fromPart + '\n' + relId);
  if (cached) return { type: 'image', assetId: cached };
  const rel = rels.get(relId);
  if (!rel || rel.external) return null;
  const path = resolvePart(fromPart, rel.target);
  if (!path) return null;
  const bytes = files.get(path);
  if (!bytes) return null;
  const id = `img-${assets.length + 1}`;
  assets.push({ id, mime: mimeOf(path), bytes });
  cache.set(fromPart + '\n' + relId, id);
  return { type: 'image', assetId: id };
}

function bulletKind(p: XNode): 'text' | 'bullet' | 'number' {
  const pPr = findTag(childArray(p), 'pPr');
  if (!pPr) return 'text';
  const tags = new Set(childArray(pPr).map((node) => tagOf(node)));
  if (tags.has('buNone')) return 'text';
  if (tags.has('buAutoNum')) return 'number';
  if (tags.has('buChar')) return 'bullet';
  return 'text';
}

function paragraphs(shape: XNode): XNode[] {
  const found: XNode[] = [];
  const walk = (node: XNode) => {
    for (const child of childArray(node)) {
      if (tagOf(child) === 'p') found.push(child);
      else walk(child);
    }
  };
  walk(shape);
  return found;
}

function placeholder(shape: XNode): string {
  return attrOf(findDesc(shape, 'ph'), 'type').toLowerCase();
}

interface ListBuf {
  ordered: boolean;
  items: string[];
}

function flushList(list: ListBuf | null, blocks: Block[], warnings: string[]): { list: null; stop: boolean } {
  if (!list || list.items.length === 0) return { list: null, stop: false };
  return { list: null, stop: !pushBlock(blocks, warnings, { type: 'list', ordered: list.ordered, items: list.items }) };
}

function emitShape(shape: XNode, blocks: Block[], warnings: string[]): boolean {
  const kind = placeholder(shape);
  const heading = kind === 'title' || kind === 'ctrtitle' ? 1 : kind === 'subtitle' ? 2 : 0;
  let list: ListBuf | null = null;
  for (const para of paragraphs(shape)) {
    const text = textOf(childArray(para)).trim();
    if (!text) continue;
    if (!heading) {
      const bullet = bulletKind(para);
      if (bullet !== 'text') {
        const ordered = bullet === 'number';
        if (!list || list.ordered !== ordered) {
          const flushed = flushList(list, blocks, warnings);
          if (flushed.stop) return true;
          list = { ordered, items: [] };
        }
        list.items.push(text);
        continue;
      }
    }
    const flushed = flushList(list, blocks, warnings);
    list = null;
    if (flushed.stop) return true;
    const block: Block = heading ? { type: 'heading', level: heading, text } : { type: 'paragraph', text };
    if (!pushBlock(blocks, warnings, block)) return true;
  }
  return flushList(list, blocks, warnings).stop;
}

function emitFrame(frame: XNode, blocks: Block[], warnings: string[]): boolean {
  const table = findDesc(frame, 'tbl');
  if (table) {
    const rows: string[][] = [];
    for (const tr of childArray(table)) {
      if (tagOf(tr) !== 'tr') continue;
      const row: string[] = [];
      for (const tc of childArray(tr)) {
        if (tagOf(tc) === 'tc') row.push(textOf(childArray(tc)).trim());
      }
      if (row.length) rows.push(row);
    }
    return !pushBlock(blocks, warnings, { type: 'table', rows });
  }
  if (findDesc(frame, 'chart')) return !pushBlock(blocks, warnings, { type: 'unsupported', text: '图表' });
  return !pushBlock(blocks, warnings, { type: 'unsupported', text: '对象' });
}

function walkShapes(nodes: XNode[], fromPart: string, rels: Map<string, Rel>, files: Map<string, Uint8Array>, assets: Asset[], cache: Map<string, string>, blocks: Block[], warnings: string[]): boolean {
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (tag === 'sp' || tag === 'cxnSp') {
      if (emitShape(node, blocks, warnings)) return true;
    } else if (tag === 'pic') {
      const blip = findDesc(node, 'blip');
      const block = assetBlock(attrOf(blip, 'embed'), fromPart, rels, files, assets, cache);
      if (block && !pushBlock(blocks, warnings, block)) return true;
    } else if (tag === 'graphicFrame') {
      if (emitFrame(node, blocks, warnings)) return true;
    } else if (walkShapes(childArray(node), fromPart, rels, files, assets, cache, blocks, warnings)) return true;
  }
  return false;
}

function notesText(files: Map<string, Uint8Array>, part: string): string {
  const bytes = files.get(part);
  if (!bytes) return '';
  const lines: string[] = [];
  const walk = (nodes: XNode[]) => {
    for (const node of nodes) {
      if (tagOf(node) === 'p') {
        const text = textOf(childArray(node)).trim();
        if (text) lines.push(text);
      } else walk(childArray(node));
    }
  };
  walk(parseOrdered(decodeXml(bytes)));
  return lines.join('\n');
}

export function parsePptx(files: Map<string, Uint8Array>, warnings: string[]): DocModel {
  const presentation = files.get('ppt/presentation.xml');
  if (!presentation) throw new FormatFail('corrupt', MSG.corrupt);
  const xml = decodeXml(presentation);
  const all = slideRids(xml);
  if (all.length > MAX_SLIDES && !warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
  const rels = relMap(readRels(files.get('ppt/_rels/presentation.xml.rels')));
  const assets: Asset[] = [];
  const cache = new Map<string, string>();
  const slides: { blocks: Block[]; notes?: string }[] = [];
  for (const rid of all.slice(0, MAX_SLIDES)) {
    const rel = rels.get(rid);
    const part = rel ? resolvePart('ppt/presentation.xml', rel.target) : null;
    const blocks: Block[] = [];
    if (!part || !files.has(part)) {
      pushBlock(blocks, warnings, { type: 'unsupported', text: '幻灯片缺失' });
      slides.push({ blocks });
      continue;
    }
    const slideRels = relMap(readRels(files.get(part.replace(/([^/]+)$/, '_rels/$1.rels'))));
    const nodes = parseOrdered(decodeXml(files.get(part)!));
    walkShapes(nodes, part, slideRels, files, assets, cache, blocks, warnings);
    const notesRel = [...slideRels.values()].find((item) => item.type.endsWith('/notesSlide'));
    const notesPart = notesRel ? resolvePart(part, notesRel.target) : null;
    const notes = notesPart ? notesText(files, notesPart) : '';
    slides.push(notes ? { blocks, notes } : { blocks });
  }
  return { kind: 'slides', slides, assets, warnings };
}
