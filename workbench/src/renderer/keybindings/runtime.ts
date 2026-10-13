/**
 * 渲染进程快捷键运行时：加载/保存 KV、订阅变化、供 keydown 与设置页使用。
 */
import { acceleratorsForGlobalHook } from '../agent-live/shortcut';
import { kb } from '../kb';
import { commands } from '../plugin-host/registry';
import type { CommandContribution } from '../plugin-host/types';
import {
  KEYBINDINGS_KV,
  effectiveOf,
  emptyStore,
  exportKeybindingsJson,
  importKeybindingsJson,
  listBoundAccelerators,
  parseStore,
  resetAllKeybindings,
  resetKeybinding,
  serializeStore,
  setKeybinding,
  type SetResult,
} from './store';
import type { KeybindingWhen, KeybindingsStoreV1 } from './types';
import { detectFocusKind, resolveCommand } from './match';
import type { MatchCandidate } from './match';

type Listener = () => void;

let store: KeybindingsStoreV1 = emptyStore();
let loaded = false;
const listeners = new Set<Listener>();
let focusCommandId: string | null = null; // 设置页定位

const emit = () => listeners.forEach((l) => l());

export function getKeybindingsStore(): KeybindingsStoreV1 {
  return store;
}

export function subscribeKeybindings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function loadKeybindings(): Promise<KeybindingsStoreV1> {
  try {
    const raw = await kb.getLayout(KEYBINDINGS_KV);
    store = parseStore(raw);
  } catch {
    store = emptyStore();
  }
  loaded = true;
  emit();
  await pushBoundToMain();
  return store;
}

async function persist(next: KeybindingsStoreV1) {
  store = next;
  await kb.setLayout(KEYBINDINGS_KV, serializeStore(next));
  emit();
  await pushBoundToMain();
  // 通知（同进程内；主进程若监听 kb:keybindings-change 可由 preload 扩展）
  try {
    (kb as { emitKeybindingsChange?: () => void }).emitKeybindingsChange?.();
  } catch {
    /* optional */
  }
}

let hostedForeground = () => false;

/** 托管外部程序在前台时，全局钩子放行「加入当前阅读」。 */
export function setHostedForeground(read: () => boolean) {
  hostedForeground = read;
}

export async function pushBoundToMain() {
  const list = acceleratorsForGlobalHook(listBoundAccelerators(commands.all(), store), hostedForeground()).map((x) => x.key);
  try {
    if (typeof kb.setBoundShortcuts === 'function') await kb.setBoundShortcuts(list);
  } catch {
    /* 主进程尚未接线时忽略 */
  }
}

export function effectiveKeybinding(id: string): string | null {
  const c = commands.get(id);
  if (!c) {
    if (Object.prototype.hasOwnProperty.call(store.overrides, id)) return store.overrides[id] ?? null;
    return null;
  }
  return effectiveOf(c, store).key;
}

export async function setUserKeybinding(
  commandId: string,
  key: string | null,
  opts?: { when?: KeybindingWhen; replace?: boolean },
): Promise<SetResult> {
  const result = setKeybinding(store, commands.all(), commandId, key, opts);
  if (result.ok) await persist(result.store);
  return result;
}

export async function resetUserKeybinding(commandId: string) {
  await persist(resetKeybinding(store, commandId));
}

export async function resetAllUserKeybindings() {
  await persist(resetAllKeybindings());
}

export function exportUserKeybindings(): string {
  return exportKeybindingsJson(store);
}

export async function importUserKeybindings(text: string) {
  const next = importKeybindingsJson(text);
  await persist(next);
}

export function getFocusCommandId() {
  return focusCommandId;
}

export function setFocusCommandId(id: string | null) {
  focusCommandId = id;
  emit();
}

/** 打开设置页并可选定位到命令 */
export type OpenKeybindingsPage = (focusCommandId?: string) => void;
let openPage: OpenKeybindingsPage | null = null;
export function registerOpenKeybindingsPage(fn: OpenKeybindingsPage) {
  openPage = fn;
}
export function openKeybindingsPage(focus?: string) {
  if (focus) setFocusCommandId(focus);
  openPage?.(focus);
}

export function candidatesFromRegistry(): MatchCandidate[] {
  return commands.all().filter((c) => c.trigger !== 'wheel').map((c) => {
    const e = effectiveOf(c, store);
    return { id: c.id, key: e.key ?? '', when: e.when };
  }).filter((c) => !!c.key);
}

/** 全局 keydown 处理：返回是否已处理 */
export function handleKeydown(e: KeyboardEvent): boolean {
  if (!loaded) return false;
  const focus = detectFocusKind(e.target);
  const id = resolveCommand(e, candidatesFromRegistry(), focus);
  if (!id) return false;
  const c = commands.get(id);
  if (!c) return false;
  e.preventDefault();
  e.stopPropagation();
  void Promise.resolve(c.run()).catch((err) => console.warn('命令执行失败', id, err));
  return true;
}

/** 菜单显示用 accelerator */
export function acceleratorForMenu(commandId: string, fallback?: string): string | undefined {
  const k = effectiveKeybinding(commandId);
  if (k) return k;
  const n = fallback ? effectiveOf({ id: commandId, title: '', keybinding: fallback }, emptyStore()).key : null;
  return n ?? undefined;
}

export function commandTitle(id: string): string {
  return commands.get(id)?.title ?? id;
}

export type { CommandContribution };

/** 主进程转发的加速键 → 执行命令 */
export function runByAccelerator(accel: string): boolean {
  const n = accel;
  for (const c of candidatesFromRegistry()) {
    if (c.key === n) {
      const cmd = commands.get(c.id);
      if (!cmd) continue;
      void Promise.resolve(cmd.run()).catch((err) => console.warn('命令执行失败', c.id, err));
      return true;
    }
  }
  return false;
}
