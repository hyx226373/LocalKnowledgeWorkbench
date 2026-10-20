/**
 * Chrome 控制器 —— 纯 TS 状态机（可单测，无 Electron 依赖）
 * API：setVisible / getVisibility / restore / setContentOnly /
 *      setEditMode / commitEdit / cancelEdit / listComponents
 */
import type {
  ChromeComponentId,
  ChromeComponentMeta,
  ChromeLayoutSize,
  ChromeProductConfig,
  ChromeStateSnapshot,
  ChromeVisibilityMap,
  PreContentOnlySnapshotPersisted,
  WorkspaceChromePersisted,
} from '../../shared/chromeLayout';
import { DEFAULT_CHROME_PRODUCT_CONFIG } from '../../shared/chromeLayout';
import { createChromeRegistry, defaultVisibilityMap } from './registry';
import {
  assertNoForbiddenPersistKeys,
  createMemoryPersistStore,
  loadChromePersist,
  sanitizeChromePersist,
  validatePreContentOnlySnapshot,
  type ChromePersistStore,
} from './persistence';

export type ChromeControllerListener = (snap: ChromeStateSnapshot, reason: string) => void;

export interface ChromeControllerOptions {
  registry?: ChromeComponentMeta[];
  persist?: ChromePersistStore;
  /** 初始已保存态；缺省从 persist 读或 defaultVisible */
  initial?: WorkspaceChromePersisted | null;
  productConfig?: Partial<ChromeProductConfig>;
}

function cloneVis(v: ChromeVisibilityMap): ChromeVisibilityMap {
  return { ...v };
}

function cloneLayout(
  l: Partial<Record<ChromeComponentId, ChromeLayoutSize>>,
): Partial<Record<ChromeComponentId, ChromeLayoutSize>> {
  const out: Partial<Record<ChromeComponentId, ChromeLayoutSize>> = {};
  for (const [k, v] of Object.entries(l)) {
    if (v) out[k as ChromeComponentId] = { ...v };
  }
  return out;
}

function visEqual(a: ChromeVisibilityMap, b: ChromeVisibilityMap): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!!a[k as ChromeComponentId] !== !!b[k as ChromeComponentId]) return false;
  }
  return true;
}

export class ChromeController {
  readonly registry: ChromeComponentMeta[];
  readonly productConfig: ChromeProductConfig;
  private readonly persist: ChromePersistStore;
  private readonly listeners = new Set<ChromeControllerListener>();

  /** 工作区已保存（非编辑、非只看内容） */
  private savedVisibility: ChromeVisibilityMap;
  private savedLayout: Partial<Record<ChromeComponentId, ChromeLayoutSize>>;

  /** 当前工作显隐（编辑态可改；非 contentOnly 时即有效态） */
  private workingVisibility: ChromeVisibilityMap;
  private workingLayout: Partial<Record<ChromeComponentId, ChromeLayoutSize>>;

  private contentOnly = false;
  private editMode = false;
  /** 进入只看内容前的 chrome 显隐快照（03：默认可落盘） */
  private preContentOnlySnapshot: ChromeVisibilityMap | null = null;
  private preContentOnlyLayout: Partial<Record<ChromeComponentId, ChromeLayoutSize>> | null = null;
  /** 快照损坏标记（load 校验失败） */
  private snapshotCorrupt = false;
  /** 进入编辑前的工作态，供 cancel */
  private preEditVisibility: ChromeVisibilityMap | null = null;
  private preEditLayout: Partial<Record<ChromeComponentId, ChromeLayoutSize>> | null = null;

  constructor(opts: ChromeControllerOptions = {}) {
    this.registry = opts.registry ?? createChromeRegistry();
    this.productConfig = {
      ...DEFAULT_CHROME_PRODUCT_CONFIG,
      ...opts.productConfig,
      contentOnlyExit: {
        ...DEFAULT_CHROME_PRODUCT_CONFIG.contentOnlyExit,
        ...opts.productConfig?.contentOnlyExit,
      },
      hiddenMenuAccess: {
        ...DEFAULT_CHROME_PRODUCT_CONFIG.hiddenMenuAccess,
        ...opts.productConfig?.hiddenMenuAccess,
        stripInvisibleAccelerators: true,
      },
    };
    this.persist = opts.persist ?? createMemoryPersistStore();

    const loaded =
      opts.initial !== undefined
        ? loadChromePersist(opts.initial ?? {}, this.registry)
        : loadChromePersist(this.persist.read() ?? {}, this.registry);

    this.savedVisibility = cloneVis(loaded.visibility);
    this.savedLayout = cloneLayout(loaded.layout ?? {});
    this.workingVisibility = cloneVis(this.savedVisibility);
    this.workingLayout = cloneLayout(this.savedLayout);
    // 03：从工作区恢复 preContentOnlySnapshot（损坏则为 null）
    if (loaded.preContentOnlySnapshot) {
      this.preContentOnlySnapshot = cloneVis(loaded.preContentOnlySnapshot.visibility);
      if (loaded.preContentOnlySnapshot.layout) {
        // 尺寸保留在 workingLayout 旁路：退出时一并恢复
        this.preContentOnlyLayout = cloneLayout(loaded.preContentOnlySnapshot.layout);
      }
    } else if (loaded.preContentOnlySnapshot === null) {
      this.preContentOnlySnapshot = null;
      this.preContentOnlyLayout = null;
    }
  }

  subscribe(fn: ChromeControllerListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  listComponents(): ChromeComponentMeta[] {
    return this.registry.map((m) => ({ ...m, hitTestWhenHidden: false as const }));
  }

  getVisibility(): ChromeStateSnapshot {
    return {
      visibility: this.effectiveVisibility(),
      savedVisibility: cloneVis(this.savedVisibility),
      layout: cloneLayout(this.workingLayout),
      contentOnly: this.contentOnly,
      editMode: this.editMode,
      dirty: this.isDirty(),
    };
  }

  /** 有效显隐：contentOnly 时全部 present 组件为 false */
  private effectiveVisibility(): ChromeVisibilityMap {
    if (!this.contentOnly) return cloneVis(this.workingVisibility);
    const out: ChromeVisibilityMap = {};
    for (const m of this.registry) {
      if (m.present) out[m.id] = false;
    }
    return out;
  }

  private isDirty(): boolean {
    if (!this.editMode) return false;
    if (!visEqual(this.workingVisibility, this.savedVisibility)) return true;
    return JSON.stringify(this.workingLayout) !== JSON.stringify(this.savedLayout);
  }

  private emit(reason: string): ChromeStateSnapshot {
    const snap = this.getVisibility();
    for (const fn of this.listeners) fn(snap, reason);
    return snap;
  }

  setVisible(id: ChromeComponentId, visible: boolean): ChromeStateSnapshot {
    const meta = this.registry.find((m) => m.id === id);
    if (!meta || !meta.present) {
      // absent：不伪称成功改变；返回当前快照
      return this.getVisibility();
    }
    if (this.contentOnly) {
      // D-L4：只看内容期间的用户显隐写入 working + preContentOnlySnapshot，
      // 退出时恢复「用户最新意图」（有效态仍全隐）
      this.workingVisibility = { ...this.workingVisibility, [id]: visible };
      this.preContentOnlySnapshot = {
        ...(this.preContentOnlySnapshot ?? cloneVis(this.workingVisibility)),
        [id]: visible,
      };
      return this.emit('chrome-toggle-while-content-only');
    }
    this.workingVisibility = { ...this.workingVisibility, [id]: visible };
    if (!this.editMode) {
      // 非编辑态：立即视为用户显式布局并落盘（独立藏/呼出持久化）
      this.savedVisibility = cloneVis(this.workingVisibility);
      this.flushPersist();
    }
    return this.emit('chrome-toggle');
  }

  /** 呼出时保留上次 layout 尺寸（不重置） */
  getLayoutSize(id: ChromeComponentId): ChromeLayoutSize | undefined {
    const s = this.workingLayout[id];
    return s ? { ...s } : undefined;
  }

  setLayoutSize(id: ChromeComponentId, size: ChromeLayoutSize): ChromeStateSnapshot {
    this.workingLayout = { ...this.workingLayout, [id]: { ...size } };
    if (!this.editMode && !this.contentOnly) {
      this.savedLayout = cloneLayout(this.workingLayout);
      this.flushPersist();
    }
    return this.emit('edit-drag');
  }

  restore(): ChromeStateSnapshot {
    // 回到上次「非编辑、非只看内容」已保存组合
    this.contentOnly = false;
    this.preContentOnlySnapshot = null;
    if (this.editMode) {
      this.editMode = false;
      this.preEditVisibility = null;
      this.preEditLayout = null;
    }
    this.workingVisibility = cloneVis(this.savedVisibility);
    this.workingLayout = cloneLayout(this.savedLayout);
    return this.emit('restore');
  }

  setContentOnly(enabled: boolean): ChromeStateSnapshot {
    if (enabled) {
      if (!this.contentOnly) {
        // 进入：保存进入前 chrome 显隐+尺寸（保留用户已隐藏组件；不碰资料/面板）
        this.preContentOnlySnapshot = cloneVis(this.workingVisibility);
        this.preContentOnlyLayout = cloneLayout(this.workingLayout);
        this.snapshotCorrupt = false;
        if (this.productConfig.persistContentOnlySnapshot) {
          this.flushPersist(); // 03：随工作区落盘
        }
      }
      this.contentOnly = true;
      return this.emit('content-only');
    }
    // 退出：恢复进入前 chrome；保留期间新增资料/面板（本控制器不管理面板，故天然保留）
    // 保留此前用户主动隐藏的组件（快照中的 false 原样恢复）
    if (this.contentOnly) {
      if (this.preContentOnlySnapshot) {
        this.workingVisibility = cloneVis(this.preContentOnlySnapshot);
      }
      if (this.preContentOnlyLayout) {
        this.workingLayout = cloneLayout(this.preContentOnlyLayout);
      }
      // 退出后快照可保留落盘供下次；清空内存会话指针前先 flush
      this.contentOnly = false;
      // 退出后清空会话快照并落盘 null（正式 visibility 不变；资料/面板不回滚）
      this.preContentOnlySnapshot = null;
      this.preContentOnlyLayout = null;
      if (this.productConfig.persistContentOnlySnapshot) {
        this.flushPersist();
      }
    }
    return this.emit('content-only');
  }

  /** 切换只看内容（默认快捷键 Ctrl+Shift+F11） */
  toggleContentOnly(): ChromeStateSnapshot {
    return this.setContentOnly(!this.contentOnly);
  }

  /** 是否应用 Esc 退出只看内容（产品可配置） */
  shouldExitContentOnlyOnEscape(): boolean {
    return this.contentOnly && this.productConfig.contentOnlyExit.escape;
  }

  /** 同一命令再按退出（产品可配置） */
  shouldExitContentOnlyOnSameCommand(): boolean {
    return this.contentOnly && this.productConfig.contentOnlyExit.sameCommand;
  }

  getPreContentOnlySnapshot(): ChromeVisibilityMap | null {
    return this.preContentOnlySnapshot ? cloneVis(this.preContentOnlySnapshot) : null;
  }

  setEditMode(enabled: boolean): ChromeStateSnapshot {
    if (enabled) {
      if (!this.editMode) {
        this.preEditVisibility = cloneVis(this.workingVisibility);
        this.preEditLayout = cloneLayout(this.workingLayout);
        this.editMode = true;
      }
      return this.emit('edit-mode');
    }
    // enabled=false 且未 commit → 等价 cancel
    if (this.editMode) return this.cancelEdit();
    return this.getVisibility();
  }

  commitEdit(): ChromeStateSnapshot {
    if (!this.editMode) return this.getVisibility();
    this.savedVisibility = cloneVis(this.workingVisibility);
    this.savedLayout = cloneLayout(this.workingLayout);
    this.editMode = false;
    this.preEditVisibility = null;
    this.preEditLayout = null;
    this.flushPersist();
    return this.emit('commit-edit');
  }

  cancelEdit(): ChromeStateSnapshot {
    if (!this.editMode) return this.getVisibility();
    if (this.preEditVisibility) this.workingVisibility = cloneVis(this.preEditVisibility);
    if (this.preEditLayout) this.workingLayout = cloneLayout(this.preEditLayout);
    this.editMode = false;
    this.preEditVisibility = null;
    this.preEditLayout = null;
    return this.emit('cancel-edit');
  }

  /** 重开工作区：从 persist 再加载 */
  reloadFromPersist(): ChromeStateSnapshot {
    const raw = this.persist.read();
    // 若原始含损坏快照，sanitize 会丢掉；检测 raw 曾有非法 snapshot
    if (raw && typeof raw === 'object' && 'preContentOnlySnapshot' in (raw as object)) {
      const snapRaw = (raw as WorkspaceChromePersisted).preContentOnlySnapshot;
      if (snapRaw != null) {
        if (!validatePreContentOnlySnapshot(snapRaw)) this.snapshotCorrupt = true;
      }
    }
    const loaded = loadChromePersist(raw ?? {}, this.registry);
    this.savedVisibility = cloneVis(loaded.visibility);
    this.savedLayout = cloneLayout(loaded.layout ?? {});
    this.workingVisibility = cloneVis(this.savedVisibility);
    this.workingLayout = cloneLayout(this.savedLayout);
    this.contentOnly = false;
    this.editMode = false;
    this.preEditVisibility = null;
    this.preEditLayout = null;
    if (loaded.preContentOnlySnapshot) {
      this.preContentOnlySnapshot = cloneVis(loaded.preContentOnlySnapshot.visibility);
      this.preContentOnlyLayout = loaded.preContentOnlySnapshot.layout
        ? cloneLayout(loaded.preContentOnlySnapshot.layout)
        : null;
      this.snapshotCorrupt = false;
    } else {
      this.preContentOnlySnapshot = null;
      this.preContentOnlyLayout = null;
    }
    return this.emit('workspace-open');
  }

  /**
   * 恢复基础界面（03：快照损坏时）：chrome 回 defaultVisible，保留内容面板（不碰面板源）。
   */
  restoreBaseUI(): ChromeStateSnapshot {
    this.contentOnly = false;
    this.editMode = false;
    this.preContentOnlySnapshot = null;
    this.preContentOnlyLayout = null;
    this.snapshotCorrupt = false;
    this.preEditVisibility = null;
    this.preEditLayout = null;
    const defaults = defaultVisibilityMap(this.registry);
    this.workingVisibility = cloneVis(defaults);
    this.savedVisibility = cloneVis(defaults);
    this.workingLayout = {};
    this.savedLayout = {};
    this.flushPersist();
    return this.emit('restore');
  }

  isSnapshotCorrupt(): boolean {
    return this.snapshotCorrupt;
  }

  markSnapshotCorrupt(v = true) {
    this.snapshotCorrupt = v;
  }

  /** 当前应写入 workspace 的 payload（visibility+layout [+ 快照]） */
  toPersistPayload(): WorkspaceChromePersisted {
    const payload: WorkspaceChromePersisted = {
      visibility: cloneVis(this.savedVisibility),
      layout: cloneLayout(this.savedLayout),
    };
    if (this.productConfig.persistContentOnlySnapshot && this.preContentOnlySnapshot) {
      const snap: PreContentOnlySnapshotPersisted = {
        schema: 1,
        visibility: cloneVis(this.preContentOnlySnapshot),
      };
      if (this.preContentOnlyLayout && Object.keys(this.preContentOnlyLayout).length) {
        snap.layout = cloneLayout(this.preContentOnlyLayout);
      }
      payload.preContentOnlySnapshot = snap;
    } else if (this.productConfig.persistContentOnlySnapshot && !this.contentOnly) {
      // 非只看内容且无会话快照 → 显式 null 清盘
      payload.preContentOnlySnapshot = null;
    }
    return sanitizeChromePersist(payload);
  }

  private flushPersist(): void {
    const payload = this.toPersistPayload();
    assertNoForbiddenPersistKeys(payload);
    this.persist.write(payload);
  }

  /** 隐藏菜单时是否应拆除不可见加速键 */
  shouldStripMenuAccelerators(): boolean {
    const vis = this.effectiveVisibility();
    if (vis['chrome.menu'] !== false) return false;
    return this.productConfig.hiddenMenuAccess.stripInvisibleAccelerators;
  }

  /** 菜单隐藏后命令是否仍可通过命令面板 / 全局快捷键 */
  hiddenMenuCommandAccess(): { commandPalette: boolean; globalShortcuts: boolean } {
    return {
      commandPalette: this.productConfig.hiddenMenuAccess.commandPalette,
      globalShortcuts: this.productConfig.hiddenMenuAccess.globalShortcuts,
    };
  }
}

export function createChromeController(opts?: ChromeControllerOptions): ChromeController {
  return new ChromeController(opts);
}

/** 无 registry 时的默认可见图（测试便捷） */
export { defaultVisibilityMap, createChromeRegistry };
