import type { AiWriteApplyDecision, AiWriteApplyResult, AiWriteApproveResult, AiWriteChangeView, AiWriteDiscardResult, AiWriteLegacyStage, AiWriteLinkStatus, AiWritePending, AiWritePlanDropInput, AiWritePlanDropResult, AiWriteSettings, LinkItem } from './aiWriteChannel';
import type { RebirthApi as importRebirthApi } from './rebirth';
import type { AttentionDraft, AttentionMark, MarkRetention } from './agentMarks';
import type {
  AgentPanelChanged,
  AgentPanelConfigPatch,
  AgentPanelConfigView,
  AgentPanelLocationSet,
  AgentPanelLocationView,
  AgentPanelRenderResult,
  AgentPanelResidentCopy,
  AgentPanelWriteResult,
  ContextBaseView,
  ConversationsView,
  ParsedConversation,
  SelectionSetInput,
  SelectionState,
} from './agentPanel';
import type { AgentMaterial, LivePanel, LiveReading, MaterialRef } from './agentLive/types';
import type { NativeDragLogEntry, NativeDragResult } from './nativeDragPolicy';
import type { WebBounds, WebEvent, WebViewInfo } from './webPanel';
import type { NavigateResult } from './adapter-sdk/types';
// 渲染进程与主进程共享的类型（也是未来 Agent API 的数据契约）
import type { WorkspaceItem } from './items';
import type { SaveOutcome, SavePreview, TextSnapshot, UndoOutcome, WriteRecord } from './textEdit';
import type { AuditEntry, PluginProcessInfo, AdapterPluginDto, PlanPreviewDto, PluginFileOp, PluginFileResult, UninstallInfo, UninstallOptionsDto } from './pluginIpc';
import type { PluginCatalogView } from './pluginCatalog';
import type { FileopsPlan, FileopsResult, PermissionGrant } from './adapter-sdk/types';
import type { RootOpReceipt, RootTask } from './rootTask';
import type { BlankFileCreated } from './blankFile';
export type { WorkspaceItem };
export type { RootOpKind, RootOpReceipt, RootTask, RootPublishSnapshot, RootDiskDeleteRequest, RootDiskDeleteResult } from './rootTask';

export type RootStatus = 'ok' | 'missing';
export type RootKind = 'folder' | 'file';

export interface Root {
  id: string;
  /** 当前工作区里的根实例。没有工作区上下文时与 id 相同。 */
  workspaceRootId: string;
  /** 资料源 id，与 id 相同。listDir、搜索、资源表仍用它。 */
  sourceId: string;
  name: string;
  /** 本机挂载路径（来自机器本地的 root_mounts 表）。其他元数据从不保存绝对路径。 */
  path: string;
  /** 根目录自身对应的资源 ID（可收藏）。alias 为 true 时改指已有资料，不是新根。 */
  resourceId: string;
  status: RootStatus;
  createdAt: number;
  /** folder = 目录来源；file = 单文件来源（其下只有 rel_path='' 的一条资料）。 */
  kind: RootKind;
  /**
   * 本次登记没有新建 roots 行。resourceId 是已有资料，id 是它所属的来源。
   * 缺省表示这是一条真实来源。
   */
  alias?: true;
}

export type EntryKind = 'file' | 'dir';

export interface DirEntry {
  /** 稳定资源 ID（UUID）。收藏、标签页等都引用它而不是路径。 */
  resourceId: string;
  rootId: string;
  /** 以 '/' 分隔的根相对路径；根本身为 '' */
  relPath: string;
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  ext: string;
  /** 被索引忽略的项（node_modules、.git 等）；只有开启“显示被忽略的项”时才会出现在目录树中 */
  ignored?: boolean;
}

/** 从根目录移除后留在隐藏列表里的一项。relPath 相对该根，不是绝对路径。 */
export interface HiddenRootItem {
  rootId: string;
  rootName: string;
  relPath: string;
  name: string;
}

export interface Favorite {
  id: number;
  resourceId: string;
  /** 以下为按 resourceId 解析出的“当前位置” */
  rootId: string;
  relPath: string;
  name: string;
  kind: EntryKind;
  missing: boolean;
  label: string | null;
  sortOrder: number;
  createdAt: number;
}

export type ReaderType = 'text' | 'markdown' | 'image' | 'pdf' | 'unsupported';

export interface ResourceInfo extends DirEntry {
  readerType: ReaderType;
  exists: boolean;
}

export interface TextContent {
  text: string;
  truncated: boolean;
  size: number;
}

export interface SearchHit {
  resourceId: string;
  rootId: string;
  relPath: string;
  name: string;
  kind: EntryKind;
  /** 正文/文件名命中（@kb/indexer searchGrouped） */
  matchKind?: 'name' | 'path' | 'content' | 'heading';
  snippet?: string;
  page?: number;
  score?: number;
  matches?: { start: number; end: number; anchor?: string }[];
}

/** 待批准计划（统一操作入口） */
export interface PendingPlanDto {
  planId: string;
  actor: string;
  title: string;
  status: string;
  contentHash: string;
  ops: Array<{
    opId: string;
    kind: string;
    resourceId?: string;
    rootId: string;
    relPath: string;
    toRelPath?: string;
    contentHash?: string;
    expectedHash?: string | null;
  }>;
}

export type IndexState = 'idle' | 'scanning' | 'error';

export interface IndexStatus {
  rootId: string;
  state: IndexState;
  /** 已索引文件数（resources.kind='file' 且未缺失），按 rootId；非浅层 readdir 项数，虚拟目录成员不另开账 */
  fileCount: number;
  /** 扫描进度（已处理条目数），仅 scanning 时有意义 */
  progress: number;
  lastScanAt: number | null;
  lastError: string | null;
  watching: boolean;
}

/** r11-E §2.10：索引健康（降级可见） */
export type IndexEngine = 'kb-indexer' | 'local-fallback' | 'starting';
export interface IndexHealth {
  engine: IndexEngine;
  contentSearch: boolean;
  reason?: string;
  since: number;
  scannedFiles: number;
  contentIndexedFiles: number;
  /** 全文空间满且压实后仍失败。不因此把 contentSearch 改成 false。 */
  contentIndexNotice?: string;
  /** locked/busy 重试用完的路径。 */
  contentIndexFailed?: Array<{ rootId: string; relPath: string; kind: 'locked' | 'busy' }>;
}

/** r11-E §2.9：双库只读诊断 */
export interface DualDbCheckResult {
  ok: boolean;
  mismatched: Array<{ resourceId: string; mainPath: string; modulesPath: string | null }>;
  checked: number;
  rootId?: string;
}

export interface OpLogEntry {
  id: number;
  ts: number;
  actor: string; // 'user' | 'agent:<name>' | 'system'
  op: string; // 'trash' | 'move' | 'write' | 'undo'
  resourceId: string | null;
  rootId: string;
  relPath: string;
  detail: Record<string, unknown>;
  undoneAt: number | null;
}

/** 操作记录界面的一行：撤销是否可用（主进程按备份是否还在、是否已撤销计算） */
export type OpUndoState = 'available' | 'undone' | 'expired' | 'missing' | 'unsupported';
export interface OpLogView extends OpLogEntry {
  undo: { state: OpUndoState; reason?: string };
  /** 撤销记录：撤销冲突时备份下来的当前内容能否恢复（只有带 conflictBackup 的撤销记录才有） */
  restore?: { state: 'available' | 'restored' | 'missing'; reason?: string };
}
export type OpUndoResult = { status: 'undone'; op: OpLogEntry } | { status: 'conflict'; detail: string[] } | { status: 'unrecoverable'; detail: string[] };

export interface OpPreview {
  op: 'trash' | 'write' | 'move' | 'undo';
  resourceId: string;
  rootId: string;
  relPath: string;
  kind: EntryKind;
  fileCount: number;
  totalBytes: number;
  /** 人类可读的说明，例如“将移入应用暂存区，可在 30 天内恢复” */
  summary: string;
  conflicts: string[];
}

export interface FsChangeEvent {
  rootId: string;
  relPath: string;
  type: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  /** 受影响的资料。目录刷新和阅读器都按它判断，不再把整根当成一次变化。 */
  resourceId?: string;
}

export interface PluginStateDto {
  id: string;
  version: string;
  source: 'builtin' | 'user' | 'adapter';
  enabled: boolean;
  /** 结构化授权记录（SDK PermissionGrant[]；内置插件为空） */
  granted: unknown[];
  installedAt: number;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  /** 项目分组名；'' 表示未分组 */
  project: string;
  layoutSchema: number;
  /** 布局引用到的根（跨根工作区会有多个） */
  rootIds: string[];
  panelCount: number;
  /** “本工作的资料”中引用的文件数（不含仅作为标签打开的） */
  refCount?: number;
  /** 工作区总览星标收藏；缺省/旧库为 false */
  favorite?: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
}
export interface WorkspaceDto extends WorkspaceSummary {
  /** schema 4：{ schema, dock, shell }，面板参数只有 itemId */
  layout: unknown;
  /** 项目表 workspace_items 中本工作区的条目 */
  items: WorkspaceItem[];
}

/** .kblayout.json 导出文件 */
export interface KbLayoutFile {
  format: 'kb-workbench.layout';
  formatVersion: 1;
  exportedAt: string;
  workspace: { name: string; project: string };
  layoutSchema: number;
  layout: unknown;
  /** layoutSchema ≥ 4 时：条目（项目表行）。schema 3 的旧文件条目内联在 layout.items 中 */
  items?: WorkspaceItem[];
  /** 布局引用的资源，用于在另一台电脑上按“根名 + 相对路径”重新匹配 */
  resources: { resourceId: string; rootId: string; rootName: string; relPath: string; kind: EntryKind }[];
  /**
   * 条目使用的第三方适配器插件（只是“需要哪些插件”的清单）。
   * **不含**插件存储与授权：存储是插件全局的、不属于某个工作区；授权绑定本机的根 ID，且必须由用户在本机重新批准
   * （导入文件不能替用户授予权限）。见 docs/06 §8.1。
   */
  plugins?: { id: string; name: string; version: string; adapterIds: string[] }[];
  /** “本工作的资料”引用的资源 ID（第 9 轮；同样按 resources 重新匹配） */
  refs?: string[];
  /** r11-A：布局 / 资料引用到的网络资料（按 url 重新匹配；不含 Cookie、授权、query） */
  webResources?: { resourceId: string; url: string; title: string; contentType: string | null; adapterId: string; ext: string; favorite: boolean }[];
  /** 固定资料。本轮资料不进这个文件。 */
  agentMaterialsPinned?: unknown;
}
/** 工作资料（集合）中的一条引用：只是对原文件的引用，添加/移除不移动、不复制原文件 */
export interface WorkspaceRef {
  resourceId: string;
  rootId: string;
  rootName: string;
  relPath: string;
  name: string;
  ext: string;
  kind: EntryKind;
  /** 原文件已不在原处（被删除/移出根），或根已移除 */
  missing: boolean;
  addedAt: number;
  /** r11（总包 §2.1）：来源；缺省按 'file'。web 条目 rootId/relPath/ext 为 ''、kind 为 'file' */
  sourceKind?: 'file' | 'web';
  /** 仅 web：sanitize 后的网址 */
  url?: string;
}

/** 全局自建目录（第 11 轮 C）。只是归类，不代表磁盘上的文件夹。 */
export interface VirtualFolder {
  folderId: string;
  parentId: string | null;
  name: string;
  sort: number;
  createdAt: number;
}
export interface VfolderCrumb {
  folderId: string | null;
  name: string;
}
export interface VfolderEntry {
  resourceId: string;
  name: string;
  ext: string;
  kind: EntryKind;
  relPath: string;
  rootId: string;
  rootName: string;
  /** 成员真实磁盘路径；虚拟目录自身无此字段。缺失/网页/无法解析时为 null */
  absPath: string | null;
  missing: boolean;
  /** ok = 有阅读器；unsupported = 仍列出，打开时提示「暂无阅读器」 */
  reader: 'ok' | 'unsupported';
  sourceKind: 'file' | 'web';
  url?: string;
}
export interface VfolderView {
  folderId: string | null;
  crumbs: VfolderCrumb[];
  folders: Pick<VirtualFolder, 'folderId' | 'parentId' | 'name' | 'sort'>[];
  entries: VfolderEntry[];
}
export interface ImportResult {
  workspace: WorkspaceSummary;
  matched: number;
  remapped: number;
  unresolved: string[]; // 无法匹配的相对路径（以“根名/相对路径”表示）
  /** 文件中列出、本机未安装（或已卸载）的第三方插件；相关条目显示“缺少适配器”占位，安装后自动恢复 */
  missingPlugins: { id: string; name: string; version: string }[];
}

/** 主题包（文件夹）：theme.json + 引用的 css / 布局预设 json。只含数据，不含可执行代码。 */
export interface ThemePackDto {
  source: 'builtin' | 'installed' | 'dev';
  /** 仅用于显示（dev 包的来源目录）；不会写进布局 */
  location: string;
  manifest: unknown;
  files: Record<string, string>;
  error?: string;
}

/** 打开文件框时可以只传入口键，也可以带上标题和过滤器。键决定上次目录。 */
export interface PickDialogRequest {
  dialogKey?: string;
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}

/** 渲染进程可调用的 API（preload 通过 contextBridge 暴露为 window.kb） */
export interface KbApi extends importRebirthApi {
  sidebarWindow(request: import('./sidebarWindow').SidebarWindowRequest): Promise<void>;
  /** 选择文件夹。dialogKey 缺省时记在「注册为根」。对象形式可另给标题。 */
  pickFolder(spec?: string | PickDialogRequest): Promise<string | null>;
  /** 选择单个文件。路径只走本机 IPC，不交给文件桥。dialogKey 缺省时记在「注册为来源」。 */
  pickFile(spec?: string | PickDialogRequest): Promise<string | null>;
  /** 选择对话存档目录。上次位置记在 dialogLastDir.archiveLocation。取消时 null。不写入配置。 */
  agentPanelPickArchiveLocation(): Promise<string | null>;
  /** 读取用户刚选中的本地文本。只接受普通文件，超过 1MB 拒绝。 */
  readUtf8File(absPath: string): Promise<string>;
  listRoots(): Promise<Root[]>;
  addRoot(path: string, name?: string, extensions?: string[]): Promise<Root>;
  /** 登记单个文件来源。路径由界面在本机选定，不传给文件桥。extensions 不参与单文件排除。 */
  addFileSource(path: string, name?: string, extensions?: string[]): Promise<Root>;
  /** 在文件夹里新建空白 md/txt。根内只刷新索引；根外按单文件来源登记。不覆盖已有文件。 */
  createBlankFile(input: { dir: string; name: string; ext: 'md' | 'txt' }): Promise<BlankFileCreated>;
  removeRoot(rootId: string): Promise<void>;
  /** 从当前工作区解除登记。确认后立即隐藏，不等待扫盘或清索引。 */
  detachRoot(rootId: string): Promise<RootOpReceipt>;
  /** 把磁盘上的根移到系统回收站（shell.trashItem）。失败则报错，不永久删除。 */
  deleteRootFolder(rootId: string): Promise<RootOpReceipt>;
  /** 把根内的一个文件或子文件夹移到系统回收站。失败则报错，不永久删除。 */
  trashInsideRoot(rootId: string, relPath: string): Promise<{ absPath: string }>;
  /** 从工作台移除。只写入该根的隐藏列表，不删除磁盘文件。 */
  hideFromRoot(rootId: string, relPath: string): Promise<{ rootId: string; relPath: string }>;
  /** 恢复一项隐藏。重新显示并重新扫描索引。 */
  restoreHidden(rootId: string, relPath: string): Promise<{ rootId: string; relPath: string }>;
  /** 清空这一根的隐藏列表，重新显示并重新扫描索引。不删除磁盘文件。 */
  restoreAllHidden(rootId: string): Promise<{ rootId: string; restored: string[] }>;
  listHiddenItems(): Promise<HiddenRootItem[]>;
  listRootTasks(): Promise<RootTask[]>;
  cancelRootTask(taskId: string): Promise<void>;
  retryRootTask(taskId: string): Promise<RootOpReceipt>;
  /** 提交失败或执行失败后的恢复入口。不清磁盘上仍然存在的原文件。 */
  restoreRoot(rootId: string): Promise<Root>;
  onRootTasks(cb: (tasks: RootTask[]) => void): () => void;
  remapRoot(rootId: string, newPath: string): Promise<Root>;
  listFavorites(): Promise<Favorite[]>;
  addFavorite(resourceId: string): Promise<Favorite>;
  removeFavorite(id: number): Promise<void>;
  listDir(rootId: string, relPath: string): Promise<DirEntry[]>;
  /** 按绝对路径列一层。无 sourceId 的松散目录用；命中根则走 listDir，否则浅层 readdir */
  listDirAbs(absPath: string): Promise<DirEntry[]>;
  /** 目录树是否显示被忽略的项（node_modules、.git 等；默认不显示，与索引一致） */
  getShowIgnored(): Promise<boolean>;
  setShowIgnored(on: boolean): Promise<void>;
  getResource(resourceId: string): Promise<ResourceInfo | null>;
  /** 资源绝对路径（含已缓存网络直链）；未缓存或不存在时抛错 */
  resourceAbsPath(resourceId: string): Promise<string>;
  /** 根是否属于当前工作区。switchTo 是另一个包含它的工作区，没有则为 null。 */
  rootWorkspace(rootId: string): Promise<{ name: string; inCurrent: boolean; switchTo: string | null; status: 'ok' | 'missing' | 'absent' }>;
  readText(resourceId: string): Promise<TextContent>;
  rescan(rootId: string): Promise<void>;
  cancelScan(rootId: string): Promise<void>;
  search(query: string): Promise<SearchHit[]>;
  searchGrouped(query: string, o?: { limit?: number; rootIds?: string[]; scope?: 'name' | 'content' | 'all' }): Promise<unknown>;
  opsPropose(title: string, ops: unknown[]): Promise<unknown>;
  opsPending(): Promise<PendingPlanDto[]>;
  opsGet(planId: string): Promise<PendingPlanDto | null>;
  opsReview(planId: string): Promise<unknown>;
  opsApprove(planId: string, opIds: string[], contentHash: string): Promise<PendingPlanDto>;
  /** 拒绝待批准计划。不执行。文件里的 approved 不能代替这次点击。 */
  opsReject(planId: string, reason?: string): Promise<PendingPlanDto>;
  agentInfo(): Promise<{ url: string; tokenFile: string; host: string; port: number } | null>;
  getLayout(key: string): Promise<unknown | null>;
  setLayout(key: string, value: unknown): Promise<void>;
  getIndexStatus(): Promise<IndexStatus[]>;
  // ---- r11-E 索引健康 / 双库
  getIndexHealth(): Promise<IndexHealth>;
  debugDualDbCheck(rootId?: string): Promise<DualDbCheckResult>;
  indexRebuild(rootId?: string): Promise<{ ok: boolean; detail?: string }>;
  listOps(limit?: number): Promise<OpLogEntry[]>;
  /** 操作记录界面：带撤销状态（备份过期 / 缺失 / 已撤销） */
  opsView(limit?: number): Promise<OpLogView[]>;
  /** 在操作记录里撤销一条；force = 有冲突时仍撤销（当前内容先备份） */
  opUndo(opId: number, force?: boolean): Promise<OpUndoResult>;
  /** 恢复撤销冲突时备份下来的内容（撤销记录上的“恢复撤销前的内容”） */
  opRestoreBackup(opId: number, force?: boolean): Promise<OpUndoResult>;
  showInFolder(resourceId: string): Promise<void>;
  /** 用系统默认程序打开。路径必须落在已登记根内。 */
  openWithDefaultApp(resourceId: string): Promise<void>;
  registerPlugin(id: string, version: string, source: 'builtin' | 'user'): Promise<PluginStateDto>;
  listPlugins(): Promise<PluginStateDto[]>;
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;
  // ---- 第三方（沙箱）适配器插件（docs/06）
  getDevMode(): Promise<boolean>;
  setDevMode(on: boolean): Promise<void>;
  listAdapterPlugins(): Promise<AdapterPluginDto[]>;
  /** 开发者模式：选择本地插件文件夹安装；取消时 null */
  installAdapterPluginFromFolder(): Promise<AdapterPluginDto | null>;
  /** 插件清单（本地 fixture / 远程 URL）；点一下安装用 */
  listPluginCatalog(): Promise<PluginCatalogView>;
  installPluginFromCatalog(entryId: string): Promise<AdapterPluginDto>;
  setPluginCatalogUrl(url: string | null): Promise<string | null>;
  setAdapterPluginEnabled(id: string, enabled: boolean): Promise<void>;
  setPermissionGrant(g: { pluginId: string; adapterId: string; permissionId: string; decision: 'granted' | 'denied'; rootIds?: string[] | 'all' }): Promise<PermissionGrant>;
  revokePermission(pluginId: string, adapterId: string, permissionId: string): Promise<PermissionGrant>;
  pluginFile(pluginId: string, adapterId: string, req: PluginFileOp): Promise<PluginFileResult>;
  mintPluginFileToken(pluginId: string, adapterId: string): Promise<string>;
  releasePluginFileToken(token: string): Promise<void>;
  adapterStorage(pluginId: string, op: 'get' | 'set' | 'delete' | 'keys', key?: string, value?: unknown): Promise<unknown>;
  adapterUninstallInfo(id: string): Promise<UninstallInfo>;
  uninstallAdapterPlugin(id: string, opts: UninstallOptionsDto): Promise<{ removedItems: number; adapterIds: string[] }>;
  planPreview(pluginId: string, adapterId: string, plan: FileopsPlan): Promise<PlanPreviewDto>;
  planExecute(planId: string): Promise<FileopsResult>;
  planDiscard(planId: string): Promise<FileopsResult>;
  listPluginAudit(pluginId: string | null, limit?: number): Promise<AuditEntry[]>;
  recordPluginEvent(pluginId: string, adapterId: string | null, kind: 'watchdog' | 'timeout', detail: string): Promise<void>;
  killPluginFrames(pluginId: string): Promise<{ killed: number[]; isolated: boolean; alsoAffected: string[] }>;
  pluginProcesses(): Promise<PluginProcessInfo[]>;
  // 网页面板（H9）
  webCreate(viewId: string, pluginId: string, adapterId: string): Promise<WebViewInfo>;
  webDestroy(viewId: string): Promise<void>;
  webNavigate(viewId: string, url: string): Promise<NavigateResult>;
  webBack(viewId: string): Promise<void>;
  webForward(viewId: string): Promise<void>;
  webReload(viewId: string): Promise<void>;
  webGetScroll(viewId: string): Promise<{ x: number; y: number }>;
  webSetScroll(viewId: string, pos: { x: number; y: number }): Promise<{ x: number; y: number }>;
  /** 网页面板会话内比例（0.5–3）。与主窗口整页缩放无关。 */
  webGetZoom(viewId: string): Promise<{ scale: number }>;
  webSetZoom(viewId: string, scale: number): Promise<{ scale: number }>;
  webSnapshot(viewId: string): Promise<string | null>;
  webClearSessionData(viewId: string, kinds?: Array<'cookies' | 'storage' | 'cache'>): Promise<void>;
  clearPluginSiteData(pluginId: string): Promise<void>;
  webOpenExternal(url: string, from: { viewId?: string; pluginId?: string; adapterId?: string }): Promise<{ ok: boolean; reason?: string }>;
  /** r12：人机界面批准外部资源的网站授权。桥不能调用。 */
  webSiteApply(req: import('./webSiteGrant').WebSiteApplyRequest): Promise<import('./webSiteGrant').WebSiteApplyResult>;
  webSiteList(): Promise<{ version: 1; file: string; globalNeverBlock: boolean; allowOpenExternal?: boolean; trustInsecureLinks?: boolean; sites: import('./webSiteGrant').WebSiteGrantRow[] }>;
  /** 主窗口内容区的外链标签。分区与工作台、网页面板都不共用。 */
  extBrowseCreate(viewId: string, url: string): Promise<{ ok: boolean; url?: string; reason?: string }>;
  extBrowseDestroy(viewId: string): Promise<void>;
  extBrowseNavigate(viewId: string, url: string): Promise<{ ok: boolean; url?: string; reason?: string }>;
  extBrowseBack(viewId: string): Promise<void>;
  extBrowseReload(viewId: string): Promise<void>;
  extBrowseOpenSystem(viewId: string): Promise<{ ok: boolean; reason?: string }>;
  extBrowseSnapshot(viewId: string): Promise<string | null>;
  onExtBrowse(cb: (ev: import('./externalBrowse').ExtBrowseEvent) => void): () => void;
  /** 逐帧位置（fire-and-forget）；null = 隐藏 */
  sendWebBounds(viewId: string, bounds: WebBounds | null): void;
  // ---- r11-A 网络资料（总包 §2.1 / §2.11；webResourceAdd/Update/Get 之外的方法见 REPORT「接口变更申请」）
  webResourceAdd(input: { url: string; title?: string; contentType?: string | null; adapterId?: string; ext?: string; opened?: boolean }): Promise<import('./webResources').WebResource>;
  webResourceUpdate(resourceId: string, patch: { title?: string; contentType?: string | null; adapterId?: string; ext?: string; opened?: boolean; favorite?: boolean }): Promise<import('./webResources').WebResource>;
  webResourceGet(resourceId: string): Promise<import('./webResources').WebResource | null>;
  webResourceGetByUrl(url: string): Promise<import('./webResources').WebResource | null>;
  webResourceList(opts?: { favoritesOnly?: boolean; limit?: number }): Promise<import('./webResources').WebResource[]>;
  webResourceRemove(resourceId: string): Promise<boolean>;
  /** 直链受控下载到缓存（主进程下载 + 主机检查）；force = 重新下载 */
  webFetchCache(resourceId: string, opts?: { force?: boolean }): Promise<import('./webResources').FetchCacheResult>;
  /** 逐站授权（SDK 修订 10）：允许 / 撤销单个主机；返回更新后的授权记录 */
  webGrantSite(pluginId: string, adapterId: string, host: string): Promise<import('./adapter-sdk/types').PermissionGrant>;
  webRevokeSite(pluginId: string, adapterId: string, host: string): Promise<import('./adapter-sdk/types').PermissionGrant | null>;
  webGrantedSites(pluginId: string, adapterId: string): Promise<string[]>;
  webPageInfo(viewId: string): Promise<{ url: string; title: string; pluginId: string; adapterId: string }>;
  /** 保存到本地：直链复制缓存 / 网页存 MHTML 到已注册根内的新文件（不覆盖），返回新文件的 resourceId */
  webSaveToLocal(input: { resourceId?: string; viewId?: string; rootId: string; relPath: string }): Promise<{ resourceId: string; rootId: string; relPath: string; opId: number }>;
  onWebResourcesChange(cb: (e: import('./webResources').WebResourcesChange) => void): () => void;
  // ---- r11-A 网络资料 end
  /** 冷启动计时：渲染进程阶段标记（docs/07 §4） */
  startupMark(name: string, wall?: number): void;
  /** 渲染进程长任务（毫秒）。主进程只记录，不在这里做界面操作。 */
  noteLongTask?(ms: number): void;
  /** 应用菜单发来的工作台命令 id（见 src/main/appMenu.ts） */
  onMenuCommand(cb: (commandId: string) => void): () => void;
  // ---- r12 自动升级。安装和回滚只在人机界面调用这条 IPC。
  updateState(): Promise<import('./update/types').UpdateSnapshot | null>;
  aboutInfo(): Promise<{ version: string; electron: string; dataDir: string; installDir: string | null }>;
  updateCheck(): Promise<import('./update/types').UpdateSnapshot>;
  updateSaveSettings(patch: Partial<import('./update/types').UpdateSettings>): Promise<import('./update/types').UpdateSnapshot>;
  updateApply(req: import('./update/types').UpdateApplyRequest): Promise<import('./update/types').UpdateSnapshot>;
  onUpdate(cb: (snapshot: import('./update/types').UpdateSnapshot) => void): () => void;
  // ---- r11-B 自定义快捷键
  setBoundShortcuts(keys: string[]): Promise<void>;
  onForwardedShortcut(cb: (accelerator: string) => void): () => void;
  onKeybindingsChange(cb: () => void): () => void;
  getStartupTrace(): Promise<{ name: string; ms: number; side: 'main' | 'renderer' }[]>;
  onWebEvent(cb: (e: WebEvent) => void): () => void;
  pluginStorageGet(pluginId: string, key: string): Promise<unknown>;
  pluginStorageSet(pluginId: string, key: string, value: unknown): Promise<void>;
  // ---- 外部程序项目（第 9 轮接线）
  appProfileCreate(input: import('./appIpc').AppProfileInput): Promise<import('./appIpc').AppProfile>;
  appProfileGet(id: string): Promise<import('./appIpc').AppProfile | null>;
  appDetect(pluginId: string, adapterId: string, programId: string): Promise<import('./appIpc').ProgramDetection>;
  appLaunch(pluginId: string, adapterId: string, itemId: string, appProfileId: string, req: import('./appIpc').LaunchRequest): Promise<import('./appIpc').LaunchResult>;
  /** itemId 给出时只返回该条目的启动 */
  appList(pluginId: string, itemId?: string): Promise<import('./appIpc').ProcessHandleInfo[]>;
  appFocus(launchId: string): Promise<boolean>;
  appClose(launchId: string, opts?: { force?: boolean }): Promise<boolean>;
  appPendingChanges(itemId?: string): Promise<import('./appIpc').AppChangesEvent[]>;
  appUndoExternal(launchId: string, force?: boolean): Promise<import('./appIpc').AppUndoOutcome>;
  /** 打开“数据迁移”窗口的某一页（失效资料引用的“修复…”用 'repair'） */
  openMigration(tab: 'export' | 'import' | 'repair' | 'backups'): Promise<void>;
  /** 打开全局 Agent 库小窗口。打开时冻结当前工作区为这次的落点。 */
  openAgentPicker(): Promise<void>;
  onAppEvent(cb: (e: import('./appIpc').AppEvent) => void): () => void;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  getWorkspace(id: string): Promise<WorkspaceDto>;
  createWorkspace(name: string, project: string, layout: unknown, items?: WorkspaceItem[]): Promise<WorkspaceSummary>;
  saveWorkspaceLayout(id: string, layout: unknown, items?: WorkspaceItem[]): Promise<void>;
  updateWorkspace(id: string, patch: { name?: string; project?: string; favorite?: boolean }): Promise<WorkspaceSummary>;
  deleteWorkspace(id: string): Promise<void>;
  /** 工作资料（集合）：引用原文件，添加/移除不移动、不复制 */
  listWorkspaceRefs(id: string): Promise<WorkspaceRef[]>;
  /** 原位编辑（第 9 轮 C）：全部经主进程服务层，渲染进程不直接写盘 */
  textOpen(resourceId: string): Promise<TextSnapshot>;
  textStat(resourceId: string): Promise<{ hash: string; mtimeMs: number; size: number }>;
  textPreviewSave(resourceId: string, text: string, baseHash: string): Promise<SavePreview>;
  textSave(resourceId: string, text: string, baseHash: string): Promise<SaveOutcome>;
  textHistory(resourceId: string): Promise<WriteRecord[]>;
  textUndoLastSave(resourceId: string, force?: boolean): Promise<UndoOutcome>;
  addWorkspaceRefs(id: string, resourceIds: string[]): Promise<WorkspaceRef[]>;
  removeWorkspaceRef(id: string, resourceId: string): Promise<WorkspaceRef[]>;
  workspacesReferencing(resourceId: string): Promise<{ id: string; name: string }[]>;
  getCurrentWorkspaceId(): Promise<string>;
  setCurrentWorkspace(id: string): Promise<void>;
  agentLiveList(workspaceId: string): Promise<AgentMaterial[]>;
  agentLiveAdd(workspaceId: string, ref: MaterialRef, opts?: { purpose?: string; index?: number }): Promise<'added' | 'duplicate'>;
  agentLiveAddMany(workspaceId: string, refs: MaterialRef[]): Promise<Array<'added' | 'duplicate'>>;
  agentLiveRemove(workspaceId: string, materialId: string): Promise<void>;
  agentLiveReorder(workspaceId: string, order: string[]): Promise<void>;
  agentLiveSetPurpose(workspaceId: string, materialId: string, purpose: string | null): Promise<void>;
  agentLivePin(workspaceId: string, materialId: string): Promise<void>;
  agentLiveUnpin(workspaceId: string, materialId: string): Promise<void>;
  agentLiveClearSession(workspaceId: string): Promise<string[]>;
  agentLiveRelocate(workspaceId: string, materialId: string, ref: MaterialRef): Promise<void>;
  agentLiveEntryPath(which: 'current' | 'workspace', workspaceId?: string): Promise<string>;
  agentLiveNoteScene(scene: { workspaceId: string; panels?: LivePanel[]; reading?: LiveReading | null }): Promise<void>;
  agentLiveStartDrag(files: string[]): Promise<boolean>;
  /** 上下文剧本。缺文件等于关。新方法只追加。 */
  agentLivePlaybookGet(workspaceId: string): Promise<import('./ctxPlaybook').CtxPlaybookState>;
  agentLivePlaybookSet(workspaceId: string, patch: import('./ctxPlaybook').CtxPlaybookPatch): Promise<import('./ctxPlaybook').CtxPlaybookState>;
  agentLivePlaybookGuess(workspaceId: string): Promise<{ assigned: number; unassigned: number }>;
  agentLiveMaterialPlace(
    workspaceId: string,
    materialId: string,
    patch: { slotId?: string | null; mount?: import('./ctxPlaybook').PlaybookMount | null; delivery?: import('./ctxPlaybook').PlaybookDelivery | null; summary?: string | null },
  ): Promise<void>;
  /** 标红给 Agent。存在 userData/agent-marks.json，不写源文件。 */
  agentMarksList(): Promise<AttentionMark[]>;
  agentMarksAdd(draft: AttentionDraft): Promise<AttentionMark>;
  agentMarksUnmark(input: { absPath: string; start: number; end: number }): Promise<AttentionMark[]>;
  agentMarksClear(): Promise<void>;
  agentMarksRetention(): Promise<MarkRetention>;
  agentMarksSetRetention(mode: MarkRetention): Promise<MarkRetention>;
  agentMarksEligible(absPath: string): Promise<{ ok: boolean; reason?: string }>;
  /** AI 写入通道。配置在应用目录 agent-data/ai-write，不写 %LOCALAPPDATA%\\LocalKnowledgeWorkbench。 */
  aiWriteSettingsGet(): Promise<AiWriteSettings>;
  aiWriteSettingsSet(input: AiWriteSettings): Promise<AiWriteSettings>;
  aiWriteSyncRoots(input: { roots: { path: string; name?: string }[] }): Promise<void>;
  aiWritePending(): Promise<AiWritePending>;
  aiWriteApprove(input: { planId: string; force?: boolean }): Promise<AiWriteApproveResult>;
  aiWriteReject(input: { planId: string }): Promise<void>;
  aiWriteConflictResolve(input: { id: string; action: 'keep' | 'restore' }): Promise<void>;
  aiWriteLinksGet(): Promise<LinkItem[]>;
  aiWriteLinksAdd(input: { items: { path: string; name?: string; kind?: 'dir' | 'file' }[] }): Promise<LinkItem[]>;
  aiWriteLinksRemove(input: { id: string }): Promise<LinkItem[]>;
  aiWriteLinksClear(): Promise<LinkItem[]>;
  aiWriteLinkStatus(): Promise<AiWriteLinkStatus>;
  aiWriteCollect(input?: { sessionId?: string }): Promise<AiWriteChangeView[]>;
  aiWriteApply(input: { sessionId: string; fileId: string; decision: AiWriteApplyDecision; landingDir?: string }): Promise<AiWriteApplyResult>;
  aiWriteSessionDiscard(input?: { sessionId?: string; confirm?: boolean }): Promise<AiWriteDiscardResult>;
  aiWriteLegacyStages(): Promise<AiWriteLegacyStage[]>;
  aiWriteLegacyStageTrash(input: { paths: string[] }): Promise<{ trashed: string[] }>;
  aiWritePlanDrop(input: AiWritePlanDropInput): Promise<AiWritePlanDropResult>;
  /** Agent 配置与对话面板。数据在应用目录 agent-data，不在 userData。 */
  agentPanelGetConfig(): Promise<AgentPanelConfigView>;
  agentPanelSaveConfig(patch: AgentPanelConfigPatch): Promise<AgentPanelConfigView>;
  agentPanelRender(input: { agentId: string }): Promise<AgentPanelRenderResult>;
  agentPanelWriteProject(input: { agentId: string; rootPath: string; confirm?: boolean }): Promise<AgentPanelWriteResult>;
  agentPanelSourceList(): Promise<{ name: string }[]>;
  agentPanelSourceRead(input: { name: string }): Promise<{ name: string; content: string }>;
  agentPanelSourceSave(input: { name: string; content: string }): Promise<{ name: string }>;
  agentPanelSourceActivate(input: { name: string }): Promise<{ name: string }>;
  agentPanelConversations(): Promise<ConversationsView>;
  agentPanelParse(input: { path: string }): Promise<ParsedConversation>;
  agentPanelSelectionGet(): Promise<SelectionState>;
  agentPanelSelectionSet(input: SelectionSetInput): Promise<SelectionState>;
  agentPanelBaseGet(): Promise<ContextBaseView | null>;
  agentPanelBaseSet(input: { path: string } | null): Promise<ContextBaseView | null>;
  agentPanelLocationGet(): Promise<AgentPanelLocationView>;
  agentPanelLocationSet(input: AgentPanelLocationSet): Promise<AgentPanelLocationView>;
  /**
   * 按 config.activeAgent 生成常驻规则全文。
   * 未选 agent 时返回 null，调用方仍复制原来的入口路径。
   */
  agentPanelCopyResidentRules(input?: { entryPath?: string } | null): Promise<AgentPanelResidentCopy | null>;
  /** 按 activeAgent 生成对话链接。未选 agent 时用通用 Markdown，不返回 null。 */
  agentPanelCopyConversationLink(input: { path: string }): Promise<AgentPanelResidentCopy>;
  /** 给空上下文的新窗口。未选 agent 时用通用 Markdown，不返回 null。 */
  agentPanelCopyNewLink(): Promise<AgentPanelResidentCopy>;
  /** 改 frontmatter 标题并 rename 对话文件。勾选和标红里的旧路径会跟着走。 */
  agentPanelRenameConversation(input: { path: string; title: string }): Promise<{ path: string; title: string }>;
  /** 把对话文件移到系统回收站。调用前要先经确认对话框。 */
  agentPanelDeleteConversation(input: { path: string }): Promise<void>;
  onAgentPanelChanged(cb: (event: AgentPanelChanged) => void): () => void;
  /**
   * 同步通道，留给测试和仍直接调用的兼容路径。
   * 界面拖出不要用它：startDrag 在 Windows 上会阻塞到放下，sendSync 会把渲染进程一起卡住。
   * mode 为 path 时只记日志，不调用 startDrag。校验失败时不抛错。
   */
  startNativeDrag(paths: readonly string[], mode?: 'file' | 'path'): NativeDragResult;
  /** 文件模式拖出。异步 send，主进程在该 IPC 里立刻 startDrag。 */
  postNativeFileDrag(paths: readonly string[]): void;
  /** startDrag 返回后主进程通知渲染进程清掉原生拖动会话。 */
  onNativeDragEnded(cb: () => void): () => void;
  /** 主进程 startDrag / 拒绝记录。只读，给开发工具和测试看。 */
  nativeDragLog(): NativeDragLogEntry[];
  /** 预热允许列表。文件模式拖出不再等待它。 */
  prepareNativeDrag(): Promise<{ ok: boolean }>;
  onAgentLiveChanged(cb: (workspaceId: string) => void): () => void;
  /** 弹出保存对话框导出；返回保存的文件名（取消时 null） */
  exportWorkspaceToFile(id: string): Promise<string | null>;
  /** 弹出打开对话框导入；取消时 null */
  importWorkspaceFromFile(): Promise<ImportResult | null>;
  listThemePacks(): Promise<ThemePackDto[]>;
  /** 选择主题包文件夹并安装到应用数据目录；取消时 null */
  installThemePackFromFolder(): Promise<ThemePackDto | null>;
  /** 主进程请求关闭窗口前，渲染进程把未保存的布局写完 */
  onBeforeQuit(cb: () => Promise<void>): () => void;
  /** 标题栏叠层颜色。只传计算样式里的 color 与 symbolColor。 */
  setWindowChrome(colors: { color: string; symbolColor: string }): Promise<void>;
  /** 打开总览前抓当前主窗 PNG。失败返回结果，不抛错。 */
  captureWorkspaceSnapshot(
    input: import('./workspacePicker/snapshotCapture').WorkspaceSnapshotRequest,
  ): Promise<import('./workspacePicker/snapshotCapture').SnapshotCaptureDecision>;
  /** 从 userData/workspace-snapshots 回填已落盘快照。缺文件的 id 不出现。 */
  loadWorkspaceSnapshots(
    workspaceIds: readonly string[],
  ): Promise<import('./workspacePicker/snapshotCapture').WorkspaceSnapshotLoadResult>;
  /** 删除相对文件名对应的落盘快照。返回实际删掉的名字。 */
  deleteWorkspaceSnapshots(relativeNames: readonly string[]): Promise<string[]>;
  /** 数据进程重启。侧栏回到「加载中」，并重新拉目录。 */
  onDataReset?(cb: () => void): () => void;
  onFsChange(cb: (e: FsChangeEvent[]) => void): () => void;
  onIndexStatus(cb: (s: IndexStatus[]) => void): () => void;
  // ---- r11-G 文件 Agent 桥（打开面板 / 调用命令；细节见协议）
  onAgentBridgeOpen(cb: (payload: unknown) => void): () => void;
  onAgentBridgeInvoke(cb: (payload: { commandId?: string; actionId?: string; args?: unknown }) => void): () => void;
  // ---- r11-C 全局自建目录与双目录视图（不移动原文件、不写 op_log）
  listVirtualFolders(): Promise<VirtualFolder[]>;
  createVirtualFolder(parentId: string | null, name: string): Promise<VirtualFolder>;
  renameVirtualFolder(folderId: string, name: string): Promise<VirtualFolder>;
  deleteVirtualFolder(folderId: string): Promise<{ parentId: string | null }>;
  moveVirtualFolder(folderId: string, newParentId: string | null, sort: number): Promise<VirtualFolder>;
  /** 替换某资源所属自建目录（一个资源可进多个；未知目录忽略；未知资源 ID 仍可挂网页占位 / 缺失条目） */
  setVfolderMembership(resourceId: string, folderIds: string[]): Promise<string[]>;
  listVfolderMembership(resourceId: string): Promise<string[]>;
  /** 从某一个自建目录移除该资源（不删库、不移动原文件）；folderId 为 null 表示清全部挂载 */
  removeVfolderMembership(resourceId: string, folderId: string | null): Promise<string[]>;
  /** folderId 为 null 时返回全部自建目录 + 未归类条目 */
  listVfolderView(folderId: string | null): Promise<VfolderView>;
  /** 按扩展名把勾选资源归入全局自建目录（只加关系，不挪动原盘文件）。 */
  classifyByType(resourceIds: string[]): Promise<{ createdFolderIds: string[]; added: number }>;
  undoVfolderClassify(): Promise<{ restored: number; removedFolders: number }>;
  vfolderUndoAvailable(): Promise<boolean>;
  /** A 组网页资源未合并前的占位记忆（URL/标题） */
  rememberWebStub(stub: { resourceId: string; url: string; title: string }): Promise<void>;
  onVfoldersChange(cb: () => void): () => void;
  onRefsChange(cb: (e: { workspaceId: string }) => void): () => void;
  // ---- r11-E
  onIndexHealth(cb: (h: IndexHealth) => void): () => void;
  // ---- r11-F 控制台
  /** 写成普通 .md，再经资源入库得到 resourceId。不覆盖已有文件。 */
  consoleWriteDraft(req: import('./consoleSchema').ConsoleDraftInput & { rootId: string; relPath: string }): Promise<{ resourceId: string; relPath: string; bytes: number; text: string }>;
  /** 已存在的根相对路径 → resourceId。路径不存在时失败。 */
  consoleResolvePath(rootId: string, relPath: string): Promise<string>;
  /** Obsidian 桥：中转库路径、跨盘开关。不写 obsidian.json。 */
  obsidianBridgeGet(): Promise<import('./obsidianBridge/types').ObsidianBridgeSettings>;
  obsidianBridgeSetVault(dir: string | null): Promise<import('./obsidianBridge/types').ObsidianBridgeSettings>;
  obsidianBridgeInit(): Promise<import('./obsidianBridge/types').ObsidianInitResult>;
  obsidianBridgeSetJunction(enabled: boolean): Promise<import('./obsidianBridge/types').ObsidianBridgeSettings>;
  /** 在 Obsidian 打开这篇 Markdown。库内直接打开，否则经中转库。 */
  obsidianOpen(req: import('./obsidianBridge/types').ObsidianOpenRequest): Promise<import('./obsidianBridge/types').ObsidianOpenResult>;
}

/** 按资源 ID 访问文件内容：kbfile://res/<resourceId>/<文件名（仅用于显示/扩展名）> */
export function kbfileResUrl(resourceId: string, name = ''): string {
  return `kbfile://res/${resourceId}/${encodeURIComponent(name)}`;
}

/** 按根相对路径访问（用于 Markdown 中的相对图片等）：kbfile://root/<rootId>/<rel/path> */
export function kbfileRootUrl(rootId: string, relPath: string): string {
  const enc = relPath
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/');
  return `kbfile://root/${rootId}/${enc}`;
}

export function readerTypeOf(ext: string, kind: EntryKind): ReaderType {
  if (kind === 'dir') return 'unsupported';
  if (['md', 'markdown'].includes(ext)) return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (
    ['txt', 'log', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini', 'toml', 'js', 'ts', 'tsx', 'jsx',
     'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'sh', 'ps1', 'bat', 'css', 'html', 'htm', 'sql', 'tex'].includes(ext)
  )
    return 'text';
  return 'unsupported';
}
