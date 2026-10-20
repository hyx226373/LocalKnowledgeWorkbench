/**
 * 对话文件 rename 或删除之后，把标红路径改到新文件，或从列表里去掉。
 */
import fs from 'node:fs';
import type { AgentPanelChanged } from '../../shared/agentPanel';
import { markPathKey } from '../../shared/agentMarks';
import type { AgentMarkStore } from './store';

export function applyConversationFileChange(
  store: AgentMarkStore,
  event: Pick<AgentPanelChanged, 'moved' | 'removed' | 'retitled'>,
  readFile?: (abs: string) => string | null,
): void {
  const read = readFile ?? ((abs: string) => {
    try {
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  });
  const movedFrom = new Set((event.moved ?? []).map((move) => markPathKey(move.from)));
  if (event.moved?.length) {
    store.retarget(event.moved);
    for (const move of event.moved) {
      const text = read(move.to);
      if (text != null) store.relocate(move.to, text);
    }
  }
  const removed = (event.removed ?? []).filter((file) => !movedFrom.has(markPathKey(file)));
  if (removed.length) store.forget(removed);
  for (const row of event.retitled ?? []) {
    const text = read(row.path);
    if (text != null) store.relocate(row.path, text);
  }
}
