/**
 * 导出迁移包（docs/12 §2–§4）。不依赖 Electron，可在测试中直接调用。
 */
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkbenchService } from '../service/WorkbenchService';
import { writeZip, type ZipEntry } from './zip';
import { allWorkspaceRefs, referencedResourceIds } from '../service/workspaceRefs';
import { isNonMigratableKey } from '../../shared/adapter-sdk/policy';
import type { AdapterPluginManifest } from '../../shared/adapter-sdk/types';
import { integrityCheck, listTables, q, vacuumInto } from './snapshot';
import {
  ENTRY_DB,
  ENTRY_MANIFEST,
  ENTRY_README,
  EXPORT_TABLES,
  LOCAL_LAYOUT_KEY,
  MIGRATION_FORMAT,
  MIGRATION_FORMAT_VERSION,
  SECRET_KEY,
  detectPathStyle,
  type ManifestFile,
  type ManifestRoot,
  type MigrationManifest,
} from './format';

export interface ExportOptions {
  appName?: string;
  appVersion?: string;
  /** 测试用：快照完成、打包之前调用（例如在这里继续写库，证明包里是快照时刻的数据） */
  afterSnapshot?: () => void;
}

export interface ExportResult {
  file: string;
  bytes: number;
  manifest: MigrationManifest;
}

const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** 递归收集目录下的文件为 zip 条目（跳过符号链接；条目名用 '/'） */
function collectDir(abs: string, prefix: string, out: ZipEntry[]) {
  if (!fs.existsSync(abs)) return;
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(abs, e.name);
    const name = `${prefix}/${e.name}`;
    if (e.isDirectory()) collectDir(p, name, out);
    else if (e.isFile()) out.push({ name, data: fs.readFileSync(p) });
  }
}

/** 在快照副本上去掉机器本地与敏感数据，返回清单所需信息 */
function sanitizeSnapshot(file: string, manifests: Map<string, AdapterPluginManifest | null>) {
  const d = new Database(file);
  try {
    d.pragma('journal_mode = DELETE');
    const { tables, virtual } = listTables(d);
    // 工作资料（集合）引用：layout 键 workspace.refs:*（第 9 轮 B）
    const wsRefs = allWorkspaceRefs(d);
    const refd = referencedResourceIds(d);
    const refdByRoot = new Map<string, number>();
    if (refd.size) {
      const q = d.prepare(`SELECT root_id FROM resources x WHERE x.id=? AND NOT EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=x.id) AND NOT EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind='file' AND w.ref=x.id)`);
      for (const id of refd) {
        const r = q.get(id) as { root_id: string } | undefined;
        if (r) refdByRoot.set(r.root_id, (refdByRoot.get(r.root_id) ?? 0) + 1);
      }
    }
    // 先读出根目录的原路径（root_mounts 随后清空）
    const roots: ManifestRoot[] = (
      d
        .prepare(
          `SELECT r.id, r.name, m.local_path,
             (SELECT COUNT(*) FROM resources x WHERE x.root_id=r.id AND x.rel_path<>'') AS n,
             (SELECT COUNT(*) FROM resources x WHERE x.root_id=r.id AND x.kind='file') AS nf,
             (SELECT COUNT(*) FROM resources x WHERE x.root_id=r.id AND (
                EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=x.id) OR
                EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind='file' AND w.ref=x.id))) AS nref
           FROM roots r LEFT JOIN root_mounts m ON m.root_id=r.id ORDER BY r.created_at`,
        )
        .all() as { id: string; name: string; local_path: string | null; n: number; nf: number; nref: number }[]
    ).map((r) => ({
      id: r.id,
      name: r.name,
      sourcePath: r.local_path ?? '',
      sourcePathStyle: detectPathStyle(r.local_path ?? ''),
      resourceCount: r.n,
      fileCount: r.nf,
      // 被收藏、在标签中打开、或被列入工作资料（集合）的资源数
      referencedCount: r.nref + (refdByRoot.get(r.id) ?? 0),
    }));
    const excludedTables: string[] = [];
    const secretLike: { pluginId: string; key: string }[] = [];
    const nonMigratable: { pluginId: string; key: string }[] = [];
    const excludedLayout: string[] = [];
    d.transaction(() => {
      for (const t of tables) {
        if (EXPORT_TABLES.includes(t)) continue;
        excludedTables.push(t);
        d.exec(`DELETE FROM ${q(t)}`);
      }
      for (const v of virtual) d.exec(`DELETE FROM ${q(v)}`); // FTS 导入时按 resources 重建
      for (const r of d.prepare('SELECT key FROM layout').all() as { key: string }[]) {
        if (LOCAL_LAYOUT_KEY.test(r.key) || SECRET_KEY.test(r.key)) {
          excludedLayout.push(r.key);
          d.prepare('DELETE FROM layout WHERE key=?').run(r.key);
        }
      }
      for (const r of d.prepare('SELECT plugin_id, key FROM plugin_kv').all() as { plugin_id: string; key: string }[]) {
        if (SECRET_KEY.test(r.key)) {
          secretLike.push({ pluginId: r.plugin_id, key: r.key });
          d.prepare('DELETE FROM plugin_kv WHERE plugin_id=? AND key=?').run(r.plugin_id, r.key);
        } else if (isNonMigratableKey(manifests.get(r.plugin_id), r.key)) {
          // 插件在 manifest.storage.nonMigratableKeys 中声明为不可迁移（SDK 修订 5）
          nonMigratable.push({ pluginId: r.plugin_id, key: r.key });
          d.prepare('DELETE FROM plugin_kv WHERE plugin_id=? AND key=?').run(r.plugin_id, r.key);
        }
      }
      // file_key（卷序列号:文件索引 / dev:ino）只在本机有意义；带到新电脑会误配“重命名”，清空
      d.exec('UPDATE resources SET file_key=NULL');
      // 直链缓存文件不在迁移包内（A：不含 web-cache）；行本身随库走，到新电脑按需再下载
      if (tables.includes('web_resources')) d.exec('UPDATE web_resources SET cache_file=NULL, cache_bytes=NULL, cached_at=NULL');
    }).immediate();
    // 删除的数据不留在空闲页里
    d.exec('VACUUM');
    const get = (sql: string) => (d.prepare(sql).get() as { n: number }).n;
    const has = (t: string) => tables.includes(t);
    const ui = d.prepare("SELECT json FROM layout WHERE key='ui'").get() as { json: string } | undefined;
    const cur = d.prepare("SELECT json FROM layout WHERE key='workspace.current'").get() as { json: string } | undefined;
    const plugins = (d.prepare('SELECT id, version, source, enabled, granted_json FROM plugins WHERE uninstalled_at IS NULL ORDER BY id').all() as any[]).map((p) => ({
      id: p.id,
      version: p.version,
      source: p.source,
      enabled: !!p.enabled,
      grants: (JSON.parse(p.granted_json) as unknown[]).length,
      storageKeys: (d.prepare('SELECT COUNT(*) n FROM plugin_kv WHERE plugin_id=?').get(p.id) as { n: number }).n,
    }));
    const contents: MigrationManifest['contents'] = {
      workspaces: get('SELECT COUNT(*) n FROM workspaces'),
      workspaceItems: get('SELECT COUNT(*) n FROM workspace_items'),
      currentWorkspaceId: cur ? (JSON.parse(cur.json) as string) : null,
      favorites: get('SELECT COUNT(*) n FROM favorites'),
      collections: has('collections') ? get('SELECT COUNT(*) n FROM collections') : null,
      workspaceRefs: { workspaces: [...wsRefs.values()].filter((r) => r.length).length, refs: [...wsRefs.values()].reduce((n, r) => n + r.length, 0), resources: refd.size },
      resources: get('SELECT COUNT(*) n FROM resources'),
      plugins,
      themePacks: [],
      appearance: ui ? (JSON.parse(ui.json) as { appearance?: unknown }).appearance ?? null : null,
      layoutKeys: (d.prepare('SELECT key FROM layout ORDER BY key').all() as { key: string }[]).map((r) => r.key),
    };
    const version = d.pragma('user_version', { simple: true }) as number;
    return { roots, excludedTables, secretLike, nonMigratable, excludedLayout, contents, version, adapterIds: plugins.filter((p) => p.source === 'adapter').map((p) => p.id) };
  } finally {
    d.close();
  }
}

export async function exportPackage(svc: WorkbenchService, outFile: string, opts: ExportOptions = {}): Promise<ExportResult> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-export-'));
  try {
    const snap = path.join(work, 'workbench.db');
    vacuumInto(svc.db, snap);
    opts.afterSnapshot?.();
    const raw = integrityCheck(snap);
    if (raw !== 'ok') throw new Error(`快照完整性检查失败：${raw}`);
    const manifests = new Map(svc.plugins.list().map((p) => [p.id, p.manifest] as const));
    const info = sanitizeSnapshot(snap, manifests);
    const check = integrityCheck(snap);
    if (check !== 'ok') throw new Error(`快照完整性检查失败：${check}`);

    const entries: ZipEntry[] = [{ name: ENTRY_DB, data: fs.readFileSync(snap) }];
    const themeEntries: ZipEntry[] = [];
    collectDir(svc.themesDir, 'themes', themeEntries);
    entries.push(...themeEntries);
    info.contents.themePacks = [...new Set(themeEntries.map((e) => e.name.split('/')[1]))];
    for (const id of info.adapterIds) collectDir(path.join(svc.plugins.dir, id), `plugins/${id}`, entries);

    const files: ManifestFile[] = entries.map((e) => ({ path: e.name, size: e.data.length, sha256: sha256(e.data) }));
    const manifest: MigrationManifest = {
      format: MIGRATION_FORMAT,
      formatVersion: MIGRATION_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      app: { name: opts.appName ?? 'LocalKnowledgeWorkbench', version: opts.appVersion ?? '0.0.0' },
      dbSchemaVersion: info.version,
      source: { platform: process.platform, pathStyle: process.platform === 'win32' ? 'win32' : 'posix' },
      roots: info.roots,
      contents: info.contents,
      excluded: {
        tables: info.excludedTables,
        layoutKeys: info.excludedLayout,
        secretLikePluginKeys: info.secretLike,
        nonMigratablePluginKeys: info.nonMigratable,
        rawFiles: true,
        notes: [
          '根目录中的原始资料文件不在包内：在新电脑上把每个根映射到资料所在的文件夹。',
          'root_mounts（本机路径）不导出；manifest.roots[].sourcePath 只用于导入界面显示。',
          '操作记录（op_log）、内容备份库（blobs）、插件审计记录（plugin_audit）、索引状态（index_state）不导出。',
          '网页面板的网站数据（cookie、登录状态、缓存）不导出，在新电脑上需要重新登录。',
          'web_resources 随库导出（id/url/title 不变）；web-cache 与 cache_file 不导出。',
          '插件在 manifest.storage.nonMigratableKeys 中声明为不可迁移的存储键不导出（只记键名）。',
        ],
      },
      secrets: {
        agentTokens: '本版本没有 Agent 接口，也没有 Agent 令牌；将来的令牌不得导出，导入后须在新电脑上重新生成（docs/12 §4）。',
        webSessions: '不导出。',
        pluginFileTokens: 'kbfile://plugin/<令牌> 只在内存中，进程退出即失效，不导出；导入时清空当前进程中的令牌。',
      },
      snapshot: { method: 'vacuum-into', integrityCheck: check },
      files,
    };
    const readme = [
      '本地知识工作台 数据迁移包',
      `格式 ${MIGRATION_FORMAT} v${MIGRATION_FORMAT_VERSION}，导出于 ${manifest.exportedAt}`,
      '',
      '包含：工作区（标签页、分屏、尺寸、每个面板的阅读状态）、收藏、虚拟集合（如果有）、主题选择、已安装主题包、插件状态（已安装列表、授权、插件存储、视图状态）。',
      '不包含：原始资料文件、本机路径、网站登录数据、密钥与令牌、插件声明为不可迁移的数据、操作记录与备份。',
      '注意：包没有加密，里面有根目录原路径、文件相对路径、工作区名称和插件数据，请妥善保管。',
      '在新电脑上：文件 → 导入数据迁移包…，把每个根目录映射到新位置。',
      '',
    ].join('\r\n');
    const zip = writeZip([{ name: ENTRY_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: ENTRY_README, data: Buffer.from(readme) }, ...entries]);
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    const tmp = `${outFile}.part-${process.pid}`;
    fs.writeFileSync(tmp, zip);
    fs.renameSync(tmp, outFile);
    return { file: path.resolve(outFile), bytes: zip.length, manifest };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
