import type { CountInput, WorkspaceCounts } from './types';

const SIDEBAR_ID = 'kb.sidebar';

function addRef(set: Set<string>, ref: unknown) {
  if (typeof ref === 'string' && ref) set.add(ref);
}

/**
 * 只扫已保存的条目与面板。不读盘、不启动应用。
 * panels 不去重；file/web/app 的 ref 去重。workspaceRefs 不计入 files。
 */
export function countWorkspace(input: CountInput): WorkspaceCounts {
  void input.workspaceRefs;
  const items = new Map<string, CountInput['items'][number]>();
  for (const it of input.items ?? []) {
    if (it && typeof it.itemId === 'string' && !items.has(it.itemId)) items.set(it.itemId, it);
  }
  const panels = (input.panels ?? []).filter((p) => p && p.id !== SIDEBAR_ID);
  const files = new Set<string>();
  const webs = new Set<string>();
  const apps = new Set<string>();
  for (const p of panels) {
    if (p.itemId) {
      const it = items.get(p.itemId);
      if (it?.sourceKind === 'file') addRef(files, it.ref);
      else if (it?.sourceKind === 'web') addRef(webs, it.ref);
      else if (it?.sourceKind === 'app') addRef(apps, it.ref);
    }
    if (p.viewType === 'native-app-host') addRef(apps, p.hostPath);
  }
  return { files: files.size, webs: webs.size, apps: apps.size, panels: panels.length };
}
