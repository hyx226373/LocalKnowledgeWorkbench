/** 带 xref 的单页 PDF，给 pdfjs 读。文本里不要放括号或反斜杠。 */
export function pdfWithText(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, '');
  const content = `BT /F1 24 Tf 72 72 Td (${safe}) Tj ET\n`;
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];
  const chunks: Buffer[] = [];
  let length = 0;
  const push = (value: string) => {
    const buf = Buffer.from(value, 'latin1');
    chunks.push(buf);
    length += buf.length;
  };
  const offsets = [0];
  push('%PDF-1.4\n');
  for (const object of objects) {
    offsets.push(length);
    push(object);
  }
  const xrefAt = length;
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  push(xref);
  return Buffer.concat(chunks);
}
