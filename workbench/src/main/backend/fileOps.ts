/**
 * 文件操作适配层（第 9 轮 C/E）。
 *
 * 界面与 agent 的所有“写盘”都经过这里（再往上是 ../backend/operations.ts 的统一操作入口）。
 * 现在的实现 LocalFileOps 用 WorkbenchService 已有的“备份 + op_log + 撤销”；
 * 磐石组的 @kb/fileops + @kb/plan 验收后，换成 PlanFileOps（见 ./plan.ts）即可，调用方不用改。
 *
 * 约定：
 *  - 所有写操作都必须带 expectedHash（调用方看到的内容哈希），不一致时返回冲突，绝不静默覆盖；
 *  - 每次写入都留恢复记录（写入前内容进备份库 + op_log），可以撤销到上一版；
 *  - 渲染进程不直接写盘，只经 IPC 调用主进程的 TextEditService → FileOpsBackend。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { OpLogEntry } from '../../shared/types';
import type { WriteRecord } from '../../shared/textEdit';
export type { WriteRecord };
import { ConflictError, type WorkbenchService } from '../service/WorkbenchService';

export interface FileStat {
  resourceId: string;
  rootId: string;
  relPath: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  /** 内容 sha256 */
  hash: string;
}
export type WriteResult = { ok: true; opId: number; stat: FileStat } | { ok: false; reason: 'conflict'; current: FileStat | null };
export type UndoResult = { ok: true; opId: number; stat: FileStat } | { ok: false; reason: 'nothing' | 'conflict' | 'unrecoverable'; detail: string[] };

/** 将来由 @kb/fileops（+ @kb/plan）实现的最小接口 */
export interface FileOpsBackend {
  stat(resourceId: string): FileStat;
  readBytes(resourceId: string, maxBytes: number): { bytes: Buffer; stat: FileStat; truncated: boolean };
  /** 原子写入；写入前内容进备份库并记 op_log。expectedHash 不符 → { ok:false, reason:'conflict' } */
  writeBytes(resourceId: string, bytes: Buffer, o: { expectedHash: string | null; actor: string; meta?: Record<string, unknown> }): WriteResult;
  /** 某文件的写入记录（新的在前） */
  history(resourceId: string, limit?: number): WriteRecord[];
  /** 撤销某次写入（恢复为写入前内容）。force：文件在那次写入后又被改过时，先备份当前内容再覆盖 */
  undoWrite(opId: number, o: { force: boolean; actor: string }): UndoResult;
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export class LocalFileOps implements FileOpsBackend {
  constructor(private svc: WorkbenchService) {}

  stat(resourceId: string): FileStat {
    const info = this.svc.getResource(resourceId);
    if (!info || info.kind !== 'file') throw new Error('文件资源不存在');
    const abs = this.svc.resolveResourcePath(resourceId);
    const st = fs.statSync(abs);
    return { resourceId, rootId: info.rootId, relPath: info.relPath, name: info.name, ext: info.ext, size: st.size, mtimeMs: st.mtimeMs, hash: sha256(fs.readFileSync(abs)) };
  }

  readBytes(resourceId: string, maxBytes: number) {
    const info = this.svc.getResource(resourceId);
    if (!info || info.kind !== 'file') throw new Error('文件资源不存在');
    const abs = this.svc.resolveResourcePath(resourceId);
    const bytes = fs.readFileSync(abs);
    const st = fs.statSync(abs);
    const stat: FileStat = { resourceId, rootId: info.rootId, relPath: info.relPath, name: info.name, ext: info.ext, size: st.size, mtimeMs: st.mtimeMs, hash: sha256(bytes) };
    return { bytes: bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes, stat, truncated: bytes.length > maxBytes };
  }

  writeBytes(resourceId: string, bytes: Buffer, o: { expectedHash: string | null; actor: string; meta?: Record<string, unknown> }): WriteResult {
    try {
      const op = this.svc.writeText(resourceId, bytes, o.actor, { expectedHash: o.expectedHash, meta: o.meta });
      return { ok: true, opId: op.id, stat: this.stat(resourceId) };
    } catch (e) {
      if (e instanceof ConflictError) {
        let current: FileStat | null = null;
        try {
          current = this.stat(resourceId);
        } catch {
          current = null;
        }
        return { ok: false, reason: 'conflict', current };
      }
      throw e;
    }
  }

  history(resourceId: string, limit = 50): WriteRecord[] {
    return this.svc
      .listOpsFor(resourceId, limit * 2)
      .filter((op: OpLogEntry) => op.op === 'write')
      .slice(0, limit)
      .map((op) => ({ opId: op.id, ts: op.ts, actor: op.actor, beforeHash: (op.detail.beforeHash as string) ?? null, afterHash: (op.detail.afterHash as string) ?? null, undone: op.undoneAt != null }));
  }

  undoWrite(opId: number, o: { force: boolean; actor: string }): UndoResult {
    let pv;
    try {
      pv = this.svc.previewUndo(opId);
    } catch (e) {
      return { ok: false, reason: 'nothing', detail: [String((e as Error).message)] };
    }
    const hard = pv.conflicts.filter((c) => c.includes('无法恢复') || c.includes('缺失'));
    if (hard.length) return { ok: false, reason: 'unrecoverable', detail: hard };
    if (pv.conflicts.length && !o.force) return { ok: false, reason: 'conflict', detail: pv.conflicts };
    const op = this.svc.undo(opId, pv.conflicts.length ? 'keep-both' : 'fail', o.actor);
    return { ok: true, opId: op.id, stat: this.stat(pv.resourceId) };
  }
}
