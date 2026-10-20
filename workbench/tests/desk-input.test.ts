import { describe, expect, it } from 'vitest';
import {
  clientToNormalized, containRect, dipRectToPhysical, mapNormalizedToInjection, normalizedToPhysical,
  physicalToAbsolute, virtualDesktopRect, wheelToMouseData, type InputSource,
} from '../src/shared/desktopPanel/inputMap';
import { DESK_INPUT_EXIT_KEY, SAME_SCREEN_HINT, isExitKey, isPanelOnSourceScreen, nextEnterState } from '../src/shared/desktopPanel/enterState';
import { MOUSEEVENTF, MockInputInjector, UnavailableInjector, toRawMouseInputs } from '../src/main/desktopSession/inputInjector';
import { DesktopInputController, validatePointerPayload } from '../src/main/desktopSession/inputController';

const key = (k: string, m: Partial<{ ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

describe('inputMap: contain / letterbox / zoom', () => {
  it('pillarbox 16:9 frame in 4:3 element', () => {
    expect(containRect(800, 600, 1920, 1080)).toEqual({ x: 0, y: 75, width: 800, height: 450 });
  });
  it('letterbox side bars', () => {
    const c = containRect(1000, 400, 1600, 900);
    expect(c.height).toBe(400); expect(c.width).toBeCloseTo(711.111, 2); expect(c.x).toBeCloseTo(144.444, 2);
  });
  it('invalid sizes -> empty', () => {
    expect(containRect(0, 10, 10, 10).width).toBe(0);
    expect(containRect(10, 10, NaN, 10).width).toBe(0);
  });
  it('center maps to 0.5,0.5; corners; bars -> null', () => {
    const el = { x: 100, y: 50, width: 800, height: 600 };
    const f = { width: 1920, height: 1080 };
    expect(clientToNormalized(500, 350, el, f)).toEqual({ u: 0.5, v: 0.5 });
    expect(clientToNormalized(100, 125, el, f)).toEqual({ u: 0, v: 0 });
    expect(clientToNormalized(900, 575, el, f)).toEqual({ u: 1, v: 1 });
    expect(clientToNormalized(500, 100, el, f)).toBeNull();
    expect(clientToNormalized(500, 600, el, f)).toBeNull();
    expect(clientToNormalized(NaN, 1, el, f)).toBeNull();
  });
  it('zoom 2x: bounding rect grows, mapping stays consistent', () => {
    const el = { x: -300, y: -250, width: 1600, height: 1200 }; // scale(2) about center of 800x600 at 100,50
    const f = { width: 1920, height: 1080 };
    const n = clientToNormalized(500, 350, el, f)!;
    expect(n.u).toBeCloseTo(0.5); expect(n.v).toBeCloseTo(0.5);
    const q = clientToNormalized(-300 + 400, -250 + 150 + 225, el, f)!;
    expect(q.u).toBeCloseTo(0.25); expect(q.v).toBeCloseTo(0.25);
  });
});

describe('inputMap: DPI + physical', () => {
  it('125% and 150%', () => {
    expect(dipRectToPhysical({ x: 0, y: 0, width: 1536, height: 864 }, 1.25)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(dipRectToPhysical({ x: 1280, y: 0, width: 1707, height: 960 }, 1.5)).toEqual({ x: 1920, y: 0, width: 2561, height: 1440 });
    expect(dipRectToPhysical({ x: 1, y: 1, width: 2, height: 2 }, 0)).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });
  it('normalized -> physical, clamp last pixel, negative origin', () => {
    const s: InputSource = { kind: 'screen', physRect: { x: -2560, y: -200, width: 2560, height: 1440 } };
    expect(normalizedToPhysical({ u: 0, v: 0 }, s)).toEqual({ x: -2560, y: -200 });
    expect(normalizedToPhysical({ u: 1, v: 1 }, s)).toEqual({ x: -1, y: 1239 });
    expect(normalizedToPhysical({ u: 0.5, v: 0.5 }, s)).toEqual({ x: -1280, y: 520 });
    expect(normalizedToPhysical({ u: 1.01, v: 0 }, s)).toBeNull();
    expect(normalizedToPhysical({ u: -0.01, v: 0 }, s)).toBeNull();
  });
  it('window source uses window rect', () => {
    const w: InputSource = { kind: 'window', physRect: { x: 300, y: 200, width: 1000, height: 500 } };
    expect(normalizedToPhysical({ u: 0.5, v: 0.5 }, w)).toEqual({ x: 800, y: 450 });
  });
});

describe('inputMap: virtual desktop absolute', () => {
  const left = { x: -2560, y: -200, width: 2560, height: 1440 };
  const main = { x: 0, y: 0, width: 1920, height: 1080 };
  const vd = virtualDesktopRect([main, left]);
  it('union', () => { expect(vd).toEqual({ x: -2560, y: -200, width: 4480, height: 1440 }); });
  it('empty', () => { expect(virtualDesktopRect([]).width).toBe(0); });
  it('corners map to 0 / 65535', () => {
    expect(physicalToAbsolute({ x: -2560, y: -200 }, vd)).toEqual({ ax: 0, ay: 0 });
    expect(physicalToAbsolute({ x: 1919, y: 1239 }, vd)).toEqual({ ax: 65535, ay: 65535 });
    expect(physicalToAbsolute({ x: 1920, y: 0 }, vd)).toBeNull();
    expect(physicalToAbsolute({ x: 0, y: 0 }, { x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
  it('primary origin on a negative-origin desktop', () => {
    expect(physicalToAbsolute({ x: 0, y: 0 }, vd)).toEqual({ ax: Math.round(2560 * 65535 / 4479), ay: Math.round(200 * 65535 / 1439) });
  });
  it('end to end: 150% secondary monitor, center', () => {
    const sec = dipRectToPhysical({ x: 1536, y: 0, width: 1280, height: 720 }, 1.5); // 2304,0 1920x1080
    const prim = dipRectToPhysical({ x: 0, y: 0, width: 1536, height: 864 }, 1.25);
    const m = mapNormalizedToInjection({ u: 0.5, v: 0.5 }, { kind: 'screen', physRect: sec }, virtualDesktopRect([prim, sec]))!;
    expect(m.phys).toEqual({ x: 2304 + 960, y: 540 });
    expect(m.abs.ax).toBe(Math.round(3264 * 65535 / 4223));
    expect(mapNormalizedToInjection({ u: 0.5, v: 0.5 }, { kind: 'screen', physRect: { x: 9000, y: 0, width: 10, height: 10 } }, vd)).toBeNull();
  });
});

describe('inputMap: wheel', () => {
  it('pixel / line / page, sign, clamp', () => {
    expect(wheelToMouseData(100, 0, 0)).toEqual({ vertical: -120, horizontal: 0 });
    expect(wheelToMouseData(-3, 0, 1)).toEqual({ vertical: 360, horizontal: 0 });
    expect(wheelToMouseData(0, 1, 2)).toEqual({ vertical: 0, horizontal: 360 });
    expect(wheelToMouseData(1e6, -1e6, 0)).toEqual({ vertical: -1200, horizontal: -1200 });
    expect(wheelToMouseData(NaN, 0, 0).vertical).toBe(0);
  });
});

describe('enterState', () => {
  it('enter only when enabled and live', () => {
    expect(nextEnterState('idle', { type: 'enter', enabled: false, live: true }).state).toBe('idle');
    expect(nextEnterState('idle', { type: 'enter', enabled: true, live: false }).state).toBe('idle');
    const t = nextEnterState('idle', { type: 'enter', enabled: true, live: true });
    expect(t).toEqual({ state: 'entered', changed: true, reason: 'pointer-enter' });
    expect(nextEnterState('entered', { type: 'enter', enabled: true, live: true }).changed).toBe(false);
  });
  it.each(['leave', 'exitKey', 'disable', 'stop', 'blur', 'sessionChanged'] as const)('%s exits', (type) => {
    expect(nextEnterState('entered', { type })).toEqual({ state: 'idle', changed: true, reason: type });
    expect(nextEnterState('idle', { type }).changed).toBe(false);
  });
  it('exit key is Ctrl+Alt+Q, not Escape', () => {
    expect(DESK_INPUT_EXIT_KEY).toBe('Ctrl+Alt+Q');
    expect(isExitKey(key('q', { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isExitKey(key('Q', { ctrlKey: true, altKey: true }))).toBe(true);
    expect(isExitKey(key('Escape'))).toBe(false);
    expect(isExitKey(key('q', { ctrlKey: true }))).toBe(false);
    expect(isExitKey(key('q', { ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false);
  });
});

describe('inputInjector: raw SendInput flags', () => {
  const pos = MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK;
  it('move/down/up/wheel', () => {
    const r = toRawMouseInputs([
      { kind: 'move', ax: 10, ay: 20 },
      { kind: 'down', ax: 1, ay: 2, button: 'left' },
      { kind: 'up', ax: 1, ay: 2, button: 'right' },
      { kind: 'down', ax: 1, ay: 2, button: 'middle' },
      { kind: 'wheel', ax: 5, ay: 6, vertical: -120, horizontal: 240 },
    ]);
    expect(r[0]).toEqual({ dx: 10, dy: 20, mouseData: 0, dwFlags: pos });
    expect(r[1].dwFlags).toBe(pos | MOUSEEVENTF.LEFTDOWN);
    expect(r[2].dwFlags).toBe(pos | MOUSEEVENTF.RIGHTUP);
    expect(r[3].dwFlags).toBe(pos | MOUSEEVENTF.MIDDLEDOWN);
    expect(r[5]).toEqual({ dx: 0, dy: 0, mouseData: -120, dwFlags: MOUSEEVENTF.WHEEL });
    expect(r[6]).toEqual({ dx: 0, dy: 0, mouseData: 240, dwFlags: MOUSEEVENTF.HWHEEL });
    expect(r).toHaveLength(7);
  });
  it('unavailable injector refuses', async () => {
    expect((await new UnavailableInjector('no koffi').send()).ok).toBe(false);
  });
});

function setup(opts: { active?: boolean } = {}) {
  const inj = new MockInputInjector();
  let t = 1000;
  let active: { sessionId: string; source: InputSource } | null = opts.active === false ? null
    : { sessionId: 's1', source: { kind: 'screen', physRect: { x: 1920, y: 0, width: 1920, height: 1080 } } };
  const ctl = new DesktopInputController({
    injector: inj, now: () => t, moveMinIntervalMs: 8,
    getActive: () => active,
    getVirtualDesktop: () => ({ x: 0, y: 0, width: 3840, height: 1080 }),
  });
  return { inj, ctl, tick: (ms: number) => { t += ms; }, setActive: (a: typeof active) => { active = a; } };
}

describe('validatePointerPayload', () => {
  it.each([
    [null, 'bad_payload'], [{}, 'bad_session'], [{ sessionId: 'x'.repeat(200), action: 'move', u: 0, v: 0 }, 'bad_session'],
    [{ sessionId: 's', action: 'type', u: 0, v: 0 }, 'bad_action'], [{ sessionId: 's', action: 'move', u: 2, v: 0 }, 'bad_coords'],
    [{ sessionId: 's', action: 'move', u: '0.5', v: 0 }, 'bad_coords'], [{ sessionId: 's', action: 'click', u: 0, v: 0 }, 'bad_button'],
    [{ sessionId: 's', action: 'down', u: 0, v: 0, button: 'x1' }, 'bad_button'], [{ sessionId: 's', action: 'wheel', u: 0, v: 0 }, 'bad_wheel'],
    [{ sessionId: 's', action: 'wheel', u: 0, v: 0, wheel: { vertical: 5000, horizontal: 0 } }, 'bad_wheel'],
    [{ sessionId: 's', action: 'wheel', u: 0, v: 0, wheel: { vertical: 0, horizontal: 0 } }, 'bad_wheel'],
    [{ sessionId: 's', action: 'wheel', u: 0, v: 0, wheel: { vertical: 1.5, horizontal: 0 } }, 'bad_wheel'],
  ])('rejects %j', (p, err) => { expect(validatePointerPayload(p)).toEqual({ ok: false, error: err }); });
  it('accepts valid', () => { expect(validatePointerPayload({ sessionId: 's', action: 'click', u: 1, v: 0, button: 'right' }).ok).toBe(true); });
});

describe('DesktopInputController (mock injector)', () => {
  it('drops everything when not entered (never auto-inject)', async () => {
    const { inj, ctl } = setup();
    expect(await ctl.pointer({ sessionId: 's1', action: 'click', u: 0.5, v: 0.5, button: 'left' })).toEqual({ ok: false, error: 'not_entered' });
    expect(inj.log).toHaveLength(0);
    expect(ctl.stats.dropped).toBe(1);
  });
  it('enter must match active live session', () => {
    expect(setup().ctl.enter('other')).toEqual({ ok: false, error: 'no_matching_session' });
    expect(setup({ active: false }).ctl.enter('s1').ok).toBe(false);
    expect(setup().ctl.enter(42).ok).toBe(false);
    const { ctl } = setup(); expect(ctl.enter('s1').ok).toBe(true); expect(ctl.entered).toBe(true);
  });
  it('click = down+up at mapped absolute', async () => {
    const { inj, ctl } = setup(); ctl.enter('s1');
    expect(await ctl.pointer({ sessionId: 's1', action: 'click', u: 0, v: 0, button: 'left' })).toEqual({ ok: true, sent: 2 });
    const ax = Math.round(1920 * 65535 / 3839);
    expect(inj.log).toEqual([{ kind: 'down', ax, ay: 0, button: 'left' }, { kind: 'up', ax, ay: 0, button: 'left' }]);
  });
  it('double click = two clicks (OS synthesizes dblclick)', async () => {
    const { inj, ctl } = setup(); ctl.enter('s1');
    for (const a of ['down', 'up', 'down', 'up'] as const) await ctl.pointer({ sessionId: 's1', action: a, u: 0.5, v: 0.5, button: 'left' });
    expect(inj.log.map((e) => e.kind)).toEqual(['down', 'up', 'down', 'up']);
  });
  it('right click and wheel', async () => {
    const { inj, ctl } = setup(); ctl.enter('s1');
    await ctl.pointer({ sessionId: 's1', action: 'click', u: 0.5, v: 0.5, button: 'right' });
    await ctl.pointer({ sessionId: 's1', action: 'wheel', u: 0.5, v: 0.5, wheel: { vertical: -120, horizontal: 0 } });
    expect(inj.log[0]).toMatchObject({ kind: 'down', button: 'right' });
    expect(inj.log[2]).toMatchObject({ kind: 'wheel', vertical: -120, horizontal: 0 });
  });
  it('move rate limit', async () => {
    const { inj, ctl, tick } = setup(); ctl.enter('s1');
    expect((await ctl.pointer({ sessionId: 's1', action: 'move', u: 0.1, v: 0.1 })).ok).toBe(true);
    tick(3);
    expect(await ctl.pointer({ sessionId: 's1', action: 'move', u: 0.2, v: 0.1 })).toEqual({ ok: true, sent: 0, dropped: 'rate_limited' });
    tick(8);
    await ctl.pointer({ sessionId: 's1', action: 'move', u: 0.3, v: 0.1 });
    expect(inj.log).toHaveLength(2);
  });
  it('drag: down, moves, up', async () => {
    const { inj, ctl, tick } = setup(); ctl.enter('s1');
    await ctl.pointer({ sessionId: 's1', action: 'down', u: 0.1, v: 0.1, button: 'left' });
    for (let i = 2; i <= 5; i++) { tick(10); await ctl.pointer({ sessionId: 's1', action: 'move', u: i / 10, v: 0.1 }); }
    await ctl.pointer({ sessionId: 's1', action: 'up', u: 0.5, v: 0.1, button: 'left' });
    expect(inj.log.map((e) => e.kind)).toEqual(['down', 'move', 'move', 'move', 'move', 'up']);
    expect(await ctl.exit('leave')).toEqual({ ok: true, sent: 0 });
  });
  it('exit mid-drag releases held button; later pointer dropped', async () => {
    const { inj, ctl } = setup(); ctl.enter('s1');
    await ctl.pointer({ sessionId: 's1', action: 'down', u: 0.5, v: 0.5, button: 'left' });
    expect(await ctl.exit('exitKey')).toEqual({ ok: true, sent: 1 });
    expect(inj.log.at(-1)).toMatchObject({ kind: 'up', button: 'left' });
    expect((await ctl.pointer({ sessionId: 's1', action: 'move', u: 0.5, v: 0.5 })).ok).toBe(false);
  });
  it('session mismatch exits', async () => {
    const { inj, ctl, setActive } = setup(); ctl.enter('s1');
    await ctl.pointer({ sessionId: 's1', action: 'down', u: 0.5, v: 0.5, button: 'right' });
    setActive({ sessionId: 's2', source: { kind: 'screen', physRect: { x: 0, y: 0, width: 10, height: 10 } } });
    expect(await ctl.pointer({ sessionId: 's1', action: 'move', u: 0.5, v: 0.5 })).toEqual({ ok: false, error: 'session_mismatch' });
    expect(ctl.entered).toBe(false);
    expect(inj.log.at(-1)).toMatchObject({ kind: 'up', button: 'right' });
  });
  it('invalid payload rejected even when entered', async () => {
    const { inj, ctl } = setup(); ctl.enter('s1');
    expect((await ctl.pointer({ sessionId: 's1', action: 'click', u: 5, v: 0, button: 'left' })).ok).toBe(false);
    expect(inj.log).toHaveLength(0); expect(ctl.stats.rejected).toBe(1);
  });
});
describe('same-screen guard', () => {
  const primary = { x: 0, y: 0, width: 1536, height: 864 };
  const right = { x: 1536, y: 0, width: 1280, height: 720 };
  const left = { x: -1920, y: -100, width: 1920, height: 1080 };
  it('panel on captured screen -> true', () => {
    expect(isPanelOnSourceScreen({ x: 100, y: 100, width: 800, height: 600 }, primary)).toBe(true);
    expect(isPanelOnSourceScreen({ x: -1500, y: 0, width: 800, height: 600 }, left)).toBe(true);
  });
  it('panel on another screen -> false', () => {
    expect(isPanelOnSourceScreen({ x: 100, y: 100, width: 800, height: 600 }, right)).toBe(false);
    expect(isPanelOnSourceScreen({ x: 1700, y: 50, width: 800, height: 600 }, primary)).toBe(false);
  });
  it('straddling: center decides', () => {
    expect(isPanelOnSourceScreen({ x: 1236, y: 0, width: 800, height: 600 }, right)).toBe(true);
    expect(isPanelOnSourceScreen({ x: 1036, y: 0, width: 800, height: 600 }, right)).toBe(false);
  });
  it('maximized window with slight negative offset still counts', () => {
    expect(isPanelOnSourceScreen({ x: -8, y: -8, width: 1552, height: 840 }, primary)).toBe(true);
  });
  it('invalid / missing -> false', () => {
    expect(isPanelOnSourceScreen(null, primary)).toBe(false);
    expect(isPanelOnSourceScreen({ x: 0, y: 0, width: 0, height: 0 }, primary)).toBe(false);
    expect(isPanelOnSourceScreen({ x: NaN, y: 0, width: 10, height: 10 }, primary)).toBe(false);
    expect(isPanelOnSourceScreen({ x: 0, y: 0, width: 10, height: 10 }, undefined)).toBe(false);
  });
  it('same screen blocks enter via state machine (enabled=false)', () => {
    const same = isPanelOnSourceScreen({ x: 0, y: 0, width: 800, height: 600 }, primary);
    expect(nextEnterState('idle', { type: 'enter', enabled: !same, live: true })).toEqual({ state: 'idle', changed: false, reason: 'input-disabled' });
    expect(SAME_SCREEN_HINT.length).toBeGreaterThan(5);
  });
});