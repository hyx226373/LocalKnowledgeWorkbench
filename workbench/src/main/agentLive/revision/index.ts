export {
  createLiveRevisionLog,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECONCILE_MS,
  DEFAULT_RETAIN_REVISIONS,
  DEFAULT_RETAIN_MS,
  DEFAULT_SEGMENT_REVISIONS,
  DEFAULT_SEGMENT_BYTES,
} from './log';
export type { AgentLiveRevision, LiveRevisionOptions } from './log';

export { createRevisionHandlers, revisionActions } from './handlers';
export type { RevisionInvokeResult } from './handlers';

export { bindPlanSubmission, checkBoundExecution, runBoundPlan } from './planGuard';
export type { BindPlanInput, PlanCheck, PlanCheckEnv } from './planGuard';

export { DIFF_INLINE_MAX, DIFF_TIMEOUT_MS, diffTooLarge, unifiedDiff } from './diffText';
export { formatHash, hashBuffer, hashFile, hashHex, isSecretPath, sameHash } from './hash';
export { AgentLiveError, assertSafeId } from './errors';
export { TEXT_COPY_MAX, isTransientPath, textKind } from './textKind';
