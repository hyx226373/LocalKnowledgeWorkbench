import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildOverview } from '../../src/shared/workspacePicker/overview';
import {
  TEMPORARY_WORKSPACE_ID,
  keepOverviewForEmptyLibrary,
  overviewEntries,
  presetRefs,
} from '../../src/renderer/workspace-picker/mount';

describe('工作区总览挂载', () => {
  it('零个已保存工作区保持总览，临时现场不进分组', () => {
    expect(keepOverviewForEmptyLibrary(0, false)).toBe(true);
    expect(keepOverviewForEmptyLibrary(0, true)).toBe(false);
    expect(keepOverviewForEmptyLibrary(2, false)).toBe(false);
    const model = buildOverview({
      entries: overviewEntries([], true),
      currentId: TEMPORARY_WORKSPACE_ID,
      overviewHidden: false,
      presets: presetRefs([
        { id: 'builtin.single', label: '单栏' },
        { id: '', label: '缺 id' },
      ]),
      ui: { search: '临时', selectedId: null },
    });
    expect(model.mode).toBe('welcome');
    expect(model.autoCreatesDefaultWorkspace).toBe(false);
    expect(model.writesLibrary).toBe(false);
    expect(model.unsaved?.id).toBe(TEMPORARY_WORKSPACE_ID);
    expect(model.unsaved?.temporary).toBe(true);
    expect(model.unsaved?.name).toBe('临时现场');
    expect(JSON.stringify(model.sections)).not.toContain(TEMPORARY_WORKSPACE_ID);
    expect(model.presets).toEqual([{ id: 'builtin.single', label: '单栏' }]);
  });

  it('已保存行只映射列表里已有的字段', () => {
    const [entry] = overviewEntries([{ id: 'a', name: '论文', project: '考研', lastOpenedAt: 5, panelCount: 2 }], false);
    expect(entry?.temporary).toBeUndefined();
    expect(entry?.summary.lastUsedAt).toBe(5);
    expect(entry?.summary.project).toBe('考研');
    expect(entry?.summary.favorite).toBe(false);
    expect(entry?.summary.counts).toEqual({ files: 0, webs: 0, apps: 0, panels: 2 });
  });

  it('passes favorite from list row into overview entry', () => {
    const [entry] = overviewEntries([{ id: 'b', name: 'fav-ws', project: '', lastOpenedAt: null, panelCount: 0, favorite: true }], false);
    expect(entry?.summary.favorite).toBe(true);
  });

  it('挂载文件不把进入动作放进白名单，也不接宿主', () => {
    const mount = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/mount.ts'), 'utf8');
    const app = readFileSync(path.join(process.cwd(), 'src/renderer/MainShell.tsx'), 'utf8');
    for (const word of ['catalog_id', 'host.attach', 'createWin32Helper', 'setVisible', 'INVOKE_WHITELIST', 'workspace.enter']) {
      expect(mount, word).not.toContain(word);
      expect(app, word).not.toContain(word);
    }
    expect(app).toContain('WorkspaceOverview');
    expect(app).toContain('onEnterTemporary');
    expect(app).toContain('keepOverviewForEmptyLibrary');
    const skipDefault = app.indexOf('listed.length === 0');
    const current = app.indexOf('kb.getCurrentWorkspaceId()');
    expect(skipDefault).toBeGreaterThan(0);
    expect(current).toBeGreaterThan(skipDefault);
  });
});
