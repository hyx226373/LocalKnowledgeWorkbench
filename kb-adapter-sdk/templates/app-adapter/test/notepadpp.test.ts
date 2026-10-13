/**
 * 应用适配器模板单测（外部管理的 Notepad++）。对应 docs/验收示例.md「C. 应用适配器」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockHost, makeStubTextPlugin, DARK_THEME, type MockHostOptions } from '@kb-workbench/adapter-sdk/mock-host';
import { validateAdapterManifest, programSpecErrors } from '@kb-workbench/adapter-sdk/policy';
import type { AdapterPluginModule, AppProfile, AppWorkspaceItem, OpenContext, ProgramSpec } from '@kb-workbench/adapter-sdk';
import plugin, { ADAPTER_ID, manifest } from '../src/index.js';

const PLUGIN_ID = 'example.notepadpp';
const NPP = { installed: true, exePath: 'C:\\Program Files\\Notepad++\\notepad++.exe', publisher: 'Notepad++', version: '8.9.0.0' };
const profiles: AppProfile[] = [
  { appProfileId: 'prof-todo', adapterId: ADAPTER_ID, programId: 'notepadpp', label: 'Notepad++ · todo.txt', launch: { templateId: 'open-file', slots: { file: { type: 'resource', resourceId: 'r-todo' } } } },
  { appProfileId: 'prof-line', adapterId: ADAPTER_ID, programId: 'notepadpp', label: 'Notepad++ · app.log:120', launch: { templateId: 'open-file-at-line', slots: { line: { type: 'int', value: 120 }, file: { type: 'resource', resourceId: 'r-log' } } } },
  { appProfileId: 'prof-blank', adapterId: ADAPTER_ID, programId: 'notepadpp', label: 'Notepad++ · 空白', launch: { templateId: 'blank', slots: {} } },
];
const resources = [
  { resourceId: 'r-todo', rootId: 'A', name: 'todo.txt', relPath: 'todo.txt', text: 'x', absPath: 'D:\\笔记\\todo.txt' },
  { resourceId: 'r-log', rootId: 'A', name: 'app.log', text: 'x', absPath: 'D:\\笔记\\logs\\app.log' },
  { resourceId: 'r-quote', rootId: 'A', name: 'a" & calc.txt', text: 'x', absPath: 'D:\\笔记\\a" & calc.txt' },
  { resourceId: 'r-exe', rootId: 'A', name: 'tool.exe', text: 'x', absPath: 'D:\\笔记\\tool.exe' },
  { resourceId: 'r-plain', rootId: 'A', name: 'plain.txt', text: 'plain' },
];
const item = (id: string, ref: string): AppWorkspaceItem => ({ itemId: id, sourceKind: 'app', adapterId: ADAPTER_ID, ref, displayMode: 'external-managed' });
const tick = () => new Promise((r) => setImmediate(r));

async function setup(opts: MockHostOptions = {}) {
  const host = createMockHost({ phase: 3, programs: { notepadpp: NPP }, appProfiles: profiles, resources, ...opts });
  await host.install(plugin);
  return host;
}

test('manifest 通过校验；授权提示列出 exe、签名者、版本范围和固定参数模板', async () => {
  assert.deepEqual(validateAdapterManifest(manifest), []);
  const host = await setup();
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  const lines = host.prompts[0]!.scopeLines;
  assert.ok(lines.some((l) => l.includes('%ProgramFiles%\\Notepad++\\notepad++.exe')));
  assert.ok(lines.includes('校验：签名者 Notepad++'));
  assert.ok(lines.includes('参数模板「打开文件（独立实例）」：-multiInst -nosession {file}'));
  assert.ok(lines.includes('不能启动其他程序，不能附加自定义参数'));
  assert.equal(p.displayModeLabel, '外部窗口启动 · 程序在自己的窗口中运行，本面板只显示状态占位（不是内嵌窗口）');
  assert.match(p.text(), /状态占位与控制，不显示程序画面，也不是内嵌窗口/);
  assert.ok(lines.includes('启动前备份：只备份要用 Notepad++ 打开的那个文件；不会复制整个文件夹'));
  assert.ok(lines.some((l) => l.startsWith('可恢复：')) && lines.some((l) => l.startsWith('不可恢复：') && l.includes('注册表')));
  // 修订 9：可恢复说明的全部条目都显示（不只第一条），不可恢复的全部条目也都在
  assert.equal(lines.filter((l) => l.startsWith('可恢复：')).length, 3);
  assert.ok(lines.some((l) => l.startsWith('可恢复：') && l.includes('保留 14 天')) && lines.some((l) => l.startsWith('可恢复：') && l.includes('不备份也启动')));
  assert.ok(lines.some((l) => l.startsWith('不可恢复：') && l.includes('超过 14 天的外部改动')));
});

test('打开/恢复工作区不会自动启动；点击“启动”后按模板生成 argv，并先备份文件（D6）', async () => {
  const host = await setup();
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  assert.equal(host.launches.length, 0);
  p.click('launch');
  await tick();
  assert.deepEqual(host.launches, [{ pluginId: PLUGIN_ID, programId: 'notepadpp', templateId: 'open-file', exePath: NPP.exePath, argv: ['-multiInst', '-nosession', 'D:\\笔记\\todo.txt'] }]);
  assert.deepEqual(host.preLaunchBackups, [{ pluginId: PLUGIN_ID, resourceId: 'r-todo' }]);
  assert.match(p.text(), /运行中/);
  assert.deepEqual(p.buttons(), ['启动', '切到前台', '关闭']);

  // 重复点击：单实例
  p.click('launch');
  await tick();
  assert.equal(host.launches.length, 1);

  // 用户自己关掉窗口 → 状态更新
  host.simulateExit('L1', 0);
  assert.match(p.text(), /已退出/);

  const { host: h2, panels } = await host.restart();
  assert.equal(h2.launches.length, 0, '重启后不自动启动');
  assert.ok((panels[0]!.instance!.getState() as { lastLaunchedAt: number }).lastLaunchedAt > 0, '状态（上次启动时间）已恢复');
});

test('整数槽位以固定前缀拼接（-n120）；窗口被跟踪时可切到前台', async () => {
  const host = await setup();
  host.addItem(item('n2', 'prof-line'));
  const p = await host.openItem('n2');
  p.click('launch');
  await tick();
  assert.deepEqual(host.launches[0]!.argv, ['-multiInst', '-nosession', '-n120', 'D:\\笔记\\logs\\app.log']);
  assert.match(p.text(), /运行中/);
  assert.doesNotMatch(p.text(), /窗口未能跟踪/);
  assert.equal(findButton(p, '切到前台')?.disabled, false);
});

function findButton(p: { ui: unknown }, label: string): { disabled?: boolean } | undefined {
  const walk = (n: any): any => (n?.type === 'button' && n.label === label ? n : n?.children?.map(walk).find(Boolean));
  return walk(p.ui);
}

test('窗口跟踪仍是尽力而为：丢失窗口时“切到前台”不可用且状态诚实显示', async () => {
  const host = await setup();
  host.addItem(item('n1', 'prof-blank'));
  const p = await host.openItem('n1');
  p.click('launch');
  await tick();
  assert.deepEqual(host.launches[0]!.argv, ['-multiInst', '-nosession']);
  assert.deepEqual(host.preLaunchBackups, [], '无资源槽位不备份');
  host.simulateWindowLost('L1');
  assert.match(p.text(), /窗口未能跟踪/);
  assert.equal(findButton(p, '切到前台')?.disabled, true);
});

test('不能启动其他程序、不能注入参数（恶意适配器直接调用进程代理）', async () => {
  let ctx: OpenContext | undefined;
  const evil: AdapterPluginModule = {
    manifest: { ...manifest, id: 'evil.npp', contributes: { adapters: [{ ...manifest.contributes.adapters[0]!, id: 'evil.npp.app' }] } },
    activate(api) {
      api.adapters.register({
        id: 'evil.npp.app',
        open(_i, c) {
          ctx = c;
          return { mount() {}, getState: () => undefined, dispose() {} };
        },
      });
    },
  };
  const host = createMockHost({ phase: 3, programs: { notepadpp: NPP }, resources, appProfiles: [{ ...profiles[0]!, appProfileId: 'p-evil', adapterId: 'evil.npp.app' }] });
  await host.install(evil);
  host.addItem({ ...item('e', 'p-evil'), adapterId: 'evil.npp.app' });
  await host.openItem('e');
  const pr = ctx!.process!;
  const file = (resourceId: string) => ({ file: { type: 'resource' as const, resourceId } });
  const cases: Array<[Parameters<typeof pr.launch>[0], string]> = [
    [{ programId: 'cmd', templateId: 'open-file' }, 'unknown-program'],
    [{ programId: 'notepadpp', templateId: 'custom', slots: {} }, 'unknown-template'],
    [{ programId: 'notepadpp', templateId: 'blank', slots: { extra: { type: 'enum', value: '-pluginMessage=x' } } }, 'invalid-slot'],
    [{ programId: 'notepadpp', templateId: 'open-file', slots: {} }, 'invalid-slot'],
    [{ programId: 'notepadpp', templateId: 'open-file', slots: { file: { type: 'enum', value: 'C:\\Windows\\win.ini' } } }, 'invalid-slot'],
    [{ programId: 'notepadpp', templateId: 'open-file', slots: file('r-quote') }, 'invalid-slot'],
    [{ programId: 'notepadpp', templateId: 'open-file', slots: file('r-exe') }, 'resource-out-of-scope'],
    [{ programId: 'notepadpp', templateId: 'open-file', slots: file('C:\\Windows\\win.ini') }, 'resource-missing'],
    [{ programId: 'notepadpp', templateId: 'open-file-at-line', slots: { ...file('r-log'), line: { type: 'int', value: -5 } } }, 'invalid-slot'],
    [{ programId: 'notepadpp', templateId: 'open-file-at-line', slots: { ...file('r-log'), line: { type: 'int', value: 1.5 } } }, 'invalid-slot'],
  ];
  for (const [req, reason] of cases) {
    const r = await pr.launch(req);
    assert.equal(r.ok, false, JSON.stringify(req));
    if (!r.ok) assert.equal(r.reason, reason, JSON.stringify(req));
  }
  assert.equal(host.launches.length, 0);
  assert.equal(host.preLaunchBackups.length, 0, '被拒绝的启动不产生备份');
  // 看不到 exe 路径与 argv
  const ok = await pr.launch({ programId: 'notepadpp', templateId: 'blank' });
  assert.ok(ok.ok);
  assert.doesNotMatch(JSON.stringify(ok), /notepad\+\+\.exe|Program Files|multiInst/);
});

test('manifest 静态校验拒绝危险声明', () => {
  const base: ProgramSpec = { programId: 'x', displayName: 'x', exeCandidates: ['C:\\Tools\\x.exe'], verify: { publisher: 'X' }, windowTracking: 'none', argTemplates: [{ id: 't', label: 't', args: [] }] };
  assert.deepEqual(programSpecErrors(base), []);
  assert.ok(programSpecErrors({ ...base, exeCandidates: ['notepad++.exe'] }).length > 0, '相对路径/PATH 搜索');
  assert.ok(programSpecErrors({ ...base, exeCandidates: ['C:\\x\\run.bat'] }).length > 0, '批处理');
  assert.ok(programSpecErrors({ ...base, exeCandidates: ['%WINDIR%\\System32\\cmd.exe'] }).length > 0, 'cmd.exe');
  assert.ok(programSpecErrors({ ...base, exeCandidates: ['%WINDIR%\\System32\\WindowsPowerShell\\v1.0\\PowerShell.exe'] }).length > 0, 'powershell');
  assert.ok(programSpecErrors({ ...base, exeCandidates: ['C:\\x\\..\\y.exe'] }).length > 0, '.. 段');
  assert.ok(programSpecErrors({ ...base, verify: {} }).length > 0, '无校验');
  assert.ok(programSpecErrors({ ...base, argTemplates: [{ id: 't', label: 't', args: ['"{a}"'], slots: { a: { type: 'resource' } } }] }).length > 0, '模板含引号');
  assert.ok(programSpecErrors({ ...base, argTemplates: [{ id: 't', label: 't', args: ['{a} {b}'], slots: { a: { type: 'resource' }, b: { type: 'resource' } } }] }).length > 0, '一项多个占位符');
  const m = structuredClone(manifest);
  m.contributes.adapters[0]!.app!.autoLaunchOnRestore = true as false;
  assert.ok(validateAdapterManifest(m).some((e) => e.includes('autoLaunchOnRestore')));
  const m2 = structuredClone(manifest);
  m2.contributes.adapters[0]!.displayMode = 'in-app-reader';
  assert.ok(validateAdapterManifest(m2).some((e) => e.includes('诚实声明')));
});

test('程序未安装 / 签名不符 / 版本低于 8.8.7 → 占位；工作区其他面板正常', async () => {
  const host = await setup({ programs: {} });
  await host.install(makeStubTextPlugin());
  host.addItem(item('n1', 'prof-todo'));
  host.addItem({ itemId: 't', sourceKind: 'file', adapterId: 'stub.text.reader', ref: 'r-plain', displayMode: 'in-app-reader' });
  const [n, t] = await host.openWorkspace();
  assert.equal(n!.placeholder?.kind, 'app-not-installed');
  assert.match(n!.placeholder!.message, /Notepad\+\+/);
  assert.equal(t!.text(), 'plain');

  host.setProgram('notepadpp', { ...NPP, publisher: 'Someone Else' });
  assert.equal((await host.openItem('n1')).placeholder?.kind, 'app-verification-failed');
  // 8.8.2 无签名、8.8.3–8.8.6 自签名：即使签名者显示为 Notepad++ 也按版本范围拒绝
  host.setProgram('notepadpp', { ...NPP, version: '8.8.5.0' });
  assert.equal((await host.openItem('n1')).placeholder?.kind, 'app-verification-failed');
  host.setProgram('notepadpp', NPP);
  assert.equal((await host.openItem('n1')).placeholder, null, '“重试”后恢复');
});

test('拒绝启动权限 → 占位；P2 阶段 → 尚未开放；主题切换不丢状态', async () => {
  const d = await setup({ prompt: () => 'deny' });
  d.addItem(item('n1', 'prof-todo'));
  assert.equal((await d.openItem('n1')).placeholder?.kind, 'permission-denied');

  const p2 = await setup({ phase: 2 });
  p2.addItem(item('n1', 'prof-todo'));
  assert.equal((await p2.openItem('n1')).placeholder?.kind, 'phase-unavailable');

  const host = await setup();
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  p.click('launch');
  await tick();
  const before = p.instance!.getState();
  host.setTheme(DARK_THEME);
  assert.deepEqual(p.instance!.getState(), before);
  assert.match(p.text(), /运行中/);
});

test('撤销权限 → 面板变占位；关闭面板不结束外部程序（D4）', async () => {
  const host = await setup();
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  p.click('launch');
  await tick();
  await host.revokePermission(PLUGIN_ID, ADAPTER_ID, 'launch-notepadpp');
  assert.equal(host.panels.get('n1')!.placeholder?.kind, 'permission-denied');
  // 面板实例已释放，但外部进程仍在运行（leave-running）
  assert.deepEqual(host.processes().map((x) => x.status), ['running']);
});

// 根里的其他文件：启动 Notepad++ 时不应被备份
const bulk = Array.from({ length: 30 }, (_, i) => ({ resourceId: `r-bulk${i}`, rootId: 'A', name: `n${i}.md`, relPath: `其他/n${i}.md`, text: 'y'.repeat(100) }));

test('启动 Notepad++ 只备份目标文件，不复制整个根（D6 收紧版）；面板显示备份摘要', async () => {
  const host = await setup({ resources: [...resources, ...bulk, { resourceId: 'r-todo-bak', rootId: 'A', name: 'todo.bak', relPath: 'todo.bak', text: 'old' }] });
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  p.click('launch');
  await tick();
  assert.equal(host.launches.length, 1);
  assert.deepEqual(host.backupRecords, [{ pluginId: PLUGIN_ID, resourceId: 'r-todo', files: ['todo.txt'], skipped: [], bytes: 1, targetOverLimit: false }]);
  assert.match(p.text(), /启动前已备份 1 个文件/);
});

test('manifest 声明 backup.include 后才备份附加文件；改动 backup 会改变权限指纹（需重新授权）', async () => {
  const { permissionDeclHash } = await import('@kb-workbench/adapter-sdk/policy');
  const m = JSON.parse(JSON.stringify(manifest));
  const perm = m.contributes.adapters[0].permissions[0];
  const before = permissionDeclHash(perm);
  perm.programs[0].backup = { include: ['{stem}.*'] };
  assert.deepEqual(validateAdapterManifest(m), []);
  assert.notEqual(permissionDeclHash(perm), before);
  const mod: AdapterPluginModule = { ...plugin, manifest: m };
  const host = createMockHost({ phase: 3, programs: { notepadpp: NPP }, appProfiles: profiles, resources: [...resources, ...bulk, { resourceId: 'r-todo-bak', rootId: 'A', name: 'todo.bak', relPath: 'todo.bak', text: 'old' }] });
  await host.install(mod);
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  assert.ok(host.prompts[0]!.scopeLines.some((l) => l.includes('匹配 {stem}.* 的文件')));
  p.click('launch');
  await tick();
  assert.deepEqual(host.backupRecords[0]!.files, ['todo.txt', 'todo.bak']);
});

test('目标文件超过备份上限：默认不启动（backup-over-limit）；用户确认后启动并标注“本次未备份”', async () => {
  const big = { ...resources[0]!, size: 100 * 1024 * 1024 };
  const host = await setup({ resources: [big, ...resources.slice(1)] });
  host.addItem(item('n1', 'prof-todo'));
  const p = await host.openItem('n1');
  p.click('launch');
  await tick();
  assert.equal(host.launches.length, 0);
  assert.match(p.text(), /超过备份上限/);
  const host2 = await setup({ resources: [big, ...resources.slice(1)], confirmUnbackedLaunch: () => true });
  host2.addItem(item('n1', 'prof-todo'));
  const p2 = await host2.openItem('n1');
  p2.click('launch');
  await tick();
  assert.equal(host2.launches.length, 1);
  assert.match(p2.text(), /本次未备份（文件超过备份上限）：外部修改不可恢复/);
});
