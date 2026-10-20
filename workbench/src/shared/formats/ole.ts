import { find, read, type CFB$Blob, type CFB$Container, type CFB$Entry } from 'cfb';
import PPT from 'ppt';
import WordExtractor from 'word-extractor';
import * as XLSX from 'xlsx';
import { MAX_BLOCKS, MAX_SHEET_COLS, MAX_SHEET_ROWS } from './limits';
import { familyOfExt, type OfficeFamily } from './magic';
import { MSG } from './messages';
import { normExt } from './ooxml';
import type { Block, DocModel, FormatInput, FormatResult } from './types';

const ENCRYPT_STREAMS = new Set(['encryptioninfo', 'encryptedpackage', 'strongencryptiondata', 'wpsencryption', 'wpsencrypt', 'kingsoftencryption']);

interface NamedEntry {
  name: string;
  content: Uint8Array;
}

function asBytes(content: CFB$Blob | undefined): Uint8Array {
  if (!content) return new Uint8Array();
  return content instanceof Uint8Array ? content : Uint8Array.from(content);
}

function entriesOf(container: CFB$Container): NamedEntry[] {
  return container.FileIndex.filter((entry) => entry.name && entry.name !== 'Root Entry' && !entry.name.startsWith('\u0001')).map((entry) => ({
    name: entry.name,
    content: asBytes(entry.content),
  }));
}

function startsWith(bytes: Uint8Array, text: string): boolean {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}

function hasFilePass(content: Uint8Array): boolean {
  let offset = 0;
  for (let n = 0; n < 6 && offset + 4 <= content.length; n++) {
    const type = content[offset] | (content[offset + 1] << 8);
    const len = content[offset + 2] | (content[offset + 3] << 8);
    if (type === 0x002f) return true;
    if (len > 8224) break;
    offset += 4 + len;
  }
  return false;
}

/** OLE 加密流、Word FIB 加密位、BIFF FILEPASS，或 WPS 私有头 WPSENC。 */
export function oleEncrypted(entries: NamedEntry[]): boolean {
  for (const entry of entries) {
    const name = entry.name.replace(/^\u0005/, '').toLowerCase();
    if (ENCRYPT_STREAMS.has(name)) return true;
  }
  const word = entries.find((entry) => entry.name === 'WordDocument');
  if (word) {
    if (startsWith(word.content, 'WPSENC')) return true;
    if (word.content.length >= 0x0c) {
      const magic = word.content[0] | (word.content[1] << 8);
      const flags = word.content[0x0a] | (word.content[0x0b] << 8);
      if (magic === 0xa5ec && (flags & 0x0100 || flags & 0x8000)) return true;
    }
  }
  const book = entries.find((entry) => entry.name === 'Workbook' || entry.name === 'Book');
  return !!book && hasFilePass(book.content);
}

function flow(blocks: Block[], warnings: string[]): FormatResult {
  return { ok: true, doc: { kind: 'flow', blocks: blocks.slice(0, MAX_BLOCKS), assets: [], warnings } };
}

async function wordFlow(bytes: Uint8Array, warnings: string[]): Promise<FormatResult> {
  const extracted = await new WordExtractor().extract(Buffer.from(bytes));
  const blocks: Block[] = extracted
    .getBody()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ type: 'paragraph', text }));
  if (blocks.length === 0) blocks.push({ type: 'unsupported', text: '未抽出文本' });
  return flow(blocks, warnings);
}

function sheetFlow(bytes: Uint8Array, warnings: string[]): FormatResult {
  const book = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  const blocks: Block[] = [];
  for (const name of book.SheetNames) {
    if (blocks.length >= MAX_BLOCKS) break;
    blocks.push({ type: 'heading', level: 2, text: name });
    const sheet = book.Sheets[name];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false });
    const limited = rows.slice(0, MAX_SHEET_ROWS).map((row) => row.slice(0, MAX_SHEET_COLS).map((cell) => (cell == null ? '' : String(cell))));
    if (rows.length > MAX_SHEET_ROWS || rows.some((row) => row.length > MAX_SHEET_COLS)) {
      if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    }
    blocks.push({ type: 'table', rows: limited });
  }
  if (blocks.length === 0) blocks.push({ type: 'unsupported', text: '未抽出文本' });
  return flow(blocks, warnings);
}

function attachBlob(content: CFB$Blob): CFB$Blob & { l: number; read_shift(size: number): number } {
  const buf = Buffer.from(asBytes(content));
  const blob = buf as Buffer & { l: number; read_shift(size: number): number };
  blob.l = 0;
  blob.read_shift = function readShift(size: number) {
    let value = 0;
    if (size === 1) value = this[this.l] ?? 0;
    else if (size === 2) value = this.readUInt16LE(this.l);
    else if (size === 4) value = this.readUInt32LE(this.l);
    else {
      this.l += size;
      return 0;
    }
    this.l += size;
    return value;
  };
  return blob;
}

function pptLines(container: CFB$Container, entries: NamedEntry[]): string[] {
  try {
    const shim = Object.assign(container, {
      find(name: string): CFB$Entry | null {
        const entry = find(container, name);
        if (!entry) return null;
        return { ...entry, content: attachBlob(entry.content) };
      },
    });
    const parsed = PPT.parse_pptcfb(shim);
    const lines = PPT.utils
      .to_text(parsed)
      .map((line) => String(line).trim())
      .filter(Boolean);
    if (lines.length) return lines;
  } catch {
    /* 老 ppt 包读不了这份流时，退回可见字符串。 */
  }
  const stream = entries.find((entry) => entry.name === 'PowerPoint Document');
  if (!stream) return [];
  const found: string[] = [];
  let current = '';
  const bytes = stream.content;
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    const printable = code >= 0x20 && code < 0xfffe;
    if (printable) current += String.fromCharCode(code);
    else {
      if (current.trim().length >= 2) found.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length >= 2) found.push(current.trim());
  return found;
}

function slideFlow(container: CFB$Container, entries: NamedEntry[], warnings: string[]): FormatResult {
  const lines = pptLines(container, entries);
  const blocks: Block[] = lines.length ? lines.map((text) => ({ type: 'paragraph' as const, text })) : [{ type: 'unsupported', text: '未抽出文本' }];
  return flow(blocks, warnings);
}

function kindFor(entries: NamedEntry[], prefer: OfficeFamily | 'pdf' | null): 'word' | 'sheet' | 'slide' | null {
  const has = (name: string) => entries.some((entry) => entry.name === name);
  const word = has('WordDocument');
  const sheet = has('Workbook') || has('Book');
  const slide = has('PowerPoint Document');
  const order: Array<'word' | 'sheet' | 'slide'> =
    prefer === 'sheet' ? ['sheet', 'word', 'slide'] : prefer === 'slide' ? ['slide', 'word', 'sheet'] : ['word', 'sheet', 'slide'];
  for (const kind of order) {
    if (kind === 'word' && word) return kind;
    if (kind === 'sheet' && sheet) return kind;
    if (kind === 'slide' && slide) return kind;
  }
  return null;
}

export async function parseOle(input: FormatInput): Promise<FormatResult> {
  let container: CFB$Container;
  try {
    container = read(Buffer.from(input.bytes), { type: 'buffer' });
  } catch {
    return { ok: false, code: 'corrupt', message: MSG.corrupt };
  }
  const entries = entriesOf(container);
  if (oleEncrypted(entries)) return { ok: false, code: 'encrypted', message: MSG.encrypted };
  const prefer = familyOfExt(normExt(input.ext));
  const kind = kindFor(entries, prefer);
  if (!kind) return { ok: false, code: 'unsupported-variant', message: MSG.unsupported };
  const warnings: string[] = [MSG.layoutLost];
  const extFamily = prefer === 'pdf' ? null : prefer;
  const actual: OfficeFamily = kind === 'word' ? 'word' : kind === 'sheet' ? 'sheet' : 'slide';
  if (extFamily && extFamily !== actual) warnings.push(MSG.magicMismatch);
  try {
    if (kind === 'word') return await wordFlow(input.bytes, warnings);
    if (kind === 'sheet') return sheetFlow(input.bytes, warnings);
    return slideFlow(container, entries, warnings);
  } catch {
    return { ok: false, code: 'corrupt', message: MSG.corrupt };
  }
}
