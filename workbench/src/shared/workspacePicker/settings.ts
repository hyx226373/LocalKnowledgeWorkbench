import { DEFAULT_WORKSPACE_PICKER_SETTINGS, type StartupResolution, type WorkspacePickerSettings } from './types';

export function parseWorkspacePickerSettings(raw: unknown): WorkspacePickerSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WORKSPACE_PICKER_SETTINGS };
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return { ...DEFAULT_WORKSPACE_PICKER_SETTINGS };
  const startup = o.startup === 'overview' || o.startup === 'last' || o.startup === 'workspace' ? o.startup : 'last';
  const startupWorkspaceId = typeof o.startupWorkspaceId === 'string' ? o.startupWorkspaceId : null;
  return {
    v: 1,
    startup,
    startupWorkspaceId,
    overviewHidden: o.overviewHidden === true,
    snapshotEnabled: snapshotEnabledOf(o.snapshotEnabled),
  };
}

/** 旧 v:1 没有该字段时为 true。只有显式 false 才关闭。 */
function snapshotEnabledOf(raw: unknown): boolean {
  return raw !== false;
}

function lastOf(lastWorkspaceId: string | null, ids: ReadonlySet<string>): StartupResolution {
  if (typeof lastWorkspaceId === 'string' && ids.has(lastWorkspaceId)) return { kind: 'last', workspaceId: lastWorkspaceId };
  return { kind: 'last', workspaceId: null };
}

/**
 * 已保存工作区为空时一律欢迎页，不返回虚构的默认工作区 id。
 * startup=workspace 但 id 无效或 null 时按 last。
 */
export function resolveStartup(input: {
  settings: WorkspacePickerSettings;
  savedWorkspaceIds: readonly string[];
  lastWorkspaceId: string | null;
}): StartupResolution {
  if (input.savedWorkspaceIds.length === 0) return { kind: 'welcome' };
  const ids = new Set(input.savedWorkspaceIds);
  if (input.settings.startup === 'overview') return { kind: 'overview' };
  if (input.settings.startup === 'workspace') {
    const id = input.settings.startupWorkspaceId;
    if (typeof id === 'string' && ids.has(id)) return { kind: 'workspace', workspaceId: id };
    return lastOf(input.lastWorkspaceId, ids);
  }
  return lastOf(input.lastWorkspaceId, ids);
}

/** 零行也不自动建已保存的默认工作区。savedCount 不改变结果。 */
export function shouldAutoCreateDefaultWorkspace(savedCount: number): boolean {
  void savedCount;
  return false;
}

/** layout 键。读写走这份对象，不另建表。 */
export const WORKSPACE_PICKER_SETTINGS_KEY = 'settings.workspacePicker';

export function readWorkspacePickerSettings(raw: unknown): WorkspacePickerSettings {
  return parseWorkspacePickerSettings(raw);
}

/** 纯序列化，不写库。 */
export function writeWorkspacePickerSettings(settings: WorkspacePickerSettings): WorkspacePickerSettings {
  return parseWorkspacePickerSettings(settings);
}

export function withWorkspacePickerSettings(
  current: WorkspacePickerSettings,
  patch: Partial<Pick<WorkspacePickerSettings, 'startup' | 'startupWorkspaceId' | 'overviewHidden' | 'snapshotEnabled'>>,
): WorkspacePickerSettings {
  return parseWorkspacePickerSettings({
    v: 1,
    startup: patch.startup ?? current.startup,
    startupWorkspaceId: patch.startupWorkspaceId !== undefined ? patch.startupWorkspaceId : current.startupWorkspaceId,
    overviewHidden: patch.overviewHidden !== undefined ? patch.overviewHidden : current.overviewHidden,
    snapshotEnabled: patch.snapshotEnabled !== undefined ? patch.snapshotEnabled : current.snapshotEnabled,
  });
}

export interface StartupPlan {
  kind: 'welcome' | 'overview' | 'last' | 'workspace';
  openOverview: boolean;
  loadWorkspaceId: string | null;
  /** 为 true 时调用方才可以读取当前工作区 id。零工作区恒为 false。 */
  readCurrentWorkspaceId: boolean;
  writeLibrary: false;
}

/** 总览已关时，startup=overview 改为继续上次，避免下次启动把总览重新打开。 */
function startupForResolve(settings: WorkspacePickerSettings): WorkspacePickerSettings {
  if (settings.startup === 'overview' && settings.overviewHidden === true) return { ...settings, startup: 'last' };
  return settings;
}

/**
 * 零工作区时恒为 false，调用方不得读取当前工作区 id。
 * 指定工作区且 id 在列表中时也不读。无效 id 与继续上次才读。
 */
export function startupReadsCurrentId(savedWorkspaceIds: readonly string[], settings: WorkspacePickerSettings): boolean {
  if (savedWorkspaceIds.length === 0) return false;
  const effective = startupForResolve(settings);
  if (effective.startup === 'overview') return false;
  if (effective.startup === 'workspace') {
    const id = effective.startupWorkspaceId;
    return !(typeof id === 'string' && savedWorkspaceIds.includes(id));
  }
  return true;
}

/** 启动分支。不写库。lastWorkspaceId 只在 startupReadsCurrentId 为 true 时才有意义。 */
export function planStartup(input: {
  settings: WorkspacePickerSettings;
  savedWorkspaceIds: readonly string[];
  lastWorkspaceId: string | null;
}): StartupPlan {
  const readCurrentWorkspaceId = startupReadsCurrentId(input.savedWorkspaceIds, input.settings);
  if (input.savedWorkspaceIds.length === 0) {
    return { kind: 'welcome', openOverview: true, loadWorkspaceId: null, readCurrentWorkspaceId: false, writeLibrary: false };
  }
  const resolved = resolveStartup({
    settings: startupForResolve(input.settings),
    savedWorkspaceIds: input.savedWorkspaceIds,
    lastWorkspaceId: input.lastWorkspaceId,
  });
  if (resolved.kind === 'welcome') {
    return { kind: 'welcome', openOverview: true, loadWorkspaceId: null, readCurrentWorkspaceId: false, writeLibrary: false };
  }
  if (resolved.kind === 'overview') {
    return { kind: 'overview', openOverview: true, loadWorkspaceId: null, readCurrentWorkspaceId: false, writeLibrary: false };
  }
  if (resolved.kind === 'workspace') {
    return { kind: 'workspace', openOverview: false, loadWorkspaceId: resolved.workspaceId, readCurrentWorkspaceId: false, writeLibrary: false };
  }
  return {
    kind: 'last',
    openOverview: false,
    loadWorkspaceId: resolved.workspaceId,
    readCurrentWorkspaceId,
    writeLibrary: false,
  };
}
