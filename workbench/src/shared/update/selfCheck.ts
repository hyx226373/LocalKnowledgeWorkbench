export interface SelfCheckInput {
  dbOpened: boolean;
  migrationOk: boolean;
  windowLoaded: boolean;
  dbError?: string;
  migrationError?: string;
  windowError?: string;
}

export function judgeSelfCheck(input: SelfCheckInput): { ok: true } | { ok: false; reason: string } {
  if (!input.dbOpened) return { ok: false, reason: input.dbError || '数据库打不开' };
  if (!input.migrationOk) return { ok: false, reason: input.migrationError || '数据库迁移失败' };
  if (!input.windowLoaded) return { ok: false, reason: input.windowError || '主窗口没有加载完成' };
  return { ok: true };
}

export function decideAfterSelfCheck(
  pending: { fromVersion: string; toVersion: string; backupId: string } | undefined,
  check: { ok: true } | { ok: false; reason: string },
):
  | { action: 'none' }
  | { action: 'clear' }
  | { action: 'rollback'; backupId: string; previousVersion: string; reason: string } {
  if (!pending) return { action: 'none' };
  if (check.ok) return { action: 'clear' };
  return {
    action: 'rollback',
    backupId: pending.backupId,
    previousVersion: pending.fromVersion,
    reason: check.reason,
  };
}
