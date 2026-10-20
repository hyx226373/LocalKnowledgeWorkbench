import { describe, expect, it } from 'vitest';
import { MAX_PDF_PAGES } from '../src/shared/formats/limits';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { contentTypes, declaredZip, inputOf, zipOffice } from './formats-samples';

const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const NS = 'http://www.ofdspec.org/2016';

function ofdXml(docRoot = 'Doc_0/Document.xml', signatures = 'Doc_0/Signs/Signatures.xml'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:OFD xmlns:ofd="${NS}" Version="1.0" DocType="OFD">
  <ofd:DocBody>
    <ofd:DocInfo><ofd:DocID>sample</ofd:DocID><ofd:Title>样例</ofd:Title></ofd:DocInfo>
    <ofd:DocRoot>${docRoot}</ofd:DocRoot>
    ${signatures ? `<ofd:Signatures>${signatures}</ofd:Signatures>` : ''}
  </ofd:DocBody>
</ofd:OFD>`;
}

function documentXml(pages: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Document xmlns:ofd="${NS}">
  <ofd:CommonData>
    <ofd:PageArea><ofd:PhysicalBox>0 0 210 297</ofd:PhysicalBox></ofd:PageArea>
    <ofd:TemplatePage ID="9" BaseLoc="Tpls/Tpl_0/Content.xml"/>
  </ofd:CommonData>
  <ofd:Pages>
    ${pages}
  </ofd:Pages>
</ofd:Document>`;
}

function sampleOfd(): Uint8Array {
  const page1 = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="${NS}">
  <ofd:Content>
    <ofd:Layer ID="1">
      <ofd:ImageObject ID="8" Boundary="10 10 20 20" ResourceID="1"/>
      <ofd:TextObject ID="5" Boundary="24 44 8 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">右</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="6" Boundary="20 44 8 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">左</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="4" Boundary="20 36 40 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">另一段</ofd:TextCode>
      </ofd:TextObject>
      <ofd:PathObject ID="7" Boundary="0 0 10 10">
        <ofd:AbbreviatedData>矢量路径数据</ofd:AbbreviatedData>
      </ofd:PathObject>
      <ofd:TextObject ID="3" Boundary="20 21 80 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">你好，版式</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="2" Boundary="20 16 80 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">第一页标题</ofd:TextCode>
      </ofd:TextObject>
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>`;
  const page2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<ofd:Page xmlns:ofd="${NS}">
  <ofd:Area><ofd:PhysicalBox>0 0 148 210</ofd:PhysicalBox></ofd:Area>
  <ofd:Template TemplateID="9"/>
  <ofd:Content>
    <ofd:Layer ID="1">
      <ofd:TextObject ID="1" Boundary="10 20 80 8" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4" DeltaX="4 4 4">第二页正文</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="11" Boundary="10 36 20 6" Font="1" Size="4" CTM="1 0 0 1 4 0">
        <ofd:TextCode X="0" Y="4">乙</ofd:TextCode>
      </ofd:TextObject>
      <ofd:TextObject ID="12" Boundary="10 36 20 6" Font="1" Size="4">
        <ofd:TextCode X="0" Y="4">甲</ofd:TextCode>
      </ofd:TextObject>
      <ofd:CompositeObject ID="13" Boundary="0 0 10 10" ResourceID="9"/>
    </ofd:Layer>
  </ofd:Content>
</ofd:Page>`;
  const template = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="${NS}"><ofd:Content><ofd:Layer>
  <ofd:TextObject ID="1" Boundary="10 10 40 6" Font="1" Size="4"><ofd:TextCode X="0" Y="4">模板不读</ofd:TextCode></ofd:TextObject>
</ofd:Layer></ofd:Content></ofd:Page>`;
  return zipOffice({
    'OFD.xml': ofdXml(),
    'Doc_0/Document.xml': documentXml('<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/><ofd:Page ID="2" BaseLoc="Pages/Page_1/Content.xml"/>'),
    'Doc_0/Pages/Page_0/Content.xml': page1,
    'Doc_0/Pages/Page_1/Content.xml': page2,
    'Doc_0/Tpls/Tpl_0/Content.xml': template,
    'Doc_0/Signs/Signatures.xml': `<?xml version="1.0" encoding="UTF-8"?><ofd:Signatures xmlns:ofd="${NS}"><ofd:Signature>机密签章不应出现</ofd:Signature></ofd:Signatures>`,
  });
}

describe('ofd', () => {
  it('两页中文按坐标排成段落，带页宽高，矢量图片签章不进正文', async () => {
    const result = await parseFormat(inputOf('ofd', sampleOfd()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'paged') throw new Error('expected paged');
    expect(result.doc.pages).toEqual([
      {
        width: 210,
        height: 297,
        blocks: [
          { type: 'paragraph', text: '第一页标题\n你好，版式' },
          { type: 'paragraph', text: '另一段' },
          { type: 'paragraph', text: '左右' },
          { type: 'unsupported', text: '矢量' },
          { type: 'unsupported', text: '图片' },
        ],
      },
      {
        width: 148,
        height: 210,
        blocks: [
          { type: 'paragraph', text: '第二页正文' },
          { type: 'paragraph', text: '甲乙' },
          { type: 'unsupported', text: '对象' },
        ],
      },
    ]);
    expect(result.doc.assets).toEqual([]);
    expect(result.doc.warnings).toEqual([MSG.sealIgnored]);
    const dumped = JSON.stringify(result.doc);
    expect(dumped).not.toContain('机密签章不应出现');
    expect(dumped).not.toContain('模板不读');
    expect(dumped).not.toContain('矢量路径数据');
  });

  it('indexText 每页一页', async () => {
    const pages = await indexText(inputOf('ofd', sampleOfd()));
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages[0]?.text.indexOf('第一页标题')).toBeLessThan(pages[0]?.text.indexOf('你好，版式') ?? -1);
    expect(pages[0]?.text.indexOf('你好，版式')).toBeLessThan(pages[0]?.text.indexOf('另一段') ?? -1);
    expect(pages[0]?.text).toContain('左右');
    expect(pages[1]?.text).toContain('第二页正文');
    expect(pages[1]?.text).toContain('甲乙');
    expect(pages.map((page) => page.text).join('\n')).not.toContain('机密签章不应出现');
  });

  it('扩展名和魔数不一致时按内容打开', async () => {
    const asEpub = await parseFormat(inputOf('epub', sampleOfd()));
    expect(asEpub.ok).toBe(true);
    if (!asEpub.ok || asEpub.doc.kind !== 'paged') throw new Error('expected paged');
    expect(asEpub.doc.pages[0]?.blocks[0]).toEqual({ type: 'paragraph', text: '第一页标题\n你好，版式' });
    expect(asEpub.doc.warnings).toContain(MSG.magicMismatch);

    const docx = zipOffice({
      '[Content_Types].xml': contentTypes([`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`]),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文字稿</w:t></w:r></w:p></w:body></w:document>`,
    });
    const asOfd = await parseFormat(inputOf('ofd', docx));
    expect(asOfd.ok).toBe(true);
    if (!asOfd.ok || asOfd.doc.kind !== 'flow') throw new Error('expected flow');
    expect(asOfd.doc.blocks).toEqual([{ type: 'paragraph', text: '文字稿' }]);
    expect(asOfd.doc.warnings).toEqual([MSG.magicMismatch]);
  });

  it('超过页数上限时截断', async () => {
    const count = MAX_PDF_PAGES + 1;
    const pages = Array.from({ length: count }, (_, index) => `<ofd:Page ID="${index + 1}" BaseLoc="Pages/Page_0/Content.xml"/>`).join('');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<ofd:Page xmlns:ofd="${NS}"><ofd:Content><ofd:Layer>
  <ofd:TextObject ID="1" Boundary="10 10 40 6" Font="1" Size="4"><ofd:TextCode X="0" Y="4">超页</ofd:TextCode></ofd:TextObject>
</ofd:Layer></ofd:Content></ofd:Page>`;
    const bytes = zipOffice({
      'OFD.xml': ofdXml('Doc_0/Document.xml', ''),
      'Doc_0/Document.xml': documentXml(pages),
      'Doc_0/Pages/Page_0/Content.xml': content,
    });
    const result = await parseFormat(inputOf('ofd', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'paged') throw new Error('expected paged');
    expect(result.doc.pages).toHaveLength(MAX_PDF_PAGES);
    expect(result.doc.pages[0]?.blocks).toEqual([{ type: 'paragraph', text: '超页' }]);
    expect(result.doc.pages[MAX_PDF_PAGES - 1]?.blocks).toEqual([{ type: 'paragraph', text: '超页' }]);
    expect(result.doc.warnings).toContain(MSG.truncated);
    expect(result.doc.warnings).not.toContain(MSG.sealIgnored);
  });

  it('损坏、超限、ENTITY 和认不出的包', async () => {
    const broken = await parseFormat(inputOf('ofd', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const noRoot = await parseFormat(
      inputOf('ofd', zipOffice({ 'OFD.xml': `<?xml version="1.0"?><ofd:OFD xmlns:ofd="${NS}"><ofd:DocBody><ofd:DocInfo/></ofd:DocBody></ofd:OFD>` })),
    );
    expect(noRoot).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const missing = await parseFormat(inputOf('ofd', zipOffice({ 'OFD.xml': ofdXml('Doc_0/Document.xml', ''), 'Doc_0/Document.xml': documentXml('<ofd:Page ID="1" BaseLoc="Pages/missing.xml"/>') })));
    expect(missing).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const entity = zipOffice({
      'OFD.xml': ofdXml('Doc_0/Document.xml', ''),
      'Doc_0/Document.xml': documentXml('<ofd:Page ID="1" BaseLoc="Pages/Page_0/Content.xml"/>'),
      'Doc_0/Pages/Page_0/Content.xml': `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ofd:Page xmlns:ofd="${NS}"><ofd:Content><ofd:Layer><ofd:TextObject ID="1" Boundary="0 0 10 4"><ofd:TextCode>&xxe;</ofd:TextCode></ofd:TextObject></ofd:Layer></ofd:Content></ofd:Page>`,
    });
    expect(await parseFormat(inputOf('ofd', entity))).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });

    const huge = await parseFormat({ ...inputOf('ofd', sampleOfd()), size: 80 * 1024 * 1024 + 1 });
    expect(huge).toMatchObject({ ok: false, code: 'too-large' });

    const bomb = await parseFormat(inputOf('ofd', declaredZip({ entries: 1, compressed: 10, uncompressed: 100000 })));
    expect(bomb).toEqual({ ok: false, code: 'too-large', message: MSG.zipLimit });

    const locked = await parseFormat(inputOf('ofd', declaredZip({ entries: 1, flags: 1 })));
    expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const foreign = await parseFormat(inputOf('ofd', zipOffice({ 'hello.txt': '不是版式' })));
    expect(foreign).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });
  });
});
