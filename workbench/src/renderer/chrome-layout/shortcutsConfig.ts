/**
 * VC-UI-01：可配置快捷键读写 + 改键 + 冲突检测 + main 重注册通知
 * 持久化键：kb.getLayout/setLayout → `chrome.shortcuts`
 * 禁止：hwnd / credentials / inputControl
 */
import {
  CHROME_SHORTCUTS_LAYOUT_KEY,
  DEFAULT_CHROME_PRODUCT_CONFIG,
  LAYOUT_SHORTCUTS_CHANGED_EVENT,
  OPEN_COMMAND_PALETTE_COMMAND_ID,
  SHORTCUTS_CHANGED_HOOK,
  TOGGLE_CONTENT_ONLY_COMMAND_ID,
  type ChromeShortcutsPersisted,
  type LayoutShortcutsChangedPayload,
  type ShortcutConflictReport,
} from '../../shared/chromeLayout';
import {
  createShortcutRegistry,
  normalizeShortcutKey,
  type ShortcutBinding,
  type ShortcutRegistry,
} from './shortcutConflict';

export { CHROME_SHORTCUTS_LAYOUT_KEY, LAYOUT_SHORTCUTS_CHANGED_EVENT, SHORTCUTS_CHANGED_HOOK };

type KbLayoutApi = {
  getLayout(key: string): Promise<unknown>;
  setLayout(key: string, value: unknown): Promise<void>;
};

export function defaultShortcuts(): ChromeShortcutsPersisted {
  return {
    contentOnlyToggleKey: DEFAULT_CHROME_PRODUCT_CONFIG.contentOnlyToggleKey,
    commandPaletteKey: DEFAULT_CHROME_PRODUCT_CONFIG.commandPaletteKey,
  };
}

/** 校验并清洗落盘值；非法则回退默认 */
export function sanitizeShortcutsPersisted(raw: unknown): ChromeShortcutsPersisted {
  const d = defaultShortcuts();
  if (!raw || typeof raw !== 'object') return d;
  const obj = raw as Record<string, unknown>;
  // 禁止敏感字段
  for (const k of ['hwnd', 'pid', 'credentials', 'inputControl', 'approvalCredentials']) {
    if (k in obj) {
      /* strip by ignoring */
    }
  }
  const out = { ...d };
  if (typeof obj.contentOnlyToggleKey === 'string' && obj.contentOnlyToggleKey.trim()) {
    out.contentOnlyToggleKey = normalizeShortcutKey(obj.contentOnlyToggleKey);
  }
  if (typeof obj.commandPaletteKey === 'string' && obj.commandPaletteKey.trim()) {
    out.commandPaletteKey = normalizeShortcutKey(obj.commandPaletteKey);
  }
  return out;
}

export type ShortcutsChangeListener = (keys: ChromeShortcutsPersisted) => void;

export class ShortcutsConfigStore {
  private keys: ChromeShortcutsPersisted = defaultShortcuts();
  private readonly listeners = new Set<ShortcutsChangeListener>();
  private readonly registry: ShortcutRegistry & {
    onConflict(fn: (r: ShortcutConflictReport) => void): () => void;
    reports: ShortcutConflictReport[];
  };
  private kb: KbLayoutApi | null = null;
  private conflictNotices: ShortcutConflictReport[] = [];

  constructor(initial?: Partial<ChromeShortcutsPersisted>, seedBindings?: ShortcutBinding[]) {
    this.keys = { ...defaultShortcuts(), ...initial };
    this.keys.contentOnlyToggleKey = normalizeShortcutKey(this.keys.contentOnlyToggleKey);
    this.keys.commandPaletteKey = normalizeShortcutKey(this.keys.commandPaletteKey);
    this.registry = createShortcutRegistry(seedBindings ?? []);
    // 注册当前键（无冲突时）
    this.registry.tryRegister({
      key: this.keys.contentOnlyToggleKey,
      commandId: TOGGLE_CONTENT_ONLY_COMMAND_ID,
      source: 'builtin',
    });
    this.registry.tryRegister({
      key: this.keys.commandPaletteKey,
      commandId: OPEN_COMMAND_PALETTE_COMMAND_ID,
      source: 'builtin',
    });
  }

  getKeys(): ChromeShortcutsPersisted {
    return { ...this.keys };
  }

  getConflictReports(): ShortcutConflictReport[] {
    return [...this.conflictNotices, ...this.registry.reports];
  }

  subscribe(fn: ShortcutsChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  attachKb(kb: KbLayoutApi): void {
    this.kb = kb;
  }

  async loadFromKb(): Promise<ChromeShortcutsPersisted> {
    if (!this.kb) return this.getKeys();
    try {
      const raw = await this.kb.getLayout(CHROME_SHORTCUTS_LAYOUT_KEY);
      if (raw != null) {
        this.keys = sanitizeShortcutsPersisted(raw);
        this.rebuildRegistryBindings();
        this.notify(false);
      }
    } catch {
      /* keep defaults */
    }
    return this.getKeys();
  }

  private rebuildRegistryBindings(): void {
    this.registry.removeByCommandId(TOGGLE_CONTENT_ONLY_COMMAND_ID);
    this.registry.removeByCommandId(OPEN_COMMAND_PALETTE_COMMAND_ID);
    this.registry.tryRegister({
      key: this.keys.contentOnlyToggleKey,
      commandId: TOGGLE_CONTENT_ONLY_COMMAND_ID,
      source: 'builtin',
    });
    this.registry.tryRegister({
      key: this.keys.commandPaletteKey,
      commandId: OPEN_COMMAND_PALETTE_COMMAND_ID,
      source: 'builtin',
    });
  }

  /**
   * 改键。冲突则报告、保留已有绑定、不覆盖；返回 { ok, report, keys }。
   * which: 'contentOnly' | 'commandPalette'
   */
  rebind(
    which: 'contentOnly' | 'commandPalette',
    newKey: string,
    opts?: { explicitOverride?: boolean },
  ): {
    ok: boolean;
    report: ShortcutConflictReport;
    keys: ChromeShortcutsPersisted;
    notice: string;
  } {
    const key = normalizeShortcutKey(newKey);
    const commandId =
      which === 'contentOnly' ? TOGGLE_CONTENT_ONLY_COMMAND_ID : OPEN_COMMAND_PALETTE_COMMAND_ID;
    const field = which === 'contentOnly' ? 'contentOnlyToggleKey' : 'commandPaletteKey';

    // 若与另一本产品键相同 → 冲突
    const other =
      which === 'contentOnly' ? this.keys.commandPaletteKey : this.keys.contentOnlyToggleKey;
    if (normalizeShortcutKey(other) === key) {
      const report: ShortcutConflictReport = {
        key,
        intendedCommandId: commandId,
        existingBinding: {
          commandId:
            which === 'contentOnly' ? OPEN_COMMAND_PALETTE_COMMAND_ID : TOGGLE_CONTENT_ONLY_COMMAND_ID,
          source: 'builtin',
        },
        conflict: true,
        message: `快捷键 ${key} 已用于另一 chrome 命令；保留已有绑定，未改键`,
      };
      this.conflictNotices.push(report);
      this.emitConflictNotice(report);
      return { ok: false, report, keys: this.getKeys(), notice: report.message };
    }

    // 先释放本命令旧键，再试注册新键（避免自己跟自己冲突）
    const prevKey = this.keys[field];
    this.registry.removeByCommandId(commandId);
    const report = this.registry.tryRegister({
      key,
      commandId,
      source: 'user',
    });
    if (report.conflict && !opts?.explicitOverride) {
      // 恢复旧键
      this.registry.tryRegister({
        key: prevKey,
        commandId,
        source: 'builtin',
      });
      this.conflictNotices.push(report);
      this.emitConflictNotice(report);
      return { ok: false, report, keys: this.getKeys(), notice: report.message };
    }

    // 无冲突（或显式覆盖同 commandId 重绑）
    this.keys = { ...this.keys, [field]: key };
    void this.persist();
    this.notify(true);
    return {
      ok: true,
      report: { ...report, conflict: false, message: `已改键 ${key} → ${commandId}` },
      keys: this.getKeys(),
      notice: `已将快捷键改为 ${key}`,
    };
  }

  private async persist(): Promise<void> {
    if (!this.kb) return;
    const payload = sanitizeShortcutsPersisted(this.keys);
    await this.kb.setLayout(CHROME_SHORTCUTS_LAYOUT_KEY, payload);
  }

  /** 测试 / 无 kb 时同步写入内存并可选 persist 回调 */
  replaceKeys(keys: ChromeShortcutsPersisted, fireNotify = true): void {
    this.keys = sanitizeShortcutsPersisted(keys);
    this.rebuildRegistryBindings();
    if (fireNotify) this.notify(true);
    void this.persist();
  }

  private notify(emitBridge: boolean): void {
    const keys = this.getKeys();
    for (const fn of this.listeners) fn(keys);
    if (emitBridge) emitShortcutsChanged(keys);
  }

  private emitConflictNotice(report: ShortcutConflictReport): void {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[chrome-layout][VC-UI-01]', report.message);
      }
      const g = typeof window !== 'undefined' ? window : globalThis;
      const w = g as unknown as { dispatchEvent?: (e: Event) => void; CustomEvent?: typeof CustomEvent };
      if (typeof w.CustomEvent === 'function' && typeof w.dispatchEvent === 'function') {
        w.dispatchEvent(new w.CustomEvent('layout.shortcutConflict', { detail: report }));
      }
    } catch {
      /* */
    }
  }
}

export function emitShortcutsChanged(keys: ChromeShortcutsPersisted): void {
  const payload: LayoutShortcutsChangedPayload = {
    contentOnlyToggleKey: keys.contentOnlyToggleKey,
    commandPaletteKey: keys.commandPaletteKey,
  };
  try {
    const g = typeof window !== 'undefined' ? window : globalThis;
    const w = g as unknown as {
      dispatchEvent?: (e: Event) => void;
      CustomEvent?: typeof CustomEvent;
      [SHORTCUTS_CHANGED_HOOK]?: (p: LayoutShortcutsChangedPayload) => void;
    };
    if (typeof w.CustomEvent === 'function' && typeof w.dispatchEvent === 'function') {
      w.dispatchEvent(new w.CustomEvent(LAYOUT_SHORTCUTS_CHANGED_EVENT, { detail: payload }));
    }
    const hook = w[SHORTCUTS_CHANGED_HOOK];
    if (typeof hook === 'function') hook(payload);
  } catch {
    /* */
  }
}

/**
 * 注册 main 侧回调：`window.__kbOnShortcutsChanged = (payload) => { ... }`
 * 或监听 `layout.shortcutsChanged`。
 */
export function registerShortcutsChangedHandler(
  fn: (p: LayoutShortcutsChangedPayload) => void,
): () => void {
  const g = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<
    string,
    unknown
  >;
  const prev = g[SHORTCUTS_CHANGED_HOOK];
  g[SHORTCUTS_CHANGED_HOOK] = fn;
  const onEv = ((ev: Event) => {
    fn((ev as CustomEvent).detail as LayoutShortcutsChangedPayload);
  }) as EventListener;
  const target =
    typeof window !== 'undefined'
      ? window
      : typeof (globalThis as { addEventListener?: unknown }).addEventListener === 'function'
        ? (globalThis as unknown as EventTarget)
        : null;
  target?.addEventListener?.(LAYOUT_SHORTCUTS_CHANGED_EVENT, onEv);
  return () => {
    if (prev === undefined) delete g[SHORTCUTS_CHANGED_HOOK];
    else g[SHORTCUTS_CHANGED_HOOK] = prev;
    target?.removeEventListener?.(LAYOUT_SHORTCUTS_CHANGED_EVENT, onEv);
  };
}

let singleton: ShortcutsConfigStore | null = null;

export function getShortcutsConfigStore(): ShortcutsConfigStore {
  if (!singleton) singleton = new ShortcutsConfigStore();
  return singleton;
}

export function resetShortcutsConfigStoreForTests(store?: ShortcutsConfigStore): void {
  singleton = store ?? null;
}

/** 解析按键事件是否匹配某快捷键字符串 */
export function eventMatchesShortcut(ev: KeyboardEvent, shortcut: string): boolean {
  const want = normalizeShortcutKey(shortcut).toLowerCase().replace(/\s+/g, '');
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push('ctrl');
  else if (ev.metaKey) parts.push('meta');
  if (ev.shiftKey) parts.push('shift');
  if (ev.altKey) parts.push('alt');
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key.toLowerCase();
  if (!['control', 'shift', 'alt', 'meta'].includes(k)) {
    parts.push(k === ' ' ? 'space' : k);
  }
  const got = parts.join('+');
  return got === want || got === want.replace('ctrl', 'control');
}
