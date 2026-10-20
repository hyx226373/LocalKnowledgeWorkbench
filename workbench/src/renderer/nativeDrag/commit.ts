import { getSidebarPrefs, type DragOutMode } from '../drawer/sidebarPrefs';
import { toDragPayload } from '../dnd/bridge';
import { getDragPayload, type KbDragPayload } from '../dir-view/dnd';
import { beginFileDrag, nativeFileDragAvailable, writePathDrag, type DragStartEvent } from './start';

/**
 * 目录树节点（文件、根目录、子文件夹）和工作台资料条目。
 * 文件模式且预加载可用：dragstart 里先 preventDefault，再立刻异步 startDrag，不写 dataTransfer。
 * 没有可拖路径或还没有原生通道时，走原来的 HTML5。
 * 路径模式只追加 text/plain。拖回本窗口时用会话里的应用内载荷，文件夹仍是目录条目。
 */
export function commitTreeFileDrag(
  event: DragStartEvent,
  seed: KbDragPayload,
  paths: readonly string[],
  writeInApp: () => void,
  mode: DragOutMode = getSidebarPrefs().dragOutMode,
): 'file' | 'path' | 'html5' {
  const payload = getDragPayload(seed);
  if (mode !== 'path' && nativeFileDragAvailable()) {
    if (beginFileDrag(event, paths, { kb: toDragPayload(payload) })) return 'file';
  }
  writeInApp();
  if (mode === 'path') {
    writePathDrag(event.dataTransfer, paths);
    return 'path';
  }
  return 'html5';
}
