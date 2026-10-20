/**
 * D-L5：窗口 / 侧栏尺寸变化 → 布局宿主 resync
 * 用 ResizeObserver 测 chrome；非 DOM 环境 no-op。
 */
import type { LayoutHost } from './layoutHost';
import { measureChromeInsetSizes } from './layoutHost';

export interface ResizeResyncOptions {
  host: LayoutHost;
  /** 观察根（默认 document.body） */
  root?: Element | null;
  /** 防抖 ms，默认 50 */
  debounceMs?: number;
  getSidebarWidth?: () => number;
  /** 把实测 inset 写回 host 的钩子（可选：通过重新构造 getInsetSizes 闭包） */
  onMeasured?: (sizes: ReturnType<typeof measureChromeInsetSizes>) => void;
}

export interface ResizeResyncHandle {
  dispose(): void;
  /** 测试：手动触发 */
  flush(): void;
}

type ROCtor = new (cb: ResizeObserverCallback) => {
  observe(target: Element): void;
  disconnect(): void;
};

export function attachResizeResync(opts: ResizeResyncOptions): ResizeResyncHandle {
  const debounceMs = opts.debounceMs ?? 50;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ro: { disconnect(): void } | null = null;

  const run = () => {
    const sizes = measureChromeInsetSizes(opts.root ?? undefined, opts.getSidebarWidth?.() ?? 280);
    opts.onMeasured?.(sizes);
    opts.host.scheduleSync('dpi-change');
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, debounceMs);
  };

  const RO = (typeof globalThis !== 'undefined'
    ? (globalThis as { ResizeObserver?: ROCtor }).ResizeObserver
    : undefined) as ROCtor | undefined;

  const root =
    opts.root ??
    (typeof document !== 'undefined' ? document.body : null);

  if (RO && root) {
    try {
      const observer = new RO(() => schedule());
      observer.observe(root);
      // 也观察 window resize（部分环境 RO 不覆盖 viewport）
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', schedule);
        ro = {
          disconnect() {
            observer.disconnect();
            window.removeEventListener('resize', schedule);
          },
        };
      } else {
        ro = observer;
      }
    } catch {
      ro = null;
    }
  } else if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', schedule);
    ro = {
      disconnect() {
        window.removeEventListener('resize', schedule);
      },
    };
  }

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      ro?.disconnect();
      ro = null;
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      run();
    },
  };
}

/** 测试用 mock ResizeObserver 安装器 */
export function installMockResizeObserver(): {
  instances: { cb: ResizeObserverCallback; targets: Element[] }[];
  restore(): void;
  fireAll(): void;
} {
  const instances: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
  const Prev = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  (globalThis as { ResizeObserver: ROCtor }).ResizeObserver = class {
    cb: ResizeObserverCallback;
    targets: Element[] = [];
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      instances.push(this);
    }
    observe(t: Element) {
      this.targets.push(t);
    }
    disconnect() {
      this.targets = [];
    }
    unobserve() {}
  } as unknown as ROCtor;
  return {
    instances,
    restore() {
      if (Prev) (globalThis as { ResizeObserver?: unknown }).ResizeObserver = Prev;
      else delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    },
    fireAll() {
      for (const inst of instances) {
        inst.cb(
          inst.targets.map(
            (t) =>
              ({
                target: t,
                contentRect: { width: 100, height: 100, x: 0, y: 0, top: 0, left: 0, bottom: 100, right: 100, toJSON() {} },
              }) as ResizeObserverEntry,
          ),
          inst as unknown as ResizeObserver,
        );
      }
    },
  };
}
