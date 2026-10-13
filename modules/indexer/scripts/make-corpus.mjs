import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export const TERMS = {
  pdf: '青岚索引词',
  pdfPage: 3,
  english: 'ZephyrIndexToken',
  phrase: '沧浪短语检验',
  bodyOnly: '仅正文柚子词',
};

const FONT_PATH = 'C:\\Windows\\Fonts\\simhei.ttf';

/**
 * @param {string} dest
 * @param {{ fileCount?: number }} [options]
 * fileCount 是填充文件数，另外还会写 1 份多页 PDF 和 3 个专项文件。
 */
export async function makeCorpus(dest, options = {}) {
  const fileCount = options.fileCount ?? 2000;
  if (!Number.isInteger(fileCount) || fileCount < 0) {
    throw new Error('fileCount 必须是非负整数');
  }
  await mkdir(dest, { recursive: true });
  const marks = {};
  const kinds = ['zh-md', 'en-md', 'zh-txt', 'en-txt'];
  for (let i = 0; i < fileCount; i += 1) {
    const kind = kinds[i % kinds.length];
    const n = String(i).padStart(6, '0');
    const mark = `文件标记${n}`;
    let rel;
    let body;
    if (kind === 'zh-md') {
      rel = `zh-md/doc-${n}.md`;
      body = `# 中文笔记 ${n}\n\n这是中文资料，编号 ${i}。\n${mark}\n用于全文检索的普通段落，数字 ${i * 13}。\n`;
    } else if (kind === 'en-md') {
      rel = `en-md/doc-${n}.md`;
      body = `# English note ${n}\n\nPlain English material number ${i}.\n${mark}\nIndex filler paragraph ${i * 13}.\n`;
    } else if (kind === 'zh-txt') {
      rel = `zh-txt/note-${n}.txt`;
      body = `中文文本 ${n}\n编号 ${i}，${mark}\n这里是正文，不是标题。\n`;
    } else {
      rel = `en-txt/note-${n}.txt`;
      body = `English text ${n}\nnumber ${i}, ${mark}\nBody line for search filler.\n`;
    }
    marks[rel] = mark;
    const abs = path.join(dest, ...rel.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, body, 'utf8');
  }

  const pdfRelPath = 'special/qinglan.pdf';
  const englishRelPath = 'special/english-token.md';
  const phraseRelPath = 'special/zh-phrase.md';
  const bodyOnlyRelPath = 'special/body-only.md';
  await mkdir(path.join(dest, 'special'), { recursive: true });
  await writePdf(path.join(dest, ...pdfRelPath.split('/')));
  await writeFile(
    path.join(dest, ...englishRelPath.split('/')),
    `# English note\n\nBody has ${TERMS.english} so search can find this English word.\n`,
    'utf8',
  );
  await writeFile(
    path.join(dest, ...phraseRelPath.split('/')),
    `# 短语笔记\n\n这一段包含${TERMS.phrase}，用来确认中文短语能被检索。\n`,
    'utf8',
  );
  await writeFile(
    path.join(dest, ...bodyOnlyRelPath.split('/')),
    `# 普通标题\n\n文件名不会包含目标词。\n正文里单独写上${TERMS.bodyOnly}，方便核对。\n`,
    'utf8',
  );

  const manifest = {
    dir: dest,
    fileCount: fileCount + 4,
    fillerCount: fileCount,
    pdfRelPath,
    pdfPage: TERMS.pdfPage,
    englishRelPath,
    phraseRelPath,
    bodyOnlyRelPath,
    terms: TERMS,
    marks,
  };
  await writeFile(path.join(dest, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return manifest;
}

async function writePdf(dest) {
  const fontBytes = await readFile(FONT_PATH);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(fontBytes, { subset: true });
  const lines = [
    '第一页 只有普通说明，用来占位。',
    '第二页 继续是无关内容，讨论天气与目录。',
    `第三页 出现目标 ${TERMS.pdf} 只在这里。`,
    '第四页 收尾文字，没有目标词。',
  ];
  for (const text of lines) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(text, { font, size: 18, x: 50, y: 760, color: rgb(0, 0, 0) });
  }
  await writeFile(dest, await pdf.save());
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = path.resolve(fileURLToPath(import.meta.url));
if (invoked && invoked.toLowerCase() === self.toLowerCase()) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('用法: node scripts/make-corpus.mjs <目录> [文件数]');
    process.exit(1);
  }
  const fileCount = process.argv[3] ? Number(process.argv[3]) : 2000;
  const manifest = await makeCorpus(path.resolve(dest), { fileCount });
  console.log(
    JSON.stringify(
      {
        dir: manifest.dir,
        fileCount: manifest.fileCount,
        pdfRelPath: manifest.pdfRelPath,
        englishRelPath: manifest.englishRelPath,
        phraseRelPath: manifest.phraseRelPath,
        bodyOnlyRelPath: manifest.bodyOnlyRelPath,
      },
      null,
      2,
    ),
  );
}
