/**
 * 迁移包格式（docs/12 §2）。zip 内：
 *   manifest.json            本文件描述的清单（format / formatVersion / 根目录列表 / 文件校验和 / 排除项）
 *   db/workbench.db          元数据库的一致快照（VACUUM INTO），已去掉机器本地与敏感数据
 *   themes/<id>/…            已安装的主题包（纯数据）
 *   plugins/<id>/…           已安装的第三方适配器插件包（开发者模式安装的文件夹）
 *   README.txt               给人看的说明
 * 不含：根目录中的原始资料文件、root_mounts（本机路径）、网页面板的网站数据（cookie/登录）、操作记录与备份库、插件审计记录、密钥/令牌。
 */
export const MIGRATION_FORMAT = 'kb-workbench.migration';
export const MIGRATION_FORMAT_VERSION = 1;
export const PACKAGE_EXT = 'kbmigrate.zip';

export const ENTRY_MANIFEST = 'manifest.json';
export const ENTRY_DB = 'db/workbench.db';
export const ENTRY_README = 'README.txt';

export type PathStyle = 'win32' | 'posix';

export interface ManifestRoot {
  id: string;
  name: string;
  /** 导出时本机上的路径（只用于导入界面显示与自动建议；导入后不会使用） */
  sourcePath: string;
  sourcePathStyle: PathStyle;
  /** 根下已知资源数（文件 + 文件夹，不含根本身） */
  resourceCount: number;
  fileCount: number;
  /** 被收藏或被工作区引用的资源数（这些在新位置找不到时会显示“缺失”） */
  referencedCount: number;
}

export interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

export interface MigrationManifest {
  format: typeof MIGRATION_FORMAT;
  formatVersion: number;
  exportedAt: string;
  app: { name: string; version: string };
  /** 元数据库 schema 版本（PRAGMA user_version） */
  dbSchemaVersion: number;
  source: { platform: string; pathStyle: PathStyle };
  roots: ManifestRoot[];
  contents: {
    workspaces: number;
    workspaceItems: number;
    currentWorkspaceId: string | null;
    favorites: number;
    /** null = 本版本数据库没有虚拟集合表 */
    collections: number | null;
    /** 工作资料（集合）引用（layout 键 workspace.refs:*）：有资料的工作区数、引用总数、被引用的不同资源数。旧包没有此字段 */
    workspaceRefs?: { workspaces: number; refs: number; resources: number };
    resources: number;
    plugins: { id: string; version: string; source: string; enabled: boolean; grants: number; storageKeys: number }[];
    themePacks: string[];
    appearance: unknown;
    layoutKeys: string[];
  };
  excluded: {
    tables: string[];
    layoutKeys: string[];
    /** 看起来像密钥的插件存储键：只记数量与插件，不记值 */
    secretLikePluginKeys: { pluginId: string; key: string }[];
    /** 插件声明为不可迁移（manifest.storage.nonMigratableKeys）而未导出的存储键（只记键名）。旧包没有此字段 */
    nonMigratablePluginKeys?: { pluginId: string; key: string }[];
    rawFiles: true;
    notes: string[];
  };
  /** 密钥与令牌的处理（docs/12 §4） */
  secrets: {
    agentTokens: string;
    webSessions: string;
    pluginFileTokens: string;
  };
  snapshot: { method: 'vacuum-into'; integrityCheck: string };
  files: ManifestFile[];
}

/** 导出时整表保留的表（白名单；不在名单里的表一律不导出并列入 excluded.tables） */
export const EXPORT_TABLES = ['roots', 'resources', 'favorites', 'layout', 'workspaces', 'workspace_items', 'plugins', 'plugin_kv', 'collections', 'collection_items', 'web_resources'];
/** 导入时用快照替换的表（root_mounts 由映射生成；resources_fts 由 resources 重建；index_state 清空） */
export const IMPORT_REPLACE_TABLES = ['roots', 'resources', 'favorites', 'layout', 'workspaces', 'workspace_items', 'plugins', 'plugin_kv', 'collections', 'collection_items', 'web_resources'];
/** 机器本地、不导出的 layout 键 */
export const LOCAL_LAYOUT_KEY = /^(web\.lastUsed\.|agent\.|migration\.)/;
/** 看起来像密钥的键（与 shared/items.ts 的 stripSecrets 同一规则） */
export const SECRET_KEY = /(pass(word)?|secret|token|api[-_]?key|credential|cookie|auth|session)/i;

export function detectPathStyle(p: string): PathStyle {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') ? 'win32' : 'posix';
}

/** 不论哪种风格都能取最后一段（Windows 路径在 Linux 上导入时 path.basename 不认反斜杠） */
export function basenameAnyStyle(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
