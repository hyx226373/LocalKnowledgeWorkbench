import { describe, expect, it } from 'vitest';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { contentTypes, inputOf, rels, zipOffice } from './formats-samples';

const PPT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const SLIDE_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function samplePptx(): Uint8Array {
  const slide1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <p:cSld><p:spTree>
    <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
    <p:grpSpPr/>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/><a:p><a:r><a:t>封面</a:t></a:r></a:p></p:txBody>
    </p:sp>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:bodyPr/>
        <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>第一点</a:t></a:r></a:p>
        <a:p><a:pPr><a:buChar char="•"/></a:pPr><a:r><a:t>第二点</a:t></a:r></a:p>
      </p:txBody>
    </p:sp>
    <p:graphicFrame>
      <a:graphic><a:graphicData>
        <a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>格A</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>格B</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>
      </a:graphicData></a:graphic>
    </p:graphicFrame>
    <p:pic>
      <p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill>
    </p:pic>
    <p:graphicFrame>
      <a:graphic><a:graphicData><c:chart r:id="rIdChart"/></a:graphicData></a:graphic>
    </p:graphicFrame>
  </p:spTree></p:cSld>
</p:sld>`;
  const slide2 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:bodyPr/><a:p><a:r><a:t>末页</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:sld>`;
  const notes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>
    <p:sp><p:txBody><a:p><a:r><a:t>备注甲</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld>
</p:notes>`;
  return zipOffice({
    '[Content_Types].xml': contentTypes([
      `<Override PartName="/ppt/presentation.xml" ContentType="${PPT_TYPE}"/>`,
      `<Override PartName="/ppt/slides/slide1.xml" ContentType="${SLIDE_TYPE}"/>`,
      `<Override PartName="/ppt/slides/slide2.xml" ContentType="${SLIDE_TYPE}"/>`,
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'ppt/presentation.xml' }]),
    'ppt/presentation.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256" r:id="rId2"/>
    <p:sldId id="257" r:id="rId3"/>
  </p:sldIdLst>
</p:presentation>`,
    'ppt/_rels/presentation.xml.rels': rels([
      { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide1.xml' },
      { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: 'slides/slide2.xml' },
    ]),
    'ppt/slides/slide1.xml': slide1,
    'ppt/slides/_rels/slide1.xml.rels': rels([
      { id: 'rIdImg', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', target: '../media/image1.png' },
      { id: 'rIdNotes', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide', target: '../notesSlides/notesSlide1.xml' },
      { id: 'rIdExt', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', target: 'http://evil.example/slide', external: true },
    ]),
    'ppt/slides/slide2.xml': slide2,
    'ppt/notesSlides/notesSlide1.xml': notes,
    'ppt/media/image1.png': PNG,
  });
}

describe('pptx / OOXML dps', () => {
  it('收成 slides：标题、列表、表、图片、图表占位和备注', async () => {
    const result = await parseFormat(inputOf('pptx', samplePptx()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'slides') throw new Error('expected slides');
    expect(result.doc.slides).toHaveLength(2);
    expect(result.doc.slides[0]?.blocks).toEqual([
      { type: 'heading', level: 1, text: '封面' },
      { type: 'list', ordered: false, items: ['第一点', '第二点'] },
      { type: 'table', rows: [['格A', '格B']] },
      { type: 'image', assetId: 'img-1' },
      { type: 'unsupported', text: '图表' },
    ]);
    expect(result.doc.slides[0]?.notes).toBe('备注甲');
    expect(result.doc.slides[1]).toEqual({ blocks: [{ type: 'paragraph', text: '末页' }] });
    expect(result.doc.assets).toEqual([{ id: 'img-1', mime: 'image/png', bytes: PNG }]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    expect(JSON.stringify(result.doc)).not.toContain('evil.example');
  });

  it('.dps 走幻灯片，扩展名不一致时按内容打开', async () => {
    const bytes = samplePptx();
    const asDps = await parseFormat(inputOf('dps', bytes));
    expect(asDps.ok).toBe(true);
    if (!asDps.ok) return;
    expect(asDps.doc.kind).toBe('slides');
    expect(asDps.doc.warnings).toEqual([MSG.externalRel]);

    const asEt = await parseFormat(inputOf('et', bytes));
    expect(asEt.ok).toBe(true);
    if (!asEt.ok) return;
    expect(asEt.doc.kind).toBe('slides');
    expect(asEt.doc.warnings).toContain(MSG.magicMismatch);
  });

  it('indexText 每张幻灯片一页，备注算在同一页', async () => {
    const pages = await indexText(inputOf('pptx', samplePptx()));
    expect(pages.map((page) => page.page)).toEqual([1, 2]);
    expect(pages[0]?.text).toContain('封面');
    expect(pages[0]?.text).toContain('备注甲');
    expect(pages[1]?.text).toContain('末页');
    expect(pages[0]?.text).not.toContain('evil.example');
  });
});
