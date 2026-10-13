/**
 * 恢复条上要不要出现、重试能不能点。阶段机仍由 restorePhase 决定。
 * 没有失败、找不到或等待手动打开时，不占底部。
 */
import type { FileResource } from './restoreFeed';

export interface RestoreDismissed {
  [panelId: string]: string;
}

export interface RestoreBarFactsInput {
  kind: string;
  phase: string;
  reason?: string;
  retryable: boolean;
  file?: FileResource | null;
}

export interface RestoreBarFacts {
  show: boolean;
  retryable: boolean;
  retryTitle: string;
  reasonText: string;
  locate: boolean;
  remap: boolean;
  switchWorkspaceId: string;
  problemKey: string;
  callsOpen: boolean;
}

const HIDDEN: RestoreBarFacts = {
  show: false,
  retryable: false,
  retryTitle: '',
  reasonText: '',
  locate: false,
  remap: false,
  switchWorkspaceId: '',
  problemKey: '',
  callsOpen: false,
};

export interface FileRestoreInput {
  idFound: boolean;
  exists: boolean;
  outOfScope: boolean;
  rootStatus: 'ok' | 'missing' | 'absent';
  rootName: string;
  inCurrentWorkspace: boolean;
  switchTo: string | null;
  /** 资料 ID 已经对不上，但按名称或相对路径还能找到一份还在的文件。 */
  pathFound: boolean;
  /** 资料还在，但原来的路径已经空了，同名文件在别处。 */
  moved: boolean;
}

export function classifyFileResource(input: FileRestoreInput): FileResource {
  if (input.outOfScope) return { missing: true, missingReason: '被格式筛选排除' };
  if (!input.idFound && input.pathFound) return { missing: false, openFailed: true };
  if (!input.idFound) return { missing: true, missingReason: '已删除' };
  if (!input.inCurrentWorkspace) {
    return {
      missing: false,
      rootInWorkspace: false,
      rootName: input.rootName,
      ...(input.switchTo ? { switchWorkspaceId: input.switchTo } : {}),
    };
  }
  if (input.rootStatus === 'missing' || input.rootStatus === 'absent') return { missing: true, missingReason: '所在的根没挂上' };
  if (!input.exists && input.moved) return { missing: true, missingReason: '改名或搬走' };
  if (!input.exists) return { missing: true, missingReason: '已删除' };
  return { missing: false };
}

export function restoreBarFacts(input: RestoreBarFactsInput): RestoreBarFacts {
  const file = input.file ?? undefined;
  const reason = input.reason ?? '';
  if (file && file.rootInWorkspace === false) {
    const name = file.rootName?.trim() || '未命名';
    const text = `所在的根不在当前工作区：${name}`;
    return {
      show: true,
      retryable: false,
      retryTitle: text,
      reasonText: text,
      locate: false,
      remap: false,
      switchWorkspaceId: file.switchWorkspaceId ?? '',
      problemKey: `root:${name}`,
      callsOpen: false,
    };
  }
  const missing = file?.missing === true || (input.kind === 'file' && input.phase === 'failed' && reason === 'resource-missing');
  if (missing) {
    const why = file?.missingReason?.trim() || (reason === 'resource-missing' || !reason ? '已删除' : reason);
    const text = `找不到：${why}`;
    return {
      show: true,
      retryable: false,
      retryTitle: text,
      reasonText: text,
      locate: true,
      remap: true,
      switchWorkspaceId: '',
      problemKey: `missing:${why}`,
      callsOpen: false,
    };
  }
  if (input.phase === 'restored' || input.phase === 'loading' || input.phase === 'preparing' || input.phase === 'unknown') {
    if (file?.openFailed === true && file.missing !== true && input.phase !== 'restored') {
      return {
        show: true,
        retryable: true,
        retryTitle: '',
        reasonText: '',
        locate: false,
        remap: false,
        switchWorkspaceId: '',
        problemKey: 'open-failed',
        callsOpen: true,
      };
    }
    return HIDDEN;
  }
  if (input.phase === 'failed') {
    return {
      show: true,
      retryable: input.retryable,
      retryTitle: input.retryable ? '' : reason || '不能重试',
      reasonText: reason,
      locate: false,
      remap: false,
      switchWorkspaceId: '',
      problemKey: `failed:${reason}`,
      callsOpen: false,
    };
  }
  if (input.phase === 'unavailable' && reason === 'manual-open') {
    return {
      show: true,
      retryable: false,
      retryTitle: '等待手动打开',
      reasonText: '等待手动打开',
      locate: false,
      remap: false,
      switchWorkspaceId: '',
      problemKey: 'manual-open',
      callsOpen: false,
    };
  }
  return HIDDEN;
}

export function restoreRetryTarget(facts: RestoreBarFacts): 'open' | 'retry' | 'none' {
  if (!facts.show || !facts.retryable) return 'none';
  return facts.callsOpen ? 'open' : 'retry';
}

function cleanId(id: string): string | null {
  if (!id || id.length > 80) return null;
  if (/[\\/]/.test(id) || /^[A-Za-z]:/.test(id)) return null;
  return id;
}

function cleanProblem(value: string): string | null {
  if (!value || value.length > 80) return null;
  if (/[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) return null;
  return value;
}

export function readRestoreDismissed(layout: unknown): RestoreDismissed {
  if (!layout || typeof layout !== 'object') return {};
  const raw = (layout as { restoreDismissed?: unknown }).restoreDismissed;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: RestoreDismissed = {};
  for (const [key, value] of Object.entries(raw)) {
    const id = cleanId(key);
    if (!id || typeof value !== 'string') continue;
    const problem = cleanProblem(value);
    if (problem) out[id] = problem;
  }
  return out;
}

export function withRestoreDismissed<T extends { layout: object }>(stored: T, map: RestoreDismissed): T {
  const layout = { ...stored.layout } as { restoreDismissed?: RestoreDismissed };
  const next: RestoreDismissed = {};
  for (const [key, value] of Object.entries(map)) {
    const id = cleanId(key);
    const problem = typeof value === 'string' ? cleanProblem(value) : null;
    if (id && problem) next[id] = problem;
  }
  if (Object.keys(next).length === 0) delete layout.restoreDismissed;
  else layout.restoreDismissed = next;
  return { ...stored, layout: layout as T['layout'] };
}

export function dismissRestore(map: RestoreDismissed, panelId: string, problemKey: string): RestoreDismissed {
  const id = cleanId(panelId);
  const problem = cleanProblem(problemKey);
  if (!id || !problem) return map;
  return { ...map, [id]: problem };
}

export function dismissRestoreAll(map: RestoreDismissed, entries: readonly { panelId: string; problemKey: string }[]): RestoreDismissed {
  let next = map;
  for (const entry of entries) next = dismissRestore(next, entry.panelId, entry.problemKey);
  return next;
}

export function hiddenByDismiss(map: RestoreDismissed, panelId: string, problemKey: string): boolean {
  return map[panelId] === problemKey;
}
