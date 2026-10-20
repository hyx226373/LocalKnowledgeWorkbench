import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { NativeHostService } from '../src/main/nativeAppHost/nativeHostService';
import { FakeWin32Helper } from '../src/main/nativeAppHost/win32Helper';
import { normalizeAttachIdentity } from '../src/shared/nativeAppHost/identity';
import { MAIN_METHOD_SET } from '../src/shared/dataMethods';
import { NATIVE_HOST_IPC_METHODS } from '../src/shared/nativeAppHost/protocol';
import { grabMethodTable, GRAB_METHODS } from '../src/main/grab/grabMethods';
import { runCommandResult, runCommandCompat } from '../src/renderer/runCommandBridge';

const req = createRequire(import.meta.url);
const koffiMod = req('../native/native-app-helper/src/win32KoffiHelper.js');
const { Win32KoffiHelper, normalizeExePath, pathLooksKnown, toHwndValue } = koffiMod;

const NPP = 'C:\\Users\\example\\Apps\\Notepad++\\notepad++.exe';

/** Koffi-free helper instance with stubbed Win32 calls. */
function stubHelper(windows: Record<string, { title: string; pid: number; path: string; createTime: number; visible?: boolean; owner?: boolean; ex?: number; throwOn?: string }>) {
  const h = Object.create(Win32KoffiHelper.prototype);
  const w = (hw: bigint) => windows[hw.toString()];
  const guard = (hw: bigint, op: string) => { if (w(hw)?.throwOn === op) throw new Error('Unexpected Buffer value, expected array'); };
  h.IsWindow = (hw: bigint) => !!w(hw);
  h.IsWindowVisible = (hw: bigint) => w(hw)?.visible !== false;
  h.GetWindow = (hw: bigint) => (w(hw)?.owner ? 99n : null);
  h.GetWindowLongPtrW = (hw: bigint) => w(hw)?.ex ?? 0;
  h._getTitle = (hw: bigint) => w(hw).title;
  h._getClassName = () => 'Notepad++';
  h._getRect = () => ({ x: 0, y: 0, width: 800, height: 600 });
  h._getPid = (hw: bigint) => { guard(hw, 'pid'); return w(hw).pid; };
  h._openProcess = (pid: number) => (pid ? { pid } : null);
  h.CloseHandle = () => true;
  let cur: bigint = 0n;
  const origInspect = Win32KoffiHelper.prototype._inspectHwnd;
  h._inspectHwnd = function (hw: bigint) { cur = hw; return origInspect.call(this, hw); };
  h._getImagePath = () => w(cur).path;
  h._getCreateTimeMs = () => w(cur).createTime;
  return h;
}

describe('host-r1 L2 fix 1: host.list enumeration', () => {
  it('normalizeExePath strips \\\\?\\ prefix, slashes and case', () => {
    expect(normalizeExePath('\\\\?\\C:/Users/example/Apps/Notepad++/NOTEPAD++.EXE')).toBe(NPP.toLowerCase());
    expect(pathLooksKnown('\\\\?\\C:\\USERS\\EXAMPLE\\APPS\\NOTEPAD++\\Notepad++.exe')).toBe(true);
    expect(pathLooksKnown('C:\\x\\notepad++.exe.bak')).toBe(false);
  });

  it('toHwndValue normalises bigint / number / External (koffi 2.x) to bigint', () => {
    expect(toHwndValue(null, 986486n)).toBe(986486n);
    expect(toHwndValue(null, 986486)).toBe(986486n);
    const fakeKoffi = { address: () => 986486n };
    expect(toHwndValue(fakeKoffi, { external: true })).toBe(986486n);
  });

  it('lists the allowlisted Notepad++ window with full identity', () => {
    const h = stubHelper({ '986486': { title: 'new 1 - Notepad++', pid: 24608, path: NPP, createTime: 1791949990428 } });
    const out = h._collectCandidates([986486n]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ hwnd: '986486', pid: 24608, createTime: 1791949990428, path: NPP });
    expect(h.lastListDiagnostics).toMatchObject({ enumerated: 1, candidates: 1, errors: 0 });
  });

  it('systematic per-hwnd failure is no longer swallowed into candidates=[]', () => {
    const h = stubHelper({
      '1': { title: 'a', pid: 1, path: NPP, createTime: 5, throwOn: 'pid' },
      '2': { title: 'b', pid: 2, path: NPP, createTime: 5, throwOn: 'pid' },
    });
    expect(() => h._collectCandidates([1n, 2n])).toThrow(/every window inspect failed \(2\/2\)/);
    try { h._collectCandidates([1n, 2n]); } catch (e) { expect((e as { code?: string }).code).toBe('ENUM_FAILED'); }
  });

  it('partial failures are reported in diagnostics, good windows still listed', () => {
    const h = stubHelper({
      '1': { title: 'bad', pid: 1, path: NPP, createTime: 5, throwOn: 'pid' },
      '2': { title: 'new 1 - Notepad++', pid: 2, path: NPP, createTime: 5 },
    });
    const out = h._collectCandidates([1n, 2n]);
    expect(out.map((c: { hwnd: string }) => c.hwnd)).toEqual(['2']);
    expect(h.lastListDiagnostics.errors).toBe(1);
    expect(h.lastListDiagnostics.firstError).toMatch(/Buffer/);
  });

  it('windows without createTime (OpenProcess denied) are skipped and counted', () => {
    const h = stubHelper({
      '1': { title: 'elevated', pid: 4, path: '', createTime: 0 },
      '2': { title: 'new 1 - Notepad++', pid: 2, path: NPP, createTime: 7 },
    });
    const out = h._collectCandidates([1n, 2n]);
    expect(out).toHaveLength(1);
    expect(h.lastListDiagnostics.skippedNoIdentity).toBe(1);
  });

  it('owner / invisible / toolwindow filters still apply', () => {
    const h = stubHelper({
      '1': { title: 'owned', pid: 1, path: NPP, createTime: 5, owner: true },
      '2': { title: 'hidden', pid: 1, path: NPP, createTime: 5, visible: false },
      '3': { title: 'tool', pid: 1, path: NPP, createTime: 5, ex: 0x80 },
      '4': { title: 'tool+app', pid: 1, path: NPP, createTime: 5, ex: 0x80 | 0x40000 },
    });
    expect(h._collectCandidates([1n, 2n, 3n, 4n]).map((c: { hwnd: string }) => c.hwnd)).toEqual(['4']);
  });

  it('service.list drops candidates lacking createTime and returns diagnostics', async () => {
    const f = new FakeWin32Helper();
    f.seed({ hwnd: '10', pid: 3, createTime: 0, path: NPP, title: 'x', className: 'c', bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: true });
    f.seed({ hwnd: '11', pid: 4, createTime: 9, path: NPP, title: 'new 1 - Notepad++', className: 'c', bounds: { x: 0, y: 0, width: 1, height: 1 }, visible: true });
    const r = await new NativeHostService({ helper: f }).list();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.candidates.map((c) => c.hwnd)).toEqual(['11']);
      expect(r.diagnostics?.skippedNoIdentity).toBe(1);
    }
  });

  it('service.list surfaces ENUM_FAILED from the JS helper (plain Error.code)', async () => {
    const f = new FakeWin32Helper();
    f.listTopLevelWindows = async () => { const e = new Error('every window inspect failed') as Error & { code: string }; e.code = 'ENUM_FAILED'; throw e; };
    const r = await new NativeHostService({ helper: f }).list();
    expect(r).toMatchObject({ ok: false, code: 'ENUM_FAILED' });
  });
});

describe('host-r1 L2 fix 2: host.attach identity', () => {
  const seed = () => {
    const f = new FakeWin32Helper();
    f.seed({ hwnd: '986486', pid: 24608, createTime: 1791949990428, path: NPP, title: 'new 1 - Notepad++', className: 'Notepad++', bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true });
    return { f, svc: new NativeHostService({ helper: f }) };
  };

  it('normalizeAttachIdentity reports missing fields', () => {
    expect(normalizeAttachIdentity({ hwnd: '986486', pid: 24608, path: NPP })).toEqual({ ok: false, missing: ['createTime'] });
    expect(normalizeAttachIdentity(undefined)).toEqual({ ok: false, missing: ['identity'] });
    expect(normalizeAttachIdentity({ hwnd: 986486, pid: '24608', createTime: '1791949990428', path: NPP })).toEqual({
      ok: true, identity: { hwnd: '986486', pid: 24608, createTime: 1791949990428, path: NPP },
    });
  });

  it('missing createTime -> IDENTITY_INCOMPLETE (no throw, no binding)', async () => {
    const { svc } = seed();
    const r = await svc.attach({ panelId: 'p1', identity: { hwnd: '986486', pid: 24608, path: NPP } as never });
    expect(r).toMatchObject({ ok: false, code: 'IDENTITY_INCOMPLETE', missing: ['createTime'] });
    expect(svc.bindingCount()).toBe(0);
  });

  it('null / garbage request does not throw', async () => {
    const { svc } = seed();
    await expect(svc.attach(null as never)).resolves.toMatchObject({ ok: false });
    await expect(svc.attach({ panelId: 'p', identity: 'x' } as never)).resolves.toMatchObject({ ok: false, code: 'IDENTITY_INCOMPLETE' });
  });

  it('numeric hwnd (CDP caller) is accepted after normalisation', async () => {
    const { svc } = seed();
    const r = await svc.attach({ panelId: 'p1', identity: { hwnd: 986486 as unknown as string, pid: 24608, createTime: 1791949990428, path: NPP } });
    expect(r.ok).toBe(true);
  });

  it('createTime mismatch -> IDENTITY_MISMATCH with detail', async () => {
    const { svc } = seed();
    const r = await svc.attach({ panelId: 'p1', identity: { hwnd: '986486', pid: 24608, createTime: 1, path: NPP } });
    expect(r).toMatchObject({ ok: false, code: 'IDENTITY_MISMATCH' });
    if (!r.ok) expect(r.message).toMatch(/createTime live=1791949990428 req=1/);
  });

  it('window gone between list and attach -> INVALID_BINDING, not a crash', async () => {
    const { f, svc } = seed();
    f.readIdentity = async () => { const e = new Error('hwnd gone') as Error & { code: string }; e.code = 'NOT_FOUND'; throw e; };
    const r = await svc.attach({ panelId: 'p1', identity: { hwnd: '986486', pid: 24608, createTime: 1791949990428, path: NPP } });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_BINDING' });
  });

  it('list -> attach round trip with the listed candidate succeeds', async () => {
    const { svc } = seed();
    const l = await svc.list();
    expect(l.ok).toBe(true);
    if (!l.ok) return;
    const c = l.candidates[0]!;
    expect(c.createTime).toBeGreaterThan(0);
    const r = await svc.attach({ panelId: 'p1', identity: { hwnd: c.hwnd, pid: c.pid, createTime: c.createTime, path: c.path } });
    expect(r.ok).toBe(true);
  });
});

describe('host-r1 L2 fix 3: grab.* exposure on window.kb', () => {
  const preloadSrc = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const mainSrc = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');

  it('grab.open / grab.pickSource are main-routed (MAIN_METHODS) and listed in preload methods', () => {
    for (const m of GRAB_METHODS) {
      expect(MAIN_METHOD_SET.has(m)).toBe(true);
      expect(preloadSrc).toContain(`'${m}'`);
    }
    expect(mainSrc).toContain('grabMethodTable(');
  });

  it('every host.* product method is main-routed and in preload (same route as grab.*)', () => {
    for (const m of NATIVE_HOST_IPC_METHODS) {
      expect(MAIN_METHOD_SET.has(m)).toBe(true);
      expect(preloadSrc).toContain(`'${m}'`);
    }
  });

  const src = (k: string) => ({ v: 1 as const, displayKey: k, label: k, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 });

  it('grab.pickSource lists sources and filters by displayKey', async () => {
    const t = grabMethodTable({ enumerateSources: async () => [src('d1'), src('d2')], sendMenuCommand: () => true });
    expect(await t['grab.pickSource']()).toMatchObject({ ok: true, sources: [{ displayKey: 'd1' }, { displayKey: 'd2' }] });
    expect(await t['grab.pickSource']({ displayKey: 'd2' })).toMatchObject({ ok: true, source: { displayKey: 'd2' } });
    expect(await t['grab.pickSource']({ displayKey: 'zz' })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('grab.open dispatches desktopPanel.open and reports no-window / enum failure', async () => {
    const sent: string[] = [];
    const t = grabMethodTable({ enumerateSources: () => [src('d1')], sendMenuCommand: (id) => { sent.push(id); return true; } });
    expect(await t['grab.open']()).toMatchObject({ ok: true, dispatched: true, commandId: 'desktopPanel.open' });
    expect(sent).toEqual(['desktopPanel.open']);
    const t2 = grabMethodTable({ enumerateSources: () => [], sendMenuCommand: () => false });
    expect(await t2['grab.open']()).toMatchObject({ ok: false, code: 'NO_WINDOW' });
    const t3 = grabMethodTable({ enumerateSources: async () => { throw new Error('capturer down'); }, sendMenuCommand: () => true });
    expect(await t3['grab.pickSource']()).toMatchObject({ ok: false, code: 'ENUM_FAILED', message: 'capturer down' });
  });
});


describe('host-r1 L2 round2: detach by bindingId / panelId', () => {
  const mk = () => {
    const f = new FakeWin32Helper();
    f.seed({ hwnd: '2691094', pid: 28784, createTime: 1791957721964, path: NPP, title: 'new 1 - Notepad++', className: 'Notepad++', bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: true });
    return { f, svc: new NativeHostService({ helper: f }) };
  };
  const id = { hwnd: '2691094', pid: 28784, createTime: 1791957721964, path: NPP };

  it('attach -> detach(bindingId) round trip', async () => {
    const { svc } = mk();
    const a = await svc.attach({ panelId: 'p1', identity: id });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(svc.resolveBindingId({ bindingId: a.bindingId })).toBe(a.bindingId);
    expect(await svc.detach({ bindingId: a.bindingId })).toEqual({ ok: true });
    expect(svc.bindingCount()).toBe(0);
  });

  it('attach -> detach(panelId only) round trip (live 80505622 failure)', async () => {
    const { svc } = mk();
    const a = await svc.attach({ panelId: 'p1', identity: id });
    expect(a.ok).toBe(true);
    expect(await svc.detach({ panelId: 'p1' })).toEqual({ ok: true });
    expect(svc.bindingCount()).toBe(0);
    expect((await svc.getState({ panelId: 'p1' })).ok).toBe(true);
  });

  it('stale bindingId falls back to panelId; re-attach after detach works', async () => {
    const { svc } = mk();
    await svc.attach({ panelId: 'p1', identity: id });
    expect(await svc.detach({ bindingId: 'stale', panelId: 'p1' })).toEqual({ ok: true });
    const again = await svc.attach({ panelId: 'p1', identity: id });
    expect(again.ok).toBe(true);
  });

  it('unknown / empty detach gives explicit NOT_ATTACHED, no throw', async () => {
    const { svc } = mk();
    expect(await svc.detach({} as never)).toMatchObject({ ok: false, code: 'NOT_ATTACHED', message: 'detach requires bindingId or panelId' });
    expect(await svc.detach(undefined as never)).toMatchObject({ ok: false, code: 'NOT_ATTACHED' });
    const r = await svc.detach({ bindingId: 'nope' });
    expect(r).toMatchObject({ ok: false, code: 'NOT_ATTACHED' });
    if (!r.ok) expect(r.message).toMatch(/live bindings=0/);
  });

  it('detach after target killed still clears binding', async () => {
    const { f, svc } = mk();
    await svc.attach({ panelId: 'p1', identity: id });
    f.forceKill('2691094');
    expect(await svc.detach({ panelId: 'p1' })).toEqual({ ok: true });
    expect(svc.bindingCount()).toBe(0);
  });
});

describe('host-r1 L2 round2: renderer runCommand bridge + grab.open', () => {
  const reg = (m: Record<string, (...a: any[]) => unknown>) => ({ get: (id: string) => (m[id] ? { run: m[id]! } : undefined) });

  it('runCommandResult: unregistered -> RENDERER_COMMAND_UNREGISTERED (was undefined)', async () => {
    expect(await runCommandResult(reg({}), 'desktopPanel.open')).toMatchObject({ ok: false, code: 'RENDERER_COMMAND_UNREGISTERED', commandId: 'desktopPanel.open' });
    expect(runCommandCompat(reg({}), 'x')).toMatchObject({ ok: false, code: 'RENDERER_COMMAND_UNREGISTERED' });
  });

  it('runCommandResult forwards args, returns value, void -> null, throw -> FAILED', async () => {
    const r = reg({ add: (a: number, b: number) => a + b, v: () => undefined, boom: () => { throw new Error('bad'); }, as: async () => ({ opened: true }) });
    expect(await runCommandResult(r, 'add', 2, 3)).toEqual({ ok: true, commandId: 'add', value: 5 });
    expect(await runCommandResult(r, 'v')).toEqual({ ok: true, commandId: 'v', value: null });
    expect(await runCommandResult(r, 'as')).toEqual({ ok: true, commandId: 'as', value: { opened: true } });
    expect(await runCommandResult(r, 'boom')).toMatchObject({ ok: false, code: 'RENDERER_COMMAND_FAILED', message: 'bad' });
    expect(runCommandCompat(r, 'add', 1, 1)).toBe(2);
  });

  const src = (k: string) => ({ v: 1 as const, displayKey: k, label: k, bounds: { x: 0, y: 0, width: 10, height: 10 }, scaleFactor: 1 });

  it('grab.open: renderer unregistered -> explicit RENDERER_COMMAND_UNREGISTERED', async () => {
    const t = grabMethodTable({ enumerateSources: () => [src('d1')], runRendererCommand: (id) => runCommandResult(reg({}), id) });
    expect(await t['grab.open']()).toMatchObject({ ok: false, code: 'RENDERER_COMMAND_UNREGISTERED', commandId: 'desktopPanel.open', sources: [{ displayKey: 'd1' }] });
  });

  it('grab.open: registered -> ok with rendererValue; undefined/throw from renderer -> RENDERER_UNAVAILABLE', async () => {
    const t = grabMethodTable({ enumerateSources: () => [src('d1')], runRendererCommand: (id) => runCommandResult(reg({ 'desktopPanel.open': () => ({ opened: true }) }), id) });
    expect(await t['grab.open']()).toMatchObject({ ok: true, dispatched: true, rendererValue: { opened: true } });
    const t2 = grabMethodTable({ enumerateSources: () => [], runRendererCommand: async () => undefined as never });
    expect(await t2['grab.open']()).toMatchObject({ ok: false, code: 'RENDERER_UNAVAILABLE' });
    const t3 = grabMethodTable({ enumerateSources: () => [], runRendererCommand: async () => { throw new Error('Script failed to execute'); } });
    expect(await t3['grab.open']()).toMatchObject({ ok: false, code: 'RENDERER_UNAVAILABLE', message: 'Script failed to execute' });
  });

  it('main wires grab.open through runRendererCommand + __kb.runCommandResult; App exposes it', () => {
    const mainSrc = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    const appSrc = readFileSync(new URL('../src/renderer/MainShell.tsx', import.meta.url), 'utf8');
    expect(mainSrc).toContain('runRendererCommand:');
    expect(mainSrc).toContain('runCommandResult');
    expect(appSrc).toContain('runCommandResult: (id: string, ...args: unknown[]) => runCommandResult(commands, id, ...args)');
  });
});

describe('host-r1 L2 round2: koffi 2.x External hwnd (integration l2fix merged)', () => {
  it('hwndToString resolves External via koffi.address; failure -> "0" (no throw)', () => {
    const { hwndToString } = koffiMod;
    const ext = Object.create(null);
    hwndToString._koffi = { address: (o: unknown) => (o === ext ? 2691094n : (() => { throw new Error('x'); })()) };
    expect(hwndToString(ext)).toBe('2691094');
    expect(hwndToString({})).toBe('0');
    expect(hwndToString(2691094n)).toBe('2691094');
    delete hwndToString._koffi;
  });

  it('_collectCandidates works when enumeration yields External handles (koffi 2.11) or bigint (3.x)', () => {
    const ext = { tag: 'ext' };
    const fakeKoffi = { address: (o: unknown) => (o === ext ? 986486n : 0n) };
    const hw = toHwndValue(fakeKoffi, ext);
    const h = stubHelper({ '986486': { title: 'new 1 - Notepad++', pid: 1, path: NPP, createTime: 3 } });
    expect(h._collectCandidates([hw])[0].hwnd).toBe('986486');
    expect(h._collectCandidates([986486n])[0].hwnd).toBe('986486');
  });
});
