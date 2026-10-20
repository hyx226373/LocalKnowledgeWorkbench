import { utils as cfbUtils, write as writeCfb } from 'cfb';
import { describe, expect, it } from 'vitest';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import type { FormatResult } from '../src/shared/formats/types';
import { inputOf } from './formats-samples';
import * as XLSX from 'xlsx';

function u16(buf: Buffer, offset: number, value: number) {
  buf.writeUInt16LE(value, offset);
}
function u32(buf: Buffer, offset: number, value: number) {
  buf.writeUInt32LE(value, offset);
}

/** word-extractor 能读的最小 Word 97 流：FIB + 一段 Unicode + 0Table 片段表。 */
function oleDoc(text: string): Uint8Array {
  const chars = `${text}\r`;
  const body = Buffer.from(chars, 'ucs2');
  const word = Buffer.alloc(0x800 + body.length);
  u16(word, 0, 0xa5ec);
  u16(word, 2, 0x00c1);
  u32(word, 0x18, 0x800);
  u32(word, 0x4c, chars.length);
  body.copy(word, 0x800);
  const lcb = 16;
  const table = Buffer.alloc(1 + 4 + lcb);
  table.writeUInt8(0x02, 0);
  u32(table, 1, lcb);
  u32(table, 5, 0);
  u32(table, 9, chars.length);
  u32(table, 15, 0x800);
  const cfb = cfbUtils.cfb_new();
  cfbUtils.cfb_add(cfb, 'WordDocument', word);
  cfbUtils.cfb_add(cfb, '0Table', table);
  return new Uint8Array(writeCfb(cfb, { type: 'buffer' }));
}

function oleWith(name: string, content: Uint8Array): Uint8Array {
  const cfb = cfbUtils.cfb_new();
  cfbUtils.cfb_add(cfb, name, Buffer.from(content));
  return new Uint8Array(writeCfb(cfb, { type: 'buffer' }));
}

function flowBlocks(result: FormatResult) {
  if (!result.ok || result.doc.kind !== 'flow') throw new Error('expected flow');
  return result.doc;
}

describe('OLE wps / et / dps', () => {
  it('老 wps 抽出纯文本，并标明版式已丢失', async () => {
    const result = await parseFormat(inputOf('wps', oleDoc('你好 WPS')));
    const doc = flowBlocks(result);
    expect(doc.blocks).toEqual([{ type: 'paragraph', text: '你好 WPS' }]);
    expect(doc.warnings).toEqual([MSG.layoutLost]);
    const pages = await indexText(inputOf('wps', oleDoc('你好 WPS')));
    expect(pages).toEqual([{ page: 1, text: '你好 WPS' }]);
  });

  it('老 et 用 BIFF 读成 flow 里的表', async () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['姓名', '分数'], ['甲', 42]]), '成绩');
    const bytes = new Uint8Array(XLSX.write(book, { type: 'buffer', bookType: 'xls' }));
    const doc = flowBlocks(await parseFormat(inputOf('et', bytes)));
    expect(doc.warnings).toContain(MSG.layoutLost);
    expect(doc.blocks).toContainEqual({ type: 'heading', level: 2, text: '成绩' });
    expect(doc.blocks).toContainEqual({ type: 'table', rows: [['姓名', '分数'], ['甲', '42']] });
  });

  it('老 dps 抽不出版式时仍给出可见文字', async () => {
    const bytes = oleWith('PowerPoint Document', Buffer.from('幻灯片甲', 'ucs2'));
    const doc = flowBlocks(await parseFormat(inputOf('dps', bytes)));
    expect(doc.warnings).toContain(MSG.layoutLost);
    expect(doc.blocks).toContainEqual({ type: 'paragraph', text: '幻灯片甲' });
  });

  it('加密流、WPS 私有头和 FILEPASS 都是 encrypted，结果里没有密码', async () => {
    const info = await parseFormat(inputOf('wps', oleWith('EncryptionInfo', Buffer.from('password-not-stored'))));
    expect(info).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });
    expect(JSON.stringify(info)).not.toContain('password');

    const word = Buffer.alloc(0x20);
    u16(word, 0, 0xa5ec);
    u16(word, 0x0a, 0x0100);
    const fib = await parseFormat(inputOf('wps', oleWith('WordDocument', word)));
    expect(fib).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const privateHeader = Buffer.concat([Buffer.from('WPSENC'), Buffer.from('secret')]);
    const wps = await parseFormat(inputOf('wps', oleWith('WordDocument', privateHeader)));
    expect(wps).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const book = Buffer.alloc(8);
    u16(book, 0, 0x0809);
    u16(book, 2, 0);
    u16(book, 4, 0x002f);
    u16(book, 6, 0);
    const pass = await parseFormat(inputOf('et', oleWith('Workbook', book)));
    expect(pass).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });
  });

  it('只有 OLE 魔数时损坏，空复合文档则无法识别变体', async () => {
    const magic = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(await parseFormat(inputOf('wps', magic))).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });
    const empty = new Uint8Array(writeCfb(cfbUtils.cfb_new(), { type: 'buffer' }));
    expect(await parseFormat(inputOf('dps', empty))).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });
  });

  it('扩展名像表格但流是文字时按流解析并警告', async () => {
    const doc = flowBlocks(await parseFormat(inputOf('et', oleDoc('其实是文字'))));
    expect(doc.blocks).toEqual([{ type: 'paragraph', text: '其实是文字' }]);
    expect(doc.warnings).toEqual([MSG.layoutLost, MSG.magicMismatch]);
  });
});
