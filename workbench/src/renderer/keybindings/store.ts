/**
 * 快捷键 overrides 注册表：KV `settings.keybindings` = { v:1, overrides }。
 * API：effectiveKeybinding / set / reset / resetAll / conflicts。
 */
import type { CommandContribution } from '../plugin-host/types';
import { isWheelBinding, normalizeKeybinding } from './normalize';
import { isReservedKey } from './reserved';
import type { CommandKeyInfo, EffectiveBinding, KeybindingWhen, KeybindingsStoreV1 } from './types';

export const KEYBINDINGS_KV = 'settings.keybindings';

export function emptyStore(): KeybindingsStoreV1 {
  return { v: 1, overrides: {}, whenOverrides: {} };
}

export function parseStore(raw: unknown): KeybindingsStoreV1 {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return emptyStore();
  const overrides: Record<string, string | null> = {};
  if (o.overrides && typeof o.overrides === 'object') {
    for (const [id, v] of Object.entries(o.overrides as Record<string, unknown>)) {
      if (v === null) overrides[id] = null;
      else if (typeof v === 'string') {
        const n = normalizeKeybinding(v);
        overrides[id] = n;
      }
    }
  }
  const whenOverrides: Record<string, KeybindingWhen> = {};
  if (o.whenOverrides && typeof o.whenOverrides === 'object') {
    for (const [id, v] of Object.entries(o.whenOverrides as Record<string, unknown>)) {
      if (v === 'global' || v === 'editorFocus' || v === 'treeFocus' || v === 'webFocus') whenOverrides[id] = v;
    }
  }
  return { v: 1, overrides, whenOverrides };
}

export function serializeStore(s: KeybindingsStoreV1): KeybindingsStoreV1 {
  return {
    v: 1,
    overrides: { ...s.overrides },
    whenOverrides: s.whenOverrides && Object.keys(s.whenOverrides).length ? { ...s.whenOverrides } : undefined,
  };
}

type CmdLike = Pick<CommandContribution, 'id' | 'title' | 'category' | 'keybinding' | 'when' | 'trigger'> & { owner?: string };

export function effectiveOf(cmd: CmdLike, store: KeybindingsStoreV1): EffectiveBinding {
  const def = normalizeKeybinding(cmd.keybinding);
  const has = Object.prototype.hasOwnProperty.call(store.overrides, cmd.id);
  let key: string | null;
  let isCleared = false;
  let isDefault = true;
  if (has) {
    key = store.overrides[cmd.id] ?? null;
    isCleared = store.overrides[cmd.id] === null;
    isDefault = false;
  } else {
    key = def;
  }
  const when: KeybindingWhen = store.whenOverrides?.[cmd.id] ?? cmd.when ?? 'global';
  return { commandId: cmd.id, key, when, isDefault, isCleared };
}

export function effectiveKeybinding(cmd: CmdLike, store: KeybindingsStoreV1): string | null {
  return effectiveOf(cmd, store).key;
}

/** 同一规范化键被多个命令占用（按 when 分区：同 when 才冲突；global 与任意 when 冲突） */
export function conflicts(
  store: KeybindingsStoreV1,
  commands: CmdLike[],
  candidate?: { commandId: string; key: string | null; when?: KeybindingWhen },
): { key: string; commandIds: string[] }[] {
  const map = new Map<string, string[]>(); // `${when}::${key}` → ids
  const add = (id: string, key: string | null, when: KeybindingWhen) => {
    if (!key) return;
    const k = `${when}::${key}`;
    const list = map.get(k) ?? [];
    list.push(id);
    map.set(k, list);
  };
  for (const c of commands) {
    if (candidate && c.id === candidate.commandId) continue;
    const e = effectiveOf(c, store);
    add(c.id, e.key, e.when);
  }
  if (candidate?.key) {
    add(candidate.commandId, candidate.key, candidate.when ?? 'global');
  }
  const out: { key: string; commandIds: string[] }[] = [];
  // 同 when 冲突
  for (const [k, ids] of map) {
    if (ids.length < 2) continue;
    const key = k.slice(k.indexOf('::') + 2);
    out.push({ key, commandIds: [...new Set(ids)] });
  }
  // global 与其它 when 的同键也算冲突
  const byKey = new Map<string, { id: string; when: KeybindingWhen }[]>();
  for (const c of commands) {
    const e =
      candidate && c.id === candidate.commandId
        ? { key: candidate.key, when: candidate.when ?? 'global', commandId: c.id }
        : effectiveOf(c, store);
    if (!e.key) continue;
    const list = byKey.get(e.key) ?? [];
    list.push({ id: c.id, when: 'when' in e && e.when ? (e.when as KeybindingWhen) : (candidate?.when ?? 'global') });
    // fix: use proper when
  }
  // 重算 byKey
  byKey.clear();
  for (const c of commands) {
    let key: string | null;
    let when: KeybindingWhen;
    if (candidate && c.id === candidate.commandId) {
      key = candidate.key;
      when = candidate.when ?? 'global';
    } else {
      const e = effectiveOf(c, store);
      key = e.key;
      when = e.when;
    }
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push({ id: c.id, when });
    byKey.set(key, list);
  }
  const seen = new Set(out.map((o) => o.commandIds.slice().sort().join(',')));
  for (const [key, entries] of byKey) {
    const ids = [...new Set(entries.map((e) => e.id))];
    if (ids.length < 2) continue;
    const hasGlobal = entries.some((e) => e.when === 'global');
    const whens = new Set(entries.map((e) => e.when));
    const sameWhenClash = [...whens].some((w) => entries.filter((e) => e.when === w).length > 1);
    if (hasGlobal || sameWhenClash || whens.size > 1) {
      // 不同 when 且都非 global：允许共存（如 editorFocus vs treeFocus）
      if (!hasGlobal && !sameWhenClash) continue;
      const sig = ids.slice().sort().join(',');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({ key, commandIds: ids });
    }
  }
  return out;
}

/** 查找占用某键的命令（排除自身） */
export function findConflict(
  store: KeybindingsStoreV1,
  commands: CmdLike[],
  commandId: string,
  key: string,
  when: KeybindingWhen = 'global',
): CmdLike | null {
  const n = normalizeKeybinding(key);
  if (!n) return null;
  const wheel = isWheelBinding(n);
  for (const c of commands) {
    if (c.id === commandId) continue;
    const e = effectiveOf(c, store);
    if (e.key !== n) continue;
    // 滚轮只和滚轮冲突，键盘只和键盘冲突。
    if (isWheelBinding(e.key) !== wheel) continue;
    if (e.when === when || e.when === 'global' || when === 'global') return c;
  }
  return null;
}

export type SetResult =
  | { ok: true; store: KeybindingsStoreV1 }
  | { ok: false; reason: 'reserved'; reserved: NonNullable<ReturnType<typeof isReservedKey>> }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'conflict'; otherId: string; otherTitle: string };

export function setKeybinding(
  store: KeybindingsStoreV1,
  commands: CmdLike[],
  commandId: string,
  key: string | null,
  opts?: { when?: KeybindingWhen; replace?: boolean },
): SetResult {
  const next: KeybindingsStoreV1 = {
    v: 1,
    overrides: { ...store.overrides },
    whenOverrides: { ...(store.whenOverrides ?? {}) },
  };
  if (key === null) {
    next.overrides[commandId] = null;
  } else {
    const n = normalizeKeybinding(key);
    if (!n) return { ok: false, reason: 'invalid' };
    const reserved = isReservedKey(n);
    if (reserved) return { ok: false, reason: 'reserved', reserved };
    const when = opts?.when ?? effectiveOf({ id: commandId, title: '' }, store).when;
    // 若命令存在，用其 when
    const cmd = commands.find((c) => c.id === commandId);
    const useWhen = opts?.when ?? next.whenOverrides?.[commandId] ?? cmd?.when ?? 'global';
    const other = findConflict(store, commands, commandId, n, useWhen);
    if (other && !opts?.replace) {
      return { ok: false, reason: 'conflict', otherId: other.id, otherTitle: other.title };
    }
    if (other && opts?.replace) {
      next.overrides[other.id] = null;
    }
    next.overrides[commandId] = n;
    void when;
  }
  if (opts?.when) next.whenOverrides![commandId] = opts.when;
  if (next.whenOverrides && !Object.keys(next.whenOverrides).length) delete next.whenOverrides;
  return { ok: true, store: next };
}

export function resetKeybinding(store: KeybindingsStoreV1, commandId: string): KeybindingsStoreV1 {
  const overrides = { ...store.overrides };
  delete overrides[commandId];
  const whenOverrides = { ...(store.whenOverrides ?? {}) };
  delete whenOverrides[commandId];
  return {
    v: 1,
    overrides,
    whenOverrides: Object.keys(whenOverrides).length ? whenOverrides : undefined,
  };
}

export function resetAllKeybindings(): KeybindingsStoreV1 {
  return emptyStore();
}

export function toCommandInfos(
  commands: CmdLike[],
  store: KeybindingsStoreV1,
  orphanOverrides?: string[],
): CommandKeyInfo[] {
  const list: CommandKeyInfo[] = commands.map((c) => ({
    id: c.id,
    title: c.title,
    category: c.category,
    defaultKeybinding: normalizeKeybinding(c.keybinding) ?? undefined,
    defaultWhen: c.when ?? 'global',
    owner: c.owner,
  }));
  if (orphanOverrides) {
    for (const id of orphanOverrides) {
      if (list.some((x) => x.id === id)) continue;
      list.push({
        id,
        title: id,
        category: '插件',
        defaultKeybinding: undefined,
        missingPlugin: true,
        owner: 'missing',
      });
    }
  }
  // 带上 store 里的 orphan
  for (const id of Object.keys(store.overrides)) {
    if (list.some((x) => x.id === id)) continue;
    list.push({
      id,
      title: id,
      category: '插件',
      missingPlugin: true,
      owner: 'missing',
    });
  }
  return list;
}

/** 备份/导出 JSON（与导入同格式） */
export function exportKeybindingsJson(store: KeybindingsStoreV1): string {
  return JSON.stringify(serializeStore(store), null, 2);
}

export function importKeybindingsJson(text: string): KeybindingsStoreV1 {
  const raw = JSON.parse(text) as unknown;
  return parseStore(raw);
}

/** 所有当前生效的绑定（供主进程转发） */
export function listBoundAccelerators(commands: CmdLike[], store: KeybindingsStoreV1): { commandId: string; key: string; when: KeybindingWhen }[] {
  const out: { commandId: string; key: string; when: KeybindingWhen }[] = [];
  for (const c of commands) {
    if (c.trigger === 'wheel') continue;
    const e = effectiveOf(c, store);
    if (e.key && !isWheelBinding(e.key)) out.push({ commandId: c.id, key: e.key, when: e.when });
  }
  return out;
}
