/**
 * Workspace chrome 持久化：仅 visibility + layout。
 * 禁止 contentOnly / editMode / hwnd / pid / preContentOnlySnapshot（默认）。
 */
import type {
  ChromeComponentId,
  ChromeComponentMeta,
  ChromeLayoutSize,
  ChromeVisibilityMap,
  PreContentOnlySnapshotPersisted,
  WorkspaceChromePersisted,
} from '../../shared/chromeLayout';
import {
  CHROME_FORBIDDEN_PERSIST_KEYS,
  PRE_CONTENT_ONLY_SNAPSHOT_SCHEMA,
} from '../../shared/chromeLayout';
import { createChromeRegistry, defaultVisibilityMap } from './registry';

export interface ChromePersistStore {
  read(): WorkspaceChromePersisted | null;
  write(data: WorkspaceChromePersisted): void;
}

/** 内存实现（单测 / 无 workspace 时） */
export function createMemoryPersistStore(
  initial?: WorkspaceChromePersisted | null,
): ChromePersistStore & { raw: WorkspaceChromePersisted | null } {
  const store = { raw: initial ?? null };
  return {
    get raw() {
      return store.raw;
    },
    set raw(v: WorkspaceChromePersisted | null) {
      store.raw = v;
    },
    read() {
      return store.raw ? structuredClone(store.raw) : null;
    },
    write(data) {
      store.raw = sanitizeChromePersist(data);
    },
  };
}

/** 从任意 JSON 读入；缺省按 defaultVisible；剔除禁止字段 */
export function loadChromePersist(
  raw: unknown,
  registry: ChromeComponentMeta[] = createChromeRegistry(),
): WorkspaceChromePersisted {
  const defaults = defaultVisibilityMap(registry);
  if (!raw || typeof raw !== 'object') {
    return { visibility: { ...defaults }, layout: {} };
  }
  const obj = raw as Record<string, unknown>;
  const chrome = (obj.chrome && typeof obj.chrome === 'object' ? obj.chrome : obj) as Record<
    string,
    unknown
  >;

  const visIn =
    chrome.visibility && typeof chrome.visibility === 'object'
      ? (chrome.visibility as ChromeVisibilityMap)
      : {};
  const visibility: ChromeVisibilityMap = { ...defaults };
  for (const m of registry) {
    if (!m.present) continue;
    if (typeof visIn[m.id] === 'boolean') visibility[m.id] = visIn[m.id];
  }

  const layout: Partial<Record<ChromeComponentId, ChromeLayoutSize>> = {};
  const layIn =
    chrome.layout && typeof chrome.layout === 'object'
      ? (chrome.layout as Record<string, ChromeLayoutSize>)
      : {};
  for (const [k, v] of Object.entries(layIn)) {
    if (!v || typeof v !== 'object') continue;
    const size: ChromeLayoutSize = {};
    if (typeof v.width === 'number') size.width = v.width;
    if (typeof v.height === 'number') size.height = v.height;
    if (size.width !== undefined || size.height !== undefined) {
      layout[k as ChromeComponentId] = size;
    }
  }

  let preContentOnlySnapshot: WorkspaceChromePersisted['preContentOnlySnapshot'];
  if ('preContentOnlySnapshot' in chrome) {
    if (chrome.preContentOnlySnapshot === null) preContentOnlySnapshot = null;
    else {
      const snap = validatePreContentOnlySnapshot(chrome.preContentOnlySnapshot);
      preContentOnlySnapshot = snap; // null if corrupt — caller may restoreBaseUI
    }
  }
  return sanitizeChromePersist({ visibility, layout, preContentOnlySnapshot });
}

/** 写出前剔除禁止字段；不写 contentOnly/editMode/hwnd/pid */
function sanitizeLayoutMap(
  layIn: unknown,
): Partial<Record<ChromeComponentId, ChromeLayoutSize>> {
  const layout: Partial<Record<ChromeComponentId, ChromeLayoutSize>> = {};
  if (!layIn || typeof layIn !== 'object') return layout;
  for (const [k, v] of Object.entries(layIn as Record<string, ChromeLayoutSize>)) {
    if (!v || typeof v !== 'object') continue;
    const size: ChromeLayoutSize = {};
    if (typeof v.width === 'number') size.width = v.width;
    if (typeof v.height === 'number') size.height = v.height;
    if (size.width !== undefined || size.height !== undefined) {
      layout[k as ChromeComponentId] = size;
    }
  }
  return layout;
}

function sanitizeVisibilityMap(visIn: unknown): ChromeVisibilityMap {
  const visibility: ChromeVisibilityMap = {};
  if (!visIn || typeof visIn !== 'object') return visibility;
  for (const [k, v] of Object.entries(visIn as Record<string, unknown>)) {
    if (typeof v === 'boolean') visibility[k as ChromeComponentId] = v;
  }
  return visibility;
}

/**
 * 校验只看内容快照。损坏返回 null（调用方走 restoreBaseUI）。
 * 允许字段：schema + visibility + layout；拒绝 hwnd/凭据/输入控制。
 */
export function validatePreContentOnlySnapshot(raw: unknown): PreContentOnlySnapshotPersisted | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  for (const k of CHROME_FORBIDDEN_PERSIST_KEYS) {
    if (k in obj) return null;
  }
  if (obj.schema !== PRE_CONTENT_ONLY_SNAPSHOT_SCHEMA && obj.schema !== 1) return null;
  if (!obj.visibility || typeof obj.visibility !== 'object') return null;
  const visibility = sanitizeVisibilityMap(obj.visibility);
  if (Object.keys(visibility).length === 0) return null;
  const layout = sanitizeLayoutMap(obj.layout);
  const out: PreContentOnlySnapshotPersisted = { schema: 1, visibility };
  if (Object.keys(layout).length) out.layout = layout;
  // 再次确保无禁止键
  const json = JSON.stringify(out);
  if (/"hwnd"|"pid"|"credentials"|"inputControl"|"contentOnly"|"editMode"/.test(json)) return null;
  return out;
}

export function sanitizeChromePersist(data: WorkspaceChromePersisted): WorkspaceChromePersisted {
  const visibility = sanitizeVisibilityMap(data.visibility);
  const layout = sanitizeLayoutMap(data.layout);
  const out: WorkspaceChromePersisted = { visibility };
  if (Object.keys(layout).length) out.layout = layout;

  if ('preContentOnlySnapshot' in data) {
    if (data.preContentOnlySnapshot === null) {
      out.preContentOnlySnapshot = null;
    } else {
      const snap = validatePreContentOnlySnapshot(data.preContentOnlySnapshot);
      if (snap) out.preContentOnlySnapshot = snap;
      // corrupt → 省略字段（不写入损坏数据）
    }
  }

  for (const k of CHROME_FORBIDDEN_PERSIST_KEYS) {
    if (k in (out as object)) {
      delete (out as unknown as Record<string, unknown>)[k];
    }
  }
  return out;
}

/** 断言序列化结果不含禁止键（含嵌套） */
export function assertNoForbiddenPersistKeys(serialized: unknown): void {
  const json = JSON.stringify(serialized);
  for (const k of CHROME_FORBIDDEN_PERSIST_KEYS) {
    // 宽松：键名作为 JSON key 出现则失败
    if (json.includes(`"${k}"`)) {
      throw new Error(`chrome persist must not contain "${k}"`);
    }
  }
  if (json.includes('"hwnd"') || /"pid"\s*:/.test(json)) {
    throw new Error('chrome persist must not contain hwnd/pid');
  }
}
