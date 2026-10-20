/**
 * 应用数据目录（docs/07 §2）：
 * - Windows：%LOCALAPPDATA%\LocalKnowledgeWorkbench（正式装机；索引缓存、网页分区等较大，不应放进配置同步的 Roaming）
 *   在改到之前用过 Electron 默认的 %APPDATA%\LocalKnowledgeWorkbench（Roaming）；首次启动时一次性迁移过去。
 * - 其他平台：沿用 Electron 默认（~/.config/LocalKnowledgeWorkbench 等）。
 * - KB_USER_DATA=<目录> 优先（测试、便携使用）；不做迁移。
 * - 非正式装机路径（非 D:\example_dev\LocalKnowledgeWorkbench）：默认强制独立 userData，
 *   避免 staging/candidate/wt dist 与正式装机互抢 live userData / instance.lock。
 * 必须在 app ready 之前调用（app.setPath('userData')）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const APP_DIR_NAME = 'LocalKnowledgeWorkbench';
/** 非正式装机隔离目录父名（仍在 LOCALAPPDATA 下，不碰真库） */
export const ISOLATED_UD_PARENT = 'LocalKnowledgeWorkbench-isolated';
/** 唯一允许继续使用默认真库 UD 的正式装机根 */
export const FORMAL_INSTALL_ROOT = 'D:\\example_dev\\LocalKnowledgeWorkbench';
/** 识别是否是工作台数据目录（元数据库） */
export const DATA_MARKER = 'workbench.db';
export const MIGRATION_NOTE = '已迁移到当前应用数据目录.txt';

export interface UserDataPlan {
  dir: string;
  /** 需要一次性迁移（旧的 Roaming 目录） */
  migrateFrom: string | null;
}

/** 规范化 Windows 路径比较（大小写、斜杠） */
function winNorm(p: string): string {
  return path.win32.resolve(p).replace(/\//g, '\\').toLowerCase();
}

/**
 * 是否正式装机路径：exe 必须落在 D:\example_dev\LocalKnowledgeWorkbench 之下。
 * staging / candidate / wt dist / 其他目录一律否。
 */
export function isFormalInstallPath(execPath: string): boolean {
  if (!execPath) return false;
  const resolved = winNorm(execPath);
  const formal = winNorm(FORMAL_INSTALL_ROOT);
  return resolved === formal || resolved.startsWith(`${formal}\\`);
}

/** 按装机目录哈希生成独立 UD，路径稳定、不含中文长路径 */
export function isolatedUserDataDir(localAppData: string, execPath: string): string {
  const installDir = winNorm(path.dirname(execPath));
  const key = crypto.createHash('sha1').update(installDir).digest('hex').slice(0, 16);
  return path.win32.join(localAppData, ISOLATED_UD_PARENT, key);
}

export function planUserDataDir(o: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  electronDefault: string;
  /** process.execPath；传入后可对非正式装机做硬隔离 */
  execPath?: string;
}): UserDataPlan {
  if (o.env.KB_USER_DATA) return { dir: path.resolve(o.env.KB_USER_DATA), migrateFrom: null };
  // 非正式装机：强制独立 UD，勿与 %LOCALAPPDATA%\LocalKnowledgeWorkbench 互抢
  if (o.platform === 'win32' && o.env.LOCALAPPDATA && o.execPath && !isFormalInstallPath(o.execPath)) {
    return { dir: isolatedUserDataDir(o.env.LOCALAPPDATA, o.execPath), migrateFrom: null };
  }
  if (o.platform !== 'win32' || !o.env.LOCALAPPDATA) return { dir: o.electronDefault, migrateFrom: null };
  const dir = path.win32.join(o.env.LOCALAPPDATA, APP_DIR_NAME);
  return { dir, migrateFrom: o.electronDefault !== dir ? o.electronDefault : null };
}

function hasData(dir: string) {
  return fs.existsSync(path.join(dir, DATA_MARKER));
}

/**
 * 一次性迁移：旧目录有元数据库、新目录还没有时，把旧目录搬过去。
 * 先尝试 rename（同盘时瞬间完成）；失败（跨盘、被占用）再复制；复制成功后在旧目录留一份说明文件，数据不删。
 * 新目录已有数据时什么都不做；出错时返回错误对象，调用方记日志。
 */
export function migrateUserData(from: string | null, to: string): 'none' | 'renamed' | 'copied' | 'skipped-target-has-data' | { error: string } {
  if (!from || path.resolve(from) === path.resolve(to) || !hasData(from)) return 'none';
  if (hasData(to)) return 'skipped-target-has-data';
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    // 目标若已被创建成空目录（例如 Chromium 先建会话目录），去掉空目录再替换
    if (fs.existsSync(to) && fs.readdirSync(to).length === 0) fs.rmdirSync(to);
    if (!fs.existsSync(to)) {
      try {
        fs.renameSync(from, to);
        return 'renamed';
      } catch {
        /* 跨盘或占用，回退复制 */
      }
    }
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
    fs.writeFileSync(path.join(from, MIGRATION_NOTE), `本地知识工作台：数据已复制到：\r\n${to}\r\n确认新位置一切正常后，可以删除本目录。\r\n`);
    return 'copied';
  } catch (e) {
    return { error: String((e as Error).message ?? e) };
  }
}