import { describe, expect, it } from 'vitest';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { contentTypes, declaredZip, inputOf, zipOffice } from './formats-samples';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WORD_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function sampleEpub(): Uint8Array {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chap2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="images/a.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="c2"/>
    <itemref idref="c1"/>
  </spine>
</package>`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body><nav epub:type="toc"><ol>
    <li><a href="chap2.xhtml">第二章</a></li>
    <li><a href="chap1.xhtml">第一章</a>
      <ol><li><a href="chap1.xhtml#s2">第二节</a></li></ol>
    </li>
  </ol></nav></body>
</html>`;
  const chap2 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <p>后章正文</p>
  <p><img src="http://evil.example/secret.png" alt="外链"/></p>
</body></html>`;
  const chap1 = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body>
  <h1>第一章</h1>
  <p>正文甲</p>
  <ol><li>其一</li><li>其二</li></ol>
  <table><tr><td>格A</td><td>格B</td></tr><tr><td>1</td><td>2</td></tr></table>
  <p><img src="images/a.png" alt="图"/></p>
  <h2 id="s2">第二节</h2>
  <p>节内</p>
  <script>alert("evil.example")</script>
</body></html>`;
  return zipOffice({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/nav.xhtml': nav,
    'OEBPS/chap1.xhtml': chap1,
    'OEBPS/chap2.xhtml': chap2,
    'OEBPS/images/a.png': PNG,
  });
}

function ncxEpub(): Uint8Array {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="c1" href="c.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>`;
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap><navPoint id="c1" playOrder="1">
    <navLabel><text>目录章</text></navLabel>
    <content src="c.xhtml"/>
  </navPoint></navMap>
</ncx>`;
  const chapter = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>仅此一段</p></body></html>`;
  return zipOffice({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': container,
    'OEBPS/content.opf': opf,
    'OEBPS/toc.ncx': ncx,
    'OEBPS/c.xhtml': chapter,
  });
}

function miniEpub(chapter: string): Uint8Array {
  return zipOffice({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    'OEBPS/content.opf': `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><manifest><item id="c1" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    'OEBPS/c.xhtml': chapter,
  });
}

async function paragraphOf(bytes: Uint8Array): Promise<string> {
  const result = await parseFormat(inputOf('epub', bytes));
  expect(result.ok).toBe(true);
  if (!result.ok || result.doc.kind !== 'flow') throw new Error('expected flow');
  const text = result.doc.blocks.map((block) => (block.type === 'paragraph' ? block.text : '')).join('\n');
  expect(JSON.stringify(result.doc)).not.toContain('passwd');
  expect(JSON.stringify(result.doc)).not.toContain('w3.org');
  return text;
}

describe('epub', () => {
  it('按 spine 收成 flow，目录标题补上，图片留在包内', async () => {
    const result = await parseFormat(inputOf('epub', sampleEpub()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') return;
    expect(result.doc.blocks).toEqual([
      { type: 'heading', level: 1, text: '第二章' },
      { type: 'paragraph', text: '后章正文' },
      { type: 'heading', level: 1, text: '第一章' },
      { type: 'paragraph', text: '正文甲' },
      { type: 'list', ordered: true, items: ['其一', '其二'] },
      { type: 'table', rows: [['格A', '格B'], ['1', '2']] },
      { type: 'image', assetId: 'img-1', alt: '图' },
      { type: 'heading', level: 2, text: '第二节' },
      { type: 'paragraph', text: '节内' },
    ]);
    expect(result.doc.assets).toEqual([{ id: 'img-1', mime: 'image/png', bytes: PNG }]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    const dumped = JSON.stringify(result.doc);
    expect(dumped).not.toContain('evil.example');
    expect(dumped).not.toContain('alert');
  });

  it('没有 nav 时用 ncx 目录标题', async () => {
    const result = await parseFormat(inputOf('epub', ncxEpub()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') return;
    expect(result.doc.blocks).toEqual([
      { type: 'heading', level: 1, text: '目录章' },
      { type: 'paragraph', text: '仅此一段' },
    ]);
  });

  it('扩展名和魔数不一致时按内容打开', async () => {
    const asDocx = await parseFormat(inputOf('docx', sampleEpub()));
    expect(asDocx.ok).toBe(true);
    if (!asDocx.ok || asDocx.doc.kind !== 'flow') return;
    expect(asDocx.doc.blocks[0]).toEqual({ type: 'heading', level: 1, text: '第二章' });
    expect(asDocx.doc.warnings).toContain(MSG.magicMismatch);

    const docx = zipOffice({
      '[Content_Types].xml': contentTypes([`<Override PartName="/word/document.xml" ContentType="${WORD_TYPE}"/>`]),
      'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>文字稿</w:t></w:r></w:p></w:body></w:document>`,
    });
    const asEpub = await parseFormat(inputOf('epub', docx));
    expect(asEpub.ok).toBe(true);
    if (!asEpub.ok || asEpub.doc.kind !== 'flow') return;
    expect(asEpub.doc.blocks).toEqual([{ type: 'paragraph', text: '文字稿' }]);
    expect(asEpub.doc.warnings).toEqual([MSG.magicMismatch]);
  });

  it('indexText 按阅读顺序放在第 1 页', async () => {
    const pages = await indexText(inputOf('epub', sampleEpub()));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text.indexOf('第二章')).toBeLessThan(pages[0]?.text.indexOf('第一章') ?? -1);
    expect(pages[0]?.text).toContain('正文甲');
    expect(pages[0]?.text).not.toContain('evil.example');
  });

  it('简单 DOCTYPE 可以读，不解析外部标识', async () => {
    const html = await paragraphOf(
      miniEpub(`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><body><p>能读</p></body></html>`),
    );
    expect(html).toBe('能读');

    const xhtml = await paragraphOf(
      miniEpub(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
  "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><body><p>过渡</p></body></html>`),
    );
    expect(xhtml).toBe('过渡');

    const system = await paragraphOf(
      miniEpub(`<?xml version="1.0"?><!DOCTYPE html SYSTEM "file:///etc/passwd"><html xmlns="http://www.w3.org/1999/xhtml"><body><p>正文</p></body></html>`),
    );
    expect(system).toBe('正文');
  });

  it('内部子集和 ENTITY 仍拒绝', async () => {
    const entity = miniEpub(
      `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>&xxe;</p></body></html>`,
    );
    expect(await parseFormat(inputOf('epub', entity))).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });

    const subset = miniEpub(
      `<?xml version="1.0"?><!DOCTYPE html [<!ELEMENT p (#PCDATA)>]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>不应读到</p></body></html>`,
    );
    expect(await parseFormat(inputOf('epub', subset))).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });

    const loose = miniEpub(
      `<?xml version="1.0"?><!DOCTYPE html SYSTEM "about:legacy-compat" [<!ENTITY x "y">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>不应读到</p></body></html>`,
    );
    expect(await parseFormat(inputOf('epub', loose))).toEqual({ ok: false, code: 'corrupt', message: MSG.xmlUnsafe });
  });

  it('超大、ZIP 炸弹、加密位、坏包', async () => {
    const huge = await parseFormat({ ...inputOf('epub', sampleEpub()), size: 80 * 1024 * 1024 + 1 });
    expect(huge).toMatchObject({ ok: false, code: 'too-large' });

    const bomb = await parseFormat(inputOf('epub', declaredZip({ entries: 1, compressed: 10, uncompressed: 100000 })));
    expect(bomb).toEqual({ ok: false, code: 'too-large', message: MSG.zipLimit });

    const locked = await parseFormat(inputOf('epub', declaredZip({ entries: 1, flags: 1 })));
    expect(locked).toEqual({ ok: false, code: 'encrypted', message: MSG.encrypted });

    const broken = await parseFormat(inputOf('epub', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0])));
    expect(broken).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const missing = await parseFormat(
      inputOf(
        'epub',
        zipOffice({
          mimetype: 'application/epub+zip',
          'META-INF/container.xml': `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="missing.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
        }),
      ),
    );
    expect(missing).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const foreign = await parseFormat(inputOf('epub', zipOffice({ 'hello.txt': '不是电子书' })));
    expect(foreign).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });
  });
});
