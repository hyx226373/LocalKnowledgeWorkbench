/** 文案。自建目录节点不能落到磁盘；目录里的文件条目可以，并要写明将移动原文件。 */

export const WILL_MOVE_FILE = '将移动原文件';
export const HINT_INVALID = '此处不可放置';
export const HINT_BAD_ENTRY = '无法识别这条资料的类型，已取消';
export const HINT_VFOLDER_NODE = '自建目录节点不能移动到磁盘（它不是磁盘文件夹）';
export const HINT_WEB_DISK = '请先保存到本地';
export const HINT_SELF = '不能移动到自身或子目录';
export const HINT_ALREADY = '已在此文件夹';
export const HINT_NO_ORIGIN = '无法确定原文件位置';
export const HINT_DIR_OPEN = '文件夹不能在阅读区打开';
export const HINT_CLASSIFY = '加入此目录（不移动原文件）';
export const HINT_CLASSIFY_ALT = '移出原目录并加入此目录（不移动原文件）';
export const HINT_CLASSIFY_COPY = '同时归入此目录（不移动原文件）';
export const HINT_CLASSIFY_SHIFT = '改归到此目录（不移动原文件）';
export const HINT_REF = '加入本工作的资料（不复制文件，不复制全局目录）';
export const HINT_TAB = '在阅读区打开为标签';
export const HINT_SPLIT = '在阅读区分屏打开';
export const HINT_FLOAT = '在工作台打开为浮动窗口';
export const HINT_REORDER = '调整根的显示顺序';
export const HINT_NOT_ROOT = '只有已登记的根可以在这里排序';

export const MENU_REMOVE_FOLDER = '从该目录移除';
export const MENU_REMOVE_WORKSPACE = '从本工作区移除';
export const MENU_ADD_FOLDER = '加入此目录';
export const MENU_MOVE_TO = '移动到…';
