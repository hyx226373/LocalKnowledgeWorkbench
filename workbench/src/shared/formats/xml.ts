import { XMLParser } from 'fast-xml-parser';
import { FormatFail } from './types';
import { MSG } from './messages';

/**
 * 关闭实体展开。带内部子集的 DOCTYPE 和任何 ENTITY 在送进解析器之前就被拒绝。
 * 简单 DOCTYPE 会先删掉，解析器看不到 PUBLIC/SYSTEM 标识，因此不会读外部 DTD。
 * preserveOrder 用来保住段落和表格的先后。
 */
export const orderedXml = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  htmlEntities: false,
});

export const flatXml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  htmlEntities: false,
  isArray: (name) => name === 'Relationship',
});

export type XNode = Record<string, unknown>;

const decoder = new TextDecoder('utf-8', { fatal: false });
const encoder = new TextEncoder();

export function decodeXml(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function encodeXml(text: string): Uint8Array {
  return encoder.encode(text);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

/**
 * 只还原五个 XML 实体、nbsp 和数字引用。自定义实体保持原样，避免在拒绝 DOCTYPE 之前被展开。
 */
export function decodeBasicEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, body: string) => {
    const key = body.toLowerCase();
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return NAMED_ENTITIES[key] ?? all;
  });
}

const XML_EXT = /\.(xml|rels|xhtml|html|htm|opf|ncx|svg)$/i;

function codeAt(source: string | Uint8Array, index: number): number {
  return typeof source === 'string' ? source.charCodeAt(index) : (source[index] ?? 0);
}

function isAsciiKw(source: string | Uint8Array, index: number, kw: string): boolean {
  for (let j = 0; j < kw.length; j++) {
    const c = codeAt(source, index + j);
    const e = kw.charCodeAt(j);
    if (c !== e && c !== e - 32) return false;
  }
  return true;
}

/** `<!DOCTYPE` / `<!ENTITY` 是 ASCII。UTF-8 的多字节字符不会冒充它们。 */
function mentionsMarkup(bytes: Uint8Array): boolean {
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== 0x3c || bytes[i + 1] !== 0x21) continue;
    if (isAsciiKw(bytes, i + 2, 'entity')) return true;
    if (i + 9 <= bytes.length && isAsciiKw(bytes, i + 2, 'doctype')) return true;
  }
  return false;
}

function indexOfDoctype(xml: string, from: number): number {
  for (let i = from; i + 9 <= xml.length; i++) {
    if (xml[i] === '<' && xml[i + 1] === '!' && isAsciiKw(xml, i + 2, 'doctype')) return i;
  }
  return -1;
}

function isWs(ch: string | undefined): boolean {
  return ch != null && /\s/.test(ch);
}

function skipWs(xml: string, i: number): number {
  while (isWs(xml[i])) i++;
  return i;
}

function isNameStart(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || ch === '_' || ch === ':';
}

function isNameChar(ch: string | undefined): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return isNameStart(ch) || (c >= 48 && c <= 57) || ch === '-' || ch === '.';
}

function skipName(xml: string, i: number): number {
  if (!isNameStart(xml[i])) return -1;
  i++;
  while (isNameChar(xml[i])) i++;
  return i;
}

function readQuoted(xml: string, i: number): number {
  const quote = xml[i];
  if (quote !== '"' && quote !== "'") return -1;
  for (let j = i + 1; j < xml.length; j++) {
    if (xml[j] === quote) return j + 1;
  }
  return -1;
}

/**
 * 简单 DOCTYPE 的结束位置（不含内部子集）。
 * 形如 `<!DOCTYPE html>`，或带 PUBLIC/SYSTEM 和引号里的标识。`[`、嵌套 `<` 都不是。
 */
function endOfSimpleDoctype(xml: string, start: number): number {
  let i = skipName(xml, skipWs(xml, start + 9));
  if (i < 0) return -1;
  i = skipWs(xml, i);
  if (xml[i] === '>') return i + 1;
  const system = isAsciiKw(xml, i, 'system') && isWs(xml[i + 6]);
  const pub = isAsciiKw(xml, i, 'public') && isWs(xml[i + 6]);
  if (!system && !pub) return -1;
  i = skipWs(xml, i + 6);
  const first = readQuoted(xml, i);
  if (first < 0) return -1;
  i = first;
  if (pub) {
    i = skipWs(xml, i);
    const second = readQuoted(xml, i);
    if (second < 0) return -1;
    i = second;
  }
  i = skipWs(xml, i);
  if (xml[i] !== '>') return -1;
  return i + 1;
}

/** `entity` 优先：同一文件里只要有 `<!ENTITY` 就拒绝，即使前面还有简单 DOCTYPE。 */
function markupKind(xml: string): 'entity' | 'doctype' | null {
  let doctype = false;
  for (let i = 0; i + 8 <= xml.length; i++) {
    if (xml[i] !== '<' || xml[i + 1] !== '!') continue;
    if (isAsciiKw(xml, i + 2, 'entity')) return 'entity';
    if (!doctype && i + 9 <= xml.length && isAsciiKw(xml, i + 2, 'doctype')) doctype = true;
  }
  return doctype ? 'doctype' : null;
}

/**
 * 删掉简单 DOCTYPE。内部子集和 `<!ENTITY` 直接拒绝。
 * 调用方只把返回值送给解析器，外部标识不会被读取。
 */
export function prepareXml(xml: string): string {
  const kind = markupKind(xml);
  if (kind == null) return xml;
  if (kind === 'entity') throw new FormatFail('corrupt', MSG.xmlUnsafe);
  let out = '';
  let i = 0;
  while (i < xml.length) {
    const start = indexOfDoctype(xml, i);
    if (start < 0) {
      out += xml.slice(i);
      break;
    }
    const end = endOfSimpleDoctype(xml, start);
    if (end < 0) throw new FormatFail('corrupt', MSG.xmlUnsafe);
    out += xml.slice(i, start);
    i = end;
  }
  return out;
}

/** 简单 DOCTYPE 可以留在包里再删掉。内部子集和 ENTITY 整包拒绝。epub 的 xhtml / opf / ncx 和 xml 一样查。 */
export function assertSafeXml(name: string, bytes: Uint8Array): void {
  if (!XML_EXT.test(name)) return;
  if (!mentionsMarkup(bytes)) return;
  prepareXml(decoder.decode(bytes));
}

/** 通过检查的简单 DOCTYPE 从字节里删掉，后面的解析器（含 exceljs）看不到外部标识。 */
export function assertSafePackage(files: Map<string, Uint8Array>): void {
  for (const [name, bytes] of files) {
    if (!XML_EXT.test(name) || !mentionsMarkup(bytes)) continue;
    const text = decoder.decode(bytes);
    const next = prepareXml(text);
    if (next !== text) files.set(name, encodeXml(next));
  }
}

export function tagOf(node: XNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ':@' && key !== '#text') return key;
  }
  return null;
}

export function childArray(node: XNode): XNode[] {
  const tag = tagOf(node);
  if (!tag) return [];
  const value = node[tag];
  return Array.isArray(value) ? (value as XNode[]) : [];
}

export function findTag(nodes: XNode[], tag: string): XNode | undefined {
  return nodes.find((node) => tagOf(node) === tag);
}

export function attrOf(node: XNode | undefined, name: string): string {
  if (!node) return '';
  const attrs = node[':@'];
  if (!attrs || typeof attrs !== 'object') return '';
  const value = (attrs as Record<string, unknown>)['@_' + name];
  return value == null ? '' : String(value);
}

export function parseOrdered(xml: string): XNode[] {
  const source = prepareXml(xml);
  try {
    const parsed = orderedXml.parse(source) as unknown;
    return Array.isArray(parsed) ? (parsed as XNode[]) : [];
  } catch (error) {
    if (error instanceof FormatFail) throw error;
    throw new FormatFail('corrupt', MSG.xmlUnsafe);
  }
}
