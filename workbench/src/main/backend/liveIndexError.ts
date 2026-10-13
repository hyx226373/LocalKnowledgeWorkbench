export type LiveIndexErrorKind = 'locked' | 'busy' | 'full' | 'other';

function sqliteCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** 只看 SQLite 的 code。消息里出现 locked/busy/full 也不算。 */
export function classifyLiveIndexError(error: unknown): LiveIndexErrorKind {
  switch (sqliteCode(error)) {
    case 'SQLITE_LOCKED':
    case 'SQLITE_LOCKED_SHAREDCACHE':
      return 'locked';
    case 'SQLITE_BUSY':
    case 'SQLITE_BUSY_TIMEOUT':
      return 'busy';
    case 'SQLITE_FULL':
      return 'full';
    default:
      return 'other';
  }
}
