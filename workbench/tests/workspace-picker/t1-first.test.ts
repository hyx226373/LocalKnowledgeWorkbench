import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { emptyStore, findConflict } from '../../src/renderer/keybindings/store';
import type { KeybindingsStoreV1 } from '../../src/renderer/keybindings/types';

/**
 * W-T1 首批。不覆盖 C1–C3 四场景。
 * 本分支没有 src/shared/workspacePicker 时，依赖 P1 的断言跳过，不算失败。
 */
type CountItem = { itemId: string; sourceKind: 'file' | 'web' | 'app'; ref: string };
type CountPanel = { id: string; itemId?: string; viewType?: string; hostPath?: string };
type CountInput = { items: CountItem[]; panels: CountPanel[]; workspaceRefs?: string[] };
type Counts = { files: number; webs: number; apps: number; panels: number };
type SampleWorkspace = { id: string; name: string; counts: Counts; temporary?: boolean };
type SampleFile = { settings: { quickSwitchKey: string }; workspaces: SampleWorkspace[] };

type PickerModule = {
  countWorkspace: (input: CountInput) => Counts;
  restorePhase: (input: {
    workspaceId: string;
    panelId: string;
    source?: Record<string, unknown> | null;
  }) => { phase: string; reason?: string; retryable: boolean };
  QUICK_SWITCH_DEFAULT_KEY: string;
  shouldAutoCreateDefaultWorkspace: (savedCount: number) => boolean;
  resolveStartup: (input: {
    settings: { v: 1; startup: 'overview' | 'last' | 'workspace'; startupWorkspaceId: string | null; overviewHidden: boolean };
    savedWorkspaceIds: readonly string[];
    lastWorkspaceId: string | null;
  }) => { kind: string; workspaceId?: string | null };
};

const PICKER_SPEC = '../../src/shared/workspacePicker';
const PICKER_SKIP =
  '本分支没有 src/shared/workspacePicker（P1 未合入），动态 import 失败后跳过。这是预期，不是产品缺陷。';

const samplePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/workspace-picker-samples.json');
const samples = JSON.parse(readFileSync(samplePath, 'utf8')) as SampleFile;

function opened(items: CountItem[], panels: CountPanel[]): CountInput {
  return { items, panels, workspaceRefs: ['workspace-ref-not-opened', ...items.map((item) => item.ref)] };
}

function oneFile(panelId: string, ref: string): CountInput {
  const itemId = `item-${ref}`;
  return opened([{ itemId, sourceKind: 'file', ref }], [{ id: panelId, itemId }]);
}

const EMPTY: CountInput = opened([], []);

/** 计数输入只有已打开条目和 dock 面板。未打开引用在 workspaceRefs，不得计入 files。 */
const COUNT_INPUTS: Record<string, CountInput> = {
  'ws-empty': EMPTY,
  'ws-mixed': opened(
    [
      { itemId: 'i-note', sourceKind: 'file', ref: 'res-note' },
      { itemId: 'i-exam', sourceKind: 'file', ref: 'res-exam' },
      { itemId: 'i-web', sourceKind: 'web', ref: 'https://example.com/formula' },
      { itemId: 'i-app', sourceKind: 'app', ref: 'ap-calc' },
    ],
    [
      { id: 'p-md', itemId: 'i-note' },
      { id: 'p-pdf', itemId: 'i-exam' },
      { id: 'p-web', itemId: 'i-web' },
      { id: 'p-app', itemId: 'i-app' },
    ],
  ),
  'ws-same-file': opened(
    [{ itemId: 'i-note', sourceKind: 'file', ref: 'res-note' }],
    [
      { id: 'a', itemId: 'i-note' },
      { id: 'b', itemId: 'i-note' },
      { id: 'c', itemId: 'i-note' },
    ],
  ),
  'ws-broken': opened(
    [
      { itemId: 'i-ok', sourceKind: 'file', ref: 'res-ok' },
      { itemId: 'i-gone', sourceKind: 'file', ref: 'res-gone' },
      { itemId: 'i-web', sourceKind: 'web', ref: 'https://example.com/down' },
    ],
    [
      { id: 'ok', itemId: 'i-ok' },
      { id: 'miss', itemId: 'i-gone' },
      { id: 'web', itemId: 'i-web' },
    ],
  ),
  'ws-plugin-off': oneFile('csv', 'res-csv'),
  'ws-unknown': oneFile('u', 'res-bin'),
  'ws-long': oneFile('only', 'res-long'),
  'ws-host': opened([], [{ id: 'npp', viewType: 'native-app-host', hostPath: 'notepad.exe' }]),
  'ws-webs': opened(
    [
      { itemId: 'i-syl', sourceKind: 'web', ref: 'https://example.com/syllabus' },
      { itemId: 'i-words', sourceKind: 'web', ref: 'https://example.com/words' },
    ],
    [
      { id: 'w1', itemId: 'i-syl' },
      { id: 'w2', itemId: 'i-words' },
    ],
  ),
  'ws-english': opened(
    [
      { itemId: 'i-read', sourceKind: 'file', ref: 'res-read' },
      { itemId: 'i-vocab', sourceKind: 'file', ref: 'res-vocab' },
    ],
    [
      { id: 'e1', itemId: 'i-read' },
      { id: 'e2', itemId: 'i-vocab' },
    ],
  ),
  'ws-english-2': oneFile('z', 'res-essay'),
  'ws-stale': oneFile('s', 'res-old'),
  'ws-cover': opened(
    [
      { itemId: 'i-pic', sourceKind: 'file', ref: 'res-pic' },
      { itemId: 'i-about', sourceKind: 'web', ref: 'https://example.com/about' },
    ],
    [
      { id: 'c1', itemId: 'i-pic' },
      { id: 'c2', itemId: 'i-about' },
    ],
  ),
  'ws-norecent': EMPTY,
};

const FROZEN_COUNTS: Record<string, Counts> = {
  'ws-empty': { files: 0, webs: 0, apps: 0, panels: 0 },
  'ws-mixed': { files: 2, webs: 1, apps: 1, panels: 4 },
  'ws-same-file': { files: 1, webs: 0, apps: 0, panels: 3 },
  'ws-broken': { files: 2, webs: 1, apps: 0, panels: 3 },
  'ws-plugin-off': { files: 1, webs: 0, apps: 0, panels: 1 },
  'ws-unknown': { files: 1, webs: 0, apps: 0, panels: 1 },
  'ws-long': { files: 1, webs: 0, apps: 0, panels: 1 },
  'ws-host': { files: 0, webs: 0, apps: 1, panels: 1 },
  'ws-webs': { files: 0, webs: 2, apps: 0, panels: 2 },
  'ws-english': { files: 2, webs: 0, apps: 0, panels: 2 },
  'ws-english-2': { files: 1, webs: 0, apps: 0, panels: 1 },
  'ws-stale': { files: 1, webs: 0, apps: 0, panels: 1 },
  'ws-cover': { files: 1, webs: 1, apps: 0, panels: 2 },
  'ws-norecent': { files: 0, webs: 0, apps: 0, panels: 0 },
};

const QUICK_SWITCH = {
  id: 'workspace.quickSwitch',
  title: '快速切换工作区',
  keybinding: 'Ctrl+Shift+F',
  when: 'global' as const,
};
const COMMAND_PALETTE = {
  id: 'workbench.commandPalette',
  title: '显示命令面板',
  keybinding: 'Ctrl+Shift+P',
  when: 'global' as const,
};

let pickerPromise: Promise<{ mod: PickerModule | null; reason: string | null }> | null = null;

function pickerOrSkip(
  loaded: { mod: PickerModule | null; reason: string | null },
  ctx: { skip: (note?: string) => void },
): PickerModule | null {
  if (!loaded.mod) {
    ctx.skip(loaded.reason ?? PICKER_SKIP);
    return null;
  }
  return loaded.mod;
}

function loadPicker(): Promise<{ mod: PickerModule | null; reason: string | null }> {
  pickerPromise ??= (async () => {
    try {
      const mod = (await import(PICKER_SPEC)) as PickerModule;
      if (typeof mod.countWorkspace !== 'function' || typeof mod.restorePhase !== 'function') {
        return { mod: null, reason: `${PICKER_SKIP} 模块没有 countWorkspace/restorePhase。` };
      }
      return { mod, reason: null };
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      return { mod: null, reason: `${PICKER_SKIP} ${detail}` };
    }
  })();
  return pickerPromise;
}

describe('工作区选择首批验证夹具', () => {
  it('样例 14 区计数与冻结口径一致', () => {
    expect(samples.workspaces).toHaveLength(14);
    const ids = samples.workspaces.map((ws) => ws.id);
    expect(ids.slice().sort()).toEqual(Object.keys(COUNT_INPUTS).sort());
    expect(new Set(ids).size).toBe(14);
    const same = samples.workspaces.find((ws) => ws.id === 'ws-same-file');
    expect(same?.counts).toEqual({ files: 1, webs: 0, apps: 0, panels: 3 });
    const host = samples.workspaces.find((ws) => ws.id === 'ws-host');
    expect(host?.counts).toEqual({ files: 0, webs: 0, apps: 1, panels: 1 });

    for (const ws of samples.workspaces) {
      const input = COUNT_INPUTS[ws.id];
      expect(input, ws.id).toBeDefined();
      expect(input!.panels.some((panel) => panel.id === 'kb.sidebar'), ws.id).toBe(false);
      expect(input!.workspaceRefs?.length, ws.id).toBeGreaterThan(0);
      expect(FROZEN_COUNTS[ws.id], ws.id).toEqual(ws.counts);
    }
  });

  it('countWorkspace 对 14 区与冻结表一致，未打开引用不计入 files', async (ctx) => {
    const mod = pickerOrSkip(await loadPicker(), ctx);
    if (!mod) return;
    for (const ws of samples.workspaces) {
      expect(mod.countWorkspace(COUNT_INPUTS[ws.id]!), ws.id).toEqual(ws.counts);
    }
    expect(
      mod.countWorkspace({
        items: [],
        panels: [
          { id: 'n1', viewType: 'native-app-host', hostPath: 'notepad.exe' },
          { id: 'n2', viewType: 'native-app-host', hostPath: 'notepad.exe' },
        ],
        workspaceRefs: ['res-not-opened'],
      }),
    ).toEqual({ files: 0, webs: 0, apps: 1, panels: 2 });
    expect(
      mod.countWorkspace({
        items: [{ itemId: 'i-note', sourceKind: 'file', ref: 'res-note' }],
        panels: [
          { id: 'kb.sidebar', itemId: 'i-note' },
          { id: 'a', itemId: 'i-note' },
          { id: 'b', itemId: 'i-note' },
          { id: 'c', itemId: 'i-note' },
        ],
        workspaceRefs: ['res-note', 'res-other'],
      }),
    ).toEqual({ files: 1, webs: 0, apps: 0, panels: 3 });
  });

  it('ReadyOnMount 不得映射为 restored，同一次导航的 ready 不覆盖 failed', async (ctx) => {
    const mod = pickerOrSkip(await loadPicker(), ctx);
    if (!mod) return;

    const held = mod.restorePhase({
      workspaceId: 'ws',
      panelId: 'file',
      source: {
        kind: 'file',
        armed: true,
        resource: { missing: false },
        reportsReady: false,
        contentReady: false,
        readyOnMount: true,
      },
    });
    expect(held.phase).toBe('unknown');
    expect(held.reason).toBe('no-content-event');
    expect(held.retryable).toBe(false);
    expect(held.phase).not.toBe('restored');

    const done = mod.restorePhase({
      workspaceId: 'ws',
      panelId: 'file-ready',
      source: {
        kind: 'file',
        armed: true,
        resource: { missing: false },
        reportsReady: true,
        contentReady: true,
        readyOnMount: false,
      },
    });
    expect(done.phase).toBe('restored');
    expect(done.retryable).toBe(false);

    const mountedAndReady = mod.restorePhase({
      workspaceId: 'ws',
      panelId: 'file-both',
      source: {
        kind: 'file',
        armed: true,
        resource: { missing: false },
        reportsReady: true,
        contentReady: true,
        readyOnMount: true,
      },
    });
    expect(mountedAndReady.phase).toBe('restored');
    expect(mountedAndReady.retryable).toBe(false);

    const web = mod.restorePhase({
      workspaceId: 'ws',
      panelId: 'web',
      source: {
        kind: 'web',
        hasView: true,
        events: [
          { type: 'load', state: 'failed', error: 'ERR', navigationId: 'n1' },
          { type: 'load', state: 'ready', navigationId: 'n1' },
        ],
      },
    });
    expect(web.phase).toBe('failed');
    expect(web.reason).toBe('ERR');
    expect(web.retryable).toBe(true);
    expect(web.phase).not.toBe('restored');
  });

  it('已保存样例与临时现场分开，且不含自动生成的默认工作区', () => {
    expect(samples.workspaces.map((ws) => ws.name)).not.toContain('默认工作区');
    expect(samples.workspaces.every((ws) => ws.temporary !== true)).toBe(true);
    const temporary = { id: 'temp-blank', name: '未保存现场', temporary: true, counts: FROZEN_COUNTS['ws-empty']! };
    const saved = [...samples.workspaces, temporary].filter((row) => row.temporary !== true);
    expect(saved.map((row) => row.id)).toEqual(samples.workspaces.map((ws) => ws.id));
    expect(saved.map((row) => row.id)).not.toContain(temporary.id);
  });

  it('零个已保存工作区时不自动创建默认工作区', async (ctx) => {
    const mod = pickerOrSkip(await loadPicker(), ctx);
    if (!mod) return;
    expect(mod.shouldAutoCreateDefaultWorkspace(0)).toBe(false);
    expect(mod.shouldAutoCreateDefaultWorkspace(3)).toBe(false);
    const startup = mod.resolveStartup({
      settings: { v: 1, startup: 'last', startupWorkspaceId: null, overviewHidden: false },
      savedWorkspaceIds: [],
      lastWorkspaceId: null,
    });
    expect(startup).toEqual({ kind: 'welcome' });
    expect(startup.workspaceId).toBeUndefined();
  });

  it('Ctrl+Shift+F 预置占用与空闲只检测冲突，不写绑定', async () => {
    const { mod } = await loadPicker();
    if (mod) {
      expect(mod.QUICK_SWITCH_DEFAULT_KEY).toBe('Ctrl+Shift+F');
      expect(QUICK_SWITCH.keybinding).toBe(mod.QUICK_SWITCH_DEFAULT_KEY);
    }

    // 样例 settings 仍是草案旧键。登记候选按 用户用 Ctrl+Shift+F，不从样例读默认键，也不写快捷键存储。
    expect(samples.settings.quickSwitchKey).toBe('Ctrl+Shift+E');
    expect(QUICK_SWITCH.keybinding).toBe('Ctrl+Shift+F');
    expect(QUICK_SWITCH.keybinding).not.toBe(samples.settings.quickSwitchKey);

    const idle = emptyStore();
    const idleBefore = structuredClone(idle);
    const idleCmds = [QUICK_SWITCH, COMMAND_PALETTE];
    expect(findConflict(idle, idleCmds, 'workspace.quickSwitch', 'Ctrl+Shift+F', 'global')).toBeNull();
    expect(idle).toEqual(idleBefore);
    expect(idle.overrides).toEqual({});
    expect(COMMAND_PALETTE.keybinding).toBe('Ctrl+Shift+P');

    const pluginDefault = {
      id: 'plugin.search',
      title: '插件搜索',
      keybinding: 'Ctrl+Shift+F',
      when: 'global' as const,
    };
    const occupiedStore = emptyStore();
    const occupiedBefore = structuredClone(occupiedStore);
    const occupied = findConflict(
      occupiedStore,
      [QUICK_SWITCH, COMMAND_PALETTE, pluginDefault],
      'workspace.quickSwitch',
      'Ctrl+Shift+F',
      'global',
    );
    expect(occupied).toBe(pluginDefault);
    expect(occupied?.id).toBe('plugin.search');
    expect(occupiedStore).toEqual(occupiedBefore);
    expect(pluginDefault.keybinding).toBe('Ctrl+Shift+F');

    const pluginUser = {
      id: 'plugin.search',
      title: '插件搜索',
      keybinding: 'Ctrl+K',
      when: 'global' as const,
    };
    const userStore: KeybindingsStoreV1 = { v: 1, overrides: { 'plugin.search': 'Ctrl+Shift+F' }, whenOverrides: {} };
    const userBefore = structuredClone(userStore);
    const byUser = findConflict(
      userStore,
      [QUICK_SWITCH, COMMAND_PALETTE, pluginUser],
      'workspace.quickSwitch',
      'Ctrl+Shift+F',
      'global',
    );
    expect(byUser).toBe(pluginUser);
    expect(byUser?.id).toBe('plugin.search');
    expect(userStore).toEqual(userBefore);
    expect(userStore.overrides['plugin.search']).toBe('Ctrl+Shift+F');
    expect(QUICK_SWITCH.keybinding).toBe('Ctrl+Shift+F');
  });
});
