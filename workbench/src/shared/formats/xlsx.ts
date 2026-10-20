import { Workbook, type Cell, type Row } from 'exceljs';
import { MAX_SHEET_COLS, MAX_SHEET_ROWS } from './limits';
import { MSG } from './messages';
import { FormatFail, type DocModel } from './types';

function plain(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && 'richText' in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function cellToString(cell: Cell): string {
  const value = cell.value;
  if (value == null || typeof value !== 'object' || value instanceof Date) return plain(value);
  if ('result' in value && value.result != null) return plain(value.result);
  if ('text' in value && typeof value.text === 'string') return value.text;
  if ('richText' in value) return plain(value);
  return '';
}

function rowStrings(row: Row): { cells: string[]; overflow: boolean } {
  const cells: string[] = [];
  let overflow = false;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    if (col > MAX_SHEET_COLS) {
      overflow = true;
      return;
    }
    cells[col - 1] = cellToString(cell);
  });
  for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
  return { cells, overflow };
}

export async function parseXlsx(bytes: Uint8Array, warnings: string[]): Promise<DocModel> {
  const workbook = new Workbook();
  try {
    // exceljs 自带的 Buffer 声明和当前 @types/node 对不上，运行时仍传入 Node Buffer。
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<Workbook['xlsx']['load']>[0]);
  } catch (error) {
    if (error instanceof FormatFail) throw error;
    throw new FormatFail('corrupt', MSG.corrupt);
  }
  const sheets: { name: string; rows: string[][] }[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    let count = 0;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (count >= MAX_SHEET_ROWS) {
        if (!warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
        return;
      }
      const parsed = rowStrings(row);
      if (parsed.overflow && !warnings.includes(MSG.truncated)) warnings.push(MSG.truncated);
      rows.push(parsed.cells);
      count++;
    });
    sheets.push({ name: sheet.name, rows });
  });
  return { kind: 'sheets', sheets, assets: [], warnings };
}
