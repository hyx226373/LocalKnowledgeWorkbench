import type { BlankFileCreated } from './blankFile';
export const REBIRTH_CHANGED_CHANNEL = 'rebirth:changed';
export function safeName(s: string): string { return s.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/,'').slice(0,70) || '未命名'; }
export type RebirthType = string;
export interface RebirthBlock { idx: number; type?: string; title: string; body: string; subOrigins?: number[] }
export interface RebirthMeta { [key: string]: unknown; agent: string; title: string; topic: string; created: string; no: number; folder?: string; cover?: string }
export interface RebirthDocument { meta: RebirthMeta; blocks: RebirthBlock[]; warnings?: string[] }
/** 导入写入成功，或在覆盖已有资料且块数变少、尚未确认时原样返回。成功路径只带 id。 */
export interface RebirthImportResult { id: string; needsConfirm?: true; oldBlocks?: number; newBlocks?: number; title?: string; pickedText?: string }
/** 已有目标且新块数更少、调用方未确认时返回待确认结果；否则返回 null。纯函数，不写盘。 */
export function rebirthFewerBlocksHold(input: { hasExisting: boolean; oldBlocks: number; newBlocks: number; id: string; title: string; confirmFewer?: boolean; pickedText?: string }): RebirthImportResult | null {
  if (!input.hasExisting || input.newBlocks >= input.oldBlocks || input.confirmFewer === true) return null;
  return { needsConfirm: true, oldBlocks: input.oldBlocks, newBlocks: input.newBlocks, id: input.id, title: input.title, ...(input.pickedText!==undefined?{pickedText:input.pickedText}:{}) };
}
export function rebirthFewerBlocksDialog(oldBlocks: number, newBlocks: number): { title: string; body: string; ok: string; cancel: string } {
  return { title: '导入内容比原文少', body: `原文 ${oldBlocks} 块 → 导入 ${newBlocks} 块，少掉的块会被删除（导入前会先备份原文）`, ok: '仍然导入', cancel: '取消' };
}
export interface RebirthSelection { selected: number[] | null; hidden: number[]; subSelected?: Record<number,number[]> }
export interface RebirthItem { id: string; no: number; title: string; blocks: number; selectedCount: number; created: string; agent?: string; topic?: string; folder?: string; cover?: string }
export interface RebirthList { groups: {agent: string; topics: {topic: string; items: RebirthItem[]}[]}[]; quarantined: {name: string; reason: string}[] }
export const REBIRTH_LINK_KINDS = ['create', 'json', 'import', 'export', 'exportWeb', 'importWeb', 'root'] as const;
export type RebirthLinkKind = typeof REBIRTH_LINK_KINDS[number];
export interface RebirthApi {
  rebirthLinkText(input:{kind:RebirthLinkKind;id?:string;agentId?:string;distillAgentId?:string}):Promise<{text:string}>;
  rebirthCoverSet(input: {id:string}): Promise<{canceled:boolean}>;
  rebirthCoverRemove(input: {id:string}): Promise<void>;
  rebirthImportInstruction(a:{id:string;mode:'file'|'json'}):Promise<{text:string}>;
  rebirthMerge(a:{id:string;text?:string;pickFile?:boolean;confirmFewer?:boolean}):Promise<RebirthImportResult | null>;
  rebirthBackups(a:{id:string}):Promise<{version:string}[]>;
  rebirthRestore(a:{id:string;version:string}):Promise<unknown>;
  rebirthTree(): Promise<RebirthTree>;
  rebirthFolderCreate(input: {folder:string}): Promise<void>;
  rebirthFolderRename(input: {folder:string;name:string}): Promise<void>;
  rebirthFolderDelete(input: {folder:string}): Promise<void>;
  rebirthFolderMove(input: {folder:string;parent:string}): Promise<void>;
  rebirthMove(input: {id:string;folder:string}): Promise<void>;
  rebirthExportFolder(input: {folder:string}): Promise<{canceled:boolean;path?:string}>;
  rebirthSettingsGet(): Promise<RebirthSettings>;
  rebirthSettingsSet(input: Partial<RebirthSettings>): Promise<RebirthSettings>;
  rebirthList(): Promise<RebirthList>;
  rebirthRead(input: {id: string}): Promise<RebirthDocument>;
  rebirthSaveBlocks(input: {id: string; blocks: Omit<RebirthBlock, 'idx'>[]}): Promise<void>;
  rebirthImport(input: {text: string; agent?: string; confirmFewer?: boolean; id?: string}): Promise<RebirthImportResult>;
  rebirthImportJson(input: {text: string; agent?: string; confirmFewer?: boolean; id?: string} | {pickFile: true; confirmFewer?: boolean; id?: string}): Promise<RebirthImportResult | null>;
  rebirthRename(input: {id: string; title: string}): Promise<void>;
  rebirthDelete(input: {id: string}): Promise<void>;
  rebirthSelectionGet(input: {id: string}): Promise<RebirthSelection>;
  rebirthSelectionSet(input: {id: string; selected: number[] | null; hidden: number[]; subSelected?: Record<number,number[]>}): Promise<void>;
  rebirthNewLink(input: {agent: string; canWrite?: boolean; mode?: 'file' | 'markdown' | 'json'}): Promise<{text: string}>;
  rebirthCopyLink(input: {id: string; mode: 'file' | 'full'}): Promise<{text: string; empty?: boolean}>;
  rebirthExportFile(input: {id: string}): Promise<{canceled: boolean; path?: string}>;
  rebirthExportRoot(input: {id: string; dir: string; name?: string}): Promise<BlankFileCreated>;
  rebirthDragOut(input: {id: string}): boolean;
  rebirthSkills(): Promise<import('./skillLibrary').SkillLibraryView>;
  rebirthImportDistill(input: { text: string; agent?: string; overwrite?: boolean; rename?: string; summary?: boolean }): Promise<{ id?: string; skill?: { ok: true; name: string; overwritten: boolean } | { ok: false; reason: string; name?: string; conflict?: boolean } }>;
  rebirthMembershipGet(): Promise<import('./rebirthMembership').MembershipFile>;
  rebirthMembershipEnsure(input: { workspaceIds: string[]; currentId?: string | null }): Promise<import('./rebirthMembership').MembershipFile>;
  rebirthNoteWorkspace(input: { currentId?: string | null; workspaceIds?: string[] }): Promise<{ root: string }>;
  rebirthMembershipApply(input: { workspaceId: string; checkedIds: string[] }): Promise<{ added: string[]; removed: string[] }>;
  rebirthMembershipRemove(input: { workspaceId: string; id: string }): Promise<{ ok: true }>;
  rebirthLibraryList(): Promise<import('./rebirthMembership').LibraryFile[]>;
  onRebirthChanged(cb: () => void): () => void;
}
export const REBIRTH_METHODS = ['rebirthLinkText','rebirthImportInstruction','rebirthMerge','rebirthBackups','rebirthRestore','rebirthCoverSet','rebirthCoverRemove','rebirthTree','rebirthFolderCreate','rebirthFolderRename','rebirthFolderDelete','rebirthFolderMove','rebirthMove','rebirthExportFolder','rebirthSettingsGet','rebirthSettingsSet','rebirthList','rebirthRead','rebirthSaveBlocks','rebirthImport','rebirthImportJson','rebirthRename','rebirthDelete','rebirthSelectionGet','rebirthSelectionSet','rebirthNewLink','rebirthCopyLink','rebirthExportFile','rebirthExportRoot','rebirthDragOut','rebirthSkills','rebirthImportDistill','rebirthMembershipGet','rebirthMembershipEnsure','rebirthNoteWorkspace','rebirthMembershipApply','rebirthMembershipRemove','rebirthLibraryList'] as const;

export interface RebirthFormatBlock { title:string; type:string; hint:string }
export interface RebirthSummaryFormat { id:string; name:string; text?:string; builtin:boolean; blocks?:RebirthFormatBlock[]; detail?:string }
export interface RebirthSettings { headerFields?: string[]; rootDir?: string; defaultDir?: string; formats?: RebirthSummaryFormat[]; activeFormat?: string; mode: 'manual' | 'ai'; folder: string; missingFolder: 'root' | 'create'; generateCover?: boolean; attachRootInfo?: boolean; archive?: {mode:'ai'|'dir';allowNewFolder:boolean;dir:string}; skillDistill?: boolean; skillAttach?: { name: string; full?: boolean }[] }
export interface RebirthFolder { folder: string; name: string; folders: RebirthFolder[]; items: RebirthItem[] }
export interface RebirthTree { root: RebirthFolder; quarantined: {name:string;reason:string}[] }
