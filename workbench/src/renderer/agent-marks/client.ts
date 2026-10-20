import type { AttentionDraft, AttentionMark } from '../../shared/agentMarks';
import { kb } from '../kb';

let marks: AttentionMark[] = [];
let loaded = false;
let inflight = false;
let watchingResets = false;
let refreshTicket = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function sameMarks(left: readonly AttentionMark[], right: readonly AttentionMark[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (a.id !== b.id || a.absPath !== b.absPath || a.startOffset !== b.startOffset || a.endOffset !== b.endOffset || a.text !== b.text) return false;
  }
  return true;
}

/**
 * 清空本轮资料时主进程会在 `session.cleared` 里按保留策略清标红，并走已有的 `kb:agent-live` 通知。
 * 通知不带事件类型，所以这里重新拉清单；内容没变就不刷新高亮。
 */
function watchRoundResets(): void {
  if (watchingResets) return;
  const listen = kb?.onAgentLiveChanged;
  if (typeof listen !== 'function') return;
  watchingResets = true;
  listen(() => {
    void refreshAgentMarks().catch(() => undefined);
  });
}

export function readAgentMarks(): AttentionMark[] {
  return marks;
}

export function subscribeAgentMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function refreshAgentMarks(): Promise<AttentionMark[]> {
  const ticket = ++refreshTicket;
  const next = await kb.agentMarksList();
  if (ticket !== refreshTicket) return marks;
  const list = Array.isArray(next) ? next : [];
  loaded = true;
  if (!sameMarks(marks, list)) {
    marks = list;
    emit();
  }
  return marks;
}

export function ensureAgentMarks(): void {
  watchRoundResets();
  if (loaded || inflight) return;
  inflight = true;
  void refreshAgentMarks().catch(() => undefined).finally(() => {
    inflight = false;
  });
}

export async function addAgentMark(draft: AttentionDraft): Promise<AttentionMark> {
  const row = await kb.agentMarksAdd(draft);
  await refreshAgentMarks();
  return row;
}

export async function unmarkAgentRange(absPath: string, start: number, end: number): Promise<void> {
  await kb.agentMarksUnmark({ absPath, start, end });
  await refreshAgentMarks();
}

export async function clearAllAgentMarks(): Promise<void> {
  await kb.agentMarksClear();
  refreshTicket += 1;
  marks = [];
  loaded = true;
  emit();
}

/** 只清这个文件的标红。后端按区间取消，区间覆盖整篇；snapshot / ENTRY 随之重发。 */
export async function clearAgentMarksForFile(absPath: string): Promise<void> {
  if (!absPath) return;
  await kb.agentMarksUnmark({ absPath, start: 0, end: Number.MAX_SAFE_INTEGER });
  await refreshAgentMarks();
}
