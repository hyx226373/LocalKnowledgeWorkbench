/**
 * 把控制台草稿写成普通文件，再走 WorkbenchService.resourceIdFor 入库。
 * 不自己写 SQLite 表。已存在的文件不覆盖（改已有控制台走 textSave / 索引写回）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildConsoleDraft, type ConsoleDraftInput } from '../../shared/consoleSchema';
import { normalizeRelPath, resolveInRoot } from '../service/paths';
import type { WorkbenchService } from '../service/WorkbenchService';

export interface ConsoleDraftWriteRequest extends ConsoleDraftInput {
  rootId: string;
  /** 根相对路径，须以 .md 结尾 */
  relPath: string;
}

export interface ConsoleDraftWritten {
  resourceId: string;
  relPath: string;
  bytes: number;
  text: string;
}

export function writeConsoleDraft(svc: WorkbenchService, req: ConsoleDraftWriteRequest): ConsoleDraftWritten {
  const root = svc.listRoots().find((r) => r.id === req.rootId);
  if (!root) throw new Error('根目录不存在');
  const rel = normalizeRelPath(req.relPath);
  if (!rel.toLowerCase().endsWith('.md')) throw new Error('控制台草稿必须是 .md 文件');
  const text = buildConsoleDraft(req);
  const abs = resolveInRoot(root.path, rel);
  if (fs.existsSync(abs)) throw new Error('文件已存在，不覆盖');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text, 'utf8');
  const resourceId = svc.resourceIdFor(req.rootId, rel);
  return { resourceId, relPath: rel, bytes: Buffer.byteLength(text), text };
}
