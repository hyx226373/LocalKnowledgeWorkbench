/**
 * GAP-L2：工作区 chrome 持久化适配器
 * 只读写 chrome.visibility + chrome.layout；永不写 hwnd/pid/contentOnly/editMode。
 *
 * 接线：优先用既有 `kb.getLayout` / `kb.setLayout`（renderer 已暴露，无需改 main/preload）。
 * 键：`workspace.chrome.<wsId>`；无 kb 时回退 localStorage / 内存。
 */
import type { WorkspaceChromePersisted } from '../../shared/chromeLayout';
import {
  assertNoForbiddenPersistKeys,
  createMemoryPersistStore,
  sanitizeChromePersist,
  type ChromePersistStore,
} from './persistence';

export interface WorkspaceChromePersistAdapter extends ChromePersistStore {
  readonly kind: 'memory' | 'kb-layout' | 'localStorage';
  /** 异步从后端拉取并刷新缓存（kb-layout） */
  loadAsync?(): Promise<WorkspaceChromePersisted | null>;
}

type KbLayoutApi = {
  getLayout(key: string): Promise<unknown>;
  setLayout(key: string, value: unknown): Promise<void>;
};

export function chromeLayoutKey(wsId: string): string {
  return `workspace.chrome.${wsId}`;
}

const cache = new Map<string, WorkspaceChromePersisted>();

export function clearChromePersistCache() {
  cache.clear();
}

/** 基于既有 kb.getLayout/setLayout 的适配器（推荐产品路径） */
export function createKbChromePersistAdapter(
  kb: KbLayoutApi,
  getWsId: () => string | null | undefined,
): WorkspaceChromePersistAdapter {
  return {
    kind: 'kb-layout',
    read() {
      const id = getWsId();
      if (!id) return null;
      return cache.get(id) ?? null;
    },
    write(data) {
      const id = getWsId();
      if (!id) return;
      const clean = sanitizeChromePersist(data);
      assertNoForbiddenPersistKeys(clean);
      cache.set(id, clean);
      void kb.setLayout(chromeLayoutKey(id), clean);
    },
    async loadAsync() {
      const id = getWsId();
      if (!id) return null;
      try {
        const raw = await kb.getLayout(chromeLayoutKey(id));
        if (!raw || typeof raw !== 'object') {
          cache.delete(id);
          return null;
        }
        const clean = sanitizeChromePersist(raw as WorkspaceChromePersisted);
        assertNoForbiddenPersistKeys(clean);
        cache.set(id, clean);
        return clean;
      } catch {
        return null;
      }
    },
  };
}

/** localStorage 回退（无 kb 时） */
export function createLocalStorageChromePersistAdapter(
  storageKey = 'kb.chrome.workspace',
): WorkspaceChromePersistAdapter {
  const hasLS =
    typeof localStorage !== 'undefined' &&
    typeof localStorage.getItem === 'function' &&
    typeof localStorage.setItem === 'function';
  if (!hasLS) {
    return createMemoryChromePersistAdapter();
  }
  return {
    kind: 'localStorage',
    read() {
      try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return null;
        return sanitizeChromePersist(JSON.parse(raw) as WorkspaceChromePersisted);
      } catch {
        return null;
      }
    },
    write(data) {
      const clean = sanitizeChromePersist(data);
      assertNoForbiddenPersistKeys(clean);
      try {
        localStorage.setItem(storageKey, JSON.stringify(clean));
      } catch {
        /* quota / private mode */
      }
    },
  };
}

export function createMemoryChromePersistAdapter(
  initial?: WorkspaceChromePersisted | null,
): WorkspaceChromePersistAdapter {
  const mem = createMemoryPersistStore(initial);
  return {
    kind: 'memory',
    read: () => mem.read(),
    write: (d) => mem.write(d),
  };
}
