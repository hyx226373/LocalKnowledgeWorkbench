import { MAX_BLOCKS } from './limits';
import { MSG } from './messages';
import { readRels, relMap, resolvePart, type Rel } from './rels';
import type { Asset, Block, DocModel } from './types';
import { FormatFail } from './types';
import { attrOf, childArray, decodeXml, findTag, parseOrdered, tagOf, type XNode } from './xml';

const ORDERED_FMT = /^(decimal|decimalZero|upperLetter|lowerLetter|upperRoman|lowerRoman|ordinal)$/i;

function pushBlock(blocks: Block[], warnings: string[], block: Block): boolean {
  if (blocks.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return false;
  }
  blocks.push(block);
  return true;
}

function rawText(nodes: XNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (typeof node['#text'] === 'string') out += node['#text'];
  }
  return out;
}

/** 只收 w:t 里的文字。标签之间的缩进空白不算正文。 */
function textOf(nodes: XNode[]): string {
  let out = '';
  for (const node of nodes) {
    const tag = tagOf(node);
    if (!tag) continue;
    if (tag === 't') out += rawText(childArray(node));
    else if (tag === 'tab') out += '\t';
    else if (tag === 'br' || tag === 'cr') out += '\n';
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

function headingLevel(styleId: string, styles: Map<string, number>): number {
  const known = styles.get(styleId);
  if (known) return known;
  const match = /^(?:heading|标题)\s*([1-6])$/i.exec(styleId);
  return match ? Number(match[1]) : 0;
}

function headingStyles(files: Map<string, Uint8Array>): Map<string, number> {
  const map = new Map<string, number>();
  const bytes = files.get('word/styles.xml');
  if (!bytes) return map;
  let nodes: XNode[] = [];
  try {
    nodes = parseOrdered(decodeXml(bytes));
  } catch {
    return map;
  }
  const visit = (list: XNode[]) => {
    for (const node of list) {
      if (tagOf(node) === 'style') {
        const id = attrOf(node, 'styleId');
        const name = attrOf(findDesc(node, 'name'), 'val');
        const outline = attrOf(findDesc(node, 'outlineLvl'), 'val');
        let level = headingLevel(name, map);
        if (!level && outline !== '' && Number(outline) >= 0 && Number(outline) < 6) level = Number(outline) + 1;
        if (!level) level = headingLevel(id, map);
        if (id && level) map.set(id, level);
      }
      visit(childArray(node));
    }
  };
  visit(nodes);
  return map;
}

function orderedNumIds(files: Map<string, Uint8Array>): Set<string> {
  const ordered = new Set<string>();
  const bytes = files.get('word/numbering.xml');
  if (!bytes) return ordered;
  let nodes: XNode[] = [];
  try {
    nodes = parseOrdered(decodeXml(bytes));
  } catch {
    return ordered;
  }
  const formats = new Map<string, string>();
  const visitAbs = (list: XNode[]) => {
    for (const node of list) {
      if (tagOf(node) === 'abstractNum') {
        const id = attrOf(node, 'abstractNumId');
        const lvl = childArray(node).find((child) => tagOf(child) === 'lvl' && (attrOf(child, 'ilvl') === '' || attrOf(child, 'ilvl') === '0'));
        const fmt = attrOf(findTag(childArray(lvl ?? {}), 'numFmt'), 'val');
        if (id) formats.set(id, fmt);
      }
      visitAbs(childArray(node));
    }
  };
  visitAbs(nodes);
  const visitNum = (list: XNode[]) => {
    for (const node of list) {
      if (tagOf(node) === 'num') {
        const numId = attrOf(node, 'numId');
        const abs = attrOf(findDesc(node, 'abstractNumId'), 'val');
        if (numId && ORDERED_FMT.test(formats.get(abs) ?? '')) ordered.add(numId);
      }
      visitNum(childArray(node));
    }
  };
  visitNum(nodes);
  return ordered;
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
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return 'application/octet-stream';
  }
}

function assetFor(relId: string, rels: Map<string, Rel>, files: Map<string, Uint8Array>, assets: Asset[], cache: Map<string, string>): Block | null {
  if (!relId || cache.has(relId)) {
    const id = cache.get(relId);
    return id ? { type: 'image', assetId: id } : null;
  }
  const rel = rels.get(relId);
  if (!rel || rel.external) return null;
  const path = resolvePart('word/document.xml', rel.target);
  if (!path) return null;
  const bytes = files.get(path);
  if (!bytes) return null;
  const id = `img-${assets.length + 1}`;
  assets.push({ id, mime: mimeOf(path), bytes });
  cache.set(relId, id);
  return { type: 'image', assetId: id };
}

function imagesIn(node: XNode, rels: Map<string, Rel>, files: Map<string, Uint8Array>, assets: Asset[], cache: Map<string, string>): Block[] {
  const blocks: Block[] = [];
  const walk = (current: XNode) => {
    const tag = tagOf(current);
    if (!tag) return;
    if (tag === 'blip' || tag === 'imagedata') {
      const block = assetFor(attrOf(current, 'embed') || attrOf(current, 'id'), rels, files, assets, cache);
      if (block) blocks.push(block);
    }
    for (const child of childArray(current)) walk(child);
  };
  walk(node);
  return blocks;
}

function cellText(tc: XNode): string {
  return textOf(childArray(tc)).replace(/\s+\n/g, '\n').trim();
}

function tableBlock(tbl: XNode): Block {
  const rows: string[][] = [];
  for (const tr of childArray(tbl)) {
    if (tagOf(tr) !== 'tr') continue;
    const row: string[] = [];
    for (const tc of childArray(tr)) {
      if (tagOf(tc) === 'tc') row.push(cellText(tc));
    }
    if (row.length) rows.push(row);
  }
  return { type: 'table', rows };
}

interface ParaInfo {
  text: string;
  heading: number;
  listId: string;
  ordered: boolean;
  code: boolean;
  images: Block[];
  math: boolean;
}

function paraInfo(p: XNode, styles: Map<string, number>, orderedNums: Set<string>, rels: Map<string, Rel>, files: Map<string, Uint8Array>, assets: Asset[], cache: Map<string, string>): ParaInfo {
  const pPr = findTag(childArray(p), 'pPr');
  const style = attrOf(findTag(childArray(pPr ?? {}), 'pStyle'), 'val');
  const outline = attrOf(findDesc(pPr, 'outlineLvl'), 'val');
  let heading = style ? headingLevel(style, styles) : 0;
  if (!heading && outline !== '' && Number(outline) >= 0 && Number(outline) < 6) heading = Number(outline) + 1;
  const numPr = findDesc(pPr, 'numPr');
  const listId = numPr ? attrOf(findDesc(numPr, 'numId'), 'val') : '';
  const code = /^(htmlpreformatted|code|sourcecode)$/i.test(style);
  return {
    text: textOf(childArray(p)).replace(/\n{3,}/g, '\n\n').trim(),
    heading,
    listId,
    ordered: listId !== '' && orderedNums.has(listId),
    code,
    images: imagesIn(p, rels, files, assets, cache),
    math: !!findDesc(p, 'oMath'),
  };
}

function textBlock(info: ParaInfo): Block {
  if (info.heading) return { type: 'heading', level: info.heading, text: info.text };
  if (info.code) return { type: 'code', text: info.text };
  return { type: 'paragraph', text: info.text };
}

export function parseDocx(files: Map<string, Uint8Array>, warnings: string[]): DocModel {
  const document = files.get('word/document.xml');
  if (!document) throw new FormatFail('corrupt', MSG.corrupt);
  const nodes = parseOrdered(decodeXml(document));
  const root = nodes.find((node) => tagOf(node) === 'document') ?? { document: nodes };
  const body = findDesc(root, 'body');
  const styles = headingStyles(files);
  const orderedNums = orderedNumIds(files);
  const rels = relMap(readRels(files.get('word/_rels/document.xml.rels')));
  const assets: Asset[] = [];
  const cache = new Map<string, string>();
  const blocks: Block[] = [];
  let list: { id: string; ordered: boolean; items: string[] } | null = null;
  let stop = false;

  const flushList = () => {
    if (!list || list.items.length === 0) {
      list = null;
      return;
    }
    stop = !pushBlock(blocks, warnings, { type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const node of body ? childArray(body) : []) {
    if (stop) break;
    const tag = tagOf(node);
    if (tag === 'p') {
      const info = paraInfo(node, styles, orderedNums, rels, files, assets, cache);
      if (info.listId && info.text) {
        if (!list || list.id !== info.listId) {
          flushList();
          if (stop) break;
          list = { id: info.listId, ordered: info.ordered, items: [] };
        }
        list.items.push(info.text);
      } else {
        flushList();
        if (stop) break;
        if (info.text) stop = !pushBlock(blocks, warnings, textBlock(info));
        else if (info.math && info.images.length === 0) stop = !pushBlock(blocks, warnings, { type: 'unsupported', text: '公式' });
      }
      if (stop) break;
      for (const image of info.images) {
        stop = !pushBlock(blocks, warnings, image);
        if (stop) break;
      }
    } else if (tag === 'tbl') {
      flushList();
      if (stop) break;
      stop = !pushBlock(blocks, warnings, tableBlock(node));
    }
  }
  if (!stop) flushList();
  return { kind: 'flow', blocks, assets, warnings };
}
