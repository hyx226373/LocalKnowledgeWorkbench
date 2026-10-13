/** 旧 NSIS 安装根迁入 versions/<版本>/。准入只走冻结的 planMigration。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  APP_EXE,
  CURRENT_FILE,
  LAUNCHER_DIR,
  UPDATER_DIR,
  VERSIONS_DIR,
  isUnderStudyDev,
  planMigration,
  versionDir,
  versionDirName,
  verifyVersionTree,
  writeCurrent,
} from '../shared/layout';

const PRE_LAYOUT_EXE = `${APP_EXE}.pre-layout`;
const SKIP_TOP = new Set([VERSIONS_DIR, LAUNCHER_DIR, UPDATER_DIR, CURRENT_FILE].map((name) => name.toLowerCase()));

async function isFile(file: string): Promise<boolean> {
  try {
    const info = await fs.stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

function normalizedVersion(fileVersion: string | null): string | null {
  try {
    return versionDirName(fileVersion ?? '');
  } catch {
    return null;
  }
}

/** fs.cp 不能把目录拷进自己的子目录，所以按顶层条目复制。 */
async function copyOldRoot(installRoot: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(installRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_TOP.has(entry.name.toLowerCase())) continue;
    const src = path.win32.join(installRoot, entry.name);
    const target = path.win32.join(dest, entry.name);
    await fs.cp(src, target, { recursive: true, force: true });
  }
}

async function removeCopy(dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  const parent = path.win32.dirname(dest);
  try {
    const left = await fs.readdir(parent);
    if (left.length === 0) await fs.rmdir(parent);
  } catch {
    // 父目录还有别的版本时留下。
  }
}

export async function migrateLayout(opts: {
  installRoot: string;
  fileVersion: string | null;
  allowStudyDev?: boolean;
  now?: string;
}): Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  const root = path.win32.resolve(opts.installRoot);
  const allowStudyDev = opts.allowStudyDev === true;
  const underStudyDev = isUnderStudyDev(root);
  const versionFromName = normalizedVersion(opts.fileVersion);
  const hasCurrentJson = await isFile(path.win32.join(root, CURRENT_FILE));
  const hasAppExe = await isFile(path.win32.join(root, APP_EXE));
  const hasAsar = await isFile(path.win32.join(root, 'resources', 'app.asar'));
  const plan = planMigration({
    hasCurrentJson,
    hasAppExe,
    hasAsar,
    fileVersion: opts.fileVersion,
    underStudyDev,
    allowStudyDev,
  });
  if (plan.action === 'refuse') return { ok: false, reason: plan.reason };

  const version = versionFromName ?? plan.version;
  const dest = versionDir(root, version);
  try {
    await copyOldRoot(root, dest);
  } catch (err) {
    await removeCopy(dest).catch(() => undefined);
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `复制旧安装根失败：${message}` };
  }

  const check = await verifyVersionTree(dest);
  if (!check.ok) {
    await removeCopy(dest);
    return { ok: false, reason: `版本目录校验失败，缺少：${check.missing.join('、')}` };
  }

  const updatedAt = opts.now ? opts.now : new Date().toISOString();
  try {
    await writeCurrent(root, {
      schema: 1,
      current: version,
      previous: null,
      updatedAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `current.json 写入失败：${message}` };
  }

  try {
    await fs.rename(path.win32.join(root, APP_EXE), path.win32.join(root, PRE_LAYOUT_EXE));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: `指针已写下，但旧 exe 还在：${APP_EXE} 改名为 ${PRE_LAYOUT_EXE} 失败（${message}）`,
    };
  }
  return { ok: true, version };
}
