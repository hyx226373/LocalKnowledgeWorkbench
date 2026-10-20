import { unzipSync, zipSync } from 'fflate';
import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from '../src/shared/formats/limits';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { contentTypes, inputOf, rels, zipOffice } from './formats-samples';

async function sampleXlsx(): Promise<Uint8Array> {
  const workbook = new Workbook();
  const scores = workbook.addWorksheet('成绩');
  scores.addRow(['姓名', '分数']);
  scores.addRow(['甲', 42]);
  scores.addRow([new Date(Date.UTC(2020, 0, 2))]);
  const note = workbook.addWorksheet('备注');
  note.addRow(['附注']);
  const raw = new Uint8Array(await workbook.xlsx.writeBuffer());
  const files = unzipSync(raw);
  const relName = Object.keys(files).find((name) => name.toLowerCase().endsWith('workbook.xml.rels'));
  if (!relName) throw new Error('workbook rels missing');
  const xml = new TextDecoder().decode(files[relName]);
  files[relName] = new TextEncoder().encode(
    xml.replace(
      '</Relationships>',
      '<Relationship Id="rIdExt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://evil.example/sheet" TargetMode="External"/></Relationships>',
    ),
  );
  return zipSync(files, { level: 0 });
}

describe('xlsx / OOXML et', () => {
  it('读成 sheets，日期变成日期文本，外部关系丢掉', async () => {
    const result = await parseFormat(inputOf('xlsx', await sampleXlsx()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'sheets') throw new Error('expected sheets');
    expect(result.doc.sheets.map((sheet) => sheet.name)).toEqual(['成绩', '备注']);
    expect(result.doc.sheets[0]?.rows[0]).toEqual(['姓名', '分数']);
    expect(result.doc.sheets[0]?.rows[1]).toEqual(['甲', '42']);
    expect(result.doc.sheets[0]?.rows[2]?.[0]?.startsWith('2020-01-02')).toBe(true);
    expect(result.doc.sheets[1]?.rows).toEqual([['附注']]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    expect(JSON.stringify(result.doc)).not.toContain('evil.example');
  });

  it('.et 走表格，扩展名与内容不一致时按内容并警告', async () => {
    const bytes = await sampleXlsx();
    const asEt = await parseFormat(inputOf('et', bytes));
    expect(asEt.ok).toBe(true);
    if (!asEt.ok) return;
    expect(asEt.doc.kind).toBe('sheets');
    expect(asEt.doc.warnings).toEqual([MSG.externalRel]);

    const asWps = await parseFormat(inputOf('wps', bytes));
    expect(asWps.ok).toBe(true);
    if (!asWps.ok) return;
    expect(asWps.doc.kind).toBe('sheets');
    expect(asWps.doc.warnings).toContain(MSG.magicMismatch);
  });

  it('indexText 每个工作表一页', async () => {
    const pages = await indexText(inputOf('xlsx', await sampleXlsx()));
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages[0]?.text).toContain('姓名');
    expect(pages[0]?.text).toContain('42');
    expect(pages[1]?.text).toContain('附注');
    expect(pages[0]?.text).not.toContain('evil.example');
  });

  it('简单 DOCTYPE 会去掉，不交给表格解析器', async () => {
    const files = unzipSync(await sampleXlsx());
    const name = Object.keys(files).find((item) => item.toLowerCase().endsWith('/workbook.xml'));
    if (!name) throw new Error('workbook missing');
    const xml = new TextDecoder().decode(files[name]);
    const injected = xml.includes('?>')
      ? xml.replace(/\?>/, '?>\n<!DOCTYPE workbook SYSTEM "file:///etc/passwd">')
      : `<!DOCTYPE workbook SYSTEM "file:///etc/passwd">${xml}`;
    files[name] = new TextEncoder().encode(injected);
    const result = await parseFormat(inputOf('xlsx', zipSync(files, { level: 0 })));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'sheets') throw new Error('expected sheets');
    expect(result.doc.sheets[0]?.rows[0]).toEqual(['姓名', '分数']);
    expect(JSON.stringify(result.doc)).not.toContain('passwd');
  });

  it('行数和列数超过上限时截断', async () => {
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('大');
    const wide = Array.from({ length: MAX_SHEET_COLS + 1 }, (_, index) => String(index));
    sheet.addRow(wide);
    for (let i = 0; i < MAX_SHEET_ROWS; i++) sheet.addRow([String(i)]);
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const result = await parseFormat(inputOf('xlsx', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'sheets') throw new Error('expected sheets');
    expect(result.doc.sheets[0]?.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(result.doc.sheets[0]?.rows[0]).toHaveLength(MAX_SHEET_COLS);
    expect(result.doc.warnings).toContain(MSG.truncated);
  });

  it('没有工作表部件时算损坏', async () => {
    const bytes = zipOffice({
      '[Content_Types].xml': contentTypes([
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      ]),
      '_rels/.rels': rels([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'xl/workbook.xml' }]),
      'xl/workbook.xml': 'this is not xml',
    });
    const result = await parseFormat(inputOf('xlsx', bytes));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('corrupt');
  });
});
