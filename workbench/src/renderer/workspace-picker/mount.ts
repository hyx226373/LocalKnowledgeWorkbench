/**
 * 总览挂载的纯数据。不写库。
 * 临时现场的 id 不进 workspaces 表，因此零工作区不会落成默认工作区。
 * 列表已回传 favorite；用途/标签等其余卡片字段仍默认；面板数用已有 panelCount。
 */
import type { OverviewEntryInput, OverviewPresetRef } from '../../shared/workspacePicker/overview';
import { summaryFromRow } from '../../shared/workspacePicker/summary';
import { TEMPORARY_WORKSPACE_ID } from '../../shared/temporaryWorkspace';

export { TEMPORARY_WORKSPACE_ID };

export interface OverviewWorkspaceRow {
  id: string;
  name: string;
  project: string;
  lastOpenedAt: number | null;
  panelCount: number;
  favorite?: boolean;
}

export function overviewEntryFromWorkspace(row: OverviewWorkspaceRow): OverviewEntryInput {
  return {
    summary: summaryFromRow({
      id: row.id,
      name: row.name,
      project: row.project,
      lastOpenedAt: row.lastOpenedAt,
      favorite: row.favorite === true,
      counts: { files: 0, webs: 0, apps: 0, panels: row.panelCount },
    }),
  };
}

export function temporaryOverviewEntry(): OverviewEntryInput {
  return {
    temporary: true,
    summary: summaryFromRow({
      id: TEMPORARY_WORKSPACE_ID,
      name: '临时现场',
      project: '',
      favorite: false,
      counts: { files: 0, webs: 0, apps: 0, panels: 0 },
    }),
  };
}

export function overviewEntries(saved: readonly OverviewWorkspaceRow[], temporary: boolean): OverviewEntryInput[] {
  const entries = saved.map(overviewEntryFromWorkspace);
  if (temporary) entries.push(temporaryOverviewEntry());
  return entries;
}

export function presetRefs(presets: readonly { id: string; label: string }[]): OverviewPresetRef[] {
  return presets.filter((preset) => preset.id && preset.label).map((preset) => ({ id: preset.id, label: preset.label }));
}

/** 还没有已保存工作区、也没有进入临时现场时，总览不能关掉。 */
export function keepOverviewForEmptyLibrary(savedCount: number, temporary: boolean): boolean {
  return savedCount === 0 && !temporary;
}
