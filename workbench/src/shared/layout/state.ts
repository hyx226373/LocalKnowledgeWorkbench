/** 外贴 27 冻结。updater/state.json 的阶段。工作台只写 preparing、ready、cancelled。 */
import { LayoutError } from './atomicJson';
import { STATE_SCHEMA, VERSION_DIR_RE, VERSIONS_DIR } from './names';

export type UpdaterPhase =
  | 'idle'
  | 'preparing'
  | 'ready'
  | 'waiting-exit'
  | 'switching'
  | 'starting'
  | 'verifying'
  | 'done'
  | 'rolling-back'
  | 'failed'
  | 'cancelled';

export const UPDATER_PHASES: readonly UpdaterPhase[] = [
  'idle',
  'preparing',
  'ready',
  'waiting-exit',
  'switching',
  'starting',
  'verifying',
  'done',
  'rolling-back',
  'failed',
  'cancelled',
];

export interface UpdaterState {
  schema: 1;
  phase: UpdaterPhase;
  fromVersion: string;
  toVersion: string | null;
  /** 相对安装根，形如 versions/0.2.5。 */
  candidateRel: string | null;
  error: string | null;
  logFile: string | null;
  attempt: number;
  startedAt: string | null;
  updatedAt: string;
}

export interface PhaseLogLine {
  phase: string;
  event: 'start' | 'end' | 'fail';
  at: string;
  ms?: number;
  result?: 'ok' | 'fail';
  detail?: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

export function formatPhaseLog(line: PhaseLogLine): string {
  return JSON.stringify(line);
}

export function parsePhaseLog(line: string): PhaseLogLine {
  const raw = JSON.parse(line) as PhaseLogLine;
  if (!raw || (raw.event !== 'start' && raw.event !== 'end' && raw.event !== 'fail')) {
    throw new LayoutError('阶段日志无法解析');
  }
  if (typeof raw.phase !== 'string' || typeof raw.at !== 'string') throw new LayoutError('阶段日志无法解析');
  return raw;
}

function versionOk(value: unknown): value is string {
  return typeof value === 'string' && VERSION_DIR_RE.test(value);
}

export function parseUpdaterState(text: string): UpdaterState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LayoutError('updater/state.json 无法解析');
  }
  if (!raw || typeof raw !== 'object') throw new LayoutError('updater/state.json 无法解析');
  const row = raw as Record<string, unknown>;
  if (row.schema !== STATE_SCHEMA) throw new LayoutError('updater/state.json schema 不是 1');
  if (typeof row.phase !== 'string' || !UPDATER_PHASES.includes(row.phase as UpdaterPhase)) {
    throw new LayoutError('updater/state.json 的 phase 不合法');
  }
  if (!versionOk(row.fromVersion)) throw new LayoutError('updater/state.json 的 fromVersion 不合法');
  if (row.toVersion !== null && !versionOk(row.toVersion)) throw new LayoutError('updater/state.json 的 toVersion 不合法');
  if (row.candidateRel !== null) {
    const rel = row.candidateRel;
    const to = row.toVersion;
    if (typeof rel !== 'string' || typeof to !== 'string' || rel !== `${VERSIONS_DIR}/${to}`) {
      throw new LayoutError('updater/state.json 的 candidateRel 不合法');
    }
  }
  if (row.error !== null && typeof row.error !== 'string') throw new LayoutError('updater/state.json 的 error 不合法');
  if (row.logFile !== null && typeof row.logFile !== 'string') throw new LayoutError('updater/state.json 的 logFile 不合法');
  if (typeof row.attempt !== 'number' || !Number.isInteger(row.attempt) || row.attempt < 0) {
    throw new LayoutError('updater/state.json 的 attempt 不合法');
  }
  if (row.startedAt !== null && (typeof row.startedAt !== 'string' || !ISO.test(row.startedAt))) {
    throw new LayoutError('updater/state.json 的 startedAt 不合法');
  }
  if (typeof row.updatedAt !== 'string' || !ISO.test(row.updatedAt)) {
    throw new LayoutError('updater/state.json 的 updatedAt 不合法');
  }
  return {
    schema: 1,
    phase: row.phase as UpdaterPhase,
    fromVersion: row.fromVersion,
    toVersion: row.toVersion as string | null,
    candidateRel: row.candidateRel as string | null,
    error: row.error as string | null,
    logFile: row.logFile as string | null,
    attempt: row.attempt,
    startedAt: row.startedAt as string | null,
    updatedAt: row.updatedAt,
  };
}
