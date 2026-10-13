/**
 * 模拟宿主：在没有 Electron / 真实应用的情况下运行适配器模板的单元测试。
 *
 * 它模拟“核心”的职责：安装/启用/卸载插件、授权提示、按 itemId 打开项目、
 * 判定占位状态、保存/恢复状态、切换主题、以及 file / web / app 三类宿主 API。
 * 所有判定都调用 ./policy.ts（与真实宿主应采用的规则相同）。
 *
 * 不模拟的：真实 DOM 渲染、真实 webview、真实进程与窗口、Authenticode 校验。
 */
import {
  ADAPTER_API_VERSION,
  type AdapterContribution,
  type AdapterHostApi,
  type AdapterImplementation,
  type AdapterInstance,
  type AdapterPluginModule,
  type AppProfile,
  type Disposable,
  type FileHostApi,
  type FileopsPlan,
  type FileopsResult,
  type HostErrorCode,
  type HostEvent,
  type JsonValue,
  type LaunchRequest,
  type LaunchResult,
  type MountTarget,
  type NavigateResult,
  type PermissionDecl,
  type PermissionDenial,
  type PermissionGrant,
  type PermissionPromptAnswer,
  type PermissionPromptRequest,
  type PlaceholderInfo,
  type PlaceholderKind,
  type ProcessBrokerApi,
  type ProcessHandleInfo,
  type ProcessStatusEvent,
  type ProgramDetection,
  type ProgramSpec,
  type RolloutPhase,
  type ThemeSnapshot,
  type UiNode,
  type UninstallOptions,
  type WebPanelHandle,
  type WorkspaceItem,
} from './types.js';
import {
  DEFAULT_APP_BACKUP_LIMITS,
  PHASE_BY_KIND,
  planAppBackup,
  type AppBackupLimits,
  checkNavigation,
  checkStateForSave,
  describePermission,
  displayModeLabel,
  expandArgs,
  isHostAllowed,
  isNonMigratableKey,
  permissionDeclHash,
  placeholderFor,
  restoreFromEnvelope,
  satisfies,
  validateAdapterManifest,
} from './policy.js';

// ───────────── 小工具 ─────────────

class Emitter<T> {
  private ls = new Set<(e: T) => void>();
  readonly event: HostEvent<T> = (l) => {
    this.ls.add(l);
    return { dispose: () => this.ls.delete(l) };
  };
  fire(e: T): void {
    for (const l of [...this.ls]) l(e);
  }
  clear(): void {
    this.ls.clear();
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** 宿主调用失败（真实宿主经 RPC 返回同样的 code），如 timeout */
export class HostCallError extends Error {
  constructor(public readonly code: HostErrorCode, message: string) {
    super(message);
    this.name = 'HostCallError';
  }
}

/** 宿主拒绝越权调用时抛出（code = out-of-scope / permission-denied） */
export class HostPermissionError extends HostCallError {
  constructor(public readonly denial: PermissionDenial) {
    super(denial.reason === 'out-of-scope' ? 'out-of-scope' : 'permission-denied', `权限被拒绝: ${denial.permissionId} (${denial.reason})${denial.detail ? ' ' + denial.detail : ''}`);
    this.name = 'HostPermissionError';
  }
}

/** 把 UiNode 树拍平成纯文本（测试断言用） */
export function uiText(node: UiNode | null | undefined): string {
  if (!node) return '';
  switch (node.type) {
    case 'text':
    case 'heading':
    case 'code':
      return node.text;
    case 'badge':
    case 'button':
      return node.label;
    case 'stack':
      return node.children.map(uiText).join('\n');
    case 'keyValue':
      return node.rows.map((r) => `${r.key}: ${r.value}`).join('\n');
    case 'tree': {
      const walk = (ns: typeof node.nodes, d: number): string[] => ns.flatMap((n) => [`${'  '.repeat(d)}${n.label}${n.detail ? ' ' + n.detail : ''}`, ...(n.expanded && n.children ? walk(n.children, d + 1) : [])]);
      return walk(node.nodes, 0).join('\n');
    }
    case 'notice':
      return [node.title, node.message ?? '', ...(node.actions ?? []).map((a) => a.label)].join('\n');
  }
}

export function findButtons(node: UiNode | null | undefined): Array<Extract<UiNode, { type: 'button' }>> {
  if (!node) return [];
  if (node.type === 'button') return [node];
  if (node.type === 'stack') return node.children.flatMap(findButtons);
  return [];
}

// ───────────── 配置 ─────────────

export interface MockResource {
  resourceId: string;
  rootId: string;
  name: string;
  text?: string;
  bytes?: Uint8Array;
  /** app 槽位解析用的“根内绝对路径”（仅宿主内部可见，适配器拿不到） */
  absPath?: string;
  /** 相对于根的路径（/ 分隔）；缺省 = name。启动前备份计划用它匹配附加文件 */
  relPath?: string;
  /** 文件大小（字节）；缺省按 text/bytes 计算 */
  size?: number;
  exists?: boolean;
  mtimeMs?: number;
  mimeType?: string;
}

export interface MockProgram {
  installed: boolean;
  exePath?: string;
  sha256?: string;
  publisher?: string;
  version?: string;
}

export interface MockPersisted {
  storage: Record<string, Record<string, JsonValue>>;
  grants: PermissionGrant[];
  disabled: string[];
  items: WorkspaceItem[];
  webSessions: Record<string, Record<string, string>>;
  theme: ThemeSnapshot;
}

export interface MockHostOptions {
  phase?: RolloutPhase;
  hostVersion?: string;
  resources?: MockResource[];
  programs?: Record<string, MockProgram>;
  appProfiles?: AppProfile[];
  /** 模拟用户对授权对话框的回答；默认全部同意（rootIds = 全部） */
  prompt?: (req: PermissionPromptRequest) => PermissionPromptAnswer;
  /** 模拟用户对 fileops 批量计划的回答；默认拒绝 */
  approveFileops?: (plan: FileopsPlan) => boolean;
  theme?: ThemeSnapshot;
  persisted?: MockPersisted;
  /** 启动前备份上限（缺省 DEFAULT_APP_BACKUP_LIMITS） */
  backupLimits?: AppBackupLimits;
  /** 模拟用户对“文件超过备份上限，不备份也启动？”的回答；默认否 */
  confirmUnbackedLaunch?: () => boolean;
}

/** 一次启动的备份计划（宿主内部记录；适配器只拿到 handle.backup 的数量摘要） */
export interface MockBackupRecord {
  pluginId: string;
  resourceId: string;
  /** 备份的文件（根内相对路径），目标文件在第一位 */
  files: string[];
  skipped: string[];
  bytes: number;
  targetOverLimit: boolean;
}

export const LIGHT_THEME: ThemeSnapshot = { id: 'builtin.study-light', colorScheme: 'light', tokens: { 'color-bg': '#faf8f3', 'color-text': '#2b2b2b' } };
export const DARK_THEME: ThemeSnapshot = { id: 'builtin.pro-dark', colorScheme: 'dark', tokens: { 'color-bg': '#1e1f22', 'color-text': '#d4d4d4' } };

interface Installed {
  module: AdapterPluginModule;
  errors: string[];
  activated: boolean;
  impls: Map<string, AdapterImplementation<any>>;
  apiEmitters: Emitter<ThemeSnapshot>[];
}

export interface LaunchRecord {
  pluginId: string;
  programId: string;
  templateId: string;
  /** 宿主最终传给 CreateProcess 的 exe 与 argv（数组形式，shell:false） */
  exePath: string;
  argv: string[];
}

// ───────────── 面板 ─────────────

export class MockPanel {
  placeholder: PlaceholderInfo | null = null;
  instance: AdapterInstance<any> | null = null;
  ui: UiNode | null = null;
  title = '';
  /** 宿主在面板头部显示的诚实标签 */
  displayModeLabel = '';
  /** “状态已重置”提示（状态无效/版本过新） */
  stateResetNotice = false;
  saveRequests = 0;
  web: MockWebPanel | null = null;
  /** 运行中被拦截的导航/弹窗（宿主以横幅提示，页面本身保留） */
  readonly blocked: Array<{ url: string; reason: string }> = [];
  readonly deniedEvents: PermissionDenial[] = [];
  /** @internal */ actionHandlers = new Set<(a: string, p: JsonValue | undefined) => void>();
  /** @internal */ disposables: Disposable[] = [];
  constructor(public readonly itemId: string) {}

  text(): string {
    return this.placeholder ? `${this.placeholder.title}\n${this.placeholder.message}` : uiText(this.ui);
  }
  click(action: string, payload?: JsonValue): void {
    for (const h of [...this.actionHandlers]) h(action, payload);
  }
  buttons(): string[] {
    return findButtons(this.ui).map((b) => b.label);
  }
}

// ───────────── web ─────────────

export class MockWebPanel implements WebPanelHandle {
  readonly partition: string;
  private history: string[] = [];
  private idx = -1;
  private scroll = { x: 0, y: 0 };
  private nav = new Emitter<{ url: string; inPage: boolean }>();
  private blk = new Emitter<{ url: string; reason: 'domain-blocked' | 'scheme-blocked' | 'popup-blocked' | 'download-blocked' }>();
  private load = new Emitter<'loading' | 'ready' | 'failed'>();
  private scr = new Emitter<{ x: number; y: number }>();
  readonly onScroll = this.scr.event;
  readonly onDidNavigate = this.nav.event;
  readonly onBlocked = this.blk.event;
  readonly onLoadState = this.load.event;
  online = true;
  /** 宿主 setScroll 被调用的次数（测试滚动恢复重试） */
  setScrollCalls = 0;

  constructor(
    readonly allowedDomains: readonly string[],
    readonly resourceDomains: readonly string[],
    partition: string,
    /** 该分区的 Cookie（模拟会话数据） */
    readonly cookies: Record<string, string>,
    private readonly panel: MockPanel,
  ) {
    this.partition = partition;
  }

  private go(url: string, push: boolean): NavigateResult {
    const r = checkNavigation(url, this.allowedDomains);
    if (!r.ok) {
      const reason = r.reason === 'scheme-blocked' ? 'scheme-blocked' : 'domain-blocked';
      this.panel.blocked.push({ url, reason });
      this.blk.fire({ url, reason });
      return r;
    }
    if (push) {
      this.history = this.history.slice(0, this.idx + 1);
      this.history.push(url);
      this.idx = this.history.length - 1;
    }
    this.load.fire('loading');
    if (!this.online) {
      this.load.fire('failed');
      return { ok: true };
    }
    const prev = this.history[this.idx - 1];
    const inPage = !!prev && prev.split('#')[0] === url.split('#')[0];
    this.nav.fire({ url, inPage });
    this.load.fire('ready');
    return { ok: true };
  }

  async navigate(url: string): Promise<NavigateResult> {
    return this.go(url, true);
  }
  back(): void {
    if (this.idx > 0) {
      this.idx--;
      this.go(this.history[this.idx]!, false);
    }
  }
  forward(): void {
    if (this.idx < this.history.length - 1) {
      this.idx++;
      this.go(this.history[this.idx]!, false);
    }
  }
  reload(): void {
    if (this.idx >= 0) this.go(this.history[this.idx]!, false);
  }
  currentUrl(): string | null {
    return this.history[this.idx] ?? null;
  }
  async getScroll() {
    return { ...this.scroll };
  }
  async setScroll(pos: { x: number; y: number }) {
    this.setScrollCalls++;
    this.scroll = { ...pos };
  }
  async clearSessionData(): Promise<void> {
    for (const k of Object.keys(this.cookies)) delete this.cookies[k];
  }

  // ---- 测试辅助：模拟“网页自己”做的事（真实宿主在 will-navigate / setWindowOpenHandler / will-download 中拦截） ----
  /** 页面内链接点击 / 脚本跳转 / 服务器重定向 */
  simulatePageNavigation(url: string): NavigateResult {
    return this.go(url, true);
  }
  simulatePopup(url: string): void {
    this.panel.blocked.push({ url, reason: 'popup-blocked' });
    this.blk.fire({ url, reason: 'popup-blocked' });
  }
  simulateDownload(url: string): void {
    this.panel.blocked.push({ url, reason: 'download-blocked' });
    this.blk.fire({ url, reason: 'download-blocked' });
  }
  /** 子资源请求是否被放行（session.webRequest.onBeforeRequest） */
  simulateSubresource(url: string): boolean {
    try {
      const u = new URL(url);
      return u.protocol === 'https:' && isHostAllowed(u.hostname, this.resourceDomains);
    } catch {
      return false;
    }
  }
  simulateSetCookie(name: string, value: string): void {
    this.cookies[name] = value;
  }
  /** 页面晚加载的内容把滚动位置推走（宿主轮询到后发 onScroll），与用户滚动在插件看来相同 */
  simulateLayoutShift(dy: number): void {
    this.simulateUserScroll(this.scroll.y + dy);
  }
  simulateUserScroll(y: number): void {
    this.scroll = { x: 0, y };
    this.scr.fire({ ...this.scroll });
  }
}

// ───────────── 主体 ─────────────

export class MockHost {
  readonly phase: RolloutPhase;
  readonly hostVersion: string;
  readonly prompts: PermissionPromptRequest[] = [];
  readonly launches: LaunchRecord[] = [];
  readonly fileopsPlans: FileopsPlan[] = [];
  /** D6：启动外部程序前，宿主对资源槽位中（已注册根内）的文件做的自动备份 */
  readonly preLaunchBackups: Array<{ pluginId: string; resourceId: string }> = [];
  /** 每次启动的备份计划明细（D6 收紧版：只含目标文件 + 声明的附加文件） */
  readonly backupRecords: MockBackupRecord[] = [];
  /** 插件记录（对应核心 plugins 表）：卸载且保留数据时保留行并标记 uninstalledAt */
  private pluginRows = new Map<string, { source: 'adapter'; uninstalledAt: number | null }>();
  private tokenSeq = 0;
  readonly warnings: string[] = [];
  readonly panels = new Map<string, MockPanel>();
  private plugins = new Map<string, Installed>();
  private moduleOrder: AdapterPluginModule[] = [];
  private storage: Record<string, Record<string, JsonValue>>;
  private grants: PermissionGrant[];
  private disabled: Set<string>;
  private items = new Map<string, WorkspaceItem>();
  private webSessions: Record<string, Record<string, string>>;
  private theme: ThemeSnapshot;
  private resources = new Map<string, MockResource>();
  private fileEvents = new Emitter<{ resourceId: string; change: 'modified' | 'deleted' | 'moved' }>();
  private procs = new Map<string, ProcessHandleInfo & { pluginId: string; profileItem: string }>();
  private procEmitters = new Map<string, Emitter<ProcessStatusEvent>>();
  private launchSeq = 0;

  constructor(private readonly opts: MockHostOptions = {}) {
    this.phase = opts.phase ?? 3;
    this.hostVersion = opts.hostVersion ?? '0.2.0';
    const p = opts.persisted;
    this.storage = clone(p?.storage) ?? {};
    this.grants = clone(p?.grants) ?? [];
    this.disabled = new Set(p?.disabled ?? []);
    this.webSessions = clone(p?.webSessions) ?? {};
    this.theme = clone(p?.theme) ?? opts.theme ?? LIGHT_THEME;
    for (const it of p?.items ?? []) this.items.set(it.itemId, clone(it));
    for (const r of opts.resources ?? []) this.resources.set(r.resourceId, { exists: true, mtimeMs: 0, ...r });
  }

  // ---------- 插件管理 ----------

  async install(module: AdapterPluginModule): Promise<{ ok: boolean; errors: string[] }> {
    const errors = validateAdapterManifest(module.manifest);
    const inst: Installed = { module, errors, activated: false, impls: new Map(), apiEmitters: [] };
    this.plugins.set(module.manifest.id, inst);
    this.pluginRows.set(module.manifest.id, { source: 'adapter', uninstalledAt: null });
    if (!this.moduleOrder.includes(module)) this.moduleOrder.push(module);
    if (!errors.length && !this.disabled.has(module.manifest.id)) await this.activate(inst);
    return { ok: errors.length === 0, errors };
  }

  private async activate(inst: Installed): Promise<void> {
    const id = inst.module.manifest.id;
    const themeEm = new Emitter<ThemeSnapshot>();
    inst.apiEmitters.push(themeEm);
    const api: AdapterHostApi = {
      pluginId: id,
      hostVersion: this.hostVersion,
      adapterApiVersion: ADAPTER_API_VERSION,
      phase: this.phase,
      adapters: {
        register: (impl) => {
          if (!inst.module.manifest.contributes.adapters.some((a) => a.id === impl.id)) throw new Error(`适配器 ${impl.id} 未在 manifest 中声明`);
          inst.impls.set(impl.id, impl as AdapterImplementation<any>);
          return { dispose: () => inst.impls.delete(impl.id) };
        },
      },
      storage: this.makeStorage(id),
      theme: { current: () => this.theme, onDidChange: themeEm.event },
      log: { info: () => {}, warn: (m) => this.warnings.push(`[${id}] ${m}`), error: (m) => this.warnings.push(`[${id}] ${m}`) },
    };
    try {
      await inst.module.activate(api);
      inst.activated = true;
    } catch (e) {
      inst.errors.push(`activate 失败: ${(e as Error).message}`);
      inst.impls.clear();
    }
  }

  private async deactivate(inst: Installed): Promise<void> {
    for (const p of this.panels.values()) if (this.findAdapter(this.items.get(p.itemId)!.adapterId)?.inst === inst) await this.closePanelInstance(p);
    try {
      await inst.module.deactivate?.();
    } catch {
      /* 忽略 */
    }
    inst.impls.clear();
    inst.apiEmitters.forEach((e) => e.clear());
    inst.activated = false;
  }

  async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    const inst = this.plugins.get(pluginId);
    if (enabled) {
      this.disabled.delete(pluginId);
      if (inst && !inst.activated && !inst.errors.length) await this.activate(inst);
    } else {
      this.disabled.add(pluginId);
      if (inst?.activated) await this.deactivate(inst);
    }
    await this.reopenPanelsOf(pluginId);
  }

  /**
   * 卸载：keepData=true 时保留插件行（source='adapter'，uninstalledAt）、存储、授权、网页会话，重装后恢复；
   * keepData=false 时全部删除。removeItems=true 时同时移除该插件适配器的条目，否则条目显示“缺少适配器”（D3）。
   */
  async uninstall(pluginId: string, opts: UninstallOptions): Promise<void> {
    const inst = this.plugins.get(pluginId);
    const adapterIds = inst?.module.manifest.contributes.adapters.map((a) => a.id) ?? [];
    if (inst?.activated) await this.deactivate(inst);
    this.plugins.delete(pluginId);
    this.disabled.delete(pluginId);
    if (opts.keepData) this.pluginRows.set(pluginId, { source: 'adapter', uninstalledAt: Date.now() });
    else this.pluginRows.delete(pluginId);
    if (opts.removeItems) {
      for (const [id, it] of [...this.items]) {
        if (!adapterIds.includes(it.adapterId)) continue;
        const p = this.panels.get(id);
        if (p) await this.closePanelInstance(p);
        this.panels.delete(id);
        this.items.delete(id);
      }
    }
    if (!opts.keepData) {
      delete this.storage[pluginId];
      this.grants = this.grants.filter((g) => g.pluginId !== pluginId);
      for (const k of Object.keys(this.webSessions)) if (k.endsWith(`kbweb.${pluginId}`)) delete this.webSessions[k];
    }
    for (const p of this.panels.values()) if (adapterIds.includes(this.items.get(p.itemId)!.adapterId)) await this.openItem(p.itemId);
  }

  /** 核心 plugins 行的模拟：undefined = 无记录 */
  pluginRecord(pluginId: string): { source: 'adapter'; uninstalledAt: number | null } | undefined {
    const r = this.pluginRows.get(pluginId);
    return r && { ...r };
  }
  storageOf(pluginId: string): Record<string, JsonValue> | undefined {
    return clone(this.storage[pluginId]);
  }
  /**
   * 模拟“导出数据迁移包”时该插件随包带走的存储（修订 5）：去掉 manifest.storage.nonMigratableKeys 声明的键
   * 与键名像密钥的键（与核心迁移组规则一致）。excluded 只列键名。
   */
  migratableStorageOf(pluginId: string): { kept: Record<string, JsonValue>; excluded: string[] } {
    const manifest = this.plugins.get(pluginId)?.module.manifest;
    const kept: Record<string, JsonValue> = {};
    const excluded: string[] = [];
    for (const [k, v] of Object.entries(this.storage[pluginId] ?? {})) {
      if (isNonMigratableKey(manifest, k) || /(pass|secret|token|api[-_]?key|credential|cookie|auth|session)/i.test(k)) excluded.push(k);
      else kept[k] = clone(v) as JsonValue;
    }
    return { kept, excluded: excluded.sort() };
  }
  webSessionOf(pluginId: string): Record<string, string> | undefined {
    return this.webSessions[`persist:kbweb.${pluginId}`];
  }
  grantsOf(pluginId: string): PermissionGrant[] {
    return this.grants.filter((g) => g.pluginId === pluginId);
  }

  async revokePermission(pluginId: string, adapterId: string, permissionId: string): Promise<void> {
    this.grants = this.grants.filter((g) => !(g.pluginId === pluginId && g.adapterId === adapterId && g.permissionId === permissionId));
    this.grants.push({ pluginId, adapterId, permissionId, decision: 'denied', declHash: '*', decidedAt: Date.now() });
    for (const p of this.panels.values()) {
      const it = this.items.get(p.itemId)!;
      if (it.adapterId !== adapterId || !p.instance) continue;
      const decl = this.findAdapter(adapterId)?.contrib.permissions.find((x) => x.id === permissionId);
      if (!decl) continue;
      if (decl.optional) {
        const d: PermissionDenial = { permissionId, kind: decl.kind, reason: 'revoked' };
        p.deniedEvents.push(d);
        p.instance.onPermissionDenied?.(d);
      } else {
        await this.openItem(p.itemId);
      }
    }
  }

  // ---------- 主题 ----------

  setTheme(theme: ThemeSnapshot): void {
    this.theme = theme;
    for (const inst of this.plugins.values()) inst.apiEmitters.forEach((e) => e.fire(theme));
    for (const p of this.panels.values()) p.instance?.onThemeChange?.(theme);
  }

  // ---------- 项目与面板 ----------

  addItem(item: WorkspaceItem): void {
    this.items.set(item.itemId, clone(item));
  }
  getItem(itemId: string): WorkspaceItem | undefined {
    return clone(this.items.get(itemId));
  }

  /** 恢复整个工作区：每个项目独立判定，任何一个失败都不影响其他 */
  async openWorkspace(): Promise<MockPanel[]> {
    const out: MockPanel[] = [];
    for (const id of this.items.keys()) out.push(await this.openItem(id));
    return out;
  }

  async openItem(itemId: string): Promise<MockPanel> {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`未知项目 ${itemId}`);
    let panel = this.panels.get(itemId);
    if (panel) await this.closePanelInstance(panel);
    panel = new MockPanel(itemId);
    this.panels.set(itemId, panel);
    try {
      await this.doOpen(item, panel);
    } catch (e) {
      await this.closePanelInstance(panel);
      this.setPlaceholder(panel, item, 'adapter-error', (e as Error).message);
    }
    return panel;
  }

  private setPlaceholder(panel: MockPanel, item: WorkspaceItem, kind: PlaceholderKind, detail?: string, plugin?: string): void {
    panel.placeholder = placeholderFor(kind, { itemId: item.itemId, adapterId: item.adapterId, detail, plugin, sourceKind: item.sourceKind });
    panel.ui = null;
  }

  private findAdapter(adapterId: string): { inst: Installed; contrib: AdapterContribution } | undefined {
    for (const inst of this.plugins.values()) {
      const contrib = inst.module.manifest.contributes?.adapters?.find((a) => a.id === adapterId);
      if (contrib) return { inst, contrib };
    }
    return undefined;
  }

  private async doOpen(item: WorkspaceItem, panel: MockPanel): Promise<void> {
    // 1. 适配器是否存在 / 启用 / 兼容
    const found = this.findAdapter(item.adapterId);
    if (!found) return this.setPlaceholder(panel, item, 'adapter-missing');
    const { inst, contrib } = found;
    const pluginId = inst.module.manifest.id;
    const pluginName = inst.module.manifest.name;
    if (inst.errors.length) return this.setPlaceholder(panel, item, 'adapter-incompatible', inst.errors.join('；'));
    if (this.disabled.has(pluginId)) return this.setPlaceholder(panel, item, 'adapter-disabled', undefined, pluginName);
    // 2. 阶段
    if (PHASE_BY_KIND[item.sourceKind] > this.phase) return this.setPlaceholder(panel, item, 'phase-unavailable', `${item.sourceKind} 类项目将在 P${PHASE_BY_KIND[item.sourceKind]} 开放（当前 P${this.phase}）`);
    if (!contrib.sourceKinds.includes(item.sourceKind)) return this.setPlaceholder(panel, item, 'adapter-incompatible', `适配器不支持 ${item.sourceKind}`);
    const impl = inst.impls.get(contrib.id);
    if (!impl) return this.setPlaceholder(panel, item, 'adapter-error', '插件未注册该适配器');
    // 诚实标签以适配器声明为准
    panel.displayModeLabel = displayModeLabel(contrib);
    // 3. 资源（与核心一致：文件不存在时不弹授权）
    if (item.sourceKind === 'file') {
      const r = this.resources.get(item.ref);
      if (!r || r.exists === false) return this.setPlaceholder(panel, item, 'resource-missing');
    }
    // 4. 必需权限（可选权限不在打开时询问，见 PermissionDeclBase.optional）
    for (const perm of contrib.permissions) {
      if (perm.optional) continue;
      const decision = this.ensureGrant(pluginId, pluginName, contrib, perm);
      if (decision.decision === 'denied') return this.setPlaceholder(panel, item, 'permission-denied', perm.reason);
    }
    // 5. 按类型预检
    let profile: AppProfile | undefined;
    if (item.sourceKind === 'file') {
      const r = this.resources.get(item.ref)!;
      const scope = this.fileScopeError(pluginId, contrib, r);
      if (scope) return this.setPlaceholder(panel, item, 'permission-denied', scope);
    } else if (item.sourceKind === 'web') {
      const nav = checkNavigation(item.ref, this.netDomains(contrib));
      if (!nav.ok) return this.setPlaceholder(panel, item, 'domain-blocked', `此网页适配器只允许 ${this.netDomains(contrib).join('、')}，项目地址不在范围内。`);
    } else {
      profile = this.opts.appProfiles?.find((p) => p.appProfileId === item.ref);
      if (!profile || profile.adapterId !== contrib.id) return this.setPlaceholder(panel, item, 'adapter-error', `应用档案 ${item.ref} 不存在`);
      const spec = this.programSpec(contrib, profile.programId);
      if (!spec) return this.setPlaceholder(panel, item, 'adapter-error', `程序 ${profile.programId} 未声明`);
      const det = this.detect(spec);
      if (!det.installed) return this.setPlaceholder(panel, item, 'app-not-installed', spec.displayName);
      if (!det.verified) return this.setPlaceholder(panel, item, 'app-verification-failed', spec.displayName);
    }
    // 5. 状态恢复
    const restored = restoreFromEnvelope(item.state ?? null, impl, contrib.stateSchemaVersion);
    panel.stateResetNotice = restored.reset;
    // 6. open → mount
    const ctx = {
      adapter: contrib,
      restoredState: restored.state,
      requestSave: () => {
        panel.saveRequests++;
      },
      permissions: {
        query: (id: string) => {
          const g = this.grants.find((x) => x.pluginId === pluginId && x.adapterId === contrib.id && x.permissionId === id);
          return g ? g.decision : ('prompt' as const);
        },
        request: async (id: string) => {
          const perm = contrib.permissions.find((x) => x.id === id);
          if (!perm) return 'denied' as const;
          return this.ensureGrant(pluginId, pluginName, contrib, perm).decision;
        },
      },
      theme: this.theme,
      files: item.sourceKind === 'file' ? this.makeFileApi(pluginId, pluginName, contrib, panel) : undefined,
      process: item.sourceKind === 'app' ? this.makeProcessApi(pluginId, contrib, item.itemId) : undefined,
      appProfile: profile,
    };
    const instance = await impl.open(clone(item), ctx);
    panel.instance = instance;
    panel.placeholder = null;
    await instance.mount(this.makeTarget(pluginId, contrib, panel));
  }

  private async closePanelInstance(panel: MockPanel): Promise<void> {
    const inst = panel.instance;
    panel.instance = null;
    panel.disposables.forEach((d) => d.dispose());
    panel.disposables = [];
    panel.actionHandlers.clear();
    if (inst) {
      try {
        await inst.dispose();
      } catch {
        /* 忽略 */
      }
    }
    if (panel.web) {
      const it = this.items.get(panel.itemId);
      const contrib = it && this.findAdapter(it.adapterId)?.contrib;
      const others = [...this.panels.values()].some((x) => x !== panel && x.web && x.instance && x.web.partition === panel.web!.partition);
      if (contrib?.web?.session.clearOnClose && !others) await panel.web.clearSessionData();
    }
  }

  private async reopenPanelsOf(pluginId: string): Promise<void> {
    const inst = this.plugins.get(pluginId);
    const ids = inst?.module.manifest.contributes.adapters.map((a) => a.id) ?? [];
    for (const p of [...this.panels.values()]) if (ids.includes(this.items.get(p.itemId)!.adapterId)) await this.openItem(p.itemId);
  }

  private ensureGrant(pluginId: string, pluginName: string, contrib: AdapterContribution, perm: PermissionDecl): PermissionGrant {
    const hash = permissionDeclHash(perm);
    const existing = this.grants.find((g) => g.pluginId === pluginId && g.adapterId === contrib.id && g.permissionId === perm.id);
    // 拒绝记录长期有效（不反复打扰）；授权记录在声明变化后失效
    if (existing && (existing.decision === 'denied' || existing.declHash === hash)) return existing;
    const req: PermissionPromptRequest = {
      pluginId,
      pluginName,
      adapterId: contrib.id,
      adapterTitle: contrib.title,
      displayMode: contrib.displayMode,
      permission: clone(perm),
      scopeLines: describePermission(perm),
    };
    this.prompts.push(req);
    const ans = this.opts.prompt ? this.opts.prompt(req) : 'grant';
    const g: PermissionGrant = {
      pluginId,
      adapterId: contrib.id,
      permissionId: perm.id,
      decision: ans === 'deny' ? 'denied' : 'granted',
      rootIds: typeof ans === 'object' ? ans.rootIds : perm.kind === 'fs.read' ? 'all' : undefined,
      declHash: hash,
      decidedAt: Date.now(),
    };
    this.grants = this.grants.filter((x) => x !== existing);
    this.grants.push(g);
    return g;
  }

  // ---------- 保存 / 重启 ----------

  /** 模拟去抖保存：对每个已挂载实例 getState → 校验 → 写入 item.state */
  flush(): void {
    for (const p of this.panels.values()) {
      if (!p.instance) continue;
      const item = this.items.get(p.itemId)!;
      const contrib = this.findAdapter(item.adapterId)?.contrib;
      if (!contrib) continue;
      const s = p.instance.getState();
      if (s === undefined) continue;
      const chk = checkStateForSave(s, contrib.maxStateBytes);
      if (!chk.ok) {
        this.warnings.push(`[${item.adapterId}] 状态未保存：${chk.reason}`);
        continue;
      }
      item.state = { v: contrib.stateSchemaVersion, data: JSON.parse(chk.json) as JsonValue };
    }
  }

  snapshot(): MockPersisted {
    return clone({
      storage: this.storage,
      grants: this.grants,
      disabled: [...this.disabled],
      items: [...this.items.values()],
      webSessions: this.webSessions,
      theme: this.theme,
    });
  }

  /** 模拟退出并重启应用：保存 → 释放全部实例 → 新宿主读取持久数据 → 重新安装同一批插件 → 恢复工作区 */
  async restart(overrides: Partial<MockHostOptions> = {}): Promise<{ host: MockHost; panels: MockPanel[] }> {
    this.flush();
    const persisted = this.snapshot();
    for (const p of this.panels.values()) await this.closePanelInstance(p);
    const host = new MockHost({ ...this.opts, ...overrides, persisted });
    for (const m of this.moduleOrder) if (this.plugins.has(m.manifest.id)) await host.install(m);
    const panels = await host.openWorkspace();
    return { host, panels };
  }

  // ---------- 宿主 API 实现 ----------

  private makeStorage(pluginId: string) {
    const ns = () => (this.storage[pluginId] ??= {});
    return {
      get: async <T extends JsonValue = JsonValue>(k: string) => (k in ns() ? (clone(ns()[k]) as T) : null),
      set: async (k: string, v: JsonValue) => {
        const s = JSON.stringify(v);
        if (s.length > 1024 * 1024) throw new Error('单值超过 1 MB');
        ns()[k] = JSON.parse(s) as JsonValue;
      },
      delete: async (k: string) => {
        delete ns()[k];
      },
      keys: async () => Object.keys(ns()),
    };
  }

  private makeTarget(pluginId: string, contrib: AdapterContribution, panel: MockPanel): MountTarget {
    const base = { panelId: `panel-${panel.itemId}`, setTitle: (t: string) => void (panel.title = t) };
    const ui = {
      render: (n: UiNode) => void (panel.ui = clone(n)),
      onAction: (h: (a: string, p: JsonValue | undefined) => void) => {
        panel.actionHandlers.add(h);
        return { dispose: () => panel.actionHandlers.delete(h) };
      },
    };
    if (contrib.displayMode === 'in-app-web') {
      const persistent = contrib.web?.session.partition === 'persistent';
      const partition = persistent ? `persist:kbweb.${pluginId}` : `kbweb-mem.${pluginId}`;
      const cookies = persistent ? (this.webSessions[partition] ??= {}) : {};
      const netDomains = this.netDomains(contrib);
      // D1：子资源 = domains ∪ resourceDomains（与核心 resourceDomainsOf 一致）
      const resDomains = [...new Set(contrib.permissions.flatMap((p) => (p.kind === 'net' ? [...p.domains, ...(p.resourceDomains ?? [])] : [])))];
      panel.web = new MockWebPanel(netDomains, resDomains, partition, cookies, panel);
      return { ...base, kind: 'web', web: panel.web };
    }
    if (contrib.displayMode === 'external-managed') return { ...base, ...ui, kind: 'external' };
    return { ...base, ...ui, kind: 'reader', element: undefined };
  }

  private netDomains(contrib: AdapterContribution): string[] {
    return contrib.permissions.flatMap((p) => (p.kind === 'net' ? p.domains : []));
  }

  private fileScopeError(pluginId: string, contrib: AdapterContribution, r: MockResource): string | null {
    const perm = contrib.permissions.find((p) => p.kind === 'fs.read');
    if (!perm || perm.kind !== 'fs.read') return '未声明 fs.read';
    const g = this.grants.find((x) => x.pluginId === pluginId && x.adapterId === contrib.id && x.permissionId === perm.id);
    if (!g || g.decision !== 'granted') return perm.reason;
    if (g.rootIds !== 'all' && !(g.rootIds ?? []).includes(r.rootId)) return `${perm.reason}（文件所在文件夹未授权）`;
    const ext = (r.name.split('.').pop() ?? '').toLowerCase();
    if (perm.extensions && !perm.extensions.includes(ext)) return `${perm.reason}（扩展名 .${ext} 不在授权范围）`;
    return null;
  }

  private makeFileApi(pluginId: string, pluginName: string, contrib: AdapterContribution, panel: MockPanel): FileHostApi {
    // 面板令牌：形式由宿主决定（与核心一致：kbfile://plugin/<令牌>/<resourceId>），插件不得自行拼接
    const panelToken = `t${++this.tokenSeq}${Math.random().toString(36).slice(2, 10)}`;
    const guard = (resourceId: string): MockResource => {
      const fail = this.pendingFileFailures.shift();
      if (fail) throw new HostCallError(fail, fail === 'timeout' ? '宿主调用超时' : fail);
      const r = this.resources.get(resourceId);
      const permId = contrib.permissions.find((p) => p.kind === 'fs.read')?.id ?? 'fs.read';
      if (!r) throw new HostPermissionError({ permissionId: permId, kind: 'fs.read', reason: 'out-of-scope', detail: `未知资源 ${resourceId}` });
      const err = this.fileScopeError(pluginId, contrib, r);
      if (err) {
        const d: PermissionDenial = { permissionId: permId, kind: 'fs.read', reason: 'out-of-scope', detail: err };
        panel.deniedEvents.push(d);
        panel.instance?.onPermissionDenied?.(d);
        throw new HostPermissionError(d);
      }
      return r;
    };
    const api: FileHostApi = {
      stat: async (id) => {
        const r = guard(id);
        const ext = (r.name.split('.').pop() ?? '').toLowerCase();
        const size = r.bytes?.length ?? new TextEncoder().encode(r.text ?? '').length;
        return { resourceId: id, name: r.name, ext, size, mtimeMs: r.mtimeMs ?? 0, exists: r.exists !== false, mimeType: r.mimeType };
      },
      readText: async (id, o) => {
        const r = guard(id);
        if (r.exists === false) throw new Error('文件不可用');
        const full = r.text ?? new TextDecoder().decode(r.bytes ?? new Uint8Array());
        const bytes = new TextEncoder().encode(full);
        const max = o?.maxBytes ?? 5 * 1024 * 1024;
        const truncated = bytes.length > max;
        return { text: truncated ? new TextDecoder().decode(bytes.slice(0, max)) : full, truncated, size: bytes.length, encoding: 'utf-8' };
      },
      readBytes: async (id, range) => {
        const r = guard(id);
        const b = r.bytes ?? new TextEncoder().encode(r.text ?? '');
        return range ? b.slice(range.offset, range.offset + range.length) : b.slice();
      },
      contentUrl: (id) => {
        const r = guard(id);
        void r;
        return `kbfile://plugin/${panelToken}/${encodeURIComponent(id)}`;
      },
      onDidChange: (l) => {
        const d = this.fileEvents.event(l);
        panel.disposables.push(d);
        return d;
      },
    };
    const w = contrib.permissions.find((p) => p.kind === 'fileops.write');
    if (w && w.kind === 'fileops.write') {
      api.requestFileops = async (plan): Promise<FileopsResult> => {
        // 必需的 fileops.write 已在打开时询问；optional:true 时在首次写入时才询问
        const g = this.ensureGrant(pluginId, pluginName, contrib, w);
        if (g.decision !== 'granted') {
          const d: PermissionDenial = { permissionId: w.id, kind: 'fileops.write', reason: 'user-denied' };
          panel.deniedEvents.push(d);
          panel.instance?.onPermissionDenied?.(d);
          return { ok: false, reason: 'permission-denied' };
        }
        for (const s of plan.steps) {
          if (!w.operations.includes(s.op)) return { ok: false, reason: 'out-of-scope', detail: `未声明操作 ${s.op}` };
          try {
            guard(s.resourceId);
          } catch {
            return { ok: false, reason: 'out-of-scope', detail: s.resourceId };
          }
        }
        this.fileopsPlans.push(clone(plan));
        if (!(this.opts.approveFileops?.(plan) ?? false)) return { ok: false, reason: 'user-rejected' };
        return { ok: true, opIds: plan.steps.map((_, i) => i + 1) };
      };
    }
    return api;
  }

  /** 测试辅助：让接下来 n 次 files.* 调用以给定错误码失败（如 'timeout'，模拟宿主约 15 s 无回应） */
  failNextFileCalls(code: HostErrorCode, n = 1): void {
    this.pendingFileFailures.push(...Array.from({ length: n }, () => code));
  }
  private pendingFileFailures: HostErrorCode[] = [];

  /** 测试辅助：模拟文件被外部修改/删除 */
  fileChanged(resourceId: string, change: 'modified' | 'deleted' | 'moved', patch?: Partial<MockResource>): void {
    const r = this.resources.get(resourceId);
    if (r && patch) Object.assign(r, patch);
    if (r && change === 'deleted') r.exists = false;
    this.fileEvents.fire({ resourceId, change });
  }

  // ---------- 进程代理 ----------

  private programSpec(contrib: AdapterContribution, programId: string): ProgramSpec | undefined {
    for (const p of contrib.permissions) if (p.kind === 'process.launch') for (const g of p.programs) if (g.programId === programId) return g;
    return undefined;
  }

  private detect(spec: ProgramSpec): ProgramDetection & { exePath?: string } {
    const m = this.opts.programs?.[spec.programId];
    if (!m || !m.installed) return { programId: spec.programId, installed: false, verified: false, reason: 'not-found' };
    const v = spec.verify;
    if (v.sha256?.length && !(m.sha256 && v.sha256.includes(m.sha256))) return { programId: spec.programId, installed: true, verified: false, version: m.version, reason: 'hash-mismatch' };
    if (v.publisher && m.publisher !== v.publisher) return { programId: spec.programId, installed: true, verified: false, version: m.version, reason: 'publisher-mismatch' };
    if (v.versionRange && !(m.version && satisfies(m.version.split('.').slice(0, 3).join('.'), v.versionRange))) return { programId: spec.programId, installed: true, verified: false, version: m.version, reason: 'version-out-of-range' };
    return { programId: spec.programId, installed: true, verified: true, version: m.version, exePath: m.exePath ?? spec.exeCandidates[0] };
  }

  private makeProcessApi(pluginId: string, contrib: AdapterContribution, itemId: string): ProcessBrokerApi {
    const em = (this.procEmitters.get(pluginId) ?? this.procEmitters.set(pluginId, new Emitter()).get(pluginId))!;
    const permDecl = contrib.permissions.find((p) => p.kind === 'process.launch')!;
    const recent: number[] = [];
    const strip = (h: ProcessHandleInfo & { pluginId: string; profileItem: string }): ProcessHandleInfo => {
      const { pluginId: _p, profileItem: _i, ...rest } = h;
      return clone(rest);
    };
    return {
      detect: async (programId) => {
        const spec = this.programSpec(contrib, programId);
        if (!spec) return { programId, installed: false, verified: false, reason: 'not-found' };
        const { exePath: _e, ...d } = this.detect(spec);
        return d;
      },
      launch: async (req: LaunchRequest): Promise<LaunchResult> => {
        const g = this.grants.find((x) => x.pluginId === pluginId && x.adapterId === contrib.id && x.permissionId === permDecl.id);
        if (g?.decision !== 'granted') return { ok: false, reason: 'permission-denied' };
        const spec = this.programSpec(contrib, req.programId);
        if (!spec) return { ok: false, reason: 'unknown-program', detail: req.programId };
        const det = this.detect(spec);
        if (!det.installed) return { ok: false, reason: 'not-installed' };
        if (!det.verified) return { ok: false, reason: 'verification-failed', detail: det.reason };
        const now = Date.now();
        while (recent.length && now - recent[0]! > 10_000) recent.shift();
        if (recent.length >= 5) return { ok: false, reason: 'rate-limited' };
        if (spec.singleInstance !== false && [...this.procs.values()].some((p) => p.pluginId === pluginId && p.profileItem === itemId && p.programId === spec.programId && (p.status === 'running' || p.status === 'starting')))
          return { ok: false, reason: 'already-running' };
        const ex = expandArgs(spec, req, (rid) => {
          const r = this.resources.get(rid);
          if (!r || r.exists === false || !r.absPath) return null;
          return { absPath: r.absPath, ext: (r.name.split('.').pop() ?? '').toLowerCase() };
        });
        if (!ex.ok) return { ok: false, reason: ex.reason, detail: ex.detail };
        // D6 收紧版：启动前只备份资源槽位指向的目标文件 + manifest backup.include 声明的同根附加文件
        const limits = this.opts.backupLimits ?? DEFAULT_APP_BACKUP_LIMITS;
        const records: MockBackupRecord[] = [];
        for (const v of Object.values(req.slots ?? {})) {
          if (v.type !== 'resource') continue;
          const r = this.resources.get(v.resourceId)!;
          const cand = (x: MockResource) => ({ relPath: x.relPath ?? x.name, size: x.size ?? x.bytes?.length ?? new TextEncoder().encode(x.text ?? '').length });
          const others = [...this.resources.values()].filter((x) => x.rootId === r.rootId && x.exists !== false).map(cand);
          const plan = planAppBackup(cand(r), spec.backup, others, limits);
          records.push({ pluginId, resourceId: v.resourceId, files: plan.files.map((f) => f.relPath), skipped: plan.skipped.map((f) => f.relPath), bytes: plan.totalBytes, targetOverLimit: plan.targetOverLimit });
        }
        if (records.some((b) => b.targetOverLimit) && !(this.opts.confirmUnbackedLaunch?.() ?? false)) return { ok: false, reason: 'backup-over-limit', detail: '文件超过备份上限' };
        recent.push(now);
        for (const b of records) {
          this.preLaunchBackups.push({ pluginId, resourceId: b.resourceId });
          this.backupRecords.push(b);
        }
        const backup = records.length
          ? {
              files: records.reduce((n, b) => n + b.files.length, 0),
              bytes: records.reduce((n, b) => n + b.bytes, 0),
              skipped: records.reduce((n, b) => n + b.skipped.length, 0),
              ...(records.some((b) => b.targetOverLimit) ? { targetUnprotected: true } : {}),
            }
          : undefined;
        this.launches.push({ pluginId, programId: spec.programId, templateId: req.templateId, exePath: det.exePath!, argv: ex.argv });
        const launchId = `L${++this.launchSeq}`;
        const h = {
          launchId,
          programId: spec.programId,
          templateId: req.templateId,
          status: 'running' as const,
          pid: 4000 + this.launchSeq,
          startedAt: now,
          window: { tracking: spec.windowTracking, state: spec.windowTracking === 'none' ? ('not-tracked' as const) : ('found' as const), title: spec.windowTracking === 'none' ? undefined : `${spec.displayName}` },
          ...(backup ? { backup } : {}),
          pluginId,
          profileItem: itemId,
        };
        this.procs.set(launchId, h);
        queueMicrotask(() => em.fire({ launchId, status: 'running', window: h.window }));
        return { ok: true, handle: strip(h) };
      },
      focus: async (id) => {
        const h = this.procs.get(id);
        return !!h && h.pluginId === pluginId && h.status === 'running' && h.window.state === 'found';
      },
      close: async (id) => {
        const h = this.procs.get(id);
        if (!h || h.pluginId !== pluginId || h.status !== 'running') return false;
        this.simulateExit(id, 0);
        return true;
      },
      list: () => [...this.procs.values()].filter((p) => p.pluginId === pluginId).map(strip),
      onStatus: (l) => em.event(l),
    };
  }

  /** 测试辅助：宿主侧看到的全部进程（含已关闭面板的） */
  processes(): ProcessHandleInfo[] {
    return [...this.procs.values()].map(({ pluginId: _p, profileItem: _i, ...rest }) => clone(rest));
  }

  /** 测试辅助：外部程序退出（用户手动关闭窗口等） */
  simulateExit(launchId: string, exitCode = 0): void {
    const h = this.procs.get(launchId);
    if (!h) return;
    h.status = exitCode === 0 ? 'exited' : 'crashed';
    h.exitCode = exitCode;
    h.window = { ...h.window, state: h.window.tracking === 'none' ? 'not-tracked' : 'lost' };
    this.procEmitters.get(h.pluginId)?.fire({ launchId, status: h.status, exitCode, window: h.window });
  }
  /** 测试辅助：窗口跟踪丢失（如 Windows 11 记事本由 Store 版接管，启动的 pid 立即退出） */
  simulateWindowLost(launchId: string): void {
    const h = this.procs.get(launchId);
    if (!h) return;
    h.window = { ...h.window, state: 'lost' };
    this.procEmitters.get(h.pluginId)?.fire({ launchId, status: h.status, window: h.window });
  }
  /** 测试辅助：改变程序安装/版本情况（如程序更新导致哈希变化） */
  setProgram(programId: string, p: MockProgram): void {
    (this.opts.programs ??= {})[programId] = p;
  }
}

export function createMockHost(opts?: MockHostOptions): MockHost {
  return new MockHost(opts);
}

/**
 * 测试用桩插件：一个最小的纯文本文件适配器，用来证明“某个适配器失败时，工作区其他面板照常恢复”。
 */
export function makeStubTextPlugin(pluginId = 'stub.text'): AdapterPluginModule {
  const adapterId = `${pluginId}.reader`;
  return {
    manifest: {
      id: pluginId,
      name: '纯文本（测试桩）',
      version: '1.0.0',
      engines: { workbench: '*', adapterApi: '^0.1.0' },
      sandbox: 'iframe',
      contributes: {
        adapters: [
          {
            id: adapterId,
            title: '纯文本',
            sourceKinds: ['file'],
            displayMode: 'in-app-reader',
            match: { file: { extensions: ['txt'] } },
            permissions: [{ id: 'read', kind: 'fs.read', scope: 'all-registered-roots', reason: '读取文本文件' }],
            stateSchemaVersion: 1,
          },
        ],
      },
    },
    activate(api) {
      api.adapters.register<{ line: number }>({
        id: adapterId,
        restoreState: (d) => (typeof (d as { line?: unknown })?.line === 'number' ? (d as { line: number }) : undefined),
        open(item, ctx) {
          let line = ctx.restoredState?.line ?? 0;
          return {
            async mount(t) {
              if (t.kind !== 'reader') return;
              const r = await ctx.files!.readText(item.ref);
              t.render({ type: 'code', text: r.text });
              t.onAction((a) => {
                if (a === 'next') {
                  line++;
                  ctx.requestSave();
                }
              });
            },
            getState: () => ({ line }),
            dispose() {},
          };
        },
      });
    },
  };
}
