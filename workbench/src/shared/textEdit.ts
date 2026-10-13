/** 原位编辑（第 9 轮 C）：主进程 TextEditService 与渲染进程共用的类型 */
import type { TextDiff } from './textDiff';

export type TextEncodingName = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be' | 'gb18030';
export interface TextSnapshot {
  resourceId: string;
  relPath: string;
  /** 换行统一为 \n 的正文（编辑器里看到的） */
  text: string;
  hash: string;
  mtimeMs: number;
  size: number;
  encoding: TextEncodingName;
  eol: 'lf' | 'crlf';
  editable: boolean;
  /** 不可编辑的原因 */
  readOnlyReason?: string;
}
export interface SavePreview {
  resourceId: string;
  relPath: string;
  diff: TextDiff;
  /** 当前磁盘内容已不是 baseHash（外部修改） */
  conflict: boolean;
  disk: TextSnapshot;
  summary: string;
}
export type SaveOutcome =
  | { status: 'saved'; opId: number; snapshot: TextSnapshot }
  | { status: 'unchanged'; snapshot: TextSnapshot }
  | { status: 'conflict'; disk: TextSnapshot; diff: TextDiff };
export type UndoOutcome =
  | { status: 'undone'; opId: number; snapshot: TextSnapshot }
  | { status: 'nothing' }
  | { status: 'conflict'; detail: string[] }
  | { status: 'unrecoverable'; detail: string[] };

export interface WriteRecord {
  opId: number;
  ts: number;
  actor: string;
  beforeHash: string | null;
  afterHash: string | null;
  undone: boolean;
}
