import { MAX_BLOCKS } from './limits';
import { MSG } from './messages';
import type { Block, DocModel, TextRun } from './types';
import { FormatFail } from './types';

/**
 * 小型 RTF 词法。只收段落、粗斜体、标题和简单表格。
 * \'hh 按当前字体的字符集解码，没有字符集时用 \ansicpg。936 / fcharset 134 都是 GBK。
 * \uN 是有符号的 UTF-16 码元，后面跳过 \ucN 个回退字节，不把回退再写进正文。
 * 不执行宏，字段指令里的外链丢掉。
 */

interface Style {
  bold: boolean;
  italic: boolean;
  uc: number;
  font: number;
  cp: number;
  outline: number;
  inTable: boolean;
  dest: 'normal' | 'fonttbl';
  atStart: boolean;
  ignoreNext: boolean;
}

interface Run {
  text: string;
  bold: boolean;
  italic: boolean;
}

const SKIP = new Set([
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'objdata',
  'objclass',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'footnote',
  'annotation',
  'atnid',
  'atnauthor',
  'atnref',
  'listtable',
  'listoverridetable',
  'listtext',
  'pntext',
  'pn',
  'revtbl',
  'rsidtbl',
  'generator',
  'xmlnstbl',
  'themedata',
  'colorschememapping',
  'datastore',
  'latentstyles',
  'mmathpr',
  'nonshppict',
  'shppict',
  'background',
  'filetbl',
  'fontemb',
  'fldinst',
  'blipuid',
  'datafield',
  'xe',
  'tc',
  'password',
  'passwordhash',
  'writereservhash',
]);

function isLetter(value: number): boolean {
  return (value >= 0x41 && value <= 0x5a) || (value >= 0x61 && value <= 0x7a);
}

function isDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}

function cpLabel(cp: number): string {
  if (cp === 936) return 'gbk';
  if (cp === 54936) return 'gb18030';
  if (cp === 950) return 'big5';
  if (cp === 932) return 'shift_jis';
  if (cp === 949) return 'euc-kr';
  if (cp === 65001 || cp === 1200) return 'utf-8';
  if (cp === 437) return 'ibm437';
  if (cp === 850) return 'ibm850';
  if (cp === 866) return 'ibm866';
  if (cp === 10000) return 'macintosh';
  if (cp === 874) return 'windows-874';
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  return 'windows-1252';
}

function charsetLabel(charset: number | undefined, cp: number): string {
  switch (charset) {
    case 134:
      return 'gbk';
    case 136:
      return 'big5';
    case 128:
      return 'shift_jis';
    case 129:
      return 'euc-kr';
    case 161:
      return 'windows-1253';
    case 162:
      return 'windows-1254';
    case 163:
      return 'windows-1258';
    case 177:
      return 'windows-1255';
    case 178:
      return 'windows-1256';
    case 186:
      return 'windows-1257';
    case 204:
      return 'windows-1251';
    case 222:
      return 'windows-874';
    case 238:
      return 'windows-1250';
    case 254:
      return 'ibm866';
    case 255:
      return 'ibm437';
    default:
      return cpLabel(cp);
  }
}

function fresh(): Style {
  return { bold: false, italic: false, uc: 1, font: 0, cp: 1252, outline: -1, inTable: false, dest: 'normal', atStart: true, ignoreNext: false };
}

function pushBlock(blocks: Block[], warnings: string[], block: Block): boolean {
  if (blocks.length >= MAX_BLOCKS) {
    if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
    return false;
  }
  blocks.push(block);
  return true;
}

function trimRuns(input: Run[]): Run[] {
  const copy = input.map((run) => ({ ...run }));
  if (copy.length) copy[0].text = copy[0].text.replace(/^\s+/, '');
  while (copy.length && copy[0].text === '') copy.shift();
  if (copy.length) copy[copy.length - 1].text = copy[copy.length - 1].text.replace(/\s+$/, '');
  while (copy.length && copy[copy.length - 1].text === '') copy.pop();
  return copy.filter((run) => run.text !== '');
}

function styledRuns(input: Run[]): TextRun[] | undefined {
  if (!input.some((run) => run.bold || run.italic)) return undefined;
  return input.map((run) => ({ text: run.text, ...(run.bold ? { bold: true } : {}), ...(run.italic ? { italic: true } : {}) }));
}

function hasRemote(slice: Uint8Array): boolean {
  let text = '';
  const end = Math.min(slice.length, 4096);
  for (let i = 0; i < end; i++) {
    const value = slice[i];
    if (value < 128) text += String.fromCharCode(value);
  }
  return /https?:|file:|mailto:/.test(text.toLowerCase());
}

export function parseRtf(bytes: Uint8Array, warnings: string[]): DocModel {
  let i = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  const fonts = new Map<number, number>();
  let pendingFont: number | null = null;
  const stack: Style[] = [];
  let state = fresh();
  const blocks: Block[] = [];
  let stop = false;
  let runs: Run[] = [];
  let buf: number[] = [];
  let bufLabel = '';
  let high = 0;
  let rows: string[][] = [];
  let row: string[] = [];
  let cellPieces: string[] = [];
  let inCell = false;

  const push = (block: Block) => {
    if (stop) return;
    stop = !pushBlock(blocks, warnings, block);
  };

  const encoding = () => charsetLabel(fonts.get(state.font), state.cp);

  const append = (text: string) => {
    if (!text || state.dest === 'fonttbl') return;
    const last = runs[runs.length - 1];
    if (last && last.bold === state.bold && last.italic === state.italic) last.text += text;
    else runs.push({ text, bold: state.bold, italic: state.italic });
  };

  const flushBytes = () => {
    if (!buf.length) return;
    const label = bufLabel || encoding();
    const raw = Uint8Array.from(buf);
    buf = [];
    let text = '';
    try {
      text = new TextDecoder(label).decode(raw);
    } catch {
      text = new TextDecoder('windows-1252').decode(raw);
    }
    append(text);
  };

  const addByte = (value: number) => {
    if (state.dest === 'fonttbl') return;
    const label = encoding();
    if (buf.length && label !== bufLabel) flushBytes();
    bufLabel = label;
    buf.push(value);
  };

  const addText = (text: string) => {
    flushBytes();
    append(text);
  };

  const pop = () => {
    flushBytes();
    const prev = stack.pop();
    if (!prev) throw new FormatFail('corrupt', MSG.corrupt);
    state = prev;
  };

  const readControl = (start: number) => {
    let cursor = start + 1;
    if (cursor >= bytes.length) throw new FormatFail('corrupt', MSG.corrupt);
    const next = bytes[cursor];
    if (next === 0x27) {
      if (cursor + 2 >= bytes.length) throw new FormatFail('corrupt', MSG.corrupt);
      const hex = String.fromCharCode(bytes[cursor + 1], bytes[cursor + 2]);
      const value = Number.parseInt(hex, 16);
      if (!/^[0-9a-f]{2}$/i.test(hex) || !Number.isFinite(value)) throw new FormatFail('corrupt', MSG.corrupt);
      return { kind: 'hex' as const, word: '', param: null as number | null, hex: value, next: cursor + 3 };
    }
    if (!isLetter(next)) return { kind: 'symbol' as const, word: String.fromCharCode(next), param: null as number | null, hex: 0, next: cursor + 1 };
    cursor++;
    while (cursor < bytes.length && isLetter(bytes[cursor])) cursor++;
    let word = '';
    for (let k = start + 1; k < cursor; k++) word += String.fromCharCode(bytes[k]).toLowerCase();
    let param: number | null = null;
    if (cursor < bytes.length && (bytes[cursor] === 0x2d || isDigit(bytes[cursor]))) {
      const numStart = cursor;
      if (bytes[cursor] === 0x2d) cursor++;
      const digitStart = cursor;
      while (cursor < bytes.length && isDigit(bytes[cursor])) cursor++;
      if (cursor === digitStart) cursor = numStart;
      else {
        let digits = '';
        for (let k = numStart; k < cursor; k++) digits += String.fromCharCode(bytes[k]);
        param = Number(digits);
      }
    }
    if (cursor < bytes.length && bytes[cursor] === 0x20) cursor++;
    return { kind: 'word' as const, word, param, hex: 0, next: cursor };
  };

  const skipRestOfGroup = (warnRemote: boolean) => {
    const start = i;
    let depth = 1;
    while (i < bytes.length && depth > 0) {
      const value = bytes[i++];
      if (value === 0x7b) {
        depth++;
        continue;
      }
      if (value === 0x7d) {
        depth--;
        continue;
      }
      if (value !== 0x5c || i >= bytes.length) continue;
      const mark = bytes[i];
      if (mark === 0x7b || mark === 0x7d || mark === 0x5c) {
        i++;
        continue;
      }
      if (!isLetter(mark) && mark !== 0x27) continue;
      const control = readControl(i - 1);
      i = control.next;
      if (control.kind === 'word' && control.word === 'bin') {
        const count = control.param ?? 0;
        if (count < 0 || i + count > bytes.length) throw new FormatFail('corrupt', MSG.corrupt);
        i += count;
      }
    }
    if (warnRemote && hasRemote(bytes.subarray(start, i)) && !warnings.includes(MSG.externalRel)) warnings.push(MSG.externalRel);
    pop();
  };

  const skipFallback = (count: number) => {
    let left = count;
    while (left > 0 && i < bytes.length) {
      const value = bytes[i];
      if (value === 0x0d || value === 0x0a) {
        i++;
        continue;
      }
      if (value === 0x5c && i + 1 < bytes.length && bytes[i + 1] === 0x27) {
        if (i + 3 >= bytes.length) throw new FormatFail('corrupt', MSG.corrupt);
        const hex = String.fromCharCode(bytes[i + 2], bytes[i + 3]);
        if (!/^[0-9a-f]{2}$/i.test(hex)) throw new FormatFail('corrupt', MSG.corrupt);
        i += 4;
        left--;
        continue;
      }
      if (value === 0x5c || value === 0x7b || value === 0x7d) break;
      i++;
      left--;
    }
  };

  const emitUnicode = (param: number) => {
    flushBytes();
    let code = param < 0 ? param + 65536 : param;
    if (code >= 0xd800 && code <= 0xdbff) high = code;
    else if (code >= 0xdc00 && code <= 0xdfff && high) {
      append(String.fromCodePoint(0x10000 + ((high - 0xd800) << 10) + (code - 0xdc00)));
      high = 0;
    } else {
      high = 0;
      if (code > 0 && code <= 0x10ffff) append(String.fromCodePoint(code));
    }
    skipFallback(state.uc);
  };

  const take = (): { text: string; runs?: TextRun[] } | null => {
    flushBytes();
    const trimmed = trimRuns(runs);
    runs = [];
    if (!trimmed.length) return null;
    const text = trimmed.map((run) => run.text).join('');
    const marked = styledRuns(trimmed);
    return marked ? { text, runs: marked } : { text };
  };

  const flushTable = () => {
    if (!rows.length || stop) {
      rows = [];
      row = [];
      cellPieces = [];
      inCell = false;
      return;
    }
    push({ type: 'table', rows });
    rows = [];
    row = [];
    cellPieces = [];
    inCell = false;
  };

  const endParagraph = () => {
    const taken = take();
    // 大纲级别只作用在这一段。下一段要再写 \outlinelevel，避免整篇都变成标题。
    const level = state.outline >= 0 ? Math.min(6, state.outline + 1) : 0;
    state.outline = -1;
    if (state.inTable || inCell || row.length) {
      if (taken?.text) cellPieces.push(taken.text);
      return;
    }
    flushTable();
    if (!taken || stop) return;
    if (level) push({ type: 'heading', level, text: taken.text, ...(taken.runs ? { runs: taken.runs } : {}) });
    else push({ type: 'paragraph', text: taken.text, ...(taken.runs ? { runs: taken.runs } : {}) });
  };

  const endCell = () => {
    const taken = take();
    if (taken?.text) cellPieces.push(taken.text);
    row.push(cellPieces.join('\n').trim());
    cellPieces = [];
    inCell = true;
    state.inTable = true;
  };

  const endRow = () => {
    const taken = take();
    if (taken?.text) cellPieces.push(taken.text);
    if (cellPieces.length) {
      row.push(cellPieces.join('\n').trim());
      cellPieces = [];
    }
    if (row.length) rows.push(row);
    row = [];
    inCell = false;
  };

  const handleWord = (word: string, param: number | null) => {
    if (state.ignoreNext) {
      const remote = word === 'fldinst';
      state.ignoreNext = false;
      state.atStart = false;
      skipRestOfGroup(remote);
      return;
    }
    const destination = state.atStart;
    state.atStart = false;
    if (destination && word === 'fonttbl') {
      state.dest = 'fonttbl';
      return;
    }
    if (destination && SKIP.has(word)) {
      skipRestOfGroup(word === 'fldinst');
      return;
    }
    if (state.dest === 'fonttbl') {
      if (word === 'f' && param != null) {
        pendingFont = param;
        if (!fonts.has(param)) fonts.set(param, 0);
      } else if (word === 'fcharset' && param != null && pendingFont != null) fonts.set(pendingFont, param);
      return;
    }
    switch (word) {
      case 'par':
        endParagraph();
        return;
      case 'line':
      case 'lbr':
        addText('\n');
        return;
      case 'tab':
        addText('\t');
        return;
      case 'cell':
      case 'nestcell':
        endCell();
        return;
      case 'row':
      case 'nestrow':
        endRow();
        return;
      case 'pard':
        state.inTable = false;
        state.outline = -1;
        return;
      case 'intbl':
      case 'trowd':
        state.inTable = true;
        return;
      case 'plain':
        flushBytes();
        state.bold = false;
        state.italic = false;
        return;
      case 'b':
        flushBytes();
        state.bold = param == null || param !== 0;
        return;
      case 'i':
        flushBytes();
        state.italic = param == null || param !== 0;
        return;
      case 'u':
        emitUnicode(param ?? 0);
        return;
      case 'uc':
        state.uc = param == null ? 1 : param;
        return;
      case 'ansicpg':
        if (param != null) state.cp = param;
        return;
      case 'pc':
        state.cp = 437;
        return;
      case 'pca':
        state.cp = 850;
        return;
      case 'mac':
        state.cp = 10000;
        return;
      case 'f':
        if (param != null) {
          flushBytes();
          state.font = param;
        }
        return;
      case 'deff':
        if (param != null) state.font = param;
        return;
      case 'outlinelevel':
        state.outline = param ?? 0;
        return;
      case 'bin': {
        const count = param ?? 0;
        if (count < 0 || i + count > bytes.length) throw new FormatFail('corrupt', MSG.corrupt);
        i += count;
        return;
      }
      default:
        return;
    }
  };

  while (i < bytes.length && !stop) {
    const value = bytes[i];
    if (value === 0x7b) {
      i++;
      stack.push(state);
      state = { ...state, atStart: true, ignoreNext: false };
      continue;
    }
    if (value === 0x7d) {
      i++;
      pop();
      continue;
    }
    if (value === 0x5c) {
      const control = readControl(i);
      i = control.next;
      if (control.kind === 'hex') {
        addByte(control.hex);
        state.atStart = false;
      } else if (control.kind === 'symbol') {
        if (control.word === '*') state.ignoreNext = true;
        else {
          state.atStart = false;
          if (state.dest !== 'fonttbl') {
            if (control.word === '~') addText('\u00a0');
            else if (control.word === '\\' || control.word === '{' || control.word === '}') addText(control.word);
            else if (control.word === '_') addText('-');
          }
        }
      } else handleWord(control.word, control.param);
      continue;
    }
    if (value === 0x0a || value === 0x0d || value === 0x00) {
      i++;
      continue;
    }
    addByte(value);
    state.atStart = false;
    i++;
  }

  if (inCell || row.length || cellPieces.length || buf.length || runs.length) {
    if (inCell || row.length || cellPieces.length) endRow();
    else {
      state.inTable = false;
      endParagraph();
    }
  }
  flushTable();
  if (runs.length || buf.length) endParagraph();
  return { kind: 'flow', blocks, assets: [], warnings };
}
