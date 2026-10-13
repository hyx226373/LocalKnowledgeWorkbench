/**
 * 网页面板 / 子 webContents：只把「已绑定」的组合键转发给主窗口渲染进程执行命令。
 * 独立函数，便于 A 合入 webPanels 时保留（总包 §3.2）。
 *
 * 不注册 globalShortcut。
 */
import type { WebContents } from 'electron';

export type BoundShortcutLookup = () => ReadonlySet<string> | readonly string[];

/** 把 before-input-event 规范化为与渲染进程一致的 Ctrl+Alt+Shift+Meta+Key */
export function acceleratorFromInput(input: {
  key: string;
  code: string;
  control: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(input.key)) return null;
  const mods: string[] = [];
  if (input.control) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Meta');
  let key = input.key;
  if (key === ' ') key = 'Space';
  if (key.length === 1) key = key.toUpperCase();
  if (/^Digit[0-9]$/.test(input.code)) key = input.code.slice(5);
  if (/^Key[A-Z]$/.test(input.code) && key.length === 1) key = input.code.slice(3);
  if (/^F([1-9]|1[0-2])$/i.test(key)) key = key.toUpperCase();
  // 固定修饰符顺序
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
  const ordered = order.filter((m) => mods.includes(m));
  return [...ordered, key].join('+');
}

/**
 * 在 webContents 上监听 before-input-event：若按键属于已绑定集合，则 preventDefault 并回调。
 * @returns dispose
 */
export function forwardBoundShortcuts(
  wc: WebContents,
  getBound: BoundShortcutLookup,
  onMatch: (accelerator: string, input: Electron.Input) => void,
): () => void {
  const handler = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown') return;
    const accel = acceleratorFromInput(input);
    if (!accel) return;
    const bound = getBound();
    const set = bound instanceof Set ? bound : new Set(bound);
    if (!set.has(accel)) return;
    event.preventDefault();
    onMatch(accel, input);
  };
  wc.on('before-input-event', handler);
  return () => {
    try {
      wc.removeListener('before-input-event', handler);
    } catch {
      /* destroyed */
    }
  };
}
