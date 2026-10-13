/** 外贴 27 冻结。新客户端只读 dirpack.json。latest.yml 仍留给 0.2.4 的 NSIS 更新器。 */
import { LayoutError } from './atomicJson';
import { DIRPACK_SCHEMA, dirZipName, MIN_MIGRATE_BASELINE } from './names';

export interface DirPackManifest {
  schema: 1;
  version: string;
  file: string;
  size: number;
  sha512: string;
  releaseDate: string;
  minBaseline: '0.2.2';
  notes?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function parseDirpack(text: string): DirPackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LayoutError('dirpack.json 无法解析');
  }
  if (!raw || typeof raw !== 'object') throw new LayoutError('dirpack.json 无法解析');
  const row = raw as Record<string, unknown>;
  if (row.schema !== DIRPACK_SCHEMA) throw new LayoutError('dirpack.json schema 不是 1');
  if (typeof row.version !== 'string') throw new LayoutError('dirpack.json 的 version 不合法');
  let file = '';
  try {
    file = dirZipName(row.version);
  } catch {
    throw new LayoutError('dirpack.json 的 version 不合法');
  }
  if (row.file !== file) throw new LayoutError('dirpack.json 的 file 与版本不一致');
  if (typeof row.size !== 'number' || !Number.isInteger(row.size) || row.size <= 0) {
    throw new LayoutError('dirpack.json 的 size 不合法');
  }
  if (typeof row.sha512 !== 'string' || row.sha512.length < 80) throw new LayoutError('dirpack.json 的 sha512 不合法');
  if (typeof row.releaseDate !== 'string' || !ISO.test(row.releaseDate)) {
    throw new LayoutError('dirpack.json 的 releaseDate 不合法');
  }
  if (row.minBaseline !== MIN_MIGRATE_BASELINE) throw new LayoutError('dirpack.json 的 minBaseline 必须是 0.2.2');
  if (row.notes !== undefined && typeof row.notes !== 'string') throw new LayoutError('dirpack.json 的 notes 不合法');
  return {
    schema: 1,
    version: row.version,
    file,
    size: row.size,
    sha512: row.sha512,
    releaseDate: row.releaseDate,
    minBaseline: '0.2.2',
    notes: row.notes,
  };
}
