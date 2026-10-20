/** 外贴 27 冻结路径。各组只导入，不改这个文件。 */
import path from 'node:path';
import { LayoutError } from './atomicJson';
import {
  APP_EXE,
  CURRENT_FILE,
  HANDOFF_REL,
  LAUNCHER_DIR,
  LAUNCHER_EXE,
  LAUNCHER_LOCK_REL,
  LOCK_REL,
  STATE_REL,
  UPDATER_DIR,
  UPDATER_EXE,
  VERSION_DIR_RE,
  VERSIONS_DIR,
} from './names';

export function assertVersionDirName(version: string): string {
  if (!VERSION_DIR_RE.test(version)) throw new LayoutError(`版本号不能作为目录名：${version}`);
  return version;
}

/** 安装根内的路径。拒绝跳出根目录。 */
export function installPath(installRoot: string, ...parts: string[]): string {
  const root = path.win32.resolve(installRoot);
  const full = path.win32.resolve(root, ...parts);
  const prefix = root.endsWith('\\') ? root : `${root}\\`;
  const same = full.toLowerCase() === root.toLowerCase();
  if (!same && !full.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new LayoutError(`路径越出安装根：${parts.join('/')}`);
  }
  return full;
}

/** 安装根、版本目录、用户数据都不许落在 用户的 D:\\example_dev 下。 */
export function isUnderStudyDev(target: string): boolean {
  const resolved = path.win32.resolve(target).toLowerCase();
  const root = 'd:\\example_dev';
  return resolved === root || resolved.startsWith(`${root}\\`);
}

export function currentFile(installRoot: string): string {
  return installPath(installRoot, CURRENT_FILE);
}

export function versionDir(installRoot: string, version: string): string {
  return installPath(installRoot, VERSIONS_DIR, assertVersionDirName(version));
}

export function appExe(installRoot: string, version: string): string {
  return installPath(installRoot, VERSIONS_DIR, assertVersionDirName(version), APP_EXE);
}

export function launcherExe(installRoot: string): string {
  return installPath(installRoot, LAUNCHER_DIR, LAUNCHER_EXE);
}

export function updaterExe(installRoot: string): string {
  return installPath(installRoot, UPDATER_DIR, UPDATER_EXE);
}

export function stateFile(installRoot: string): string {
  return installPath(installRoot, ...STATE_REL.split('/'));
}

export function handoffFile(installRoot: string): string {
  return installPath(installRoot, ...HANDOFF_REL.split('/'));
}

export function updateLockFile(installRoot: string): string {
  return installPath(installRoot, ...LOCK_REL.split('/'));
}

export function launcherLockFile(installRoot: string): string {
  return installPath(installRoot, ...LAUNCHER_LOCK_REL.split('/'));
}

export function candidateRel(version: string): string {
  return `${VERSIONS_DIR}/${assertVersionDirName(version)}`;
}
