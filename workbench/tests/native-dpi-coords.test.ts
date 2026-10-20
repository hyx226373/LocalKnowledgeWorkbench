/**
 * L2 native DPI contract — pure logic (Linux-safe).
 * Proves: 渲染逻辑坐标 × scaleFactor → 屏/物理坐标 无系统性漂移 (scale 1 & 1.25).
 * No PC window / NPP / Electron live.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  screenToPanel,
  panelToScreen,
  panelDipToPhysical,
  physicalToPanelDip,
  rectDipToPhysical,
  rectDipToPhysicalTrunc,
  panelDipToPhysicalTrunc,
  pickDisplayForRect,
  panelBoundsForNative,
} from '../src/shared/nativeAppHost';
import { NativeHostService, FakeWin32Helper } from '../src/main/nativeAppHost';
import type { NativeHostCandidate } from '../src/shared/nativeAppHost/types';

const NPP: NativeHostCandidate = {
  hwnd: '123456',
  pid: 4242,
  createTime: 1_700_000_000_000,
  path: 'C:\\Program Files\\Notepad++\\notepad++.exe',
  title: 'new 1 - Notepad++',
  className: 'Notepad++',
  bounds: { x: 100, y: 100, width: 800, height: 600 },
  visible: true,
};

describe('L2 DPI: logical × scale → physical (no systematic drift)', () => {
  it.each([
    { scale: 1, label: '100%' },
    { scale: 1.25, label: '125%' },
  ])('scale=$scale ($label): DIP↔physical round-trip exact', ({ scale }) => {
    const logical = { x: 80, y: 40, width: 640, height: 480 };
    const phys = rectDipToPhysical(logical, scale);
    expect(phys).toEqual({
      x: 80 * scale,
      y: 40 * scale,
      width: 640 * scale,
      height: 480 * scale,
    });
    const back = {
      x: phys.x / scale,
      y: phys.y / scale,
      width: phys.width / scale,
      height: phys.height / scale,
    };
    expect(back.x).toBeCloseTo(logical.x, 10);
    expect(back.y).toBeCloseTo(logical.y, 10);
    expect(back.width).toBeCloseTo(logical.width, 10);
    expect(back.height).toBeCloseTo(logical.height, 10);
  });

  it('scale=1.25: known L2-style panel content has zero formula drift', () => {
    // Renderer CSS/DIP content rect (logical)
    const logical = { x: 12, y: 48, width: 900, height: 600 };
    const scale = 1.25;
    const physical = rectDipToPhysical(logical, scale);
    // Exact: 12*1.25=15, 48*1.25=60, 900*1.25=1125, 600*1.25=750
    expect(physical).toEqual({ x: 15, y: 60, width: 1125, height: 750 });
    // Inverse
    expect(physicalToPanelDip({ x: physical.x, y: physical.y }, scale)).toEqual({ x: 12, y: 48 });
  });

  it('integer rounding: Math.trunc toward zero (matches SetWindowPos helper)', () => {
    // 101 * 1.25 = 126.25 → trunc 126 (not round-half-up 126)
    expect(panelDipToPhysicalTrunc({ x: 101, y: 33 }, 1.25)).toEqual({ x: 126, y: 41 });
    // 33 * 1.25 = 41.25 → 41
    expect(rectDipToPhysicalTrunc({ x: 101, y: 33, width: 11, height: 7 }, 1.25)).toEqual({
      x: 126,
      y: 41,
      width: 13, // 11*1.25=13.75 → 13
      height: 8, // 7*1.25=8.75 → 8
    });
    // scale=1: trunc is identity for integers
    expect(rectDipToPhysicalTrunc({ x: 10, y: 20, width: 30, height: 40 }, 1)).toEqual({
      x: 10, y: 20, width: 30, height: 40,
    });
  });

  it('panelToScreen is DIP offset only (scale on PanelScreenRect not multiplied)', () => {
    for (const scale of [1, 1.25]) {
      const panel = { x: 200, y: 100, width: 400, height: 300, scaleFactor: scale };
      const local = { x: 50, y: 75 };
      const screen = panelToScreen(local, panel);
      expect(screen).toEqual({ x: 250, y: 175 });
      expect(screenToPanel(screen, panel)).toEqual(local);
    }
  });

  it('empty displays → scaleFactor=1 fallback (plugin bug; causes L2 drift at 1.25)', () => {
    const rect = { x: 100, y: 100, width: 200, height: 200 };
    const fallback = pickDisplayForRect(rect, []);
    expect(fallback.scaleFactor).toBe(1);
    const real = pickDisplayForRect(rect, [
      { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 },
    ]);
    expect(real.scaleFactor).toBe(1.25);
    // Same logical → wrong vs right physical (systematic drift magnitude)
    const logical = { x: 0, y: 0, width: 800, height: 600 };
    const wrong = rectDipToPhysical(logical, fallback.scaleFactor);
    const right = rectDipToPhysical(logical, real.scaleFactor);
    expect(wrong.width).toBe(800);
    expect(right.width).toBe(1000);
    expect(right.width - wrong.width).toBe(200); // 25% drift when plugin passes []
  });

  it('panelBoundsForNative usePhysical=true applies scale+trunc; false passes through', () => {
    const panel = { x: 10, y: 20, width: 100, height: 50, scaleFactor: 1.25 };
    expect(panelBoundsForNative(panel, { usePhysical: false })).toEqual({
      x: 10, y: 20, width: 100, height: 50,
    });
    expect(panelBoundsForNative(panel, { usePhysical: true })).toEqual({
      x: 12, // 10*1.25
      y: 25, // 20*1.25
      width: 125,
      height: 62, // 50*1.25=62.5 → trunc 62
    });
  });
});

describe('L2 host.setBounds path: no native-side scale rewrite when displays correct', () => {
  let helper: FakeWin32Helper;
  let svc: NativeHostService;

  beforeEach(() => {
    helper = new FakeWin32Helper();
    helper.seed(NPP);
    helper.seedParent('9001', { x: 0, y: 0, width: 1280, height: 800 }, { clientInset: 0 });
    svc = new NativeHostService({
      helper,
      resolveParentHwnd: () => '9001',
      listDisplays: () => [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 }],
    });
  });

  it('setBounds passes caller client rect through (usePhysical false) at scale 1.25', async () => {
    const att = await svc.attach({
      identity: { hwnd: NPP.hwnd, pid: NPP.pid, createTime: NPP.createTime, path: NPP.path },
      panelId: 'p-dpi',
    });
    expect(att.ok).toBe(true);
    if (!att.ok) return;

    // Plugin already converted logical×1.25 → physical client coords
    const clientPhysical = { x: 15, y: 60, width: 1125, height: 750 };
    const r = await svc.setBounds({ bindingId: att.bindingId, bounds: clientPhysical });
    expect(r.ok).toBe(true);

    const got = await helper.getBounds(NPP.hwnd);
    // Fake maps parent-client → screen via parent client origin (0,0)
    expect(got).toEqual(clientPhysical);
  });

  it('panelToScreen IPC: DIP round-trip at scale 1 and 1.25', () => {
    for (const scale of [1, 1.25] as const) {
      const panel = { x: 100, y: 50, width: 400, height: 300, scaleFactor: scale };
      const pt = { x: 20, y: 30 };
      const out = svc.panelToScreen({ point: pt, panel });
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect(out.point).toEqual({ x: 120, y: 80 });
      const back = svc.screenToPanel({ point: out.point, panel });
      expect(back.ok && back.point).toEqual(pt);
    }
  });
});

describe('L2 formula smoke: logical×scale samples', () => {
  it('point samples have zero residual after ×scale then /scale', () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 275, y: 25 },
      { x: 578, y: 454 },
      { x: 1920, y: 1080 },
    ];
    for (const scale of [1, 1.25]) {
      for (const p of samples) {
        const phys = panelDipToPhysical(p, scale);
        const back = physicalToPanelDip(phys, scale);
        expect(back.x).toBeCloseTo(p.x, 10);
        expect(back.y).toBeCloseTo(p.y, 10);
      }
    }
  });
});
