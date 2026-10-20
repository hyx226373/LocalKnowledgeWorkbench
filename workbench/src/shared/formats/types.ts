/**
 * 版式文档的中间结构。格式模块不依赖 DOM / React，渲染进程和测试共用。
 * 只解析调用方已经取到的字节，不访问网络，不拉取云文档。
 */

export const FORMAT_PLUGIN_ID = 'builtin.formats';
export const FORMAT_PLUGIN_VERSION = '1.0.0';

export type FormatCapability = 'parse' | 'render' | 'thumbnail' | 'indexText';

export interface FormatManifest {
  id: string;
  version: string;
  extensions: string[];
  mimeTypes?: string[];
  capabilities: FormatCapability[];
  /** 超过则降级，不再把整文件送进解析器。 */
  maxBytes: number;
}

export interface FormatInput {
  ext: string;
  mime?: string;
  size: number;
  bytes: Uint8Array;
  name: string;
}

export type FormatErrorCode = 'too-large' | 'encrypted' | 'corrupt' | 'unsupported-variant' | 'timeout';

/** 一段里的连续文字。没有粗斜体时不写 runs，正文仍在 text 里。 */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
}

export type Block =
  | { type: 'heading'; level: number; text: string; runs?: TextRun[] }
  | { type: 'paragraph'; text: string; runs?: TextRun[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][] }
  | { type: 'code'; text: string }
  | { type: 'image'; assetId: string; alt?: string }
  | { type: 'unsupported'; text: string };

/** 图片字节只活在内存里，不进面板状态。 */
export interface Asset {
  id: string;
  mime: string;
  bytes?: Uint8Array;
}

export interface FlowPage {
  blocks: Block[];
  width?: number;
  height?: number;
}

export type DocModel =
  | { kind: 'flow'; blocks: Block[]; assets: Asset[]; warnings: string[] }
  | { kind: 'paged'; pages: FlowPage[]; assets: Asset[]; warnings: string[] }
  | { kind: 'sheets'; sheets: { name: string; rows: string[][] }[]; assets: Asset[]; warnings: string[] }
  | { kind: 'slides'; slides: { blocks: Block[]; notes?: string }[]; assets: Asset[]; warnings: string[] };

export type FormatResult =
  | { ok: true; doc: DocModel }
  | { ok: false; code: FormatErrorCode; message: string; doc?: DocModel };

export class FormatFail extends Error {
  constructor(
    readonly code: FormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FormatFail';
  }
}

export interface FormatAdapterDecl {
  id: string;
  title: string;
  extensions: readonly string[];
}

/** 扩展名选适配器。魔数在 parse 里再决定真正的解析器。 */
export const FORMAT_ADAPTERS: readonly FormatAdapterDecl[] = [
  { id: 'builtin.formats.docx', title: '文档', extensions: ['docx', 'wps'] },
  { id: 'builtin.formats.xlsx', title: '表格', extensions: ['xlsx', 'et'] },
  { id: 'builtin.formats.pptx', title: '幻灯片', extensions: ['pptx', 'dps'] },
  { id: 'builtin.formats.epub', title: '电子书', extensions: ['epub'] },
  { id: 'builtin.formats.odt', title: '文档', extensions: ['odt'] },
  { id: 'builtin.formats.rtf', title: '文档', extensions: ['rtf'] },
  { id: 'builtin.formats.ofd', title: '版式', extensions: ['ofd'] },
];

export function adapterIdForExt(ext: string): string | undefined {
  const e = ext.toLowerCase().replace(/^\./, '');
  return FORMAT_ADAPTERS.find((a) => a.extensions.includes(e))?.id;
}
