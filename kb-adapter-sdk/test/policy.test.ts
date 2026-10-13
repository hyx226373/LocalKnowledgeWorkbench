import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNavigation, checkStateForSave, domainEntryError, expandArgs, isHostAllowed, satisfies, restoreFromEnvelope, placeholderFor, backupGlobError, planAppBackup, migrateOrPreserve, describeAppRecovery, programSpecErrors, displayModeLabel, DISPLAY_MODE_FACTS, storageDeclErrors, isNonMigratableKey } from '../src/policy.js';
import type { ProgramSpec } from '../src/types.js';

test('域名条目校验', () => {
  for (const ok of ['developer.mozilla.org', '*.example.com', 'xn--fiqs8s.example.cn']) assert.equal(domainEntryError(ok), null, ok);
  for (const bad of ['*', '*.com', 'Example.com', 'example.com:443', 'https://example.com', 'example.com/path', '1.2.3.4', 'a.*.com', 'localhost', 'example.com.']) assert.notEqual(domainEntryError(bad), null, bad);
});

test('子域通配不含裸域，且不被后缀欺骗', () => {
  assert.equal(isHostAllowed('docs.example.com', ['*.example.com']), true);
  assert.equal(isHostAllowed('example.com', ['*.example.com']), false);
  assert.equal(isHostAllowed('badexample.com', ['*.example.com']), false);
});

test('导航检查', () => {
  const d = ['developer.mozilla.org'];
  assert.deepEqual(checkNavigation('https://developer.mozilla.org/a', d), { ok: true });
  assert.deepEqual(checkNavigation('https://DEVELOPER.mozilla.org/a', d), { ok: true });
  assert.equal(checkNavigation('https://developer.mozilla.org./a', d).ok, false);
  assert.deepEqual(checkNavigation('http://developer.mozilla.org/', d), { ok: false, reason: 'scheme-blocked' });
  assert.deepEqual(checkNavigation('https://u:p@developer.mozilla.org/', d), { ok: false, reason: 'invalid-url' });
  assert.deepEqual(checkNavigation('not a url', d), { ok: false, reason: 'invalid-url' });
});

test('状态保存检查：大小、秘密字段、疑似正文', () => {
  assert.equal(checkStateForSave({ page: 3, zoom: 1.25 }).ok, true);
  assert.equal(checkStateForSave({ accessToken: 'x' }).ok, false);
  assert.equal(checkStateForSave({ nested: { Cookie: 'a=b' } }).ok, false);
  assert.equal(checkStateForSave({ body: 'x'.repeat(3000) }).ok, false);
  assert.equal(checkStateForSave({ list: Array.from({ length: 3000 }, (_, i) => `item-${i}`) }).ok, false);
  assert.equal(checkStateForSave({ a: 1 }, 4).ok, false);
});

test('状态恢复：信封非法 / 版本过新 / restoreState 抛错 → reset', () => {
  const impl = { restoreState: (d: unknown) => { if (d === 'boom') throw new Error('x'); return d as string; } };
  assert.deepEqual(restoreFromEnvelope(null, impl, 1), { state: undefined, reset: false });
  assert.deepEqual(restoreFromEnvelope({ v: 1, data: 'ok' }, impl, 1), { state: 'ok', reset: false });
  assert.deepEqual(restoreFromEnvelope({ v: 2, data: 'ok' }, impl, 1), { state: undefined, reset: true });
  assert.deepEqual(restoreFromEnvelope({ v: 1, data: 'boom' }, impl, 1), { state: undefined, reset: true });
  assert.deepEqual(restoreFromEnvelope({ data: 'x' }, impl, 1), { state: undefined, reset: true });
});

test('参数展开：前缀槽位、尾随反斜杠、以 - 开头、枚举与整数范围', () => {
  const spec: ProgramSpec = {
    programId: 'p', displayName: 'P', exeCandidates: ['C:\\P\\p.exe'], verify: { publisher: 'P' }, windowTracking: 'none',
    argTemplates: [{ id: 't', label: 't', args: ['--mode={mode}', '--line={line}', '{file}'], slots: { mode: { type: 'enum', values: ['view', 'edit'] }, line: { type: 'int', min: 1, max: 100000 }, file: { type: 'resource' } } }],
  };
  const res = (p: string) => () => ({ absPath: p, ext: 'txt' });
  const req = (mode: string, line: number) => ({ programId: 'p', templateId: 't', slots: { mode: { type: 'enum' as const, value: mode }, line: { type: 'int' as const, value: line }, file: { type: 'resource' as const, resourceId: 'r' } } });
  assert.deepEqual(expandArgs(spec, req('view', 3), res('D:\\a b\\c.txt')), { ok: true, argv: ['--mode=view', '--line=3', 'D:\\a b\\c.txt'] });
  assert.equal(expandArgs(spec, req('view --evil', 3), res('D:\\c.txt')).ok, false);
  assert.equal(expandArgs(spec, req('view', 0), res('D:\\c.txt')).ok, false);
  assert.equal(expandArgs(spec, req('view', 1.5), res('D:\\c.txt')).ok, false);
  assert.equal(expandArgs(spec, req('view', 3), res('D:\\dir\\')).ok, false);
  assert.equal(expandArgs(spec, req('view', 3), res('-rf.txt')).ok, false);
  assert.equal(expandArgs(spec, req('view', 3), res('D:\\a\nb.txt')).ok, false);
});

test('semver 子集', () => {
  assert.equal(satisfies('0.1.3', '^0.1.0'), true);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false);
  assert.equal(satisfies('1.4.0', '^1.2.0'), true);
  assert.equal(satisfies('10.0.22621', '>=10.0.19041 <11.0.0'), true);
});

test('file 项目的适配器不可用时提供“改用默认视图”', () => {
  assert.ok(placeholderFor('adapter-missing', { itemId: 'i', adapterId: 'a', sourceKind: 'file' }).actions.includes('open-with-default'));
  assert.ok(!placeholderFor('adapter-missing', { itemId: 'i', adapterId: 'a', sourceKind: 'web' }).actions.includes('open-with-default'));
});

test('启动前备份：附加 glob 校验（相对目标文件夹、不越界、不许“整个文件夹”）', () => {
  for (const ok of ['{stem}.*', 'images/*.png', '**/*.md', '{stem}.bak', '附件/*.pdf']) assert.equal(backupGlobError(ok), null, ok);
  for (const bad of ['*', '**', '**/*', '*.*', '/etc/*.conf', '../x.txt', 'a/../b.txt', 'a\\b.txt', 'C:/x.txt', 'a**b.txt', 'sub/**', '{name}.txt', '[ab].txt', '']) assert.notEqual(backupGlobError(bad), null, bad);
  const spec = { programId: 'p', displayName: 'P', exeCandidates: ['C:\\P\\p.exe'], verify: { publisher: 'P' }, argTemplates: [{ id: 't', label: 't', args: [] }], windowTracking: 'none', backup: { include: ['*'] } } as ProgramSpec;
  assert.ok(programSpecErrors(spec).some((e) => e.includes('过宽')));
  assert.deepEqual(programSpecErrors({ ...spec, backup: { include: ['{stem}.*'] } }), []);
});

test('启动前备份计划：只含目标文件 + 声明的同文件夹附加文件；上限；目标超限', () => {
  const root = [
    { relPath: '笔记/todo.txt', size: 10 },
    { relPath: '笔记/todo.bak', size: 20 },
    { relPath: '笔记/other.txt', size: 30 },
    { relPath: '笔记/sub/todo.bak', size: 40 },
    { relPath: '别处/todo.bak', size: 50 },
    { relPath: '大文件.iso', size: 10_000 },
  ];
  const t = root[0]!;
  assert.deepEqual(planAppBackup(t, undefined, root).files.map((f) => f.relPath), ['笔记/todo.txt']);
  const p = planAppBackup(t, { include: ['{stem}.*'] }, root);
  assert.deepEqual(p.files.map((f) => [f.relPath, f.why]), [['笔记/todo.txt', 'target'], ['笔记/todo.bak', 'declared']]);
  assert.equal(p.totalBytes, 30);
  assert.deepEqual(planAppBackup(t, { include: ['**/{stem}.bak'] }, root).files.map((f) => f.relPath), ['笔记/todo.txt', '笔记/sub/todo.bak', '笔记/todo.bak']);
  const lim = planAppBackup(t, { include: ['**/*.bak', '*.txt'] }, root, { maxFilesPerLaunch: 2, maxBytesPerLaunch: 1000 });
  assert.deepEqual(lim.files.map((f) => f.relPath), ['笔记/todo.txt', '笔记/other.txt']);
  assert.deepEqual(lim.skipped.map((f) => f.why), ['over-file-limit', 'over-file-limit']);
  const big = planAppBackup(root[5]!, undefined, root, { maxFilesPerLaunch: 50, maxBytesPerLaunch: 1000 });
  assert.equal(big.targetOverLimit, true);
  assert.equal(big.files.length, 0);
});

test('可恢复/不可恢复说明', () => {
  const r = describeAppRecovery({ displayName: 'Notepad++' });
  assert.match(r.scope, /只备份要用 Notepad\+\+ 打开的那个文件；不会复制整个文件夹/);
  assert.ok(r.recoverable.some((l) => l.includes('14 天')));
  assert.ok(r.notRecoverable.some((l) => l.includes('另存为')) && r.notRecoverable.some((l) => l.includes('注册表')));
  assert.match(describeAppRecovery({ displayName: 'X', backup: { include: ['{stem}.*'] } }).scope, /匹配 \{stem\}\.\* 的文件/);
});

test('状态迁移失败不丢数据：migrateOrPreserve', () => {
  const steps = { 1: (d: any) => ({ clicks: d.count }) };
  assert.deepEqual(migrateOrPreserve({ count: 3 }, 1, 2, steps, () => ({ clicks: 0 })), { state: { clicks: 3 } });
  const fail = migrateOrPreserve({ clicks: 3 }, 2, 3, steps, () => ({ total: 0 }));
  assert.deepEqual(fail.state, { total: 0 });
  assert.deepEqual(fail.preserved?.data, { clicks: 3 });
  assert.equal(fail.preserved?.v, 2);
  const thrown = migrateOrPreserve({ count: 1 }, 1, 2, { 1: () => { throw new Error('坏数据'); } }, () => ({}));
  assert.match(thrown.preserved!.error, /坏数据/);
  assert.deepEqual(migrateOrPreserve({ a: 1 }, 2, 2, steps, () => ({})), { state: { a: 1 } });
});

test('显示方式如实标注', () => {
  assert.match(displayModeLabel({ displayMode: 'in-app-reader', permissions: [] }), /^内嵌渲染/);
  assert.match(displayModeLabel({ displayMode: 'in-app-web', permissions: [{ id: 'n', kind: 'net', reason: '', domains: ['a.example.com'] }] }), /^内嵌网页 .*仅限 a\.example\.com/);
  assert.match(displayModeLabel({ displayMode: 'external-managed', permissions: [] }), /^外部窗口启动.*不是内嵌窗口/);
  assert.match(DISPLAY_MODE_FACTS['in-app-web'].notes, /截图占位/);
});

test('修订 5：storage.nonMigratableKeys 校验与匹配', () => {
  assert.deepEqual(storageDeclErrors(undefined), []);
  assert.deepEqual(storageDeclErrors({ nonMigratableKeys: ['deviceId', 'cache.*'] }), []);
  assert.equal(storageDeclErrors({ nonMigratableKeys: ['*'] }).length, 1);
  assert.equal(storageDeclErrors({ nonMigratableKeys: ['a*b'] }).length, 1);
  assert.equal(storageDeclErrors({ nonMigratableKeys: [''] }).length, 1);
  assert.equal(storageDeclErrors({ nonMigratableKeys: 'x' }).length, 1);
  assert.equal(storageDeclErrors({ nonMigratableKeys: Array.from({ length: 33 }, (_, i) => `k${i}`) }).length, 1);
  const m = { storage: { nonMigratableKeys: ['deviceId', 'cache.*'] } };
  assert.equal(isNonMigratableKey(m, 'deviceId'), true);
  assert.equal(isNonMigratableKey(m, 'deviceId2'), false);
  assert.equal(isNonMigratableKey(m, 'cache.paths'), true);
  assert.equal(isNonMigratableKey(m, 'cachex'), false);
  assert.equal(isNonMigratableKey(null, 'deviceId'), false);
});
