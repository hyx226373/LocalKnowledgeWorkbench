import type { LiveEvent } from '../../../shared/agentLive/types';

const KEYS = [
  'rev',
  'ts',
  'type',
  'workspaceId',
  'materialId',
  'resourceId',
  'sourceId',
  'relPath',
  'absPath',
  'order',
  'purpose',
  'contentHash',
  'prevContentHash',
  'content',
  'diff',
  'diffSupported',
  'prevAbsPath',
  'prevRelPath',
  'panelId',
  'fromWorkspaceId',
  'toWorkspaceId',
  'toRevision',
  'snapshotRevision',
  'tier',
  'materialIds',
] as const;

/** 只写出冻结字段。size、mtimeMs、workspaceName 不进 jsonl。diffSupported 仅在 false 时写出。 */
export function projectEvent(event: LiveEvent, rev: number, ts: string): string {
  const out: Record<string, unknown> = {};
  const source = event as unknown as Record<string, unknown>;
  for (const key of KEYS) {
    if (key === 'rev') {
      out.rev = rev;
      continue;
    }
    if (key === 'ts') {
      out.ts = event.ts ?? ts;
      continue;
    }
    if (key === 'diffSupported') {
      if (event.diffSupported === false) out.diffSupported = false;
      continue;
    }
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }
  return JSON.stringify(out);
}
