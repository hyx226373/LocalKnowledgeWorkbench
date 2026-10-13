/** 外贴 27 冻结名。各组只导入，不改这个文件。 */

export const LAUNCHER_EXE = 'kb-launch.exe';
export const APP_EXE = 'LocalKnowledgeWorkbench.exe';
export const UPDATER_EXE = 'kb-updater.exe';
export const CURRENT_FILE = 'current.json';
export const CURRENT_SCHEMA = 1 as const;
export const STATE_REL = 'updater/state.json';
export const HANDOFF_REL = 'updater/handoff.json';
export const LOCK_REL = 'updater/update.lock';
export const LAUNCHER_LOCK_REL = 'updater/launcher.lock';
export const VERSIONS_DIR = 'versions';
export const LAUNCHER_DIR = 'launcher';
export const UPDATER_DIR = 'updater';
export const DIRPACK_FILE = 'dirpack.json';
export const DIRPACK_SCHEMA = 1 as const;
export const STATE_SCHEMA = 1 as const;
export const HANDOFF_SCHEMA = 1 as const;
export const READY_MARKER_FILE = 'update-ready.json';
export const READY_SCHEMA = 1 as const;
export const MIN_MIGRATE_BASELINE = '0.2.2';
export const SHORTCUT_NAME = '本地知识工作台';
export const UPDATE_WINDOW_TITLE = '本地知识工作台更新';
export const RESTART_TO_UPDATE_TITLE = '重启完成更新';
export const RESTART_TO_UPDATE_BODY =
  '新版本已准备好。确认后将保存并退出工作台，由更新器完成切换。更新窗口会保持打开。';

export const PHASE_TIMEOUT_MS = {
  'waiting-exit': 60_000,
  switching: 30_000,
  starting: 45_000,
  verifying: 60_000,
} as const;

/** 解压进 versions/<版本>/ 之后必须都存在且大小大于 0。 */
export const VERSION_TREE_REQUIRED = [
  APP_EXE,
  'resources/app.asar',
  'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/win32-x64.node',
  'ffmpeg.dll',
  'icudtl.dat',
  'resources.pak',
] as const;

/** 目录名只允许三位数字版本，避免路径穿越。 */
export const VERSION_DIR_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function dirZipName(version: string): string {
  if (!VERSION_DIR_RE.test(version)) throw new Error(`版本号不能作为目录名：${version}`);
  return `LocalKnowledgeWorkbench-${version}-win-x64-dir.zip`;
}
