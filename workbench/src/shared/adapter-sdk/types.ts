/* 来自 kb-adapter-sdk@8b7011f src/types.ts（逐字复制，仅把 './types.js' 改为 './types'）。不要在这里改规则：规则变更先改 SDK，再重新同步。 */
/**
 * 本地知识工作台 · 适配器 SDK 类型（Adapter API v0.1）
 *
 * - 纯类型 + 两个常量，零运行时依赖，不依赖 DOM / React / Node 类型。
 * - 与核心现有的 `api.views.register({id,title,match,component,serializeState,restoreState})`
 *   并存：file 适配器由宿主桥接到视图注册表（见 docs/适配器规范.md §9）。
 * - 规范正文见 docs/适配器规范.md；字段注释是摘要，以规范为准。
 */

/** 适配器 API 版本（semver），独立于应用版本与核心 HOST_API_VERSION。 */
export const ADAPTER_API_VERSION = '0.1.0';

/** 状态信封默认大小上限（字节，UTF-8 JSON）。适配器可在 manifest 中调小，不能调大。 */
export const DEFAULT_MAX_STATE_BYTES = 16 * 1024;

// ───────────────────────── 基础 ─────────────────────────

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Disposable {
  dispose(): void;
}

/** 事件订阅：调用即订阅，返回 Disposable 取消订阅。 */
export type HostEvent<T> = (listener: (e: T) => void) => Disposable;

/** 来源类型 */
export type SourceKind = 'file' | 'web' | 'app';

/** 修订 10：插件来源。'builtin' = 随工作台安装包一起发布的内置适配器（宿主自己加载，不经开发者模式安装）；其余一律按 'third-party' 校验 */
export type AdapterInstallSource = 'builtin' | 'third-party';

/**
 * 诚实的显示方式（清单字段 `displayMode`，必填，界面用 displayModeLabel 显示；DISPLAY_MODE_FACTS 给出完整说明）：
 * - in-app-reader「内嵌渲染」：内容由适配器在应用内渲染（沙箱 iframe + UiNode）。
 * - in-app-web「内嵌网页」：宿主拥有的网页面板，加载受限域名的网页；工作台浮层出现时可能临时以截图占位。
 * - external-managed「外部窗口启动」：启动外部程序，程序在它自己的窗口中运行；面板只显示状态占位与控制按钮，不显示程序画面。
 * 对应关系固定：file→in-app-reader，web→in-app-web，app→external-managed。
 * “嵌入外部程序窗口”不是一种 displayMode，而是 external-managed 的逐应用/逐版本验证的实验增强（AppEmbeddingDeclaration）。
 */
export type DisplayMode = 'in-app-reader' | 'in-app-web' | 'external-managed';

/** 发布阶段：P1 文件阅读器 + 工作区面板；P2 网页面板；P3 指定本地应用适配器。 */
export type RolloutPhase = 1 | 2 | 3;

// ───────────────────────── 工作区项目 ─────────────────────────

/**
 * 迁移失败时原样保留的旧状态。适配器把它放进自己的新状态里（例如字段 `legacy`）继续保存，
 * 这样升级后即使迁移失败也不丢数据；用户可在面板里看到提示，修复迁移的新版本可再次尝试。见 policy.ts migrateOrPreserve。
 */
export interface PreservedLegacyState {
  v: number;
  data: JsonValue;
  /** 迁移失败原因（给用户看的简短中文） */
  error: string;
}

/** 版本化状态信封：v = 适配器 stateSchemaVersion；data 必须小、无秘密、无文件正文。 */
export interface StateEnvelope<T = JsonValue> {
  v: number;
  data: T;
}

interface WorkspaceItemBase {
  /** 稳定 ID（UUID），布局面板只引用它 */
  itemId: string;
  adapterId: string;
  displayMode: DisplayMode;
  /** 最近一次保存的状态；null/缺省 = 默认状态 */
  state?: StateEnvelope | null;
  /** 用户自定义标题（可选） */
  title?: string;
}

export interface FileWorkspaceItem extends WorkspaceItemBase {
  sourceKind: 'file';
  /** resourceId（核心资源表的稳定 ID，不是路径） */
  ref: string;
}
export interface WebWorkspaceItem extends WorkspaceItemBase {
  sourceKind: 'web';
  /** 初始 URL（必须落在适配器已声明的域名内；不得含凭据/令牌） */
  ref: string;
}
export interface AppWorkspaceItem extends WorkspaceItemBase {
  sourceKind: 'app';
  /** appProfileId：核心保存的“程序 + 参数模板 + 槽位取值”绑定，见 AppProfile */
  ref: string;
}
export type WorkspaceItem = FileWorkspaceItem | WebWorkspaceItem | AppWorkspaceItem;

/** dockview 面板参数（核心布局 schema 4：`{schema:4, dock, shell}`，条目存 workspace_items 表）：只有 itemId。 */
export interface LayoutPanelParams {
  itemId: string;
}

/**
 * 应用档案（由核心存储，用户在“添加外部程序项目”时创建）。
 * 适配器只能看到 programId / templateId / 槽位的逻辑值，看不到 exe 绝对路径和最终 argv。
 */
export interface AppProfile {
  appProfileId: string;
  adapterId: string;
  programId: string;
  label: string;
  launch: { templateId: string; slots: Record<string, SlotValue> };
}

// ───────────────────────── 权限 ─────────────────────────

interface PermissionDeclBase {
  /** 在本适配器内唯一，例如 'read-json' */
  id: string;
  /** 中文理由，原样显示在授权对话框 */
  reason: string;
  /**
   * 必需（缺省）：打开条目时询问，被拒 → 核心显示 permission-denied 占位。
   * 可选（true）：打开时不询问；由插件 ctx.permissions.request() 或首次使用时询问
   * （fileops.write：首次 requestFileops 时）。被拒时适配器照常运行并收到 onPermissionDenied。
   */
  optional?: boolean;
}

/** 读取已注册根内的资源（只经 resourceId，拿不到绝对路径） */
export interface FsReadPermission extends PermissionDeclBase {
  kind: 'fs.read';
  /** ask-per-root：授权时用户勾选可读的根；all-registered-roots：所有已注册根（含将来新增的根需再次确认） */
  scope: 'ask-per-root' | 'all-registered-roots';
  /** 进一步限制扩展名（小写，不含点） */
  extensions?: string[];
}

/** 通过核心 fileops 服务修改文件；每一批修改仍需用户在“批量计划”对话框中批准 */
export interface FileopsWritePermission extends PermissionDeclBase {
  kind: 'fileops.write';
  operations: Array<'write' | 'move' | 'trash'>;
}

/** 网络：只允许列出的域名 */
export interface NetPermission extends PermissionDeclBase {
  kind: 'net';
  /** 顶层导航允许的主机：精确主机名（developer.mozilla.org）或显式子域通配（*.example.com，不含裸域）。禁止 '*'、IP、端口、路径。 */
  domains: string[];
  /**
   * 子资源（子框架/脚本/样式/图片/XHR/WebSocket/Worker）额外允许的主机；缺省 = 与 domains 相同。
   * 产品决定 D1：子资源只允许 domains ∪ resourceDomains。会列在授权对话框中（describePermission），改动后 declHash 变化 → 重新询问。
   * 宿主的检查发生在页面自身 CSP 之后：页面 CSP 已挡掉的请求宿主看不到。
   */
  resourceDomains?: string[];
  /**
   * 修订 10：授权方式。缺省 'listed' = 只允许 domains 中列出的主机（第三方插件只能用这种）。
   * 'ask-per-site' = 逐站授权：首次导航到某个主机时宿主弹框询问，用户批准后把**精确主机名**写入该适配器
   * PermissionGrant.grantedHosts；顶层导航、重定向、子框架、弹窗、下载、子资源只允许 domains ∪ grantedHosts ∪ resourceDomains。
   * 只有随包内置（source = 'builtin'）的适配器可以声明；第三方插件声明了就拒绝安装（validateAdapterManifest）。
   * 逐站授权的适配器可以打开 http 地址（宿主标注“不安全连接”），但仍只限已批准的主机；IP、端口、userinfo、非 http(s) 协议一律拒绝。
   * 这条规则不放宽 domains 本身：仍禁止 '*'、IP、端口、路径。
   */
  mode?: 'listed' | 'ask-per-site';
}

/** 启动指定程序（仅限列出的 exe + 固定参数模板） */
export interface ProcessLaunchPermission extends PermissionDeclBase {
  kind: 'process.launch';
  programs: ProgramSpec[];
}

export type PermissionDecl = FsReadPermission | FileopsWritePermission | NetPermission | ProcessLaunchPermission;
export type PermissionKind = PermissionDecl['kind'];

/** 可启动程序声明 */
export interface ProgramSpec {
  /** 在插件内唯一，如 'notepad' */
  programId: string;
  displayName: string;
  /**
   * exe 候选路径（按顺序取第一个存在且通过校验的）。
   * 必须是绝对路径或以环境变量令牌开头：%WINDIR% %SystemRoot% %ProgramFiles% %ProgramFiles(x86)% %LOCALAPPDATA%。
   * 只允许 .exe；不做 PATH 搜索；禁止 .bat/.cmd/.ps1/.vbs/.js/.lnk。
   */
  exeCandidates: string[];
  /** 校验：至少提供 sha256 或 publisher 之一，否则必须显式 unverified:true（授权框以警告样式显示） */
  verify: {
    sha256?: string[];
    /** Authenticode 签名主体（如 'Microsoft Windows'），宿主用 WinVerifyTrust 校验 */
    publisher?: string;
    /** 文件版本范围（semver 风格，对 Windows 四段版本取前三段） */
    versionRange?: string;
    unverified?: boolean;
  };
  /** 固定参数模板；适配器只能选模板并填类型化槽位 */
  argTemplates: ArgTemplate[];
  /** 窗口跟踪：best-effort = 宿主尝试按 pid/窗口类关联顶层窗口，可能失败 */
  windowTracking: 'none' | 'best-effort';
  /** 同一 profile 同时最多运行一个实例（默认 true） */
  singleInstance?: boolean;
  /** 启动前备份范围（D6 收紧版）。缺省 = 只备份资源槽位指向的目标文件。属于权限声明：改动后 declHash 变化，需重新授权。 */
  backup?: AppBackupDecl;
}

/**
 * 启动外部程序前的备份范围。宿主**只**备份：资源槽位指向的目标文件 + 这里声明的附加文件；从不复制整个已注册根。
 * 上限与保留期由宿主决定（参考值见 policy.ts DEFAULT_APP_BACKUP_LIMITS），超出上限的文件不备份并在启动前提示。
 */
export interface AppBackupDecl {
  /**
   * 附加文件：相对于“目标文件所在文件夹”的 glob，只匹配同一已注册根内的普通文件。
   * 语法：`*` `?`（不跨文件夹）、`**`（独占一段，跨文件夹）、`{stem}`（目标文件名去掉最后一个扩展名）。
   * 禁止：绝对路径、`..`、反斜杠、只由通配符组成的模式（如 `*`、`**`、`*.*`，或 `**` 段后面只跟 `*` 的写法）。最多 8 条。
   * 例：`{stem}.*`（同名不同扩展名的伴随文件）、`images/*.png`。
   */
  include?: string[];
}

/**
 * 参数模板。args 中每个元素是一个 argv 项：
 * - 纯字面量（不得含 '{' '}'、换行、NUL、双引号）
 * - 或 `前缀{slot}`，前缀为字面量，slot 必须在 slots 中声明，每项至多一个占位符
 */
export interface ArgTemplate {
  id: string;
  label: string;
  args: string[];
  slots?: Record<string, ArgSlot>;
}

export type ArgSlot =
  /** 核心把 resourceId 解析为已注册根内的绝对路径；适配器永远看不到这个路径。产品决定 D6：启动前宿主自动备份该文件（blobs + op_log）。 */
  | { type: 'resource'; extensions?: string[] }
  | { type: 'enum'; values: string[] }
  | { type: 'int'; min: number; max: number };

export type SlotValue =
  | { type: 'resource'; resourceId: string }
  | { type: 'enum'; value: string }
  | { type: 'int'; value: number };

/** 授权记录（核心保存在 plugins.granted_json；按 pluginId+adapterId+permissionId） */
export interface PermissionGrant {
  pluginId: string;
  adapterId: string;
  permissionId: string;
  decision: 'granted' | 'denied';
  /** fs.read + ask-per-root 时用户勾选的根 */
  rootIds?: string[] | 'all';
  /** 授权时 manifest 中该权限的指纹（内容变化 → 视为未授权，需重新询问） */
  declHash: string;
  decidedAt: number;
  /**
   * 修订 10：net + mode 'ask-per-site' 时用户逐个批准过的**精确主机名**（小写、punycode、无端口、非 IP）。
   * 只在 decision === 'granted' 且 declHash 有效时生效；撤销（decision 'denied'）后全部失效。
   */
  grantedHosts?: string[];
}

/** 宿主向用户展示的授权请求（mock host 记录它，验收时检查“是否展示且限定范围”） */
export interface PermissionPromptRequest {
  pluginId: string;
  pluginName: string;
  adapterId: string;
  adapterTitle: string;
  displayMode: DisplayMode;
  permission: PermissionDecl;
  /** 宿主生成的中文范围说明（每行一条），例如“仅限域名：developer.mozilla.org” */
  scopeLines: string[];
}

export type PermissionPromptAnswer = 'grant' | 'deny' | { grant: true; rootIds: string[] };

export interface PermissionDenial {
  permissionId: string;
  kind: PermissionKind;
  reason: 'user-denied' | 'revoked' | 'out-of-scope' | 'policy';
  detail?: string;
}

// ───────────────────────── Manifest ─────────────────────────

export interface AdapterMatch {
  file?: { extensions?: string[]; mimeTypes?: string[]; maxSizeBytes?: number };
  /** 'https://developer.mozilla.org/*' 形式；主机必须在 net 权限 domains 内 */
  web?: { urlPatterns: string[] };
  app?: { programIds: string[] };
  /** 与核心视图优先级同档：内置 100、回退 1、插件 ≤200 */
  priority?: number;
}

export interface StateMigrationDecl {
  from: number;
  to: number;
  note?: string;
}

export interface WebAdapterOptions {
  /** 新建项目的默认 URL */
  homeUrl: string;
  /**
   * 会话：分区名由宿主按插件派生（persist:kbweb.<pluginId> 或内存分区），插件不能指定或共享。
   * persistent：Cookie/存储保留到用户清除或卸载；ephemeral：仅本次运行。
   */
  session: {
    partition: 'persistent' | 'ephemeral';
    /** 关闭最后一个该插件的面板时清除 */
    clearOnClose?: boolean;
    /** 该插件连续 N 天没有创建网页面板（未使用）则宿主清除整个分区；不是单个 Cookie 的年龄。缺省不限 */
    maxAgeDays?: number;
  };
  /** 离开允许域名的链接：block = 拦截并显示“域名被阻止”；open-external-with-confirm = 确认后用系统浏览器打开（产品决定 D2：推荐值） */
  offDomain: 'block' | 'open-external-with-confirm';
  /** 宿主可以拒绝所有弹窗（包括允许域名内的 window.open / target=_blank）；open-external-with-confirm 只是在横幅中提供“用系统浏览器打开” */
  popups: 'block' | 'open-external-with-confirm';
  downloads: 'block' | 'ask';
}

/** 逐应用/逐版本验证的“嵌入窗口”声明。默认关闭，需用户在设置中开启实验开关。 */
export interface AppEmbeddingDeclaration {
  method: 'win32-reparent';
  enabledByDefault: false;
  verified: VerifiedEmbedding[];
}

export interface VerifiedEmbedding {
  programId: string;
  /** 已验证的产品版本范围 */
  productVersionRange: string;
  /** 已验证的 exe 哈希（换版本即失效 → 自动回落到 external-managed） */
  exeSha256: string[];
  /** 验证过的 Windows 版本，如 'Windows 11 23H2 (22631)' */
  windowsBuilds: string[];
  /** 验证覆盖的 DPI 缩放 */
  dpiScales: number[];
  verifiedAt: string;
  verifiedBy: string;
  /** 证据：验收记录文件路径或链接 */
  evidence: string;
  knownIssues: string[];
}

export interface AppAdapterOptions {
  programIds: string[];
  /** 关闭面板 / 退出工作台时对已启动程序的处理（产品决定 D4：leave-running，外部程序继续运行） */
  onPanelClose: 'leave-running' | 'ask' | 'close-gracefully';
  /** 恢复工作区时是否自动启动：固定 false，必须用户点击“启动”（防止开机即拉起程序） */
  autoLaunchOnRestore: false;
  embedding?: AppEmbeddingDeclaration;
}

export interface AdapterContribution {
  /** 全局唯一，建议 `<pluginId>.<name>` */
  id: string;
  title: string;
  description?: string;
  /** v0.1 中每个适配器只能声明一种 sourceKind（数组形式为将来预留） */
  sourceKinds: SourceKind[];
  displayMode: DisplayMode;
  match: AdapterMatch;
  permissions: PermissionDecl[];
  /** 当前状态结构版本（正整数，从 1 开始） */
  stateSchemaVersion: number;
  /** 声明已实现的迁移（代码在 restoreState 中实现），供宿主/商店展示和静态检查 */
  stateMigrations?: StateMigrationDecl[];
  /** ≤ DEFAULT_MAX_STATE_BYTES */
  maxStateBytes?: number;
  web?: WebAdapterOptions;
  app?: AppAdapterOptions;
}

export interface AdapterPluginManifest {
  /** 小写反向域名风格，与核心 PluginManifest.id 规则相同 */
  id: string;
  name: string;
  version: string;
  publisher?: string;
  description?: string;
  engines: { workbench: string; adapterApi: string };
  /** 包内相对路径（.js/.mjs），必须是**单文件 ES 模块**（宿主以 import('kbplugin://<id>/<main>') 加载，不解析裸模块名）；用核心 `npm run plugin:build` 打包 */
  main?: string;
  /** 'onAdapter:<adapterId>'（打开该适配器的项目时激活） */
  activationEvents?: string[];
  /** 第三方插件运行环境：v1 只有沙箱 iframe；v1 只能经开发者模式从本地文件夹安装（产品决定 D7：无商店、无签名） */
  sandbox: 'iframe';
  contributes: { adapters: AdapterContribution[] };
  /** 插件存储（storage.*）的声明（修订 5） */
  storage?: PluginStorageDecl;
}

/**
 * 插件存储声明（修订 5）。
 * nonMigratableKeys：不随“数据迁移包”导出的键（换电脑后必须重新获得的数据：令牌、设备绑定的 ID、本机路径缓存等）。
 * 每项是完整键名，或以 `*` 结尾的前缀（如 `device.*`）；最多 32 项，每项 1–128 个字符，`*` 只能出现在末尾。
 * 宿主导出迁移包时排除这些键（manifest 只记键名，不记值）；本机的存储不受影响。
 * 键名像密钥（pass/secret/token/api_key/credential/cookie/auth/session）的键无论是否声明都不导出。
 */
export interface PluginStorageDecl {
  nonMigratableKeys?: string[];
}

// ───────────────────────── 安全 UI 描述（无 HTML） ─────────────────────────

export type UiTone = 'normal' | 'muted' | 'info' | 'success' | 'warning' | 'danger';

export interface UiTreeNode {
  id: string;
  label: string;
  /** 次要文本（类型/值预览） */
  detail?: string;
  expanded?: boolean;
  children?: UiTreeNode[];
}

/**
 * 声明式 UI 树：宿主只用 textContent 渲染，不解释 HTML，不执行脚本，样式全部来自主题令牌。
 * v1 中这是第三方阅读器唯一的渲染方式（沙箱 iframe 不可见，没有自绘 DOM）。
 */
export type UiNode =
  | { type: 'text'; text: string; tone?: UiTone; mono?: boolean }
  | { type: 'heading'; text: string; level?: 1 | 2 | 3 }
  | { type: 'code'; text: string; language?: string }
  | { type: 'badge'; label: string; tone?: UiTone }
  | { type: 'button'; label: string; action: string; payload?: JsonValue; disabled?: boolean; variant?: 'primary' | 'secondary' | 'ghost' }
  | { type: 'stack'; direction?: 'row' | 'column'; children: UiNode[] }
  | { type: 'keyValue'; rows: Array<{ key: string; value: string }> }
  | { type: 'tree'; nodes: UiTreeNode[]; toggleAction: string }
  | { type: 'notice'; tone: 'info' | 'warning' | 'error'; title: string; message?: string; actions?: Array<{ label: string; action: string; payload?: JsonValue }> };

// ───────────────────────── 宿主 API ─────────────────────────

export interface ThemeSnapshot {
  id: string;
  colorScheme: 'light' | 'dark';
  /** 令牌名（不含 --kb- 前缀）→ 值，只读 */
  tokens: Readonly<Record<string, string>>;
}

/** 插件私有存储：按插件 id 隔离（核心 plugin_kv）。单值 ≤1 MB，总量 ≤10 MB。禁止存秘密。 */
export interface PluginStorage {
  get<T extends JsonValue = JsonValue>(key: string): Promise<T | null>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * 宿主调用失败的错误码（核心以 HostPermissionError / rpc-result.code 返回）。
 * timeout：单次调用约 15 s 无回应（需用户操作的 requestFileops / permissions.request 不设超时）。
 */
export type HostErrorCode =
  | 'permission-denied'
  | 'out-of-scope'
  | 'resource-missing'
  | 'plugin-unavailable'
  | 'invalid-request'
  | 'quota-exceeded'
  | 'timeout';

/**
 * 运行约束：插件不得长时间占用事件循环。宿主心跳约每 0.5 s 一次，约 3 s 无回应即判卡死并终止该插件进程
 * （其所有面板变为 adapter-error 占位）；activate/open/mount 约 10 s 未完成即超时。具体数值由宿主决定。
 */
export interface AdapterHostApi {
  readonly pluginId: string;
  readonly hostVersion: string;
  readonly adapterApiVersion: string;
  readonly phase: RolloutPhase;
  adapters: { register<S = JsonValue>(impl: AdapterImplementation<S>): Disposable };
  storage: PluginStorage;
  theme: { current(): ThemeSnapshot; onDidChange: HostEvent<ThemeSnapshot> };
  log: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
}

/** 本适配器声明的权限的查询/请求（只能请求已声明的 id） */
export interface PermissionsApi {
  query(permissionId: string): 'granted' | 'denied' | 'prompt';
  request(permissionId: string): Promise<'granted' | 'denied'>;
}

// ---- file ----

export interface FileStat {
  resourceId: string;
  name: string;
  ext: string;
  size: number;
  mtimeMs: number;
  exists: boolean;
  mimeType?: string;
}

export interface TextReadResult {
  text: string;
  truncated: boolean;
  size: number;
  encoding: string;
}

export interface FileopsPlanStep {
  op: 'write' | 'move' | 'trash';
  resourceId: string;
  /** write：新内容；move：同根内目标相对路径 */
  content?: string;
  toRelPath?: string;
  /** 乐观锁：写前内容哈希 */
  expectedHash?: string;
}
export interface FileopsPlan {
  title: string;
  steps: FileopsPlanStep[];
}
export type FileopsResult =
  | { ok: true; opIds: number[] }
  | { ok: false; reason: 'user-rejected' | 'permission-denied' | 'conflict' | 'out-of-scope'; detail?: string };

export interface FileHostApi {
  stat(resourceId: string): Promise<FileStat>;
  readText(resourceId: string, opts?: { maxBytes?: number }): Promise<TextReadResult>;
  readBytes(resourceId: string, range?: { offset: number; length: number }): Promise<Uint8Array>;
  /**
   * 只读内容 URL。**形式由宿主决定，插件不得自行拼接或解析**（核心 v0.2 返回 kbfile://plugin/<面板令牌>/<resourceId>，
   * 令牌绑定插件+适配器，每次请求按当前授权检查；沙箱 CSP img-src 只允许 kbfile://plugin 与 data:）。
   * v1 只有 UiNode，没有可放 <img> 的节点；保留给后续版本。
   */
  contentUrl(resourceId: string): string;
  onDidChange: HostEvent<{ resourceId: string; change: 'modified' | 'deleted' | 'moved' }>;
  /** 仅声明 fileops.write 时存在：提交批量计划，由用户在对话框中批准 */
  requestFileops?(plan: FileopsPlan): Promise<FileopsResult>;
}

// ---- web ----

export type NavigateResult =
  | { ok: true }
  | { ok: false; reason: 'domain-blocked' | 'scheme-blocked' | 'permission-denied' | 'invalid-url' };

export interface WebPanelHandle {
  /** 宿主派生的分区名（只读），如 'persist:kbweb.example.mdn-docs' */
  readonly partition: string;
  readonly allowedDomains: readonly string[];
  navigate(url: string): Promise<NavigateResult>;
  back(): void;
  forward(): void;
  reload(): void;
  /** 宿主缓存值（导航完成后更新）：刚调用 navigate 时可能仍是旧地址；需要确切地址时以 onDidNavigate 为准 */
  currentUrl(): string | null;
  /** 宿主读取/恢复滚动位置（宿主实现，插件不能注入脚本）。恢复是尽力而为：页面晚加载的内容可能在之后再移动位置 */
  getScroll(): Promise<{ x: number; y: number }>;
  setScroll(pos: { x: number; y: number }): Promise<void>;
  /** 宿主节流（≥250ms）上报的滚动位置 */
  onScroll: HostEvent<{ x: number; y: number }>;
  onDidNavigate: HostEvent<{ url: string; inPage: boolean }>;
  onBlocked: HostEvent<{ url: string; reason: 'domain-blocked' | 'scheme-blocked' | 'popup-blocked' | 'download-blocked' }>;
  onLoadState: HostEvent<'loading' | 'ready' | 'failed'>;
  clearSessionData(kinds?: Array<'cookies' | 'storage' | 'cache'>): Promise<void>;
}

// ---- app ----

export interface ProgramDetection {
  programId: string;
  installed: boolean;
  verified: boolean;
  version?: string;
  reason?: 'not-found' | 'hash-mismatch' | 'publisher-mismatch' | 'version-out-of-range' | 'unsupported-os';
}

export type LaunchFailure =
  | 'permission-denied'
  | 'unknown-program'
  | 'unknown-template'
  | 'invalid-slot'
  | 'resource-missing'
  | 'resource-out-of-scope'
  | 'not-installed'
  | 'verification-failed'
  | 'already-running'
  | 'rate-limited'
  | 'spawn-failed'
  /** 启动前备份失败（读不到文件、备份区写入失败）：不启动 */
  | 'backup-failed'
  /** 目标文件超过备份上限、用户未确认“不备份也启动”：不启动 */
  | 'backup-over-limit';

export type ProcessStatus = 'starting' | 'running' | 'exited' | 'crashed' | 'unknown';

export interface WindowTrackingInfo {
  tracking: 'none' | 'best-effort';
  state: 'not-tracked' | 'searching' | 'found' | 'lost';
  title?: string;
}

/** 适配器可见的进程信息：没有 exe 路径和 argv */
export interface ProcessHandleInfo {
  launchId: string;
  programId: string;
  templateId: string;
  status: ProcessStatus;
  pid?: number;
  startedAt: number;
  exitCode?: number | null;
  window: WindowTrackingInfo;
  /** 本次启动前的备份摘要（没有资源槽位时缺省） */
  backup?: LaunchBackupSummary;
}

/** 启动前备份摘要：只有数量，没有路径 */
export interface LaunchBackupSummary {
  files: number;
  bytes: number;
  /** 匹配到但因上限未备份的附加文件数 */
  skipped: number;
  /** 目标文件本身未备份（超过上限且用户确认继续） */
  targetUnprotected?: boolean;
}

export interface LaunchRequest {
  programId: string;
  templateId: string;
  slots?: Record<string, SlotValue>;
}

export type LaunchResult = { ok: true; handle: ProcessHandleInfo } | { ok: false; reason: LaunchFailure; detail?: string };

export interface ProcessStatusEvent {
  launchId: string;
  status: ProcessStatus;
  exitCode?: number | null;
  window: WindowTrackingInfo;
}

export interface ProcessBrokerApi {
  detect(programId: string): Promise<ProgramDetection>;
  launch(req: LaunchRequest): Promise<LaunchResult>;
  /** 把已跟踪窗口切到前台（窗口未找到时返回 false） */
  focus(launchId: string): Promise<boolean>;
  /** 先发 WM_CLOSE 优雅关闭；force:true 需用户确认后才 TerminateProcess */
  close(launchId: string, opts?: { force?: boolean }): Promise<boolean>;
  /** 仅本插件启动的进程 */
  list(): ProcessHandleInfo[];
  onStatus: HostEvent<ProcessStatusEvent>;
}

// ───────────────────────── 生命周期 ─────────────────────────

export interface OpenContext<S = JsonValue> {
  readonly adapter: Readonly<AdapterContribution>;
  /** restoreState 的结果；首次打开或状态无效时为 undefined */
  readonly restoredState: S | undefined;
  /** 状态变化后调用；宿主去抖后调用 instance.getState() 并保存 */
  requestSave(): void;
  readonly permissions: PermissionsApi;
  readonly theme: ThemeSnapshot;
  /** sourceKind = file 且 fs.read 已授权时存在 */
  readonly files?: FileHostApi;
  /** sourceKind = app 且 process.launch 已授权时存在 */
  readonly process?: ProcessBrokerApi;
  /** sourceKind = app 时存在 */
  readonly appProfile?: Readonly<AppProfile>;
}

interface MountTargetBase {
  readonly panelId: string;
  setTitle(title: string): void;
}

export interface UiMountTarget extends MountTargetBase {
  render(node: UiNode): void;
  onAction(handler: (action: string, payload: JsonValue | undefined) => void): Disposable;
}

export interface ReaderMountTarget extends UiMountTarget {
  kind: 'reader';
  /**
   * @deprecated v1 不提供（未来版本，形式待定）：核心的沙箱 iframe 不可见，只渲染 UiNode，宿主始终传 undefined。
   * 字段仅为与 SDK 8f880a8 的类型兼容而保留；插件不得依赖它。
   */
  readonly element?: unknown;
}

/** 宿主可能在工作台浮层（对话框/菜单）与网页区域相交时临时隐藏原生网页视图（显示截图），不通知插件；插件不得依赖网页一直可见 */
export interface WebMountTarget extends MountTargetBase {
  kind: 'web';
  readonly web: WebPanelHandle;
}

export interface ExternalMountTarget extends UiMountTarget {
  kind: 'external';
}

export type MountTarget = ReaderMountTarget | WebMountTarget | ExternalMountTarget;

export interface AdapterInstance<S = JsonValue> {
  mount(target: MountTarget): void | Promise<void>;
  /** 返回当前状态（可 JSON 序列化、小、无秘密）；宿主包成 {v: stateSchemaVersion, data} */
  getState(): S | undefined;
  onThemeChange?(theme: ThemeSnapshot): void;
  /** 可选权限被拒、运行时被撤销、或请求越界时调用；适配器应降级显示而不是抛错 */
  onPermissionDenied?(denial: PermissionDenial): void;
  onVisibilityChange?(visible: boolean): void;
  dispose(): void | Promise<void>;
}

export interface AdapterImplementation<S = JsonValue> {
  /** 必须等于 manifest.contributes.adapters[].id */
  id: string;
  open(item: Readonly<WorkspaceItem>, ctx: OpenContext<S>): AdapterInstance<S> | Promise<AdapterInstance<S>>;
  /**
   * 校验并迁移已保存的状态。fromVersion = 信封中的 v。
   * 返回 undefined → 宿主使用默认状态并提示“状态已重置”（不报错、不影响其他面板）。
   */
  restoreState?(data: unknown, fromVersion: number): S | undefined;
}

export interface AdapterPluginModule {
  manifest: AdapterPluginManifest;
  activate(api: AdapterHostApi): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}

// ───────────────────────── 占位与卸载 ─────────────────────────

export type PlaceholderKind =
  | 'adapter-missing'
  | 'adapter-disabled'
  | 'adapter-incompatible'
  | 'adapter-error'
  | 'phase-unavailable'
  | 'permission-denied'
  | 'resource-missing'
  | 'app-not-installed'
  | 'app-verification-failed'
  | 'domain-blocked'
  | 'network-offline';

export type PlaceholderActionId =
  | 'install-plugin'
  | 'enable-plugin'
  | 'review-permission'
  | 'open-with-default'
  | 'locate-program'
  | 'retry'
  | 'go-home'
  | 'open-in-system-browser'
  | 'remove-item';

export interface PlaceholderInfo {
  kind: PlaceholderKind;
  itemId: string;
  adapterId: string;
  title: string;
  message: string;
  actions: PlaceholderActionId[];
}

export interface UninstallOptions {
  /**
   * true：保留插件存储、授权与网页会话数据，重新安装后恢复（核心：plugins 行保留，source='adapter'，标记 uninstalled_at）；
   * false：删除 plugins 行、plugin_kv、网页分区（Cookie/存储/缓存）。
   */
  keepData: boolean;
  /** 同时从所有工作区移除由该插件适配器显示的条目（默认 false：条目保留为“缺少适配器”占位，产品决定 D3） */
  removeItems?: boolean;
}
