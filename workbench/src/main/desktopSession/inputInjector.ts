/**
 * desk-input (b): main-process input injection behind an injectable interface.
 * Real: Windows SendInput via koffi (optional; missing -> UnavailableInjector, no fallback path).
 * Tests: MockInputInjector records events and never touches the real mouse.
 */
export type MouseButton = 'left' | 'right' | 'middle';
export type InjectEvent =
  | { kind: 'move'; ax: number; ay: number }
  | { kind: 'down'; ax: number; ay: number; button: MouseButton }
  | { kind: 'up'; ax: number; ay: number; button: MouseButton }
  | { kind: 'wheel'; ax: number; ay: number; vertical: number; horizontal: number };

export interface InjectResult { ok: boolean; sent: number; error?: string }
export interface InputInjector {
  readonly name: string;
  send(events: InjectEvent[]): Promise<InjectResult>;
}

export class MockInputInjector implements InputInjector {
  readonly name = 'mock';
  readonly log: InjectEvent[] = [];
  async send(events: InjectEvent[]): Promise<InjectResult> {
    this.log.push(...events);
    return { ok: true, sent: events.length };
  }
}

export class UnavailableInjector implements InputInjector {
  readonly name = 'unavailable';
  constructor(private readonly why: string) {}
  async send(): Promise<InjectResult> {
    return { ok: false, sent: 0, error: `injector_unavailable: ${this.why}` };
  }
}

export const MOUSEEVENTF = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040, WHEEL: 0x0800, HWHEEL: 0x1000, VIRTUALDESK: 0x4000, ABSOLUTE: 0x8000,
} as const;

export interface RawMouseInput { dx: number; dy: number; mouseData: number; dwFlags: number }

/** InjectEvent -> SendInput MOUSEINPUT list (pure). Every event carries an absolute virtual-desk position. */
export function toRawMouseInputs(events: InjectEvent[]): RawMouseInput[] {
  const pos = MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK;
  const out: RawMouseInput[] = [];
  for (const e of events) {
    if (e.kind === 'move') out.push({ dx: e.ax, dy: e.ay, mouseData: 0, dwFlags: pos });
    else if (e.kind === 'down' || e.kind === 'up') {
      const down = e.kind === 'down';
      const f = e.button === 'left' ? (down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP)
        : e.button === 'right' ? (down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP)
        : (down ? MOUSEEVENTF.MIDDLEDOWN : MOUSEEVENTF.MIDDLEUP);
      out.push({ dx: e.ax, dy: e.ay, mouseData: 0, dwFlags: pos | f });
    } else {
      out.push({ dx: e.ax, dy: e.ay, mouseData: 0, dwFlags: pos });
      if (e.vertical) out.push({ dx: 0, dy: 0, mouseData: e.vertical, dwFlags: MOUSEEVENTF.WHEEL });
      if (e.horizontal) out.push({ dx: 0, dy: 0, mouseData: e.horizontal, dwFlags: MOUSEEVENTF.HWHEEL });
    }
  }
  return out;
}

/** Real SendInput (win32 + koffi). NOT executed on real hardware in this round. */
export function createSendInputInjector(loadKoffi: () => unknown = () => require('koffi')): InputInjector {
  if (process.platform !== 'win32') return new UnavailableInjector('not win32');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let koffi: any;
  try { koffi = loadKoffi(); } catch (e) { return new UnavailableInjector(`koffi: ${(e as Error).message}`); }
  try {
    const user32 = koffi.load('user32.dll');
    const MOUSEINPUT = koffi.struct('DESK_MOUSEINPUT', { dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
    const KEYBDINPUT = koffi.struct('DESK_KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr' });
    const INPUT = koffi.struct('DESK_INPUT', { type: 'uint32', u: koffi.union('DESK_INPUT_U', { mi: MOUSEINPUT, ki: KEYBDINPUT }) });
    const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, DESK_INPUT *pInputs, int cbSize)');
    const size = koffi.sizeof(INPUT);
    return {
      name: 'sendinput',
      async send(events: InjectEvent[]): Promise<InjectResult> {
        const raw = toRawMouseInputs(events);
        if (!raw.length) return { ok: true, sent: 0 };
        const arr = raw.map((r) => ({ type: 0, u: { mi: { dx: r.dx, dy: r.dy, mouseData: r.mouseData >>> 0, dwFlags: r.dwFlags, time: 0, dwExtraInfo: 0 } } }));
        const n = SendInput(arr.length, arr, size) as number;
        return n === arr.length ? { ok: true, sent: n } : { ok: false, sent: n, error: `SendInput sent ${n}/${arr.length}` };
      },
    };
  } catch (e) {
    return new UnavailableInjector(`SendInput bind: ${(e as Error).message}`);
  }
}