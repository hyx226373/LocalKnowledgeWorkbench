/** 外贴 27 冻结入口。各组只导入，不改这个目录。 */
export {
  ATOMIC_RENAME_ATTEMPTS,
  ATOMIC_RENAME_DELAYS_MS,
  LayoutError,
  writeAtomicJson,
  type AtomicIo,
} from './atomicJson';
export { parseCurrent, pointAt, pointBack, readCurrent, writeCurrent, type CurrentPointer } from './current';
export { parseHandoff, type UpdateHandoff } from './handoff';
export { verifyVersionTree, type TreeCheck } from './integrity';
export { mayLauncherWritePointer, planLaunch, type LaunchPlan } from './launchPlan';
export { parseDirpack, type DirPackManifest } from './manifest';
export { compareCore, planMigration, versionDirName, type MigrationPlan } from './migratePlan';
export {
  APP_EXE,
  CURRENT_FILE,
  CURRENT_SCHEMA,
  DIRPACK_FILE,
  DIRPACK_SCHEMA,
  dirZipName,
  HANDOFF_REL,
  HANDOFF_SCHEMA,
  LAUNCHER_DIR,
  LAUNCHER_EXE,
  LAUNCHER_LOCK_REL,
  LOCK_REL,
  MIN_MIGRATE_BASELINE,
  PHASE_TIMEOUT_MS,
  READY_MARKER_FILE,
  READY_SCHEMA,
  RESTART_TO_UPDATE_BODY,
  RESTART_TO_UPDATE_TITLE,
  SHORTCUT_NAME,
  STATE_REL,
  STATE_SCHEMA,
  UPDATE_WINDOW_TITLE,
  UPDATER_DIR,
  UPDATER_EXE,
  VERSION_DIR_RE,
  VERSION_TREE_REQUIRED,
  VERSIONS_DIR,
} from './names';
export {
  appExe,
  assertVersionDirName,
  candidateRel,
  currentFile,
  handoffFile,
  installPath,
  isUnderStudyDev,
  launcherExe,
  launcherLockFile,
  stateFile,
  updateLockFile,
  updaterExe,
  versionDir,
} from './paths';
export { decideRecovery, type RecoverAction } from './recover';
export {
  formatPhaseLog,
  parsePhaseLog,
  parseUpdaterState,
  UPDATER_PHASES,
  type PhaseLogLine,
  type UpdaterPhase,
  type UpdaterState,
} from './state';
