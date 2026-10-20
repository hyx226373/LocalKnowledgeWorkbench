import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { dirViewActions, setGetDragPayload, setOnDropTarget, type KbDragPayload } from '../dir-view/dnd';
import { HINT_BAD_ENTRY } from './copy';
import { interpretDirTarget } from './interpret';
import { attachDisk, entryOf } from './mime';
import { parentRel } from './names';
import { runDrop, runRemoveFromFolder, runRemoveFromWorkspace } from './session';
import type { DragFrom, DragItem, DragPayload, Modifiers } from './types';

let roots: { id: string; resourceId: string }[] = [];
let lastPayload: DragPayload | null = null;

export function setDndRoots(list: { id: string; resourceId: string }[]) {
  roots = list;
}

export function modifiersFromEffect(effect: string): Modifiers {
  const parts = new Set(effect.split('+').map((s) => s.trim().toLowerCase()));
  return { alt: parts.has('alt'), ctrl: parts.has('ctrl') };
}

export function toDragPayload(payload: KbDragPayload): DragPayload {
  return {
    v: 1,
    items: payload.items.map((it) => {
      const extra = it as KbDragPayload['items'][number] & { rootId?: string; relPath?: string; name?: string; size?: number };
      let rootId = extra.rootId;
      let relPath = extra.relPath;
      if (it.from.kind === 'roots-list' && !rootId) rootId = roots.find((r) => r.resourceId === it.resourceId)?.id;
      if (it.from.kind === 'root') {
        rootId = rootId || it.from.rootId;
        if (relPath === undefined) relPath = it.from.relPath;
      }
      const item: DragItem = {
        resourceId: it.resourceId,
        sourceKind: it.sourceKind,
        from: it.from,
        entry: it.entry,
        name: extra.name,
        rootId,
        relPath,
        size: extra.size,
      };
      if (it.entry === 'vfolder-node' && it.from.kind === 'vfolder' && it.from.folderId) item.folderId = it.from.folderId;
      return item;
    }),
  };
}

/** 自建目录里的文件条目若种子没带磁盘位置，用资源记录补上。补不上就保持原样，落点会拒绝。 */
export async function enrichDisk(payload: DragPayload): Promise<DragPayload> {
  const items: DragItem[] = [];
  for (const it of payload.items) {
    const entry = entryOf(it);
    const located = !!(it.rootId && typeof it.relPath === 'string');
    if ((entry === 'file' || entry === 'dir-entry') && it.from.kind !== 'roots-list' && it.resourceId && !located) {
      try {
        const res = await kb.getResource(it.resourceId);
        items.push(attachDisk(it, res));
        continue;
      } catch {
        /* 解析失败保持原样 */
      }
    }
    if (!it.rootId && it.absPath) {
      try {
        const allRoots = await kb.listRoots().catch(() => []);
        const normAbs = it.absPath.replace(/\\/g, '/').toLowerCase();
        for (const r of allRoots) {
          const normRoot = r.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
          if (normAbs === normRoot || normAbs.startsWith(normRoot + '/')) {
            const rel = it.absPath.slice(r.path.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
            it.rootId = r.id;
            it.relPath = rel;
            if (!it.resourceId && kb.consoleResolvePath) {
              const rid = await kb.consoleResolvePath(r.id, rel).catch(() => null);
              if (rid) it.resourceId = rid;
            }
            break;
          }
        }
      } catch {
        /* 解析失败保持原样 */
      }
    }
    items.push(it);
  }
  return { v: 1, items };
}

async function logicalTarget(target: DragFrom, payload: DragPayload) {
  const allRoots = payload.items.length > 0 && payload.items.every((it) => it.from.kind === 'roots-list' && entryOf(it) === 'dir-entry');
  let hit: { kind: 'file' | 'dir' } | null = null;
  let childNames: string[] = [];
  if (target.kind === 'root' && !allRoots) {
    if (target.relPath === '') {
      childNames = (await kb.listDir(target.rootId, '')).map((e) => e.name);
    } else {
      const entries = await kb.listDir(target.rootId, parentRel(target.relPath));
      const found = entries.find((e) => e.relPath === target.relPath);
      hit = found ? { kind: found.kind } : null;
      if (found?.kind === 'dir') childNames = (await kb.listDir(target.rootId, target.relPath)).map((e) => e.name);
    }
  }
  return interpretDirTarget(target, payload.items, roots.map((r) => r.id), hit, childNames);
}

async function handleDirDrop(target: DragFrom, payload: KbDragPayload, effect: string) {
  const drag = await enrichDisk(toDragPayload(payload));
  lastPayload = drag;
  const logical = await logicalTarget(target, drag);
  await runDrop(logical, drag, modifiersFromEffect(effect));
}

function seedWithRootId(seed: KbDragPayload): KbDragPayload {
  return {
    v: 1,
    items: seed.items.map((it) => {
      if (it.from.kind !== 'roots-list') return it;
      const extra = it as KbDragPayload['items'][number] & { rootId?: string };
      if (extra.rootId) return it;
      const id = roots.find((r) => r.resourceId === it.resourceId)?.id;
      return id ? { ...it, rootId: id } : it;
    }),
  };
}

async function alertNeedSelection(body: string) {
  await dialogs.alert({ title: '先选一项资料', body });
}

export async function promptMove(payload?: DragPayload) {
  const base = payload ?? lastPayload;
  if (!base?.items.length) {
    await alertNeedSelection('在目录树或本工作的资料上右键，再执行这个命令。');
    return;
  }
  const drag = await enrichDisk(base);
  lastPayload = drag;
  if (drag.items.some((it) => entryOf(it) == null)) {
    await dialogs.alert({ title: '不能移动', body: HINT_BAD_ENTRY });
    return;
  }
  if (drag.items.some((it) => entryOf(it) === 'vfolder-node' || it.from.kind === 'roots-list')) {
    await dialogs.alert({ title: '不能这样移动', body: '自建目录节点和已登记的根本身不能移动到磁盘文件夹。' });
    return;
  }
  const first = drag.items[0];
  const dest = await dialogs.prompt({
    title: '移动到…',
    body: '将移动原文件。目标是真实磁盘文件夹（根内相对路径，根目录留空）。',
    fields: [
      { name: 'rootId', label: '目标根', value: first.rootId || (first.from.kind === 'root' ? first.from.rootId : '') },
      { name: 'relPath', label: '目标文件夹', value: '' },
    ],
  });
  if (!dest) return;
  await runDrop({ kind: 'disk-dir', rootId: dest.rootId, relPath: dest.relPath }, drag);
}

export async function promptAddToFolder(payload?: DragPayload) {
  const base = payload ?? lastPayload;
  if (!base?.items.length) {
    await alertNeedSelection('在资料上右键，再把它加入自建目录。');
    return;
  }
  const drag = await enrichDisk(base);
  lastPayload = drag;
  if (drag.items.some((it) => entryOf(it) !== 'file')) {
    await dialogs.alert({ title: '不能加入自建目录', body: '只有文件条目可以归类。目录节点、文件夹和根都不行。' });
    return;
  }
  const dest = await dialogs.prompt({
    title: '加入自建目录…',
    body: '只加入全局自建目录，不移动原文件。',
    fields: [{ name: 'folderId', label: '自建目录 id', value: '' }],
  });
  if (!dest?.folderId) return;
  await runDrop({ kind: 'vfolder', folderId: dest.folderId }, drag);
}

export async function promptRemoveFromFolder(resourceId?: string, folderId?: string | null, name?: string) {
  const item = lastPayload?.items[0];
  const id = resourceId || item?.resourceId;
  if (!id) {
    await alertNeedSelection('在自建目录里的资料上右键，再执行这个命令。');
    return;
  }
  let folder: string | null;
  if (folderId !== undefined) folder = folderId;
  else if (item?.from.kind === 'vfolder') folder = item.from.folderId;
  else {
    const dest = await dialogs.prompt({
      title: '从该目录移除',
      body: '只解除归类，不关闭面板，不移动原文件。',
      fields: [{ name: 'folderId', label: '自建目录 id', value: '' }],
    });
    if (!dest?.folderId) return;
    folder = dest.folderId;
  }
  const label = name || item?.name || (await kb.getResource(id).catch(() => null))?.name || id;
  await runRemoveFromFolder(folder, id, label);
}

export async function promptRemoveFromWorkspace(resourceId?: string, name?: string) {
  const item = lastPayload?.items[0];
  const id = resourceId || item?.resourceId;
  if (!id) {
    await alertNeedSelection('在目录树或本工作的资料上右键，再执行这个命令。');
    return;
  }
  const label = name || item?.name || (await kb.getResource(id).catch(() => null))?.name || id;
  await runRemoveFromWorkspace(id, label);
}

/** 把 C 的拖拽挂钩接到本包的落点语义。目录树本身留在 dir-view。 */
export function installDirViewDnd() {
  setGetDragPayload(seedWithRootId);
  setOnDropTarget((target, payload, effect) => {
    void handleDirDrop(target, payload, effect);
  });
  dirViewActions.moveTo = (payload) => {
    void promptMove(toDragPayload(payload));
  };
  dirViewActions.addToFolder = (payload) => {
    void promptAddToFolder(toDragPayload(payload));
  };
  dirViewActions.removeFromFolder = (resourceId, folderId) => {
    void promptRemoveFromFolder(resourceId, folderId);
  };
  dirViewActions.removeFromWorkspace = (resourceId) => {
    void promptRemoveFromWorkspace(resourceId);
  };
  return () => {
    setGetDragPayload(null);
    setOnDropTarget(null);
    delete dirViewActions.moveTo;
    delete dirViewActions.addToFolder;
    delete dirViewActions.removeFromFolder;
    delete dirViewActions.removeFromWorkspace;
  };
}
