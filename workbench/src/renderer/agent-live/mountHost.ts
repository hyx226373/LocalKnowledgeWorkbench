import type { MaterialRef } from '../../shared/agentLive/types';
import { getSidebarPrefs } from '../drawer/sidebarPrefs';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { AGENT_LIVE_CHROME_KEY } from './collapse';
import type { AgentLiveHost } from './host';
import { postFileDrag } from '../nativeDrag/start';
import { joinRoot } from './paths';

export interface MountHostInput {
  workspaceId: () => string;
  roots: () => { id: string; path: string }[];
  selectedResourceIds: () => string[];
  fileItem: (id: string) => { ref: string } | null;
  activeFileItem: () => { itemId: string; ref: string } | null;
  hostedApp: () => boolean;
  notify: (message: string) => void;
  cache: Map<string, MaterialRef>;
  bump: () => void;
}

const inflight = new Set<string>();

function isTokenPath(absPath: string): boolean {
  const name = absPath.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return name === 'agent-token.json';
}

/** 界面挂点用的宿主。路径只从数据进程或已打开的资源解析，不猜用户数据目录。 */
export function createMountHost(input: MountHostInput): AgentLiveHost {
  const remember = (resourceId: string) => {
    if (!resourceId || input.cache.has(resourceId) || inflight.has(resourceId)) return;
    inflight.add(resourceId);
    void kb.getResource(resourceId).then((res) => {
      if (!res) return;
      const root = input.roots().find((item) => item.id === res.rootId);
      if (!root?.path) return;
      const absPath = joinRoot(root.path, res.relPath);
      if (!absPath || isTokenPath(absPath)) return;
      input.cache.set(resourceId, {
        resourceId,
        sourceId: res.rootId,
        relPath: res.relPath,
        absPath,
        name: res.name,
      });
      input.bump();
    }).catch(() => undefined).finally(() => {
      inflight.delete(resourceId);
    });
  };
  const refOf = (resourceId: string): MaterialRef | null => {
    const hit = input.cache.get(resourceId);
    if (hit) return hit;
    remember(resourceId);
    return null;
  };
  return {
    workspaceId: () => input.workspaceId(),
    currentReading: () => {
      const item = input.activeFileItem();
      return item ? refOf(item.ref) : null;
    },
    readingForPanel: (panelId) => {
      const item = input.fileItem(panelId);
      return item ? refOf(item.ref) : null;
    },
    selection: () => input.selectedResourceIds().map((resourceId) => ({ resourceId, absPath: '' })),
    hostedForeground: () => input.hostedApp(),
    notify: (message) => input.notify(message),
    confirm: (spec) => dialogs.confirm(spec),
    writeClipboard: async (text) => {
      await navigator.clipboard.writeText(text);
    },
    bridgeEntryPath: () => kb.agentLiveEntryPath('current', input.workspaceId()),
    workspaceEntryPath: (workspaceId) => kb.agentLiveEntryPath('workspace', workspaceId),
    pickFile: (dialogKey) => kb.pickFile(dialogKey),
    startDragCopy: (request) => {
      if (request.deleteSource !== false || request.op !== 'copy' || !request.files.length) return;
      if (getSidebarPrefs().dragOutMode === 'path') return;
      postFileDrag(request.files);
    },
    resolve: async (ref) => {
      if (ref.absPath) return isTokenPath(ref.absPath) ? null : ref;
      // 有根+相对路径时直接拼真实地址（松散/自建目录成员拖拽常带 sourceId+relPath）
      if (ref.sourceId && typeof ref.relPath === 'string') {
        const root = input.roots().find((item) => item.id === ref.sourceId);
        if (root?.path) {
          const absPath = joinRoot(root.path, ref.relPath);
          if (absPath && !isTokenPath(absPath)) {
            return { ...ref, absPath, name: ref.name || absPath.split(/[\\/]/).pop() || absPath };
          }
        }
      }
      if (!ref.resourceId) return null;
      const res = await kb.getResource(ref.resourceId);
      if (!res) return null;
      // 网络直链（rootId 空）：仅已缓存文件可解析为本地路径
      if (!res.rootId) {
        if (!res.exists || typeof kb.resourceAbsPath !== "function") return null;
        try {
          const absPath = await kb.resourceAbsPath(ref.resourceId);
          if (!absPath || isTokenPath(absPath)) return null;
          return {
            ...ref,
            resourceId: ref.resourceId,
            sourceId: null,
            relPath: res.relPath,
            absPath,
            name: ref.name || res.name,
          };
        } catch {
          return null;
        }
      }
      const root = input.roots().find((item) => item.id === res.rootId);
      if (!root?.path) return null;
      const absPath = joinRoot(root.path, res.relPath);
      if (!absPath || isTokenPath(absPath)) return null;
      return {
        ...ref,
        resourceId: ref.resourceId,
        sourceId: res.rootId,
        relPath: res.relPath,
        absPath,
        name: ref.name || res.name,
      };
    },
    loadChrome: () => kb.getLayout(AGENT_LIVE_CHROME_KEY),
    saveChrome: async (_workspaceId, state) => {
      await kb.setLayout(AGENT_LIVE_CHROME_KEY, state);
    },
  };
}
