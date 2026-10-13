/** 外贴 27 冻结。handoff.json 只由工作台在用户确认后写入，更新器只读。 */
import { LayoutError } from './atomicJson';
import { dirZipName, HANDOFF_SCHEMA, VERSION_DIR_RE, VERSIONS_DIR } from './names';

export interface UpdateHandoff {
  schema: 1;
  fromVersion: string;
  toVersion: string;
  candidateRel: string;
  sha512: string;
  size: number;
  packageName: string;
  userDataDir: string;
  installRoot: string;
  backupId: string;
  createdAt: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function parseHandoff(text: string): UpdateHandoff {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LayoutError('updater/handoff.json 无法解析');
  }
  if (!raw || typeof raw !== 'object') throw new LayoutError('updater/handoff.json 无法解析');
  const row = raw as Record<string, unknown>;
  if (row.schema !== HANDOFF_SCHEMA) throw new LayoutError('updater/handoff.json schema 不是 1');
  if (typeof row.fromVersion !== 'string' || !VERSION_DIR_RE.test(row.fromVersion)) {
    throw new LayoutError('updater/handoff.json 的 fromVersion 不合法');
  }
  if (typeof row.toVersion !== 'string' || !VERSION_DIR_RE.test(row.toVersion)) {
    throw new LayoutError('updater/handoff.json 的 toVersion 不合法');
  }
  if (row.fromVersion === row.toVersion) throw new LayoutError('updater/handoff.json 的目标版本与当前相同');
  if (row.candidateRel !== `${VERSIONS_DIR}/${row.toVersion}`) {
    throw new LayoutError('updater/handoff.json 的 candidateRel 不合法');
  }
  if (typeof row.sha512 !== 'string' || row.sha512.length < 80) throw new LayoutError('updater/handoff.json 的 sha512 不合法');
  if (typeof row.size !== 'number' || !Number.isInteger(row.size) || row.size <= 0) {
    throw new LayoutError('updater/handoff.json 的 size 不合法');
  }
  if (row.packageName !== dirZipName(row.toVersion)) throw new LayoutError('updater/handoff.json 的 packageName 不合法');
  if (typeof row.userDataDir !== 'string' || !row.userDataDir.trim()) {
    throw new LayoutError('updater/handoff.json 的 userDataDir 不合法');
  }
  if (typeof row.installRoot !== 'string' || !row.installRoot.trim()) {
    throw new LayoutError('updater/handoff.json 的 installRoot 不合法');
  }
  if (typeof row.backupId !== 'string' || !row.backupId.trim()) throw new LayoutError('updater/handoff.json 的 backupId 不合法');
  if (typeof row.createdAt !== 'string' || !ISO.test(row.createdAt)) {
    throw new LayoutError('updater/handoff.json 的 createdAt 不合法');
  }
  return {
    schema: 1,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion,
    candidateRel: row.candidateRel,
    sha512: row.sha512,
    size: row.size,
    packageName: row.packageName,
    userDataDir: row.userDataDir,
    installRoot: row.installRoot,
    backupId: row.backupId,
    createdAt: row.createdAt,
  };
}
