export {
  DEFAULT_WORKSPACE_PICKER_SETTINGS,
  QUICK_SWITCH_DEFAULT_KEY,
  WORKSPACE_CARD_CLASS,
} from './types';
export type {
  CountInput,
  LayoutThumbModel,
  LayoutThumbNode,
  RestoreEvent,
  RestorePhase,
  RestoreSource,
  StartupResolution,
  ThumbItem,
  ThumbLayout,
  WebPhaseEvent,
  WorkspaceCounts,
  WorkspaceDetail,
  WorkspacePickerSettings,
  WorkspaceStartup,
  WorkspaceSummary,
} from './types';

export { normalizeAccent, normalizeCoverRef, normalizePurpose, normalizeTags } from './normalize';
export { summaryFromRow } from './summary';
export { countWorkspace } from './count';
export { layoutThumbModel } from './layoutThumb';
export { restorePhase } from './restore';
export {
  WORKSPACE_PICKER_SETTINGS_KEY,
  parseWorkspacePickerSettings,
  planStartup,
  readWorkspacePickerSettings,
  resolveStartup,
  shouldAutoCreateDefaultWorkspace,
  startupReadsCurrentId,
  withWorkspacePickerSettings,
  writeWorkspacePickerSettings,
} from './settings';
export type { StartupPlan } from './settings';
export {
  OVERVIEW_EDIT_FIELDS,
  OVERVIEW_FILTERS,
  OVERVIEW_UNGROUPED_PROJECT,
  buildOverview,
  dispatchOverview,
  initialOverviewUi,
  overviewGate,
  overviewMatchesQuery,
  overviewSectionsForFilter,
  workspaceCardClassName,
} from './overview';
export type {
  OverviewActions,
  OverviewCardModel,
  OverviewDetailInput,
  OverviewDetailModel,
  OverviewDispatchResult,
  OverviewEditButtonModel,
  OverviewEditField,
  OverviewEntryInput,
  OverviewFilterId,
  OverviewGate,
  OverviewGroupModel,
  OverviewInput,
  OverviewIntent,
  OverviewModel,
  OverviewPresetRef,
  OverviewSectionModel,
  OverviewServiceActionModel,
  OverviewUiState,
  OverviewWelcomeModel,
} from './overview';
export { assessSnapshotCapture, guardSnapshotWrite } from './snapshotGuard';
export type { SnapshotCaptureDecision, SnapshotGuardReason, SnapshotGuardResult } from './snapshotGuard';
export { decideSnapshotCapture, snapshotPngSampleXor, WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL } from './snapshotCapture';
export type { SnapshotPixelSource, WorkspaceSnapshotRequest } from './snapshotCapture';
export { planSnapshotCacheDelete, snapshotCacheFileName } from './snapshotCache';
