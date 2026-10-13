/**
 * 0.11 第 6 条：从资料区往外拖只能是复制。
 * Electron startDrag 只接收路径。调用方不得在拖拽结束后删除或移动这些文件。
 * 不写入 application/x-kb-resource+json，避免现有目录落点把它当成移动。
 */

export const AGENT_COPY_MIME = 'application/x-kb-agent-material+json';
export const AGENT_REORDER_MIME = 'application/x-kb-agent-reorder';

export interface CopyDragPayload {
  v: 1;
  op: 'copy';
  files: string[];
}

export interface NativeCopyDrag {
  files: string[];
  op: 'copy';
  deleteSource: false;
}

export function copyDragPayload(absPaths: readonly string[]): CopyDragPayload {
  const files: string[] = [];
  for (const absPath of absPaths) {
    if (typeof absPath === 'string' && absPath.trim()) files.push(absPath);
  }
  return { v: 1, op: 'copy', files };
}

export function nativeCopyDrag(absPaths: readonly string[]): NativeCopyDrag {
  return { files: copyDragPayload(absPaths).files, op: 'copy', deleteSource: false };
}

export function assertCopyDrag(payload: CopyDragPayload): void {
  if (payload.v !== 1 || payload.op !== 'copy') throw new Error('资料区向外拖只能是复制');
  if ('move' in payload) throw new Error('拖出载荷不能包含移动');
}

export interface CopyDragTransfer {
  effectAllowed: string;
  setData(type: string, value: string): void;
}

/** 只设置 copy。不设置 move，也不放目录拖拽用的资源 MIME。 */
export function applyCopyDrag(transfer: CopyDragTransfer, absPaths: readonly string[]): CopyDragPayload {
  const payload = copyDragPayload(absPaths);
  assertCopyDrag(payload);
  transfer.effectAllowed = 'copy';
  transfer.setData(AGENT_COPY_MIME, JSON.stringify(payload));
  const lines = payload.files.map((file) => {
    const encoded = encodeURI(file.replace(/\\/g, '/'));
    return /^[a-zA-Z]:/.test(file) ? `file:///${encoded}` : `file://${encoded}`;
  });
  if (lines.length) transfer.setData('text/uri-list', lines.join('\r\n'));
  return payload;
}

export function parseCopyDrag(raw: string): CopyDragPayload | null {
  try {
    const value = JSON.parse(raw) as CopyDragPayload;
    if (!value || value.v !== 1 || value.op !== 'copy' || !Array.isArray(value.files)) return null;
    return value;
  } catch {
    return null;
  }
}
