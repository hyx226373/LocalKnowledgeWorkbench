// IPC 与文档类型以共享协议为唯一来源；这里只保留树视图模型。
export type { RebirthType as BlockType, RebirthBlock as Block, RebirthItem as Card,
 RebirthSelection as Selection, RebirthDocument as Document,
 RebirthSettings as ArchiveSettings } from '../../shared/rebirth';
import type { RebirthItem, RebirthTree } from '../../shared/rebirth';
export interface Folder { path:string; name:string; children?:Folder[]; items?:RebirthItem[] }
export interface Tree { folders:Folder[]; items:RebirthItem[]; quarantined:RebirthTree['quarantined'] }
