/**
 * 保留键（§5.5）：不可改绑；设置页显示「保留」；录制到则拒绝。
 * Alt+F4、F11、编辑器 Ctrl+C/V/X/Z/Y/A、Ctrl+S。
 */
import { normalizeKeybinding } from './normalize';

export interface ReservedKey {
  key: string;
  reason: string;
}

export const RESERVED_KEYS: ReservedKey[] = [
  { key: 'Alt+F4', reason: '关闭窗口（系统）' },
  { key: 'F11', reason: '全屏（系统）' },
  { key: 'Ctrl+C', reason: '编辑器复制' },
  { key: 'Ctrl+V', reason: '编辑器粘贴' },
  { key: 'Ctrl+X', reason: '编辑器剪切' },
  { key: 'Ctrl+Z', reason: '编辑器撤销' },
  { key: 'Ctrl+Y', reason: '编辑器重做' },
  { key: 'Ctrl+A', reason: '编辑器全选' },
  { key: 'Ctrl+S', reason: '编辑器保存' },
];

const RESERVED_SET = new Set(RESERVED_KEYS.map((r) => normalizeKeybinding(r.key)!));

export function isReservedKey(binding: string | null | undefined): ReservedKey | null {
  const n = normalizeKeybinding(binding);
  if (!n) return null;
  if (!RESERVED_SET.has(n)) return null;
  return RESERVED_KEYS.find((r) => normalizeKeybinding(r.key) === n) ?? { key: n, reason: '系统保留' };
}

export function reservedKeySet(): Set<string> {
  return new Set(RESERVED_SET);
}
