import { withTimeout } from './deadline';
import { parseDocx } from './docx';
import { isEpubPackage, parseEpub } from './epub';
import { isOdtPackage, parseOdt } from './odt';
import { isOfdPackage, parseOfd } from './ofd';
import { familyOfExt, sniff } from './magic';
import { MSG } from './messages';
import { parseOle } from './ole';
import { assertBudget, classifyOffice, normExt } from './ooxml';
import { externalWarning, stripExternalRels } from './rels';
import { FormatFail, type Block, type DocModel, type FormatInput, type FormatResult } from './types';
import { assertSafePackage } from './xml';
import { repackOffice, unzipOffice } from './zip';
import { parsePdfText } from './pdfText';
import { parsePptx } from './pptx';
import { parseRtf } from './rtf';
import { parseXlsx } from './xlsx';

function blockText(block: Block): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'code':
    case 'unsupported':
      return block.text;
    case 'list':
      return block.items.join('\n');
    case 'table':
      return block.rows.map((row) => row.join('\t')).join('\n');
    case 'image':
      return block.alt ?? '';
  }
}

export function pagesOf(doc: DocModel): { page: number; text: string }[] {
  if (doc.kind === 'flow') {
    return [{ page: 1, text: doc.blocks.map(blockText).filter(Boolean).join('\n') }];
  }
  if (doc.kind === 'paged') {
    return doc.pages.map((page, index) => ({ page: index + 1, text: page.blocks.map(blockText).filter(Boolean).join('\n') }));
  }
  if (doc.kind === 'sheets') {
    return doc.sheets.map((sheet, index) => ({
      page: index + 1,
      text: [sheet.name, ...sheet.rows.map((row) => row.join('\t'))].filter(Boolean).join('\n'),
    }));
  }
  return doc.slides.map((slide, index) => ({
    page: index + 1,
    text: [...slide.blocks.map(blockText), slide.notes ?? ''].filter(Boolean).join('\n'),
  }));
}

type ActualKind = 'docx' | 'xlsx' | 'pptx' | 'epub' | 'odt' | 'rtf' | 'ofd';

const KNOWN_EXT = new Set(['docx', 'wps', 'xlsx', 'et', 'pptx', 'dps', 'pdf', 'epub', 'odt', 'rtf', 'ofd']);

function extAgrees(ext: string, actual: ActualKind): boolean {
  if (actual === 'docx') return ext === 'docx' || ext === 'wps';
  if (actual === 'xlsx') return ext === 'xlsx' || ext === 'et';
  if (actual === 'pptx') return ext === 'pptx' || ext === 'dps';
  return ext === actual;
}

/** 扩展名和魔数都认识、但不是同一种时加警告。魔数仍决定解析器。 */
function noteMismatch(ext: string, actual: ActualKind, warnings: string[]): void {
  const name = normExt(ext);
  if (!name || !KNOWN_EXT.has(name) || extAgrees(name, actual) || warnings.includes(MSG.magicMismatch)) return;
  warnings.push(MSG.magicMismatch);
}

async function parseZip(input: FormatInput): Promise<FormatResult> {
  const files = unzipOffice(input.bytes);
  const dropped = stripExternalRels(files).dropped;
  assertSafePackage(files);
  const warnings: string[] = [];
  externalWarning(dropped, warnings);
  if (files.has('[Content_Types].xml')) {
    const family = classifyOffice(files, input.ext, warnings);
    if (!family) return { ok: false, code: 'unsupported-variant', message: MSG.unsupported };
    noteMismatch(input.ext, family === 'sheet' ? 'xlsx' : family === 'slide' ? 'pptx' : 'docx', warnings);
    if (family === 'word') return { ok: true, doc: parseDocx(files, warnings) };
    if (family === 'sheet') return { ok: true, doc: await parseXlsx(repackOffice(files), warnings) };
    return { ok: true, doc: parsePptx(files, warnings) };
  }
  if (isEpubPackage(files)) {
    noteMismatch(input.ext, 'epub', warnings);
    return { ok: true, doc: parseEpub(files, warnings) };
  }
  if (isOdtPackage(files)) {
    noteMismatch(input.ext, 'odt', warnings);
    return { ok: true, doc: parseOdt(files, warnings) };
  }
  if (isOfdPackage(files)) {
    noteMismatch(input.ext, 'ofd', warnings);
    return { ok: true, doc: parseOfd(files, warnings) };
  }
  const officeExt = familyOfExt(normExt(input.ext));
  if (officeExt && officeExt !== 'pdf') return { ok: false, code: 'corrupt', message: MSG.corrupt };
  return { ok: false, code: 'unsupported-variant', message: MSG.unsupported };
}

async function parseInner(input: FormatInput): Promise<FormatResult> {
  assertBudget(input);
  const kind = sniff(input.bytes);
  if (kind === 'zip') return parseZip(input);
  if (kind === 'ole') return parseOle(input);
  if (kind === 'pdf') return parsePdfText(input);
  if (kind === 'rtf') {
    const warnings: string[] = [];
    noteMismatch(input.ext, 'rtf', warnings);
    return { ok: true, doc: parseRtf(input.bytes, warnings) };
  }
  return { ok: false, code: 'unsupported-variant', message: MSG.unsupported };
}

export async function parseFormat(input: FormatInput): Promise<FormatResult> {
  try {
    return await withTimeout(parseInner(input));
  } catch (error) {
    if (error instanceof FormatFail) return { ok: false, code: error.code, message: error.message };
    return { ok: false, code: 'corrupt', message: MSG.corrupt };
  }
}

/** 失败返回空数组，不把异常抛到索引循环外。本轮不接 @kb/indexer。 */
export async function indexText(input: FormatInput): Promise<{ page: number; text: string }[]> {
  try {
    const result = await parseFormat(input);
    if (!result.ok) return [];
    return pagesOf(result.doc);
  } catch {
    return [];
  }
}
