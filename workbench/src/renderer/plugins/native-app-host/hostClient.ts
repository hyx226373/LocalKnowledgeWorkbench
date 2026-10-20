/**
 * Renderer-side host.* client.
 * - Prefer window.kb dotted invoke when Electron preload exposes NATIVE_HOST_IPC.
 * - Otherwise in-memory MockNativeHostClient (fake Notepad++ candidate) for UI/tests.
 * Plugin may call: list / attach / detach / getState.
 * Plugin must NOT call: setBounds / setVisible / activate (layout host owns those).
 */
import {
  NATIVE_HOST_IPC,
  type HostAttachRequest,
  type HostAttachResponse,
  type HostDetachRequest,
  type HostGetStateRequest,
  type HostListResponse,
  type HostOkResponse,
  type HostStateResponse,
  type NativeHostCandidate,
} from '../../../shared/nativeAppHost';

export interface NativeHostClient {
  list(): Promise<HostListResponse>;
  attach(req: HostAttachRequest): Promise<HostAttachResponse>;
  detach(req: HostDetachRequest): Promise<HostOkResponse>;
  getState(req?: HostGetStateRequest): Promise<HostStateResponse>;
}

const FAKE_NPP: NativeHostCandidate = {
  hwnd: '900001',
  pid: 4242,
  createTime: 1_700_000_000_000,
  path: 'C:\\Program Files\\Notepad++\\notepad++.exe',
  title: 'new 1 - Notepad++',
  className: 'Notepad++',
  bounds: { x: 80, y: 80, width: 900, height: 600 },
  visible: true,
};

const FAKE_OTHER: NativeHostCandidate = {
  hwnd: '900002',
  pid: 1001,
  createTime: 1_700_000_000_100,
  path: 'C:\\Windows\\System32\\notepad.exe',
  title: 'Untitled - Notepad',
  className: 'Notepad',
  bounds: { x: 40, y: 40, width: 640, height: 480 },
  visible: true,
};

/** In-memory mock used when kb IPC is unavailable (Linux box / unit tests). */
export class MockNativeHostClient implements NativeHostClient {
  candidates: NativeHostCandidate[];
  /** Call log for tests (VC-L1-09). */
  readonly calls: Array<{ method: string; args?: unknown }> = [];
  private bindings = new Map<
    string,
    { identity: HostAttachRequest['identity']; panelId: string; state: 'attached' | 'invalid' }
  >();
  private seq = 0;

  constructor(seed: NativeHostCandidate[] = [FAKE_NPP, FAKE_OTHER]) {
    this.candidates = seed.map((c) => ({ ...c, bounds: { ...c.bounds } }));
  }

  async list(): Promise<HostListResponse> {
    this.calls.push({ method: NATIVE_HOST_IPC.list });
    return { ok: true, candidates: this.candidates.map((c) => ({ ...c })), platform: 'win32' };
  }

  async attach(req: HostAttachRequest): Promise<HostAttachResponse> {
    this.calls.push({ method: NATIVE_HOST_IPC.attach, args: req });
    const found = this.candidates.find(
      (c) =>
        c.hwnd === req.identity.hwnd &&
        c.pid === req.identity.pid &&
        c.createTime === req.identity.createTime &&
        c.path.toLowerCase() === req.identity.path.toLowerCase(),
    );
    if (!found) {
      return { ok: false, code: 'NOT_FOUND', message: 'candidate not in mock list' };
    }
    const bindingId = `mock-bind-${++this.seq}`;
    this.bindings.set(bindingId, {
      identity: { ...req.identity },
      panelId: req.panelId,
      state: 'attached',
    });
    return {
      ok: true,
      bindingId,
      identity: {
        hwnd: found.hwnd,
        pid: found.pid,
        createTime: found.createTime,
        path: found.path,
      },
      state: 'attached',
    };
  }

  async detach(req: HostDetachRequest): Promise<HostOkResponse> {
    this.calls.push({ method: NATIVE_HOST_IPC.detach, args: req });
    const bid = req.bindingId ?? [...this.bindings.keys()].find((k) => (this.bindings.get(k) as { panelId?: string } | undefined)?.panelId === req.panelId);
    if (!bid || !this.bindings.has(bid)) {
      return { ok: false, code: 'INVALID_BINDING', message: 'unknown binding' };
    }
    this.bindings.delete(bid);
    return { ok: true };
  }

  async getState(req: HostGetStateRequest = {}): Promise<HostStateResponse> {
    this.calls.push({ method: NATIVE_HOST_IPC.getState, args: req });
    let entry: { identity: HostAttachRequest['identity']; panelId: string; state: 'attached' | 'invalid' } | undefined;
    let bindingId: string | null = null;
    if (req.bindingId) {
      entry = this.bindings.get(req.bindingId);
      bindingId = req.bindingId;
    } else if (req.panelId) {
      for (const [id, b] of this.bindings) {
        if (b.panelId === req.panelId) {
          entry = b;
          bindingId = id;
          break;
        }
      }
    }
    if (!entry || !bindingId) {
      return {
        ok: true,
        snapshot: {
          bindingId: null,
          state: 'idle',
          identity: null,
          bounds: null,
          visible: false,
          alive: false,
          panelId: req.panelId,
        },
      };
    }
    const cand = this.candidates.find((c) => c.hwnd === entry!.identity.hwnd);
    return {
      ok: true,
      snapshot: {
        bindingId,
        state: entry.state,
        identity: {
          hwnd: entry.identity.hwnd,
          pid: entry.identity.pid,
          createTime: entry.identity.createTime,
          path: entry.identity.path,
        },
        bounds: cand?.bounds ?? null,
        visible: cand?.visible ?? true,
        alive: !!cand,
        panelId: entry.panelId,
      },
    };
  }

  /** Test helper: count attach invocations. */
  attachCallCount(): number {
    return this.calls.filter((c) => c.method === NATIVE_HOST_IPC.attach).length;
  }
}

type KbInvoke = (method: string, ...args: unknown[]) => Promise<unknown>;

function resolveKbInvoke(): KbInvoke | null {
  if (typeof window === 'undefined') return null;
  const kb = (window as unknown as { kb?: Record<string, unknown> }).kb;
  if (!kb) return null;
  // Dotted product ops may be direct properties or via a generic invoke.
  const listFn = kb[NATIVE_HOST_IPC.list];
  if (typeof listFn === 'function') {
    return (method, ...args) => (kb[method] as (...a: unknown[]) => Promise<unknown>)(...args);
  }
  if (typeof kb.invoke === 'function') {
    return (method, ...args) => (kb.invoke as KbInvoke)(method, ...args);
  }
  return null;
}

class IpcNativeHostClient implements NativeHostClient {
  constructor(private readonly invoke: KbInvoke) {}

  list(): Promise<HostListResponse> {
    return this.invoke(NATIVE_HOST_IPC.list) as Promise<HostListResponse>;
  }
  attach(req: HostAttachRequest): Promise<HostAttachResponse> {
    return this.invoke(NATIVE_HOST_IPC.attach, req) as Promise<HostAttachResponse>;
  }
  detach(req: HostDetachRequest): Promise<HostOkResponse> {
    return this.invoke(NATIVE_HOST_IPC.detach, req) as Promise<HostOkResponse>;
  }
  getState(req: HostGetStateRequest = {}): Promise<HostStateResponse> {
    return this.invoke(NATIVE_HOST_IPC.getState, req) as Promise<HostStateResponse>;
  }
}

let sharedClient: NativeHostClient | null = null;

/** Prefer real IPC; fall back to mock. Tests may inject via setHostClient. */
export function createHostClient(opts?: { forceMock?: boolean; mock?: MockNativeHostClient }): NativeHostClient {
  if (opts?.mock) return opts.mock;
  if (opts?.forceMock) return new MockNativeHostClient();
  const invoke = resolveKbInvoke();
  if (invoke) return new IpcNativeHostClient(invoke);
  return new MockNativeHostClient();
}

export function getHostClient(): NativeHostClient {
  if (!sharedClient) sharedClient = createHostClient();
  return sharedClient;
}

export function setHostClient(client: NativeHostClient | null): void {
  sharedClient = client;
}

export { FAKE_NPP, FAKE_OTHER };
