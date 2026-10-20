import { describe, expect, it } from 'vitest';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { contentTypes, declaredZip, inputOf, zipOffice } from './formats-samples';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const ODT_MIME = 'application/vnd.oasis.opendocument.text';

function contentXml(body: string, styles = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0">
  <office:automatic-styles>${styles}</office:automatic-styles>
  <office:body><office:text>${body}</office:text></office:body>
</office:document-content>`;
}

function sampleOdt(): Uint8Array {
  const styles = `<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>
    <text:list-style style:name="L2"><text:list-level-style-bullet text:level="1" text:bullet-char="•"/></text:list-style>`;
  const body = `<text:h text:outline-level="1">总览</text:h>
    <text:p text:style-name="Heading_20_2">次标题</text:p>
    <text:p>正文甲</text:p>
    <text:list text:style-name="L1"><text:list-item><text:p>其一</text:p></text:list-item><text:list-item><text:p>其二</text:p></text:list-item></text:list>
    <text:list text:style-name="L2"><text:list-item><text:p>甲</text:p></text:list-item></text:list>
    <table:table table:name="表1">
      <table:table-row><table:table-cell><text:p>格A</text:p></table:table-cell><table:table-cell><text:p>格B</text:p></table:table-cell></table:table-row>
      <table:table-row><table:table-cell><text:p>1</text:p></table:table-cell><table:table-cell><text:p>2</text:p></table:table-cell></table:table-row>
    </table:table>
    <text:p><draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame></text:p>
    <text:p><text:a xlink:href="http://evil.example/secret">链接文字</text:a></text:p>
    <text:script>alert("evil.example")</text:script>`;
  return zipOffice({
    mimetype: ODT_MIME,
    'content.xml': contentXml(body, styles),
    'Pictures/a.png': PNG,
  });
}

describe('odt', () => {
  it('收成 flow：标题、段落、列表、表、包内图片', async () => {
    const result = await parseFormat(inputOf('odt', sampleOdt()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') return;
    expect(result.doc.blocks).toEqual([
      { type: 'heading', level: 1, text: '总览' },
      { type: 'heading', level: 2, text: '次标题' },
      { type: 'paragraph', text: '正文甲' },
      { type: 'list', ordered: true, items: ['其一', '其二'] },
      { type: 'list', ordered: false, items: ['甲'] },
      { type: 'table', rows: [['格A', '格B'], ['1', '2']] },
      { type: 'image', assetId: 'img-1' },
      { type: 'paragraph', text: '链接文字' },
    ]);
    expect(result.doc.assets).toEqual([{ id: 'img-1', mime: 'image/png', bytes: PNG }]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    const dumped = JSON.stringify(result.doc);
    expect(dumped).not.toContain('evil.example');
    expect(dumped).not.toContain('alert');
  });

  it('扩展名和魔数不一致时按内容打开', async () => {
    const asDocx = await parseFormat(inputOf('docx', sampleOdt()));
    expect(asDocx.ok).toBe(true);
    if (!asDocx.ok || asDocx.doc.kind !== 'flow') return;
    expect(asDocx.doc.blocks[0]).toEqual({ type: 'heading', level: 1, text: '总览' });
    expect(asDocx.doc.warnings).toContain(MSG.magicMismatch);

    const docx = zipOffice({
      '[Content_Types].xml': contentTypes([`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`]),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文字稿</w:t></w:r></w:p></w:body></w:document>`,
    });
    const asOdt = await parseFormat(inputOf('odt', docx));
    expect(asOdt.ok).toBe(true);
    if (!asOdt.ok || asOdt.doc.kind !== 'flow') return;
    expect(asOdt.doc.blocks).toEqual([{ type: 'paragraph', text: '文字稿' }]);
    expect(asOdt.doc.warnings).toEqual([MSG.magicMismatch]);
  });

  it('indexText 把正文放在第 1 页', async () => {
    const pages = await indexText(inputOf('odt', sampleOdt()));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.text).toContain('总览');
    expect(pages[0]?.text).toContain('其一');
    expect(pages[0]?.text).not.toContain('evil.example');
  });

  it('简单 DOCTYPE 会去掉，正文仍在', async () => {
    const bytes = zipOffice({
      mimetype: ODT_MIME,
      'content.xml': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE office:document-content PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "office.dtd">
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>仍可读</text:p></office:text></office:body></office:document-content>`,
    });
    const result = await parseFormat(inputOf('odt', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') throw new Error('expected flow');
    expect(result.doc.blocks).toEqual([{ type: 'paragraph', text: '仍可读' }]);
    expect(JSON.stringify(result.doc)).not.toContain('office.dtd');
  });

  it('拒绝 DOCTYPE，外部实体不会展开', async () => {
    const bytes = zipOffice({
      mimetype: ODT_MIME,
      'content.xml': `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>&xxe;</text:p></office:text></office:body></office:document-content>`,
    });
    const result = await parseFormat(inputOf('odt', bytes));
    expect(result).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });
  });

  it('超大、ZIP 炸弹、加密位、坏包、重复列', async () => {
    const huge = await parseFormat({ ...inputOf('odt', sampleOdt()), size: 80 * 1024 * 1024 + 1 });
    expect(huge).toMatchObject({ ok: false, code: 'too-large' });

    const bomb = await parseFormat(inputOf('odt', declaredZip({ entries: 1, compressed: 10, uncompressed: 100000 })));
    expect(bomb).toEqual({ ok: false, code: 'too-large', message: MSG.zipLimit });

    const locked = await parseFormat(inputOf('odt', declaredZip({ entries: 1, flags: 1 })));
    expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const broken = await parseFormat(inputOf('odt', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const missing = await parseFormat(inputOf('odt', zipOffice({ mimetype: ODT_MIME })));
    expect(missing).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const sheet = await parseFormat(
      inputOf(
        'odt',
        zipOffice({
          mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
          'content.xml': `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:spreadsheet/></office:body></office:document-content>`,
        }),
      ),
    );
    expect(sheet).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });

    const foreign = await parseFormat(inputOf('odt', zipOffice({ 'hello.txt': '不是文档' })));
    expect(foreign).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });

    const repeated = await parseFormat(
      inputOf(
        'odt',
        zipOffice({
          mimetype: ODT_MIME,
          'content.xml': contentXml(
            '<table:table><table:table-row><table:table-cell table:number-columns-repeated="100000"><text:p>甲</text:p></table:table-cell></table:table-row></table:table>',
          ),
        }),
      ),
    );
    expect(repeated.ok).toBe(true);
    if (!repeated.ok || repeated.doc.kind !== 'flow') return;
    const table = repeated.doc.blocks[0];
    expect(table).toEqual({ type: 'table', rows: [Array.from({ length: 32 }, () => '甲')] });
    expect(repeated.doc.warnings).toEqual([MSG.truncated]);
  });
});
