import { describe, expect, it } from 'vitest';
import { MSG } from '../src/shared/formats/messages';
import { indexText, parseFormat } from '../src/shared/formats/parse';
import { encode, inputOf } from './formats-samples';

/** 中文只走 \'hh / \uN，样例本身保持 ASCII，避免测试文件编码干扰。 */
function rtf(body: string): Uint8Array {
  return encode(body);
}

function sampleRtf(): Uint8Array {
  return rtf(
    String.raw`{\rtf1\ansi\ansicpg936\deff0{\fonttbl{\f0\fnil\fcharset134 SimSun;}}\f0\fs24 \'c4\'e3\'ba\'c3\b \'b4\'d6\'cc\'e5\b0 \i \'d0\'b1\'cc\'e5\i0\par\u20320?\uc2\u22909\'ba\'c3\uc1\u-24800?\par\trowd\cellx1000\cellx2000\pard\intbl \'b8\'f1A\cell\pard\intbl \'b8\'f1B\cell\row\pard\outlinelevel0 \'ba\'f3\'bc\'c7\par{\field{\*\fldinst{HYPERLINK "http://evil.example/secret"}}{\fldrslt \'c1\'b4\'bd\'d3\'ce\'c4\'d7\'d6}}\par}`,
  );
}

describe('rtf', () => {
  it('收成 flow：段落、粗斜体、\\uN、表格、标题，并丢掉外链', async () => {
    const result = await parseFormat(inputOf('rtf', sampleRtf()));
    expect(result.ok).toBe(true);
    if (!result.ok || result.doc.kind !== 'flow') return;
    expect(result.doc.blocks).toEqual([
      {
        type: 'paragraph',
        text: '你好粗体斜体',
        runs: [{ text: '你好' }, { text: '粗体', bold: true }, { text: '斜体', italic: true }],
      },
      { type: 'paragraph', text: '你好鼠' },
      { type: 'table', rows: [['格A', '格B']] },
      { type: 'heading', level: 1, text: '后记' },
      { type: 'paragraph', text: '链接文字' },
    ]);
    expect(result.doc.assets).toEqual([]);
    expect(result.doc.warnings).toEqual([MSG.externalRel]);
    expect(JSON.stringify(result.doc)).not.toContain('evil.example');

    const grouped = await parseFormat(inputOf('rtf', rtf(String.raw`{\rtf1\ansi\ansicpg936{\b \'b4\'d6\'cc\'e5}{\i \'d0\'b1\'cc\'e5}}`)));
    expect(grouped.ok).toBe(true);
    if (!grouped.ok || grouped.doc.kind !== 'flow') return;
    expect(grouped.doc.blocks).toEqual([
      {
        type: 'paragraph',
        text: '粗体斜体',
        runs: [
          { text: '粗体', bold: true },
          { text: '斜体', italic: true },
        ],
      },
    ]);

    const charset = await parseFormat(
      inputOf('rtf', rtf(String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fcharset134 SimSun;}}\f0\'c4\'e3\'ba\'c3}`)),
    );
    expect(charset.ok).toBe(true);
    if (!charset.ok || charset.doc.kind !== 'flow') return;
    expect(charset.doc.blocks).toEqual([{ type: 'paragraph', text: '你好' }]);

    const codepage = await parseFormat(inputOf('rtf', rtf(String.raw`{\rtf1\ansi\ansicpg936 \'c4\'e3\'ba\'c3}`)));
    expect(codepage.ok).toBe(true);
    if (!codepage.ok || codepage.doc.kind !== 'flow') return;
    expect(codepage.doc.blocks).toEqual([{ type: 'paragraph', text: '你好' }]);
  });

  it('扩展名和魔数不一致时按内容打开', async () => {
    const asDocx = await parseFormat(inputOf('docx', sampleRtf(), 'sample.docx'));
    expect(asDocx.ok).toBe(true);
    if (!asDocx.ok || asDocx.doc.kind !== 'flow') return;
    expect(asDocx.doc.blocks[0]).toMatchObject({ type: 'paragraph', text: '你好粗体斜体' });
    expect(asDocx.doc.warnings).toContain(MSG.magicMismatch);

    const plain = await parseFormat(inputOf('rtf', encode('hello')));
    expect(plain).toEqual({ ok: false, code: 'unsupported-variant', message: MSG.unsupported });

    const upper = await parseFormat(inputOf('txt', rtf(String.raw`{\RTF1\ansi\ansicpg936 \'c4\'e3}`)));
    expect(upper.ok).toBe(true);
    if (!upper.ok || upper.doc.kind !== 'flow') return;
    expect(upper.doc.blocks).toEqual([{ type: 'paragraph', text: '你' }]);
    expect(upper.doc.warnings).toEqual([]);
  });

  it('indexText 把正文放在第 1 页', async () => {
    const pages = await indexText(inputOf('rtf', sampleRtf()));
    expect(pages).toHaveLength(1);
    expect(pages[0]?.page).toBe(1);
    expect(pages[0]?.text).toContain('你好');
    expect(pages[0]?.text).toContain('后记');
    expect(pages[0]?.text).toContain('格A');
    expect(pages[0]?.text).not.toContain('evil.example');
  });

  it('坏的控制字、多余括号、\\bin 越界都算损坏', async () => {
    const badHex = await parseFormat(inputOf('rtf', rtf(String.raw`{\rtf1 \'zz}`)));
    expect(badHex).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const extra = await parseFormat(inputOf('rtf', rtf(String.raw`{\rtf1 hi}}`)));
    expect(extra).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });

    const bin = await parseFormat(inputOf('rtf', rtf(String.raw`{\rtf1\bin20 hi}`)));
    expect(bin).toEqual({ ok: false, code: 'corrupt', message: MSG.corrupt });
  });

  it('超过 80MB 拒绝解析', async () => {
    const huge = await parseFormat({ ...inputOf('rtf', sampleRtf()), size: 80 * 1024 * 1024 + 1 });
    expect(huge).toEqual({ ok: false, code: 'too-large', message: MSG.tooLarge });
  });
});
