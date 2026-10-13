export const MSG_ADDED = '已加入本轮资料，agent 可通过已有入口读取';
export const MSG_DUPLICATE_SESSION = '已在本轮资料中';
export const MSG_DUPLICATE_PINNED = '已在固定资料中';
export const MSG_DUPLICATE_LIST = '已在清单中';
export const MSG_COPIED = '已复制，粘贴给你的 agent 即可';
export const MSG_CLEAR_TITLE = '清空本轮资料？';
export const MSG_CLEAR_BODY = '只解除本轮引用，不会删除原文件，也不影响固定资料。';
export const MSG_CLEARED = '已清空本轮资料，原文件未删除';
export const MSG_EMPTY_SESSION = '本轮资料已经是空的';
export const MSG_PINNED = '已固定，会随工作区保存';
export const MSG_UNPINNED = '已取消固定，改回本轮资料';
export const MSG_REMOVED = '已从清单移除，原文件未删除';
export const MSG_RELOCATED = '已重新定位';
export const MSG_LIMIT = '每个工作区最多 200 项';
export const MSG_NO_READING = '当前没有可加入的文件';
export const MSG_NO_SELECTION = '先在目录或搜索结果里选中文件';
export const MSG_WEB_REJECTED = '网络资料尚未缓存到本地，无法加入';
export const MSG_DIR_REJECTED = '请加入文件，文件夹本轮不加入';
export const MSG_NO_PATH = '没有真实路径，不能加入';
export const MSG_DRAG_OUT = '拖出为复制，不会移动原文件';
export const MSG_ENTRY_CAP = '入口清单只列前 50 项，其余在 snapshot.json';
export const MSG_SELECT_ROW = '先在 agent 工作资料里选一项';
export const MSG_PURPOSE_HINT = '在清单里编辑用途';
export const MSG_REORDER_HINT = '在资料区里拖动排序';
export const MSG_CONNECT_NOTE = '已接入的 agent 继续用原来的入口，不必重新连接。';

export function addedMessage(count: number): string {
  if (count <= 1) return MSG_ADDED;
  return `已加入本轮资料 ${count} 项，agent 可通过已有入口读取`;
}

export function duplicateMessage(tier: 'session' | 'pinned' | null): string {
  if (tier === 'pinned') return MSG_DUPLICATE_PINNED;
  if (tier === 'session') return MSG_DUPLICATE_SESSION;
  return MSG_DUPLICATE_LIST;
}
