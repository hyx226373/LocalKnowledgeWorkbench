import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractFile } from '../src/extract.ts';

it('returns PDF body after closing the loading task (pdfjs 5 and 6)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-task-'));
  try {
    // A small, self-contained text PDF keeps this regression independent of corpus tooling.
    const stream = 'BT /F1 12 Tf 20 100 Td (PDF amber verification word) Tj ET';
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
    let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
    objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const file = path.join(dir, 'sample.pdf');
    writeFileSync(file, pdf);
    const pages = await extractFile(file, 'sample.pdf');
    expect(pages).toHaveLength(1);
    expect(pages[0].body).toContain('amber verification');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 30000);
