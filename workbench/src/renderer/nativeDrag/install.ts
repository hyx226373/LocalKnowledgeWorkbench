import { kb } from '../kb';
import { clearNativeDragSession, noteNativeDragDrop, noteNativeDragEnd } from './session';

let installed = false;

/**
 * 监听原生拖动结束。不在离窗时交接：那时 Chromium 自己的拖放已经开始，再 startDrag 会嵌套并卡死主进程。
 * dragend 的第一次（preventDefault 取消 HTML5 时）由会话自己忽略。
 */
export function installNativeDragSession(): () => void {
  if (installed || typeof window === 'undefined') return () => undefined;
  installed = true;
  const onEnd = () => noteNativeDragEnd();
  const onDrop = () => noteNativeDragDrop();
  window.addEventListener('dragend', onEnd, true);
  window.addEventListener('drop', onDrop, true);
  let offIpc: () => void = () => undefined;
  try {
    if (typeof kb?.onNativeDragEnded === 'function') offIpc = kb.onNativeDragEnded(() => clearNativeDragSession());
  } catch { /* 测试里没有预加载 */ }
  return () => {
    window.removeEventListener('dragend', onEnd, true);
    window.removeEventListener('drop', onDrop, true);
    offIpc();
    installed = false;
    clearNativeDragSession();
  };
}
