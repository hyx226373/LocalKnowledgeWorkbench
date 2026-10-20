import { describe, expect, it } from 'vitest';
import { checkStateForSave } from '../src/shared/adapter-sdk/policy';
import { withTimeout } from '../src/shared/formats/deadline';
import { FormatFail } from '../src/shared/formats/types';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { formatViewState } from '../src/shared/formats/state';
import { contentTypes, declaredZip, inputOf, rels, zipOffice } from './formats-samples';

const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sampleDocx(): Uint8Array {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="a1"/></w:pPr><w:r><w:t>总览</w:t></w:r></w:p>
    <w:p><w:r><w:t>正文甲</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>其一</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>其二</w:t></w:r></w:p>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>格A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>格B</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:drawing><a:blip r:embed="rIdImg"/></w:drawing></w:r></w:p>
    <w:p><w:r><w:t>链接文字</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:styleId="a1"><w:name w:val="heading 1"/></w:style>
</w:styles>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
  return zipOffice({
    '[Content_Types].xml': contentTypes([
      `<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`,
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'word/document.xml' }]),
    'word/document.xml': document,
    'word/styles.xml': styles,
    'word/numbering.xml': numbering,
    'word/_rels/document.xml.rels': rels([
      { id: 'rIdImg', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: 'media/image1.png' },
      { id: 'rIdExt', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target: 'http://evil.example/secret', external: true },
    ]),
    'word/media/image1.png': PNG,
  });
}

describe('docx / OOXML wps', () => {
  it('收成 flow：标题、段落、有序列表、表、图片', async () => {
    const result = await parseFormat(inputOf('docx', sampleDocx()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.kind).toBe('flow');
    if (result.doc.kind !== 'flow') return;
    expect(result.doc.blocks).toEqual([
      { type: 'heading', level: 1, text: '总览' },
      { type: 'paragraph', text: '正文甲' },
      { type: 'list', ordered: true, items: ['其一', '其二'] },
      { type: 'table', rows: [['格A', '格B'], ['1', '2']] },
      { type: 'image', assetId: 'img-1' },
      { type: 'paragraph', text: '链接文字' },
    ]);
    expect(result.doc.assets).toEqual([{ id: 'img-1', mime: 'image/png', bytes: PNG }]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    expect(JSON.stringify(result.doc)).not.toContain('evil.example');
  });

  it('同一 OOXML 用 .wps 扩展名仍走文字，扩展名不一致才警告', async () => {
    const bytes = sampleDocx();
    const asWps = await parseFormat(inputOf('wps', bytes));
    expect(asWps.ok).toBe(true);
    if (!asWps.ok) return;
    expect(asWps.doc.kind).toBe('flow');
    expect(asWps.doc.warnings).toEqual([MSG.externalRel]);

    const asEt = await parseFormat(inputOf('et', bytes));
    expect(asEt.ok).toBe(true);
    if (!asEt.ok) return;
    expect(asEt.doc.kind).toBe('flow');
    expect(asEt.doc.warnings).toContain(MSG.magicMismatch);
  });

  it('indexText 把正文放在第 1 页', async () => {
    const pages = await indexText(inputOf('docx', sampleDocx()));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text).toContain('总览');
    expect(pages[0]?.text).toContain('其一');
    expect(pages[0]?.text).not.toContain('evil.example');
  });

  it('简单 DOCTYPE 会去掉，正文仍在，不读取外部标识', async () => {
    const bytes = zipOffice({
      '[Content_Types].xml': contentTypes([`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`]),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE document PUBLIC "-//W3C//DTD document//EN" "file:///etc/passwd">
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>仍可读</w:t></w:r></w:p></w:body></w:document>`,
    });
    const result = await parseFormat(inputOf('docx', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') throw new Error('expected flow');
    expect(result.doc.blocks).toEqual([{ type: 'paragraph', text: '仍可读' }]);
    expect(JSON.stringify(result.doc)).not.toContain('passwd');
  });

  it('拒绝 DOCTYPE，外部实体不会展开', async () => {
    const bytes = zipOffice({
      '[Content_Types].xml': contentTypes([`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`]),
      'word/document.xml': `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&xxe;</w:t></w:r></w:p></w:body></w:document>`,
    });
    const result = await parseFormat(inputOf('docx', bytes));
    expect(result).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });
  });

  it('超大、ZIP 炸弹、加密位、坏包', async () => {
    const tiny = sampleDocx();
    const huge = await parseFormat({ ...inputOf('docx', tiny), size: 80 * 1024 * 1024 + 1 });
    expect(huge).toMatchObject({ ok: false, code: 'too-large' });

    const bomb = await parseFormat(inputOf('docx', declaredZip({ entries: 1, compressed: 10, uncompressed: 100000 })));
    expect(bomb).toEqual({ ok: false, code: 'too-large', message: MSG.zipLimit });

    const many = await parseFormat(inputOf('docx', declaredZip({ entries: 8001 })));
    expect(many).toEqual({ ok: false, code: 'too-large', message: MSG.zipLimit });

    const locked = await parseFormat(inputOf('docx', declaredZip({ entries: 1, flags: 1 })));
    expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const broken = await parseFormat(inputOf('docx', zipOffice({ '[Content_Types].xml': contentTypes([]) })));
    expect(broken).toMatchObject({ ok: false, code: 'corrupt' });
  });

  it('阅读状态只留位置，正文和密码存不进去', () => {
    expect(formatViewState({ page: 2, scale: 1.5, password: 'secret', body: '正文' })).toEqual({ page: 2, scale: 1.5 });
    expect(checkStateForSave({ page: 1, password: 'secret' }).ok).toBe(false);
    expect(checkStateForSave({ page: 1, body: '甲'.repeat(3000) }).ok).toBe(false);
    expect(checkStateForSave(formatViewState({ slide: 3, scroll: 10 })).ok).toBe(true);
  });

  it('超时返回 timeout，不把正文写进错误', async () => {
    const pending = new Promise<number>(() => {});
    await expect(withTimeout(pending, 20)).rejects.toEqual(expect.any(FormatFail));
    try {
      await withTimeout(pending, 20);
    } catch (error) {
      expect(error).toMatchObject({ code: 'timeout', message: MSG.timeout });
    }
  });
});
