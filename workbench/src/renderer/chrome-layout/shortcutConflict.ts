/**
 * 快捷键冲突检测（03）：冲突必须明确报告，保留已有用户绑定，永不静默覆盖。
 */
import type { ShortcutConflictReport } from '../../shared/chromeLayout';

export type BindingSource = 'user' | 'builtin' | 'plugin' | 'unknown';

export interface ShortcutBinding {
  key: string;
  commandId: string;
  source?: BindingSource;
}

export interface ShortcutRegistry {
  /** 当前已注册绑定（只读查询） */
  list(): ShortcutBinding[];
  /** 注册；若冲突且已有绑定则拒绝并返回报告（不覆盖） */
  tryRegister(binding: ShortcutBinding): ShortcutConflictReport;
  /** 移除某键绑定（改键时释放旧键） */
  removeBinding(key: string): void;
  /** 按 commandId 移除所有绑定 */
  removeByCommandId(commandId: string): void;
}

type Listener = (report: ShortcutConflictReport) => void;

export function normalizeShortcutKey(key: string): string {
  return key
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const low = p.toLowerCase();
      if (low === 'control' || low === 'ctrl') return 'Ctrl';
      if (low === 'cmd' || low === 'meta' || low === 'command') return 'Meta';
      if (low === 'option' || low === 'alt') return 'Alt';
      if (low === 'shift') return 'Shift';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join('+');
}

export function createShortcutRegistry(
  initial: ShortcutBinding[] = [],
): ShortcutRegistry & {
  onConflict(fn: Listener): () => void;
  reports: ShortcutConflictReport[];
} {
  const map = new Map<string, ShortcutBinding>();
  for (const b of initial) {
    map.set(normalizeShortcutKey(b.key), { ...b, key: normalizeShortcutKey(b.key) });
  }
  const listeners = new Set<Listener>();
  const reports: ShortcutConflictReport[] = [];

  const emit = (r: ShortcutConflictReport) => {
    reports.push(r);
    for (const fn of listeners) fn(r);
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[chrome-layout] shortcut conflict:', r.message);
      }
    } catch {
      /* */
    }
  };

  return {
    reports,
    onConflict(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    list() {
      return [...map.values()].map((b) => ({ ...b }));
    },
    removeBinding(key) {
      map.delete(normalizeShortcutKey(key));
    },
    removeByCommandId(commandId) {
      for (const [k, b] of [...map.entries()]) {
        if (b.commandId === commandId) map.delete(k);
      }
    },
    tryRegister(binding) {
      const key = normalizeShortcutKey(binding.key);
      const existing = map.get(key);
      if (existing && existing.commandId !== binding.commandId) {
        const report: ShortcutConflictReport = {
          key,
          intendedCommandId: binding.commandId,
          existingBinding: { commandId: existing.commandId, source: existing.source },
          conflict: true,
          message: `快捷键 ${key} 已被「${existing.commandId}」占用；保留已有绑定，不覆盖为「${binding.commandId}」`,
        };
        emit(report);
        return report;
      }
      if (!existing) {
        map.set(key, { ...binding, key });
      }
      return {
        key,
        intendedCommandId: binding.commandId,
        existingBinding: existing ? { commandId: existing.commandId, source: existing.source } : null,
        conflict: false,
        message: existing ? `已绑定 ${key} → ${existing.commandId}` : `已注册 ${key} → ${binding.commandId}`,
      };
    },
  };
}
