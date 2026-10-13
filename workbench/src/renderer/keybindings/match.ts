/**
 * 快捷键匹配：when 子句 + 输入框优先级（B9）。
 * input/textarea/contenteditable 内仅响应带 Ctrl/Alt/Meta 的组合键或 F 键；普通字符不触发命令。
 */
import { matchNormalized, normalizeKeybinding } from './normalize';
import type { KeybindingWhen } from './types';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (target == null) return false;
  if (typeof Element !== 'undefined' && !(target instanceof Element)) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown };
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  if (typeof el.closest === 'function' && el.closest('[contenteditable="true"]')) return true;
  return false;
}

/** 在可编辑焦点下，该事件是否允许触发命令 */
export function allowInEditable(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey'>): boolean {
  if (e.ctrlKey || e.altKey || e.metaKey) return true;
  if (/^F([1-9]|1[0-2])$/i.test(e.key)) return true;
  return false;
}

export type FocusKind = 'editor' | 'tree' | 'web' | 'other';

export function detectFocusKind(target: EventTarget | null, activeElement?: Element | null): FocusKind {
  const el = (target instanceof Element ? target : null) ?? activeElement ?? (typeof document !== 'undefined' ? document.activeElement : null);
  if (!el) return 'other';
  if (el.closest?.('[data-testid="editor-text"], .kb-editor-text, .kb-editor')) return 'editor';
  if (el.closest?.('[data-testid="sidebar"], .kb-sidebar, [data-testid="tree-row"]')) return 'tree';
  if (el.closest?.('[data-testid="web-surface"], .kb-web-surface, webview')) return 'web';
  return 'other';
}

export function whenMatches(when: KeybindingWhen, focus: FocusKind): boolean {
  if (when === 'global') return true;
  if (when === 'editorFocus') return focus === 'editor';
  if (when === 'treeFocus') return focus === 'tree';
  if (when === 'webFocus') return focus === 'web';
  return true;
}

export interface MatchCandidate {
  id: string;
  key: string;
  when: KeybindingWhen;
}

/** 从候选中找出应触发的命令（先更具体的 when，再注册顺序） */
export function resolveCommand(
  e: KeyboardEvent,
  candidates: MatchCandidate[],
  focus: FocusKind,
): string | null {
  if (isEditableTarget(e.target) && !allowInEditable(e)) return null;
  const matched: MatchCandidate[] = [];
  for (const c of candidates) {
    if (!c.key) continue;
    if (!matchNormalized(e, c.key)) continue;
    if (!whenMatches(c.when, focus)) continue;
    matched.push(c);
  }
  if (!matched.length) return null;
  // 非 global 优先于 global
  matched.sort((a, b) => {
    const sa = a.when === 'global' ? 1 : 0;
    const sb = b.when === 'global' ? 1 : 0;
    return sa - sb;
  });
  return matched[0]!.id;
}

/** 旧 matchKey 兼容：仅比较绑定字符串 */
export function matchKey(e: KeyboardEvent, binding: string): boolean {
  const n = normalizeKeybinding(binding);
  return !!n && matchNormalized(e, n);
}
