/** 侧栏分区收起。网格和 ribbon 都可用。 */
import { DRAWER_MODULE_LABEL, type DrawerModuleId } from './order';

const BLOCK_KEY = 'kb.sidebarBlocksCollapsed';

let collapsed: string[] = [];
function applyBlocks(): void {
  if (typeof document === 'undefined') return;
  const de = document.documentElement;
  for (const id of Object.keys(DRAWER_MODULE_LABEL)) de.classList.toggle(`sbc-${id}`, collapsed.includes(id));
}
function saveBlocks(): void {
  try { localStorage.setItem(BLOCK_KEY, JSON.stringify(collapsed)); } catch { /* ignore */ }
  applyBlocks();
}
export const SIDEBAR_BLOCK_IDS = Object.keys(DRAWER_MODULE_LABEL) as DrawerModuleId[];
export function isSidebarBlockCollapsed(id: DrawerModuleId): boolean { return collapsed.includes(id); }
export function toggleSidebarBlock(id: DrawerModuleId): void {
  collapsed = collapsed.includes(id) ? collapsed.filter((x) => x !== id) : [...collapsed, id];
  saveBlocks();
}
export function showAllSidebarBlocks(): void { collapsed = []; saveBlocks(); }
export function initSidebarBlocks(): void {
  try { const v = JSON.parse(localStorage.getItem(BLOCK_KEY) || '[]'); collapsed = Array.isArray(v) ? v : []; } catch { collapsed = []; }
  applyBlocks();
}

initSidebarBlocks();
