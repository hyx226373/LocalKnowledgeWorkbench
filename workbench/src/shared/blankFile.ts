/** 新建空白文件只允许这两种类型。扩展名小写，不带点。 */
export const BLANK_FILE_EXTS = ['md', 'txt'] as const;
export type BlankFileExt = (typeof BLANK_FILE_EXTS)[number];

export interface BlankFileCreated {
  resourceId: string;
  rootId: string;
  /** 实际文件名，含扩展名。重名时已改成「名字(2).md」这种形式。 */
  name: string;
  absPath: string;
  /** indexed：落在已注册文件夹根内，只刷新该根索引。source：按单文件来源新登记。 */
  placed: 'indexed' | 'source';
  /** 侧栏要展开的目录资源。不含文件本身。 */
  expandIds: string[];
}

const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isBlankFileExt(ext: string): ext is BlankFileExt {
  return ext === 'md' || ext === 'txt';
}

/**
 * 补上所选扩展名。已经以该扩展名结尾则不再加一遍。
 * 不改文件名中间的点，也不把另一种扩展名换掉。
 */
export function completeBlankFileName(rawName: string, rawExt: string): { stem: string; ext: BlankFileExt; fileName: string } {
  const ext = String(rawExt ?? '').trim().toLowerCase().replace(/^\./, '');
  if (!isBlankFileExt(ext)) throw new Error('类型只支持 md 或 txt');
  let stem = String(rawName ?? '').trim();
  const suffix = `.${ext}`;
  if (stem.toLowerCase().endsWith(suffix)) stem = stem.slice(0, -suffix.length).trim();
  if (!stem) throw new Error('请填写文件名');
  if (stem === '.' || stem === '..' || ILLEGAL.test(stem)) throw new Error('文件名包含不能使用的字符');
  if (/[. ]$/.test(stem)) throw new Error('文件名不能以空格或点结尾');
  if (RESERVED.test(stem)) throw new Error('文件名不能使用系统保留名');
  if (stem.length > 180) throw new Error('文件名过长');
  return { stem, ext, fileName: `${stem}.${ext}` };
}

/** 第 1 个是「名字.md」，从第 2 个起是「名字(2).md」。 */
export function blankFileCandidate(stem: string, ext: BlankFileExt, n: number): string {
  if (n <= 1) return `${stem}.${ext}`;
  return `${stem}(${n}).${ext}`;
}
