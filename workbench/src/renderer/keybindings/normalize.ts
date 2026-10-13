/**
 * 快捷键规范化：Ctrl+Alt+Shift+Meta+键（固定修饰符顺序）。
 * 本轮不做 chord（多段序列）；REPORT 注明。
 */
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

const ALIASES: Record<string, string> = {
  control: 'Ctrl',
  ctrl: 'Ctrl',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  win: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  esc: 'Escape',
  escape: 'Escape',
  return: 'Enter',
  enter: 'Enter',
  space: 'Space',
  ' ': 'Space',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  tab: 'Tab',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert',
  plus: '+',
  minus: '-',
};

function canonKey(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const fm = /^f([1-9]|1[0-2])$/i.exec(t);
  if (fm) return `F${fm[1]}`;
  if (t.length === 1) return t.toUpperCase();
  return t[0]!.toUpperCase() + t.slice(1);
}

/** 规范化；非法返回 null。含空格的多段 chord 本轮拒绝。 */
export function normalizeKeybinding(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  // chord：空格分隔的多段（如 "Ctrl+K Ctrl+S"）
  if (/\s/.test(s) && !/^space$/i.test(s)) return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const mods = new Set<string>();
  let key: string | null = null;
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl');
    else if (lower === 'alt' || lower === 'option') mods.add('Alt');
    else if (lower === 'shift') mods.add('Shift');
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command' || lower === 'win') mods.add('Meta');
    else {
      if (key != null) return null;
      key = canonKey(p);
    }
  }
  if (!key) return null;
  if ((MOD_ORDER as readonly string[]).includes(key) && parts.length === 1) return null;
  // Wheel 必须带 Ctrl / Alt / Meta。单独 Wheel、只有 Shift 的 Wheel 拒绝。
  if (key === 'Wheel' && !mods.has('Ctrl') && !mods.has('Alt') && !mods.has('Meta')) return null;
  const ordered = MOD_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

/** 滚轮绑定：键名以 Wheel 结尾。 */
export function isWheelBinding(key: string | null | undefined): boolean {
  return !!key && /(?:^|\+)Wheel$/.test(key);
}

/** 从滚轮事件生成绑定。没有 Ctrl/Alt/Meta 时返回 null。 */
export function bindingFromWheel(e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  if (!mods.length) return null;
  return normalizeKeybinding([...mods, 'Wheel'].join('+'));
}

/** 从 KeyboardEvent 生成规范化绑定字符串 */
export function bindingFromEvent(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  let key = e.key;
  if (key === ' ') key = 'Space';
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;
  if (key.length === 1) key = key.toUpperCase();
  if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  if (/^Key[A-Z]$/.test(e.code) && key.length === 1) key = e.code.slice(3);
  return normalizeKeybinding([...mods, key].join('+'));
}

export function matchNormalized(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
  binding: string,
): boolean {
  const want = normalizeKeybinding(binding);
  if (!want) return false;
  return bindingFromEvent(e) === want;
}

export function formatKeybinding(binding: string | null | undefined): string {
  return normalizeKeybinding(binding) ?? '';
}
