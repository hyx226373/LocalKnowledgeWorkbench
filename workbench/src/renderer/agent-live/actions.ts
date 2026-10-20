import type { AgentMaterial, MaterialRef } from '../../shared/agentLive/types';
import { DIALOG_LAST_DIR } from '../../shared/dialogLastDir';
import type { AgentLiveAddDetail, AgentLiveAddReturn, AgentLiveClient } from './client';
import { isMaterialLimit, MAX_MATERIALS } from './limits';
import { isAddDetail } from './client';
import { tierOf } from './format';
import type { AgentLiveHost } from './host';
import {
  MSG_CLEAR_BODY,
  MSG_CLEAR_TITLE,
  MSG_CLEARED,
  MSG_DIR_CONFIRM_BODY,
  MSG_DIR_CONFIRM_TITLE,
  MSG_COPIED,
  MSG_EMPTY_SESSION,
  MSG_LIMIT,
  MSG_NO_PATH,
  MSG_WEB_REJECTED,
  MSG_NO_SELECTION,
  MSG_PINNED,
  MSG_PURPOSE_HINT,
  MSG_RELOCATED,
  MSG_REMOVED,
  MSG_REORDER_HINT,
  MSG_SELECT_ROW,
  MSG_UNPINNED,
  addedMessage,
  duplicateMessage,
} from './messages';
import { pathKey } from './paths';

export interface LiveBinding {
  client: AgentLiveClient;
  host: AgentLiveHost;
}

let current: LiveBinding | null = null;
let selectedMaterialId: string | null = null;

export function bindAgentLive(binding: LiveBinding | null): void {
  current = binding;
}

export function getAgentLiveBinding(): LiveBinding | null {
  return current;
}

export function setSelectedMaterial(materialId: string | null): void {
  selectedMaterialId = materialId;
}

export function getSelectedMaterial(): string | null {
  return selectedMaterialId;
}

function findMaterial(items: readonly AgentMaterial[], ref: MaterialRef): AgentMaterial | undefined {
  if (ref.resourceId) return items.find((item) => item.resourceId === ref.resourceId);
  if (!ref.absPath) return undefined;
  const key = pathKey(ref.absPath);
  return items.find((item) => !item.resourceId && pathKey(item.absPath) === key);
}

export async function describeAdd(client: AgentLiveClient, workspaceId: string, ref: MaterialRef, value: AgentLiveAddReturn): Promise<AgentLiveAddDetail> {
  if (isAddDetail(value)) return value;
  const items = await client.list(workspaceId);
  const hit = findMaterial(items, ref);
  return { result: value, tier: hit ? tierOf(hit) : 'session', materialId: hit?.materialId ?? '' };
}

export function summarizeAdds(details: readonly AgentLiveAddDetail[]): string {
  let added = 0;
  let sessionDup = 0;
  let pinnedDup = 0;
  for (const detail of details) {
    if (detail.result === 'added') added += 1;
    else if (detail.tier === 'pinned') pinnedDup += 1;
    else sessionDup += 1;
  }
  const parts: string[] = [];
  if (added) parts.push(added === 1 ? addedMessage(1) : addedMessage(added));
  if (sessionDup === 1) parts.push(duplicateMessage('session'));
  else if (sessionDup > 1) parts.push(`已在本轮资料中 ${sessionDup} 项`);
  if (pinnedDup === 1) parts.push(duplicateMessage('pinned'));
  else if (pinnedDup > 1) parts.push(`已在固定资料中 ${pinnedDup} 项`);
  return parts.join('。');
}

async function readyRef(host: AgentLiveHost, ref: MaterialRef): Promise<MaterialRef | null> {
  if (ref.absPath) return ref;
  if (!host.resolve) return null;
  return host.resolve(ref);
}

export async function addRefs(binding: LiveBinding, refs: readonly MaterialRef[]): Promise<string> {
  const workspaceId = binding.host.workspaceId();
  const usable: MaterialRef[] = [];
  for (const ref of refs) {
    const ready = await readyRef(binding.host, ref);
    if (!ready?.absPath) {
      // 网页/直链通常无 sourceId、无 relPath；侧栏本地文件会带 sourceId
      const webish = !ref.absPath && !!ref.resourceId && ref.sourceId == null && !ref.relPath;
      binding.host.notify(webish ? MSG_WEB_REJECTED : MSG_NO_PATH);
      continue;
    }
    usable.push(ready);
  }
  if (!usable.length) return '';
  const existing = await binding.client.list(workspaceId);
  const room = Math.max(0, MAX_MATERIALS - existing.length);
  const accepted: MaterialRef[] = [];
  let fresh = 0;
  let blocked = false;
  for (const ref of usable) {
    if (findMaterial(existing, ref)) {
      accepted.push(ref);
      continue;
    }
    if (fresh < room) {
      accepted.push(ref);
      fresh += 1;
    } else blocked = true;
  }
  if (!accepted.length) {
    binding.host.notify(MSG_LIMIT);
    return MSG_LIMIT;
  }
  try {
    const raw = binding.client.addMany
      ? await binding.client.addMany(workspaceId, accepted)
      : await Promise.all(accepted.map((ref) => binding.client.add(workspaceId, ref)));
    const details = await Promise.all(raw.map((value, index) => describeAdd(binding.client, workspaceId, accepted[index]!, value)));
    const message = summarizeAdds(details);
    if (blocked) {
      const both = message ? `${message}。${MSG_LIMIT}` : MSG_LIMIT;
      binding.host.notify(both);
      return both;
    }
    if (message) binding.host.notify(message);
    return message;
  } catch (error) {
    if (isMaterialLimit(error)) {
      binding.host.notify(MSG_LIMIT);
      return MSG_LIMIT;
    }
    throw error;
  }
}

/** 无阅读/无选中（尤其空树）时：选文件以 loose material 加入（resourceId null）。取消则静默返回。 */

/** 含目录时先走 MSG_DIR_CONFIRM_*；取消则不加。 */
export async function addRefsMaybeDir(binding: LiveBinding, refs: readonly MaterialRef[], opts?: { asDir?: boolean }): Promise<string> {
  if (!refs.length) return '';
  if (opts?.asDir) {
    const ok = await binding.host.confirm({
      title: MSG_DIR_CONFIRM_TITLE,
      body: MSG_DIR_CONFIRM_BODY,
      ok: '加入',
      cancel: '取消',
    });
    if (!ok) return '';
  }
  return addRefs(binding, refs);
}

export async function addFromDisk(binding: LiveBinding): Promise<void> {
  const picked = await binding.host.pickFile(DIALOG_LAST_DIR.addMaterial);
  if (!picked) return;
  const name = picked.replace(/[\\/]+$/, '');
  const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  await addRefs(binding, [{ absPath: picked, name: slash >= 0 ? name.slice(slash + 1) : name, resourceId: null }]);
}

export async function addCurrent(binding: LiveBinding): Promise<void> {
  if (binding.host.hostedForeground()) return;
  const ref = binding.host.currentReading();
  if (!ref) {
    await addFromDisk(binding);
    return;
  }
  await addRefs(binding, [ref]);
}

export async function addSelection(binding: LiveBinding, refs?: readonly MaterialRef[]): Promise<void> {
  const list = refs ?? binding.host.selection();
  if (!list.length) {
    binding.host.notify(MSG_NO_SELECTION);
    return;
  }
  await addRefs(binding, list);
}

export async function removeSelected(binding: LiveBinding, materialId?: string): Promise<void> {
  const id = materialId || selectedMaterialId;
  if (!id) {
    binding.host.notify(MSG_SELECT_ROW);
    return;
  }
  await binding.client.remove(binding.host.workspaceId(), id);
  if (selectedMaterialId === id) selectedMaterialId = null;
  binding.host.notify(MSG_REMOVED);
}

export async function pinSelected(binding: LiveBinding, materialId?: string): Promise<void> {
  const id = materialId || selectedMaterialId;
  if (!id) {
    binding.host.notify(MSG_SELECT_ROW);
    return;
  }
  await binding.client.pin(binding.host.workspaceId(), id);
  binding.host.notify(MSG_PINNED);
}

export async function unpinSelected(binding: LiveBinding, materialId?: string): Promise<void> {
  const id = materialId || selectedMaterialId;
  if (!id) {
    binding.host.notify(MSG_SELECT_ROW);
    return;
  }
  await binding.client.unpin(binding.host.workspaceId(), id);
  binding.host.notify(MSG_UNPINNED);
}

export async function setPurposeSelected(binding: LiveBinding, purpose?: string | null, materialId?: string): Promise<void> {
  const id = materialId || selectedMaterialId;
  if (!id || purpose === undefined) {
    binding.host.notify(purpose === undefined ? MSG_PURPOSE_HINT : MSG_SELECT_ROW);
    return;
  }
  const trimmed = purpose?.trim() ?? '';
  const next = trimmed ? trimmed : null;
  await binding.client.setPurpose(binding.host.workspaceId(), id, next);
}

export async function reorderMaterials(binding: LiveBinding, order?: readonly string[]): Promise<void> {
  if (!order?.length) {
    binding.host.notify(MSG_REORDER_HINT);
    return;
  }
  await binding.client.reorder(binding.host.workspaceId(), [...order]);
}

export async function clearSession(binding: LiveBinding): Promise<void> {
  const ok = await binding.host.confirm({
    title: MSG_CLEAR_TITLE,
    body: MSG_CLEAR_BODY,
    ok: '清空',
    cancel: '取消',
  });
  if (!ok) return;
  const ids = await binding.client.clearSession(binding.host.workspaceId());
  binding.host.notify(ids.length ? MSG_CLEARED : MSG_EMPTY_SESSION);
}

export async function relocateMaterial(binding: LiveBinding, materialId: string): Promise<void> {
  const picked = await binding.host.pickFile(DIALOG_LAST_DIR.relocateMaterial);
  if (!picked) return;
  const name = picked.replace(/[\\/]+$/, '');
  const slash = Math.max(name.lastIndexOf('\\'), name.lastIndexOf('/'));
  await binding.client.relocate(binding.host.workspaceId(), materialId, {
    absPath: picked,
    name: slash >= 0 ? name.slice(slash + 1) : name,
    resourceId: null,
  });
  binding.host.notify(MSG_RELOCATED);
}

export async function copyBridgeLink(binding: LiveBinding): Promise<void> {
  const path = await binding.host.bridgeEntryPath();
  await binding.host.writeClipboard(path);
  binding.host.notify(MSG_COPIED);
}

export async function copyWorkspaceLink(binding: LiveBinding): Promise<void> {
  const entryPath = await binding.host.workspaceEntryPath(binding.host.workspaceId());
  const rules = binding.host.residentRules ? await binding.host.residentRules(entryPath) : null;
  await binding.host.writeClipboard(rules && rules.trim() ? rules : entryPath);
  binding.host.notify(MSG_COPIED);
}

export function requireBinding(): LiveBinding | null {
  return current;
}
