/**
 * 插件 / 扩展点类型（宿主 API v0.2）。内置功能与第三方插件使用同一套类型。
 * 本文件不依赖 React 运行时（只用类型），可在 Node 测试中导入。
 *
 * 0.2 相对 0.1 的破坏性变化（0.x 期间允许）：
 *  - 视图 → 适配器（adapters）：一个条目（file/web/app）由适配器显示；views.register 保留为已废弃别名（只注册 file 适配器）。
 *  - themes.register → themes.registerChrome / registerReading / registerLayoutPreset（外框、阅读区、布局预设三轴分离）。
 *  - 权限采用适配器 SDK 的结构化声明（PermissionDecl：kind + 范围 + 理由），授权记录为 PermissionGrant{rootIds, declHash}（T22）。
 *  - 第三方插件只能是沙箱 iframe 中的适配器插件（AdapterPluginManifest，开发者模式安装）；本文件的 PluginModule 只用于内置插件。
 */
import type { ComponentType } from 'react';
import type { ResourceInfo, TextContent } from '../../shared/types';
import type { SaveOutcome, SavePreview, TextSnapshot, UndoOutcome, WriteRecord } from '../../shared/textEdit';
import type { DisplayMode, LayoutPresetTemplate, SourceKind, WorkspaceItem } from './layoutModel';
import type { AdapterContribution as SdkAdapterContribution, PermissionDecl } from '../../shared/adapter-sdk/types';

export { HOST_API_VERSION } from '../../shared/hostApi';

/**
 * 权限：采用适配器 SDK 的结构化声明（T22：SDK 为准）。每项带 id、kind、范围参数与中文理由：
 *  - fs.read（scope: ask-per-root | all-registered-roots，extensions?）
 *  - fileops.write（operations: write/move/trash；每一批修改仍需在批量计划对话框中批准）
 *  - net（domains）/ process.launch（programs）：P2/P3 才开放
 * 内置插件（随应用发布、在渲染进程中运行）的权限视为已授予；第三方插件一律走沙箱 iframe 与授权对话框。
 */
export type Permission = PermissionDecl;

export interface AdapterDecl {
  id: string;
  title?: string;
  sourceKinds: SourceKind[];
  displayMode: DisplayMode;
  /** 声明式匹配（供未激活时“打开方式”列表与文档使用）；运行时以 AdapterContribution.match 为准 */
  match?: { extensions?: string[]; mimeTypes?: string[]; urlPatterns?: string[]; appProfiles?: string[] };
  permissions?: PermissionDecl[];
  stateSchemaVersion?: number;
}

export interface PluginManifest {
  id: string; // 反向域名风格，如 'builtin.readers'、'demo.csv-table'
  name: string;
  version: string;
  engines: { workbench: string }; // semver 范围，如 '^0.2.0'
  description?: string;
  /** 激活事件：'onStartup' | 'onAdapter:<id>' | 'onCommand:<commandId>' */
  activationEvents?: string[];
  contributes?: {
    adapters?: AdapterDecl[];
    /** @deprecated 0.1 写法，等价于 sourceKinds:['file'], displayMode:'in-app-reader' 的 adapters */
    views?: { id: string; title: string; extensions?: string[]; mimeTypes?: string[] }[];
    panels?: { id: string; title: string; location: PanelLocation }[];
    commands?: { id: string; title: string; keybinding?: string }[];
    chromeThemes?: { id: string; label: string }[];
    readingThemes?: { id: string; label: string }[];
    layoutPresets?: { id: string; label: string }[];
  };
}

export interface Disposable {
  dispose(): void;
}

// ---------------- adapters（取代 0.1 的 views） ----------------

/** 适配器匹配时看到的目标 */
export type AdapterTarget =
  | { sourceKind: 'file'; resource: ResourceInfo }
  | { sourceKind: 'web'; url: string }
  | { sourceKind: 'app'; appProfileId: string };

export interface AdapterProps<S = unknown> {
  item: Readonly<WorkspaceItem>;
  /** sourceKind=file 时为对应资源 */
  resource: ResourceInfo;
  /** 由 restoreState 还原的视图状态（首次打开为 undefined） */
  state: S | undefined;
  /** 视图状态变化时调用；宿主负责净化（剔除密钥、限制大小）并写入工作区布局 */
  setState(state: S): void;
  api: PluginApi;
  /**
   * 第 9 轮 D：内容已显示（用于“可见内容加载完成”启动指标）。声明了 reportsReady 的适配器在首屏内容画好后调用一次；
   * 没声明的，宿主在视图挂载后的下一帧自动视为就绪。
   */
  reportReady?: () => void;
}
/** @deprecated 0.1 名称 */
export type ViewProps<S = unknown> = AdapterProps<S>;

export interface AdapterContribution<S = unknown> {
  /** 全局唯一的适配器 id，写入条目的 adapterId，例如 'builtin.markdown' */
  id: string;
  title: string;
  sourceKinds: SourceKind[];
  /** 诚实声明显示方式：in-app-reader（应用内阅读器）/ in-app-web（应用内网页）/ external-managed（外部程序，由应用托管窗口位置） */
  displayMode: DisplayMode;
  /** 返回优先级：0 表示不支持；数值越大越优先（内置 100 档、回退 1 档、插件可用 200 覆盖内置） */
  match(target: AdapterTarget): number;
  component: ComponentType<AdapterProps<S>>;
  /** 状态格式版本；变更状态结构时 +1，并提供 migrateState */
  stateSchemaVersion?: number;
  migrateState?(data: unknown, fromVersion: number): unknown;
  /** 把视图状态转成可 JSON 序列化的数据（默认原样） */
  serializeState?(state: S): unknown;
  /** 从布局 JSON 还原；数据不合法时返回 undefined（宿主用默认状态） */
  restoreState?(raw: unknown): S | undefined;
  /**
   * 视图自己处理文件内容变化（经 api.workspace.onDidChangeFile）。为 true 时宿主不会因为文件 mtime/大小变化而重建视图，
   * 编辑器里未保存的修改因此不会被冲掉（第 9 轮 C）。默认 false：文件变化时宿主重建视图以显示新内容。
   */
  handlesFileChanges?: boolean;
  /** 视图会自己调用 props.reportReady()（内容真正画好时）；否则宿主在挂载后自动视为就绪 */
  reportsReady?: boolean;
  /** 第三方沙箱适配器：宿主据此做授权、范围预检，并把面板交给沙箱 iframe（component 不用于渲染内容） */
  sandbox?: { pluginId: string; pluginName: string; decl: SdkAdapterContribution };
  /**
   * 内容缩放能力。只声明真正做到的动作。
   * delegated：交给外部程序，宿主不得 requestActivate、不得抢焦点。
   */
  contentZoom?: {
    actions: Array<'in' | 'out' | 'reset' | 'fit' | 'set' | 'wheel'>;
    anchor: 'exact' | 'page' | 'reflow' | 'approx';
    min: number;
    max: number;
    delegated?: boolean;
    note?: string;
  };
}

/** @deprecated 0.1 写法：只处理文件的视图 */
export interface ViewContribution<S = unknown> {
  id: string;
  title: string;
  match(resource: ResourceInfo): number;
  component: ComponentType<AdapterProps<S>>;
  serializeState?(state: S): unknown;
  restoreState?(raw: unknown): S | undefined;
}

// ---------------- panels / commands / themes ----------------

export type PanelLocation = 'sidebar' | 'bottom';
export interface PanelContribution {
  id: string;
  title: string;
  location: PanelLocation;
  order?: number;
  component: ComponentType<{ api: PluginApi }>;
}

export interface CommandContribution {
  id: string;
  title: string;
  category?: string;
  /** 默认快捷键；用户覆盖由 keybindings 注册表计算 */
  keybinding?: string; // 如 'Ctrl+Shift+P'
  /** 作用范围；缺省 global（总包 §2.3） */
  when?: 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';
  /**
   * 缺省 key。wheel 只给内容缩放的滚轮绑定（view.contentZoomWheel），
   * 不进 listBoundAccelerators，也不走 keydown。
   */
  trigger?: 'key' | 'wheel';
  /** 缺省 false。true 才允许文件桥 invoke。 */
  bridgeInvokable?: boolean;
  /** 缺省 false。true 时桥只拒绝，不直接执行写副作用。 */
  approvalRequired?: boolean;
  argsSchema?: object;
  run(...args: unknown[]): unknown;
}

/** 控制台功能块动作只能看见这两条。没有 approve。 */
export interface ConsoleBlockContext {
  commands: { execute(id: string, ...args: unknown[]): Promise<unknown> };
  ops: { propose(title: string, ops: unknown[]): Promise<unknown> };
  log(message: string): void;
}

export interface ConsoleBlockRenderResult extends Disposable {
  element?: unknown;
}

export interface ConsoleBlockContribution {
  kind: string;
  /** 该 kind 能渲染的最高 version */
  version: number;
  render(block: { version: number; data: unknown }, ctx: ConsoleBlockContext): ConsoleBlockRenderResult;
  actions?: Record<string, (args: unknown, ctx: ConsoleBlockContext) => void | Promise<void>>;
}

/** 一个明暗变体：令牌（不含 --kb- 前缀）+ 已校验、已加作用域前缀的 CSS */
export interface ThemeVariant {
  tokens: Record<string, string>;
  css?: string;
}
/** 外框样式（chrome theme）：顶栏、侧栏、标签、按钮、分隔条、状态栏、对话框…… */
export interface ChromeThemeContribution {
  id: string;
  label: string;
  light: ThemeVariant;
  dark: ThemeVariant;
}
/** 阅读区样式（reading theme）：正文字体、行高、版心、代码、PDF 页面底色…… */
export interface ReadingThemeContribution {
  id: string;
  label: string;
  light: ThemeVariant;
  dark: ThemeVariant;
}
/** 工作区布局预设：只描述分栏排列（改变面板排列的东西一律是布局预设，不是主题） */
export type LayoutPresetContribution = LayoutPresetTemplate;

// ---------------- host API ----------------

export interface PluginApi {
  readonly pluginId: string;
  readonly hostVersion: string;
  adapters: { register<S>(a: AdapterContribution<S>): Disposable };
  /** @deprecated 用 adapters.register */
  views: { register<S>(v: ViewContribution<S>): Disposable };
  panels: { register(p: PanelContribution): Disposable };
  commands: { register(c: CommandContribution): Disposable; execute(id: string, ...args: unknown[]): Promise<unknown> };
  /** 控制台 fenced 功能块。第三方动作不能批准计划。 */
  consoleBlocks: { register(c: ConsoleBlockContribution): Disposable };
  themes: {
    registerChrome(t: ChromeThemeContribution): Disposable;
    registerReading(t: ReadingThemeContribution): Disposable;
    registerLayoutPreset(p: LayoutPresetContribution): Disposable;
  };
  /** 内置插件访问已注册根内的文件 */
  workspace: {
    readText(resourceId: string): Promise<TextContent>;
    fileUrl(resource: { resourceId: string; name: string }): string;
    rootFileUrl(rootId: string, relPath: string): string;
    showInFolder(resourceId: string): Promise<void>;
    /** 文件内容变化（外部软件、其他面板保存、撤销）：按资源 ID 订阅，内部去抖 */
    onDidChangeFile(resourceId: string, cb: () => void): Disposable;
    /**
     * 原位编辑（第 9 轮 C）。**只提供给内置插件**（第三方插件为 undefined；它们的写操作走 fileops 计划 + 用户批准）。
     * 全部经主进程服务层：保存前差异、哈希冲突检测、备份 + op_log、撤销到上一版。
     */
    textEdit?: TextEditApi;
  };
  /** 插件私有存储（插件全局设置；应用数据目录内按插件 id 隔离，随备份导出）。视图状态请用 setState 存进工作区。 */
  storage: { get<T = unknown>(key: string): Promise<T | null>; set(key: string, value: unknown): Promise<void> };
}

export interface TextEditApi {
  open(resourceId: string): Promise<TextSnapshot>;
  stat(resourceId: string): Promise<{ hash: string; mtimeMs: number; size: number }>;
  previewSave(resourceId: string, text: string, baseHash: string): Promise<SavePreview>;
  save(resourceId: string, text: string, baseHash: string): Promise<SaveOutcome>;
  history(resourceId: string): Promise<WriteRecord[]>;
  undoLastSave(resourceId: string, force?: boolean): Promise<UndoOutcome>;
}

export interface PluginModule {
  manifest: PluginManifest;
  activate(api: PluginApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
