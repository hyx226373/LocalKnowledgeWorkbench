/**
 * 应用数据目录（docs/07 §2）。
 * - Windows：%LOCALAPPDATA%\LocalKnowledgeWorkbench（本机数据：索引、缓存、网页会话都较大，不应随漫游配置同步）。
 *   第八轮之前用的是 Electron 默认的 %APPDATA%\LocalKnowledgeWorkbench（Roaming），首次启动时一次性迁移过来。
 * - 其他平台：保持 Electron 默认（~/.config/LocalKnowledgeWorkbench 等）。
 * - KB_USER_DATA=<目录> 优先（测试、便携使用），不做迁移。
 * 必须在 app ready 之前调用（app.setPath('userData')）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP_DIR_NAME = 'LocalKnowledgeWorkbench';
/** 识别“这是工作台的数据目录”的文件（元数据库） */
export const DATA_MARKER = 'workbench.db';
export const MIGRATION_NOTE = '已迁移到本地应用数据目录.txt';

export interface UserDataPlan {
  dir: string;
  /** 需要从这里迁移（旧的 Roaming 目录） */
  migrateFrom: string | null;
}

export function planUserDataDir(o: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; electronDefault: string }): UserDataPlan {
  if (o.env.KB_USER_DATA) return { dir: path.resolve(o.env.KB_USER_DATA), migrateFrom: null };
  if (o.platform !== 'win32' || !o.env.LOCALAPPDATA) return { dir: o.electronDefault, migrateFrom: null };
  const dir = path.win32.join(o.env.LOCALAPPDATA, APP_DIR_NAME);
  return { dir, migrateFrom: o.electronDefault !== dir ? o.electronDefault : null };
}

function hasData(dir: string) {
  return fs.existsSync(path.join(dir, DATA_MARKER));
}

/**
 * 一次性迁移：旧目录有元数据库、新目录还没有时，把旧目录整体搬过去。
 * 先尝试 rename（同盘时瞬间完成）；失败（跨盘、被占用）则复制，复制成功后在旧目录留一个说明文件，旧数据不删除。
 * 新目录已有数据时什么都不做（不覆盖）。返回做了什么，便于记录日志。
 */
export function migrateUserData(from: string | null, to: string): 'none' | 'renamed' | 'copied' | 'skipped-target-has-data' | { error: string } {
  if (!from || path.resolve(from) === path.resolve(to) || !hasData(from)) return 'none';
  if (hasData(to)) return 'skipped-target-has-data';
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // 目标可能已被创建为空目录（例如 Chromium 先建了目录），空目录可以替换
    if (fs.existsSync(to) && fs.readdirSync(to).length === 0) fs.rmdirSync(to);
    if (!fs.existsSync(to)) {
      try {
        fs.renameSync(from, to);
        return 'renamed';
      } catch {
        /* 跨盘或被占用：退回复制 */
      }
    }
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    fs.writeFileSync(path.join(from, MIGRATION_NOTE), `本地知识工作台的数据已复制到：\r\n${to}\r\n确认新位置一切正常后，可以删除此目录。\r\n`);
    return 'copied';
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
}
