/** 外贴 27 冻结。先判定，再复制。复制失败时旧根目录的主程序必须还在。 */
import { parseVersion } from '../update/version';
import { LayoutError } from './atomicJson';
import { MIN_MIGRATE_BASELINE } from './names';

export function versionDirName(fileVersion: string): string {
  let parsed: ReturnType<typeof parseVersion>;
  try {
    parsed = parseVersion(fileVersion.trim());
  } catch {
    throw new LayoutError(`版本号无法归一：${fileVersion}`);
  }
  if (parsed.pre || parsed.core.length > 4 || (parsed.core.length === 4 && parsed.core[3] !== 0)) {
    throw new LayoutError(`版本号无法归一：${fileVersion}`);
  }
  const maj = parsed.core[0] ?? 0;
  const min = parsed.core[1] ?? 0;
  const pat = parsed.core[2] ?? 0;
  return `${maj}.${min}.${pat}`;
}

export function compareCore(a: string, b: string): number {
  const pa = parseVersion(a).core;
  const pb = parseVersion(b).core;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export type MigrationPlan =
  | { action: 'refuse'; reason: string }
  | { action: 'copy-then-point'; version: string };

export function planMigration(input: {
  hasCurrentJson: boolean;
  hasAppExe: boolean;
  hasAsar: boolean;
  fileVersion: string | null;
  underStudyDev: boolean;
  allowStudyDev: boolean;
}): MigrationPlan {
  if (input.underStudyDev && !input.allowStudyDev) {
    return { action: 'refuse', reason: '禁止迁移 D:\\study_dev，除非 Amy 另批' };
  }
  if (input.hasCurrentJson) return { action: 'refuse', reason: '已经是版本目录布局' };
  if (!input.hasAppExe) return { action: 'refuse', reason: '找不到旧版主程序' };
  if (!input.hasAsar) return { action: 'refuse', reason: '找不到 resources/app.asar' };
  if (!input.fileVersion) return { action: 'refuse', reason: '读不到主程序版本号' };
  let version = '';
  try {
    version = versionDirName(input.fileVersion);
  } catch (err) {
    return { action: 'refuse', reason: err instanceof Error ? err.message : String(err) };
  }
  if (compareCore(version, MIN_MIGRATE_BASELINE) < 0) {
    return { action: 'refuse', reason: `版本 ${version} 低于最低可迁基线 0.2.2` };
  }
  return { action: 'copy-then-point', version };
}
