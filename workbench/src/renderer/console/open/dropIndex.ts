/**
 * 把拖进来的资料追加进控制台索引文本。只改定义，不表示磁盘移动。
 */
import {
  executableIndex,
  indexItemFromDrag,
  nextItemOrder,
  parseConsoleDocument,
  withIndexItems,
  type ConsoleIndexItem,
  type ResourceDragItem,
} from '../../../shared/consoleSchema';

export function appendDragToIndex(
  text: string,
  drags: readonly ResourceDragItem[],
  titleOf: (drag: ResourceDragItem) => string,
  newId: () => string,
): { ok: true; text: string; added: number } | { ok: false; error: string } {
  const parsed = parseConsoleDocument(text);
  const index = executableIndex(parsed);
  if (!index) return { ok: false, error: parsed.primary?.error || '没有可写回的控制台索引' };
  let order = nextItemOrder(index.items);
  const add: ConsoleIndexItem[] = [];
  for (const drag of drags) {
    add.push(indexItemFromDrag(drag, titleOf(drag), order, newId()));
    order += 1;
  }
  const next = withIndexItems(text, add);
  if (!next.ok) return next;
  return { ok: true, text: next.text, added: add.length };
}
