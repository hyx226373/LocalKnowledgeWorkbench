import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  WORKSPACE_PICKER_SETTINGS_KEY,
  planStartup,
  readWorkspacePickerSettings,
  startupReadsCurrentId,
  withWorkspacePickerSettings,
  writeWorkspacePickerSettings,
  type StartupPlan,
} from '../../src/shared/workspacePicker/settings';
import { DEFAULT_WORKSPACE_PICKER_SETTINGS, type WorkspacePickerSettings } from '../../src/shared/workspacePicker/types';

function settings(patch: Partial<WorkspacePickerSettings>): WorkspacePickerSettings {
  return { ...DEFAULT_WORKSPACE_PICKER_SETTINGS, ...patch };
}

/** 与 App onReady 相同的顺序：零工作区先返回，其后才可能读取当前工作区。 */
function decide(savedWorkspaceIds: readonly string[], value: WorkspacePickerSettings, readCurrent: () => string): StartupPlan {
  if (savedWorkspaceIds.length === 0) return planStartup({ settings: value, savedWorkspaceIds, lastWorkspaceId: null });
  const lastId = startupReadsCurrentId(savedWorkspaceIds, value) ? readCurrent() : null;
  return planStartup({ settings: value, savedWorkspaceIds, lastWorkspaceId: lastId });
}

describe('工作区启动设置', () => {
  it('解析与写出保持 v1，不带多余字段', () => {
    expect(WORKSPACE_PICKER_SETTINGS_KEY).toBe('settings.workspacePicker');
    const raw = { v: 1, startup: 'overview', startupWorkspaceId: 'a', overviewHidden: true, extra: true };
    expect(readWorkspacePickerSettings(raw)).toEqual({
      v: 1,
      startup: 'overview',
      startupWorkspaceId: 'a',
      overviewHidden: true,
      snapshotEnabled: true,
    });
    expect(writeWorkspacePickerSettings(readWorkspacePickerSettings(raw))).toEqual({
      v: 1,
      startup: 'overview',
      startupWorkspaceId: 'a',
      overviewHidden: true,
      snapshotEnabled: true,
    });
    expect(readWorkspacePickerSettings({ ...raw, snapshotEnabled: false })).toEqual({
      v: 1,
      startup: 'overview',
      startupWorkspaceId: 'a',
      overviewHidden: true,
      snapshotEnabled: false,
    });
    expect(withWorkspacePickerSettings(DEFAULT_WORKSPACE_PICKER_SETTINGS, { startup: 'workspace', startupWorkspaceId: 'a' })).toEqual({
      v: 1,
      startup: 'workspace',
      startupWorkspaceId: 'a',
      overviewHidden: false,
      snapshotEnabled: true,
    });
    expect(
      withWorkspacePickerSettings(settings({ snapshotEnabled: false, startup: 'overview', startupWorkspaceId: 'a' }), {
        startup: 'workspace',
      }),
    ).toEqual({
      v: 1,
      startup: 'workspace',
      startupWorkspaceId: 'a',
      overviewHidden: false,
      snapshotEnabled: false,
    });
  });

  it('三种 startup；无效 id 回落；总览保持关闭时按继续上次', () => {
    const read = vi.fn(() => 'b');
    const last = decide(['a', 'b'], settings({ startup: 'last' }), read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(last).toEqual({ kind: 'last', openOverview: false, loadWorkspaceId: 'b', readCurrentWorkspaceId: true, writeLibrary: false });

    read.mockClear();
    const overview = decide(['a', 'b'], settings({ startup: 'overview' }), read);
    expect(read).not.toHaveBeenCalled();
    expect(overview).toEqual({ kind: 'overview', openOverview: true, loadWorkspaceId: null, readCurrentWorkspaceId: false, writeLibrary: false });

    read.mockClear();
    const hiddenOverview = decide(['a', 'b'], settings({ startup: 'overview', overviewHidden: true }), read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(hiddenOverview).toEqual({ kind: 'last', openOverview: false, loadWorkspaceId: 'b', readCurrentWorkspaceId: true, writeLibrary: false });

    read.mockClear();
    const chosen = decide(['a', 'b'], settings({ startup: 'workspace', startupWorkspaceId: 'a' }), read);
    expect(read).not.toHaveBeenCalled();
    expect(chosen).toEqual({ kind: 'workspace', openOverview: false, loadWorkspaceId: 'a', readCurrentWorkspaceId: false, writeLibrary: false });

    read.mockClear();
    const missing = decide(['a', 'b'], settings({ startup: 'workspace', startupWorkspaceId: 'missing' }), read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(missing).toEqual({ kind: 'last', openOverview: false, loadWorkspaceId: 'b', readCurrentWorkspaceId: true, writeLibrary: false });

    const nullId = decide(['a'], settings({ startup: 'workspace', startupWorkspaceId: null }), () => 'a');
    expect(nullId).toEqual({ kind: 'last', openOverview: false, loadWorkspaceId: 'a', readCurrentWorkspaceId: true, writeLibrary: false });
  });

  it('零工作区不读取当前工作区、不落库，即使启动设置指向某个 id', () => {
    const read = vi.fn(() => 'should-not');
    const plan = decide([], settings({ startup: 'workspace', startupWorkspaceId: 'ghost', overviewHidden: false }), read);
    expect(read).not.toHaveBeenCalled();
    expect(startupReadsCurrentId([], settings({ startup: 'last' }))).toBe(false);
    expect(plan).toEqual({ kind: 'welcome', openOverview: true, loadWorkspaceId: null, readCurrentWorkspaceId: false, writeLibrary: false });
    const src = readFileSync(path.join(process.cwd(), 'src/shared/workspacePicker/settings.ts'), 'utf8');
    expect(src).not.toContain('getCurrentWorkspaceId');
    expect(src).not.toContain('setLayout');
    expect(src).not.toContain('createWorkspace');

    const app = readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');
    const start = app.indexOf('const onReady = useCallback');
    const end = app.indexOf('panelManager.setHost');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = app.slice(start, end);
    expect(body).toContain('startupReadsCurrentId');
    expect(body).toContain('planStartup');
    expect(body).not.toContain('setLayout');
    expect(body).not.toContain('createWorkspace');
    const zero = body.indexOf('listed.length === 0');
    const current = body.indexOf('kb.getCurrentWorkspaceId()');
    expect(zero).toBeGreaterThan(0);
    expect(current).toBeGreaterThan(zero);
    expect(app).not.toContain('setVisible');
    expect(app).not.toContain('createWin32Helper');
  });
});
