/**
 * 布局侧最小 host 客户端。
 * 语义对齐 native `host.setBounds` / `host.setVisible` / `host.activate`
 * （native 用 bindingId；布局宿主按面板工作，用 panelId — integ 映射 panelId→binding）。
 * 真嵌入等 integ resolveParentHwnd；此处可 mock / 优雅 no-op。
 */
import type { ContentBounds } from '../../shared/chromeLayout';

/** 与 native NativeHostRect 对齐的屏幕矩形（width/height） */
export interface HostRect {
  x: number;
  y: number;
  width: number;
  height: number;
  /** L2：面板所在显示器 scaleFactor；与 native PanelScreenRect 对齐 */
  scaleFactor?: number;
}

export function contentBoundsToHostRect(b: ContentBounds): HostRect {
  const r: HostRect = { x: b.x, y: b.y, width: b.w, height: b.h };
  if (typeof b.scaleFactor === 'number' && b.scaleFactor > 0) r.scaleFactor = b.scaleFactor;
  return r;
}

/**
 * 布局宿主调用面（panelId 级）。
 * 禁止插件并行调用同一几何同步路径。
 */
export interface LayoutNativeHostClient {
  setBounds(req: { panelId: string; bounds: HostRect }): Promise<{ ok: boolean }>;
  setVisible(req: { panelId: string; visible: boolean }): Promise<{ ok: boolean }>;
  activate(req: { panelId: string; focusHost: boolean }): Promise<{ ok: boolean }>;
}

export type HostCallName = 'setBounds' | 'setVisible' | 'activate';

export interface HostCallRecord {
  op: HostCallName;
  panelId: string;
  args: unknown;
  at: number;
}

/** 录制调用的 mock（单测用；断言布局宿主为唯一调用方） */
export class MockLayoutNativeHostClient implements LayoutNativeHostClient {
  readonly calls: HostCallRecord[] = [];
  /** 可选：模拟失败 */
  failOps = new Set<HostCallName>();

  private rec(op: HostCallName, panelId: string, args: unknown): { ok: boolean } {
    this.calls.push({ op, panelId, args, at: Date.now() });
    if (this.failOps.has(op)) return { ok: false };
    return { ok: true };
  }

  async setBounds(req: { panelId: string; bounds: HostRect }) {
    return this.rec('setBounds', req.panelId, req);
  }
  async setVisible(req: { panelId: string; visible: boolean }) {
    return this.rec('setVisible', req.panelId, req);
  }
  async activate(req: { panelId: string; focusHost: boolean }) {
    return this.rec('activate', req.panelId, req);
  }

  clear() {
    this.calls.length = 0;
  }

  callsFor(op: HostCallName, panelId?: string): HostCallRecord[] {
    return this.calls.filter((c) => c.op === op && (panelId === undefined || c.panelId === panelId));
  }
}

type KbHostFn = (req: unknown) => Promise<unknown>;

/**
 * 从 window.kb 适配；若 `host.setBounds` 等不存在则优雅 no-op。
 * 注意：preload 未挂 chrome.* 前，布局宿主仍可在渲染进程内直接驱动 mock/适配器。
 */
export function createKbHostClient(
  kb: Record<string, unknown> | null | undefined,
  /** integ 可注入 panelId→bindingId；缺省把 panelId 当作 bindingId 透传 */
  resolveBindingId: (panelId: string) => string | null = (id) => id,
): LayoutNativeHostClient {
  const getFn = (name: string): KbHostFn | null => {
    if (!kb) return null;
    const fn = kb[name];
    return typeof fn === 'function' ? (fn as KbHostFn) : null;
  };

  const call = async (
    method: string,
    panelId: string,
    build: (bindingId: string) => unknown,
  ): Promise<{ ok: boolean }> => {
    const fn = getFn(method);
    if (!fn) return { ok: true }; // 优雅 no-op
    const bindingId = resolveBindingId(panelId);
    if (!bindingId) return { ok: false };
    try {
      const res = (await fn(build(bindingId))) as { ok?: boolean } | undefined;
      if (res && typeof res === 'object' && 'ok' in res) return { ok: !!res.ok };
      return { ok: true };
    } catch {
      return { ok: false };
    }
  };

  return {
    setBounds: (req) =>
      call('host.setBounds', req.panelId, (bindingId) => ({
        bindingId,
        bounds: req.bounds,
      })),
    setVisible: (req) =>
      call('host.setVisible', req.panelId, (bindingId) => ({
        bindingId,
        visible: req.visible,
      })),
    activate: (req) =>
      call('host.activate', req.panelId, (bindingId) => ({
        bindingId,
        focusHost: req.focusHost,
      })),
  };
}

/** 始终 no-op（无宿主环境） */
export function createNoopHostClient(): LayoutNativeHostClient {
  return {
    async setBounds() {
      return { ok: true };
    },
    async setVisible() {
      return { ok: true };
    },
    async activate() {
      return { ok: true };
    },
  };
}
