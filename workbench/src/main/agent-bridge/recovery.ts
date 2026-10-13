/**
 * 重启对账与备份策略。
 * 不调用批准，不执行计划，不写 SQLite。
 * 非终态请求只和计划服务对账：已执行的同步成 success/failed/conflict，仍是草稿的留在 awaiting_approval。
 */
import type { BridgeStatus } from './types';

export const BRIDGE_BACKUP_POLICY = {
  /** 工作区导出文件。桥目录不写进去。 */
  layoutFile: '.kblayout.json',
  includedInWorkspaceLayout: false,
  /** 相对 userData。默认桥根就是这个目录。 */
  userDataRelative: 'agent-bridge/',
  /** docs/12 的迁移备份只含 workbench.db、themes/、plugins/，不含本目录。 */
  migrationBackupIncludesBridge: false,
  /** 与 docs/12 一致：导入前备份和手动备份一共保留最近 5 份。 */
  migrationBackupKeep: 5,
  /** 整份 userData（含 agent-bridge）被拷回时，启动对账，不重放写操作。 */
  onUserDataRestore: 'reconcile-nonterminal-no-apply',
  /** 没有超时。关掉待批准窗口不等于拒绝。 */
  approvalTimeout: false,
} as const;

export function isNonTerminal(status: BridgeStatus | string): boolean {
  return status === 'pending' || status === 'awaiting_approval' || status === 'running';
}

export function savedContentHash(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const hash = (result as { contentHash?: unknown }).contentHash;
  return typeof hash === 'string' && hash.length > 0 ? hash : null;
}
