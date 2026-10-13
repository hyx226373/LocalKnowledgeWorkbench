/**
 * 第三方（沙箱）适配器插件的主进程侧（H2/H5/H7/H8）：
 *  - 开发者模式本地安装（D7：v1 第三方插件唯一来源；无商店、无签名）：复制插件文件夹到 <数据目录>/plugins/<id>；
 *  - manifest 校验：SDK validateAdapterManifest + engines.workbench；不通过 = “已安装但不兼容”；
 *  - 结构化授权（SDK PermissionGrant，含 rootIds 与 declHash）存 plugins.granted_json；
 *  - files.* 与 kbfile://plugin/<token>/… 每次调用都按授权根与扩展名检查（不信任渲染进程转发来的任何判断）；
 *  - 插件私有存储 get/set/delete/keys（单值 ≤1 MB、总量 ≤10 MB）；卸载时保留/删除；
 *  - files.requestFileops 的批量计划：preview → 用户批准 → 引擎执行（桩引擎，见 plan.ts）。
 *  - 网页面板（H9）的访问检查 webAccess：域名/分区/策略全部取自 manifest + 授权。
 * 不依赖 Electron（WebContentsView 与网站数据分区由 main/webPanels.ts 管理）。
 *
 * 第 11 轮 A（星图 · 网络资料）：内置适配器（随应用分发的 resources/builtin-adapters/<id>，plugins.source='builtin'）
 * 与 SDK 修订 10 的逐站授权（net.mode='ask-per-site'，只允许内置适配器使用）。内置插件不可卸载、只能禁用；
 * 第三方插件不能占用内置插件 / 适配器 id，也不能声明 ask-per-site。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateAdapterManifest, permissionDeclHash, satisfies, isAskPerSite, netAllowedHosts, netResourceHosts, withGrantedHost, withoutGrantedHost, siteHostError } from '../../shared/adapter-sdk/policy';
import { ADAPTER_API_VERSION, type AdapterContribution, type AdapterInstallSource, type AdapterPluginManifest, type FileStat, type FileopsPlan, type FileopsResult, type NetPermission, type PermissionGrant, type TextReadResult } from '../../shared/adapter-sdk/types';
import { HOST_API_VERSION } from '../../shared/hostApi';
import { adapterOf, fileScopeError, fsReadDecl, grantDecision, revokedGrant, upsertGrant } from '../../shared/grants';
import { navDomains, netDecl, resourceDomainsOf, webPartition } from '../../shared/webPanel';
import { AUDIT_KINDS, type AuditEntry, type AuditKind } from '../../shared/pluginIpc';
import type { AdapterPluginDto, PlanPreviewDto, PluginAccessCode, PluginFileOp, UninstallInfo, UninstallOptionsDto } from '../../shared/pluginIpc';
import { resolveInRoot, normalizeRelPath } from './paths';
import { OutOfScopeError } from '../../shared/sourceFilter';
import { StubPlanEngine, type FileopsPlanEngine } from './plan';
import { decodeText, type WorkbenchService } from './WorkbenchService';

export class PluginAccessError extends Error {
  constructor(public readonly code: PluginAccessCode, msg: string) {
    super(`[${code}] ${msg}`);
    this.name = 'PluginAccessError';
  }
}

const RESERVED_PREFIX = /^(builtin|demo|kb)\./;
const MAX_PKG_FILES = 2000;
const MAX_PKG_BYTES = 50 * 1024 * 1024;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const DEFAULT_TEXT_MAX = 5 * 1024 * 1024;
const HARD_TEXT_MAX = 16 * 1024 * 1024;
const MAX_BYTES_CHUNK = 4 * 1024 * 1024;
const PLAN_TTL_MS = 10 * 60 * 1000;
const AUDIT_KEEP = 500;

interface Pkg {
  manifest: AdapterPluginManifest | null;
  errors: string[];
  dir: string;
}

export class PluginHostService {
  readonly dir: string;
  private pkgs = new Map<string, Pkg>();
  private tokens = new Map<string, { pluginId: string; adapterId: string }>();
  private plans = new Map<string, { pluginId: string; adapterId: string; plan: FileopsPlan; at: number }>();
  /** r11-A：内置适配器插件 id → 包目录（应用资源目录内，只读） */
  private builtin = new Map<string, string>();
  /** r11-A：逐站授权变化的监听（网页面板刷新允许的主机） */
  private grantListeners = new Set<(pluginId: string) => void>();
  engine: FileopsPlanEngine;

  constructor(private svc: WorkbenchService) {
    this.dir = path.join(svc.dataDir, 'plugins');
    fs.mkdirSync(this.dir, { recursive: true });
    this.engine = new StubPlanEngine(svc);
    for (const id of this.installedIds()) this.pkgs.set(id, this.readPackage(path.join(this.dir, id), id));
  }

  /**
   * 重新从数据库与插件目录载入已安装插件（数据被整体替换后调用：导入迁移包、恢复备份）。
   * 同时清空进程内的文件令牌与未执行的批量计划（它们引用的是替换前的数据）。
   */
  reload(): void {
    this.pkgs.clear();
    this.tokens.clear();
    this.plans.clear();
    const builtins = [...this.builtin.values()];
    this.builtin.clear();
    for (const id of this.installedIds()) this.pkgs.set(id, this.readPackage(path.join(this.dir, id), id));
    for (const d of builtins) this.loadBuiltin(d);
  }

  // ---- r11-A 网络资料：内置适配器 ----

  /**
   * 扫描内置适配器目录（打包后 <resources>/builtin-adapters，开发时 <app>/resources/builtin-adapters）。
   * 每个子目录是一个插件包（manifest.json + main），plugins 表写 source='builtin' 的行（首次默认启用，之后保留用户的启用/禁用与授权）。
   * 返回载入的插件 id；目录不存在时返回空数组。
   */
  loadBuiltins(dir: string): string[] {
    if (!dir || !fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (!e.isDirectory() || !fs.existsSync(path.join(dir, e.name, 'manifest.json'))) continue;
      const id = this.loadBuiltin(path.join(dir, e.name));
      if (id) out.push(id);
    }
    return out;
  }

  private loadBuiltin(pkgDir: string): string | null {
    const pkg = this.readPackage(pkgDir, path.basename(pkgDir), 'builtin');
    const id = pkg.manifest?.id;
    if (typeof id !== 'string') return null;
    const other = this.svc.db.prepare('SELECT source, uninstalled_at FROM plugins WHERE id=?').get(id) as { source: string; uninstalled_at: number | null } | undefined;
    if (other && other.source !== 'builtin') {
      // 旧版本按开发者模式装过同 id 的第三方插件：内置版本优先，第三方行标记卸载（文件与授权保留，便于用户自行处理）
      if (other.source === 'adapter') this.svc.db.prepare("UPDATE plugins SET source='builtin', uninstalled_at=NULL, version=?, updated_at=? WHERE id=?").run(String(pkg.manifest!.version ?? '0.0.0'), Date.now(), id);
      else return null;
    } else if (!other) {
      this.svc.db.prepare("INSERT INTO plugins(id, version, source, enabled, granted_json, installed_at, updated_at) VALUES (?,?, 'builtin', 1, '[]', ?, ?)").run(id, String(pkg.manifest!.version ?? '0.0.0'), Date.now(), Date.now());
    } else {
      this.svc.db.prepare('UPDATE plugins SET version=?, uninstalled_at=NULL WHERE id=?').run(String(pkg.manifest!.version ?? '0.0.0'), id);
    }
    this.builtin.set(id, pkgDir);
    this.pkgs.set(id, pkg);
    return id;
  }

  isBuiltin(id: string): boolean {
    return this.builtin.has(id);
  }

  /** 内置插件声明的全部适配器 id（第三方不能占用） */
  private builtinAdapterIds(): Set<string> {
    const s = new Set<string>();
    for (const id of this.builtin.keys()) for (const a of this.pkgs.get(id)?.manifest?.contributes?.adapters ?? []) s.add(a.id);
    return s;
  }

  private pkgDir(id: string): string {
    return this.builtin.get(id) ?? path.join(this.dir, id);
  }

  /** 网页面板订阅：逐站授权 / 撤销 / 启用状态变化 → 重新计算允许的主机 */
  onGrantsChanged(f: (pluginId: string) => void): () => void {
    this.grantListeners.add(f);
    return () => this.grantListeners.delete(f);
  }
  private emitGrants(pluginId: string) {
    for (const f of this.grantListeners) {
      try {
        f(pluginId);
      } catch {
        /* 监听方自行处理 */
      }
    }
  }

  // ---------------- 安装 / 列表 / 卸载 ----------------

  private installedIds(): string[] {
    const third = (this.svc.db.prepare("SELECT id FROM plugins WHERE source='adapter' AND uninstalled_at IS NULL ORDER BY id").all() as { id: string }[])
      .map((r) => r.id)
      .filter((id) => !this.builtin.has(id) && fs.existsSync(path.join(this.dir, id, 'manifest.json')));
    return [...[...this.builtin.keys()].filter((id) => this.row(id)), ...third];
  }

  /** 读取并校验插件包（不执行任何代码） */
  readPackage(dir: string, expectId?: string, source: AdapterInstallSource = 'third-party'): Pkg {
    let manifest: AdapterPluginManifest | null = null;
    const errors: string[] = [];
    try {
      const text = fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8').replace(/^\uFEFF/, '');
      if (text.length > 256 * 1024) throw new Error('manifest.json 超过 256 KB');
      manifest = JSON.parse(text);
    } catch (e) {
      return { manifest: null, errors: [`manifest.json 无法读取：${(e as Error).message}`], dir };
    }
    errors.push(...validateAdapterManifest(manifest!, ADAPTER_API_VERSION, { source }));
    const m = manifest!;
    if (expectId && m.id !== expectId) errors.push(`manifest id ${m.id} 与安装目录不符`);
    if (typeof m.id === 'string' && RESERVED_PREFIX.test(m.id)) errors.push(`插件 id 不能以 builtin./demo./kb. 开头（保留给内置插件）：${m.id}`);
    if (m.engines?.workbench && !satisfies(HOST_API_VERSION, m.engines.workbench)) errors.push(`需要宿主 API ${m.engines.workbench}，当前为 ${HOST_API_VERSION}`);
    if (source === 'third-party') {
      for (const a of m.contributes?.adapters ?? []) if (typeof a.id === 'string' && !a.id.startsWith(`${m.id}.`)) errors.push(`适配器 id 必须以插件 id 为前缀：${a.id}`);
      // r11-A：第三方插件不能占用内置插件 / 适配器 id
      if (typeof m.id === 'string' && this.builtin.has(m.id)) errors.push(`插件 id 已被内置插件占用：${m.id}`);
      const bi = this.builtinAdapterIds();
      for (const a of m.contributes?.adapters ?? []) if (typeof a.id === 'string' && bi.has(a.id)) errors.push(`适配器 id 已被内置适配器占用：${a.id}`);
    } else if (!(m.contributes?.adapters ?? []).every((a) => typeof a.id === 'string' && (a.id === m.id || a.id.startsWith(`${m.id}.`)))) errors.push('内置适配器 id 必须等于插件 id 或以插件 id 为前缀');
    const main = typeof m.main === 'string' ? m.main : '';
    if (!/^[\w./-]+\.m?js$/.test(main) || main.split('/').some((s) => s === '..' || s === '' || s === '__kb')) errors.push(`main 必须是包内的 .js/.mjs 文件：${main || '（缺失）'}`);
    else if (!fs.existsSync(path.join(dir, ...main.split('/')))) errors.push(`main 指向的文件不存在：${main}（需要打包后的单文件 ES 模块，见 docs/06）`);
    return { manifest: m, errors, dir };
  }

  /** 开发者模式：从本地文件夹安装（复制到数据目录；同 id 覆盖，保留授权与存储） */
  installFromFolder(src: string): AdapterPluginDto {
    const srcAbs = path.resolve(src);
    if (!fs.statSync(srcAbs).isDirectory()) throw new Error('请选择插件文件夹（包含 manifest.json）');
    const probe = this.readPackage(srcAbs);
    if (!probe.manifest) throw new Error(probe.errors.join('；'));
    const id = probe.manifest.id;
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,63}$/.test(id)) throw new Error(`非法插件 id: ${id}`);
    if (RESERVED_PREFIX.test(id)) throw new Error(`插件 id 不能以 builtin./demo./kb. 开头：${id}`);
    // r11-A：逐站授权（net.mode = ask-per-site）只允许内置适配器；第三方插件声明时拒绝安装（不进入“已安装但不兼容”）
    const perSite = probe.manifest.contributes?.adapters?.find((a) => (a.permissions ?? []).some((p) => p.kind === 'net' && isAskPerSite(p as NetPermission)));
    if (perSite) throw new Error(`第三方插件不能使用逐站授权（net.mode = ask-per-site，仅内置网页适配器可用）：${perSite.id}`);
    if (this.builtin.has(id)) throw new Error(`插件 id 已被内置插件占用：${id}`);
    const bi = this.builtinAdapterIds();
    const clash = probe.manifest.contributes?.adapters?.find((a) => bi.has(a.id));
    if (clash) throw new Error(`适配器 id 已被内置适配器占用：${clash.id}`);
    const dst = path.join(this.dir, id);
    if (path.resolve(dst) === srcAbs || srcAbs.startsWith(this.dir + path.sep)) throw new Error('不能从插件安装目录本身安装');
    const other = this.svc.db.prepare('SELECT source FROM plugins WHERE id=?').get(id) as { source: string } | undefined;
    if (other && other.source !== 'adapter') throw new Error(`插件 id 已被${other.source === 'builtin' ? '内置插件' : '已安装的主题包'}占用：${id}`);
    const tmp = `${dst}.installing-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    copyPackage(srcAbs, tmp);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(tmp, dst);
    const pkg = this.readPackage(dst, id);
    this.svc.db
      .prepare(
        `INSERT INTO plugins(id, version, source, enabled, granted_json, installed_at, updated_at) VALUES (?,?, 'adapter', 1, '[]', ?, ?)
         ON CONFLICT(id) DO UPDATE SET version=excluded.version, source='adapter', uninstalled_at=NULL, updated_at=excluded.updated_at`,
      )
      .run(id, String(pkg.manifest?.version ?? '0.0.0'), Date.now(), Date.now());
    this.pkgs.set(id, pkg);
    return this.dto(id)!;
  }

  list(): AdapterPluginDto[] {
    return this.installedIds().map((id) => this.dto(id)!).filter(Boolean);
  }

  private row(id: string): { enabled: number; installed_at: number; granted_json: string } | undefined {
    const r = this.svc.db.prepare("SELECT enabled, installed_at, granted_json, source FROM plugins WHERE id=? AND source IN ('adapter','builtin') AND uninstalled_at IS NULL").get(id) as
      | { enabled: number; installed_at: number; granted_json: string; source: string }
      | undefined;
    if (!r) return undefined;
    // builtin 行只在本次启动确实载入了对应内置包时有效（渲染进程内置插件也写 source='builtin'，不属于这里）
    if (r.source === 'builtin' && !this.builtin.has(id)) return undefined;
    if (r.source === 'adapter' && this.builtin.has(id)) return undefined;
    return r;
  }

  private dto(id: string): AdapterPluginDto | null {
    const r = this.row(id);
    if (!r) return null;
    const pkg = this.pkgs.get(id) ?? this.readPackage(this.pkgDir(id), id, this.builtin.has(id) ? 'builtin' : 'third-party');
    this.pkgs.set(id, pkg);
    const usage = this.storageUsage(id);
    return {
      id,
      name: pkg.manifest?.name ?? id,
      version: pkg.manifest?.version ?? '?',
      source: this.builtin.has(id) ? 'builtin' : 'dev',
      manifest: pkg.manifest,
      errors: pkg.errors,
      enabled: !!r.enabled,
      installedAt: r.installed_at,
      grants: this.grants(id),
      storageBytes: usage.bytes,
      storageKeys: usage.keys,
      mainUrl: `kbplugin://${id}/${pkg.manifest?.main ?? ''}`,
    };
  }

  setEnabled(id: string, enabled: boolean) {
    if (!this.row(id)) throw new Error(`插件不存在: ${id}`);
    this.svc.setPluginEnabled(id, enabled);
    if (!enabled) this.dropTokens(id);
    this.emitGrants(id);
  }

  uninstallInfo(id: string): UninstallInfo {
    const pkg = this.pkgs.get(id);
    if (!this.row(id)) throw new Error(`插件不存在: ${id}`);
    const adapters = pkg?.manifest?.contributes?.adapters?.map((a) => a.id) ?? [];
    const usage = this.storageUsage(id);
    const c = this.svc.countItemsByAdapters(adapters);
    const hasWeb = pkg?.manifest?.contributes?.adapters?.some((a) => a.sourceKinds?.includes('web')) ?? false;
    return { pluginId: id, storageBytes: usage.bytes, storageKeys: usage.keys, grants: this.grants(id).length, auditEntries: (this.svc.db.prepare('SELECT COUNT(*) AS n FROM plugin_audit WHERE plugin_id=?').get(id) as { n: number }).n, siteDataBytes: hasWeb ? 0 : null, items: c.items, workspaces: c.workspaces };
  }

  /**
   * 卸载：删除插件文件；keepData=true 保留存储与授权（plugins 行标记 uninstalled_at），false 全部删除；
   * removeItems=true 从所有工作区移除该插件适配器的条目，否则条目保留为“缺少适配器”占位（D3）。
   * 网站数据分区（persist:kbweb.<id>）由调用方（主进程）在 keepData=false 时清理。
   */
  uninstall(id: string, opts: UninstallOptionsDto): { removedItems: number; adapterIds: string[] } {
    if (!this.row(id)) throw new Error(`插件不存在: ${id}`);
    if (this.builtin.has(id)) throw new Error(`内置插件不能卸载，可以在插件管理中禁用：${id}`);
    const adapterIds = this.pkgs.get(id)?.manifest?.contributes?.adapters?.map((a) => a.id) ?? [];
    this.dropTokens(id);
    for (const [k, p] of this.plans) if (p.pluginId === id) this.plans.delete(k);
    let removedItems = 0;
    this.svc.db.transaction(() => {
      if (opts.keepData) this.svc.db.prepare('UPDATE plugins SET uninstalled_at=?, updated_at=? WHERE id=?').run(Date.now(), Date.now(), id);
      else {
        this.svc.db.prepare('DELETE FROM plugins WHERE id=?').run(id);
        this.svc.db.prepare('DELETE FROM plugin_kv WHERE plugin_id=?').run(id);
        this.svc.db.prepare('DELETE FROM plugin_audit WHERE plugin_id=?').run(id);
      }
      if (opts.removeItems) removedItems = this.svc.removeItemsByAdapters(adapterIds);
    }).immediate();
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.pkgs.delete(id);
    return { removedItems, adapterIds };
  }

  /** 已安装（未卸载）的第三方插件提供的适配器 → 插件 */
  adapterOwners(): Map<string, { id: string; name: string; version: string }> {
    const m = new Map<string, { id: string; name: string; version: string }>();
    for (const id of this.installedIds()) {
      const man = this.pkgs.get(id)?.manifest;
      for (const a of man?.contributes?.adapters ?? []) m.set(a.id, { id, name: man!.name, version: man!.version });
    }
    return m;
  }

  // ---------------- 审计记录 ----------------

  /**
   * 写一条审计记录。detail 只含根名 + 相对路径、计划标题等，不含绝对路径与文件内容。
   * 同一插件、同类、同内容在 2 秒内重复的合并（count+1），防止恶意插件用拒绝刷爆数据库；每个插件最多保留 AUDIT_KEEP 条。
   */
  audit(pluginId: string, adapterId: string | null, kind: AuditKind, detail: string, code: string | null = null): void {
    if (!(AUDIT_KINDS as readonly string[]).includes(kind)) throw new PluginAccessError('invalid-request', `未知审计类型 ${kind}`);
    const d = String(detail).slice(0, 500);
    const now = Date.now();
    const db = this.svc.db;
    const last = db.prepare('SELECT id, last_at, adapter_id, kind, code, detail FROM plugin_audit WHERE plugin_id=? ORDER BY id DESC LIMIT 1').get(pluginId) as
      | { id: number; last_at: number; adapter_id: string | null; kind: string; code: string | null; detail: string }
      | undefined;
    if (last && now - last.last_at < 2000 && last.kind === kind && last.detail === d && last.code === code && last.adapter_id === adapterId) {
      db.prepare('UPDATE plugin_audit SET count=count+1, last_at=? WHERE id=?').run(now, last.id);
      return;
    }
    db.prepare('INSERT INTO plugin_audit(at,last_at,plugin_id,adapter_id,kind,code,detail) VALUES (?,?,?,?,?,?,?)').run(now, now, pluginId, adapterId, kind, code, d);
    db.prepare('DELETE FROM plugin_audit WHERE plugin_id=? AND id <= (SELECT id FROM plugin_audit WHERE plugin_id=? ORDER BY id DESC LIMIT 1 OFFSET ?)').run(pluginId, pluginId, AUDIT_KEEP);
  }

  listAudit(pluginId: string | null, limit = 100): AuditEntry[] {
    const n = Math.max(1, Math.min(Number(limit) || 100, 1000));
    const rows = (
      pluginId ? this.svc.db.prepare('SELECT * FROM plugin_audit WHERE plugin_id=? ORDER BY id DESC LIMIT ?').all(pluginId, n) : this.svc.db.prepare('SELECT * FROM plugin_audit ORDER BY id DESC LIMIT ?').all(n)
    ) as { id: number; at: number; last_at: number; plugin_id: string; adapter_id: string | null; kind: AuditKind; code: string | null; detail: string; count: number }[];
    return rows.map((r) => ({ id: r.id, at: r.at, lastAt: r.last_at, pluginId: r.plugin_id, adapterId: r.adapter_id, kind: r.kind, code: r.code, detail: r.detail, count: r.count }));
  }

  /** 资源的“根名/相对路径”（审计用；不含绝对路径） */
  private describeResource(resourceId: unknown): string {
    if (typeof resourceId !== 'string') return '（无效 resourceId）';
    try {
      const r = this.svc.getResource(resourceId);
      if (!r) return `resourceId ${resourceId.slice(0, 60)}`;
      const root = this.svc.listRoots().find((x) => x.id === r.rootId)?.name ?? '?';
      return `${root}/${r.relPath}`;
    } catch (e) {
      if (e instanceof OutOfScopeError) return `resourceId ${resourceId.slice(0, 60)}`;
      throw e;
    }
  }

  /** 拒绝类错误（permission-denied / out-of-scope）写审计后原样抛出 */
  private auditDenial<T>(pluginId: string, adapterId: string, what: string, f: () => T): T {
    try {
      return f();
    } catch (e) {
      if (e instanceof PluginAccessError && (e.code === 'permission-denied' || e.code === 'out-of-scope') && this.row(pluginId)) this.audit(pluginId, adapterId, 'denied', `${what}：${e.message}`, e.code);
      throw e;
    }
  }

  // ---------------- 授权 ----------------

  grants(id: string): PermissionGrant[] {
    const r = this.svc.db.prepare('SELECT granted_json FROM plugins WHERE id=?').get(id) as { granted_json: string } | undefined;
    if (!r) return [];
    try {
      const v = JSON.parse(r.granted_json);
      return Array.isArray(v) ? v.filter((g) => g && typeof g === 'object' && typeof g.permissionId === 'string') : [];
    } catch {
      return [];
    }
  }
  private saveGrants(id: string, grants: PermissionGrant[]) {
    this.svc.db.prepare('UPDATE plugins SET granted_json=?, updated_at=? WHERE id=?').run(JSON.stringify(grants), Date.now(), id);
  }

  /** 记录用户在授权对话框中的决定。允许记录的 declHash 由主进程按当前声明计算（渲染进程传来的不采信）。 */
  setGrant(input: { pluginId: string; adapterId: string; permissionId: string; decision: 'granted' | 'denied'; rootIds?: string[] | 'all' }): PermissionGrant {
    const { decl } = this.declOf(input.pluginId, input.adapterId, input.permissionId);
    let rootIds: PermissionGrant['rootIds'];
    if (input.decision === 'granted' && decl.kind === 'fs.read') {
      const known = new Set(this.svc.listRoots().map((r) => r.id));
      if (decl.scope === 'all-registered-roots') rootIds = [...known];
      else {
        if (!Array.isArray(input.rootIds) || !input.rootIds.length) throw new PluginAccessError('invalid-request', '请至少勾选一个文件夹');
        rootIds = input.rootIds.filter((r) => known.has(r));
        if (!rootIds.length) throw new PluginAccessError('invalid-request', '勾选的文件夹不存在');
      }
    }
    // r11-A：逐站授权改为“允许”时保留已批准的主机列表（插件级允许本身不批准任何主机）
    const prevHosts = decl.kind === 'net' && isAskPerSite(decl) && input.decision === 'granted' ? (findGrantOf(this.grants(input.pluginId), input.pluginId, input.adapterId, input.permissionId)?.grantedHosts ?? []) : null;
    const g: PermissionGrant = {
      pluginId: input.pluginId,
      adapterId: input.adapterId,
      permissionId: input.permissionId,
      decision: input.decision,
      declHash: permissionDeclHash(decl),
      decidedAt: Date.now(),
      ...(rootIds ? { rootIds } : {}),
      ...(prevHosts ? { grantedHosts: prevHosts } : {}),
    };
    this.saveGrants(input.pluginId, upsertGrant(this.grants(input.pluginId), g));
    this.audit(input.pluginId, input.adapterId, 'grant', `${input.permissionId}（${decl.kind}）：${g.decision === 'granted' ? '允许' : '拒绝'}${rootIds ? `，${rootIds.length} 个文件夹` : ''}`);
    this.emitGrants(input.pluginId);
    return g;
  }

  // ---- r11-A 网络资料：逐站授权（SDK 修订 10） ----

  /** 适配器的逐站授权 net 声明；不是 ask-per-site 时抛 invalid-request */
  private siteDecl(pluginId: string, adapterId: string): { decl: NetPermission; adapter: AdapterContribution } {
    const pkg = this.pkgs.get(pluginId);
    if (!pkg?.manifest || !this.row(pluginId)) throw new PluginAccessError('plugin-unavailable', `插件未安装: ${pluginId}`);
    const a = adapterOf(pkg.manifest, adapterId);
    const decl = netDecl(a);
    if (!a || !decl || !isAskPerSite(decl)) throw new PluginAccessError('invalid-request', `适配器 ${adapterId} 不使用逐站授权`);
    if (!this.builtin.has(pluginId)) throw new PluginAccessError('permission-denied', '逐站授权只允许内置适配器使用');
    return { decl, adapter: a };
  }

  /** 当前已批准的主机（未批准 / 已撤销时为空；declHash 不一致视为未批准） */
  grantedSites(pluginId: string, adapterId: string): string[] {
    const { decl } = this.siteDecl(pluginId, adapterId);
    const { decision, grant } = grantDecision(this.grants(pluginId), pluginId, adapterId, decl);
    return decision === 'granted' ? [...(grant?.grantedHosts ?? [])] : [];
  }

  /**
   * 用户在“允许访问 <host>？”中点了允许：把精确主机名加入 grantedHosts（declHash 由主进程计算）。
   * 插件级记录是“拒绝/撤销”时，用户这次的明确允许把它改回“允许”，只含这一个主机。
   */
  grantSite(pluginId: string, adapterId: string, host: string): PermissionGrant {
    const { decl } = this.siteDecl(pluginId, adapterId);
    const h = String(host ?? '').toLowerCase();
    const err = siteHostError(h);
    if (err) throw new PluginAccessError('invalid-request', err);
    const { decision, grant } = grantDecision(this.grants(pluginId), pluginId, adapterId, decl);
    const base: PermissionGrant =
      decision === 'granted' && grant ? grant : { pluginId, adapterId, permissionId: decl.id, decision: 'granted', declHash: permissionDeclHash(decl), decidedAt: Date.now(), grantedHosts: [] };
    const g = { ...withGrantedHost(base, h), decidedAt: Date.now() };
    this.saveGrants(pluginId, upsertGrant(this.grants(pluginId), g));
    this.audit(pluginId, adapterId, 'grant', `${decl.id}（逐站）：允许访问 ${h}`);
    this.emitGrants(pluginId);
    return g;
  }

  /** 撤销单个主机（插件管理中的已批准网站列表） */
  revokeSite(pluginId: string, adapterId: string, host: string): PermissionGrant | null {
    const { decl } = this.siteDecl(pluginId, adapterId);
    const g = findGrantOf(this.grants(pluginId), pluginId, adapterId, decl.id);
    if (!g) return null;
    const next = { ...withoutGrantedHost(g, String(host ?? '').toLowerCase()), decidedAt: Date.now() };
    this.saveGrants(pluginId, upsertGrant(this.grants(pluginId), next));
    this.audit(pluginId, adapterId, 'grant', `${decl.id}（逐站）：撤销 ${host}`);
    this.emitGrants(pluginId);
    return next;
  }

  revoke(pluginId: string, adapterId: string, permissionId: string): PermissionGrant {
    this.declOf(pluginId, adapterId, permissionId);
    const g = revokedGrant(pluginId, adapterId, permissionId);
    this.saveGrants(pluginId, upsertGrant(this.grants(pluginId), g));
    this.audit(pluginId, adapterId, 'grant', `${permissionId}：撤销`);
    this.emitGrants(pluginId);
    return g;
  }

  private declOf(pluginId: string, adapterId: string, permissionId: string) {
    const pkg = this.pkgs.get(pluginId);
    if (!pkg?.manifest || !this.row(pluginId)) throw new PluginAccessError('plugin-unavailable', `插件未安装: ${pluginId}`);
    const a = adapterOf(pkg.manifest, adapterId);
    const decl = a?.permissions.find((p) => p.id === permissionId);
    if (!a || !decl) throw new PluginAccessError('invalid-request', `未声明的权限 ${adapterId}/${permissionId}`);
    return { pkg, adapter: a, decl };
  }

  /** 插件必须已安装、启用、兼容 */
  private usable(pluginId: string): Pkg {
    const r = this.row(pluginId);
    const pkg = this.pkgs.get(pluginId);
    if (!r || !pkg?.manifest) throw new PluginAccessError('plugin-unavailable', `插件未安装: ${pluginId}`);
    if (!r.enabled) throw new PluginAccessError('plugin-unavailable', `插件已禁用: ${pluginId}`);
    if (pkg.errors.length) throw new PluginAccessError('plugin-unavailable', `插件不兼容: ${pkg.errors[0]}`);
    return pkg;
  }

  // ---------------- H9：网页面板 ----------------

  /**
   * 网页面板的访问检查（主进程创建 WebContentsView 之前）：插件已安装/启用/兼容、适配器是 web 适配器、
   * 必需的 net 权限已授予且 declHash 与当前声明一致。返回值（域名、分区、策略）全部取自 manifest，渲染进程传入的不采信。
   */
  webAccess(
    pluginId: string,
    adapterId: string,
  ): { adapter: AdapterContribution; domains: string[]; resourceDomains: string[]; partition: string; web: NonNullable<AdapterContribution['web']>; perSite: boolean } {
    return this.auditDenial(pluginId, adapterId, '打开网页面板', () => {
      const pkg = this.usable(pluginId);
      const a = adapterOf(pkg.manifest, adapterId);
      if (!a || !a.sourceKinds.includes('web') || a.displayMode !== 'in-app-web' || !a.web) throw new PluginAccessError('invalid-request', `适配器 ${adapterId} 不是网页适配器`);
      const decl = netDecl(a);
      if (!decl) throw new PluginAccessError('permission-denied', '适配器未声明 net 权限');
      const { decision, grant } = grantDecision(this.grants(pluginId), pluginId, adapterId, decl);
      const partition = webPartition(pluginId, a.web.session?.partition);
      if (isAskPerSite(decl)) {
        // r11-A：逐站授权——插件级未决定也可以建视图（每个主机在导航时单独询问）；被撤销则整体拒绝
        if (!this.builtin.has(pluginId)) throw new PluginAccessError('permission-denied', '逐站授权只允许内置适配器使用');
        if (decision === 'denied') throw new PluginAccessError('permission-denied', '网络权限已被拒绝或撤销');
        const g = decision === 'granted' ? grant : undefined;
        return { adapter: a, domains: netAllowedHosts(decl, g), resourceDomains: netResourceHosts(decl, g), partition, web: a.web, perSite: true };
      }
      if (decision !== 'granted') throw new PluginAccessError('permission-denied', decision === 'denied' ? '网络权限已被拒绝或撤销' : '尚未授予网络权限');
      return { adapter: a, domains: navDomains(a), resourceDomains: resourceDomainsOf(a), partition, web: a.web, perSite: false };
    });
  }

  /** 已安装的、带网页适配器的插件及其会话策略（启动时 maxAgeDays 清理、卸载清理用） */
  webPlugins(): { pluginId: string; partitions: string[]; maxAgeDays?: number }[] {
    const out: { pluginId: string; partitions: string[]; maxAgeDays?: number }[] = [];
    for (const [id, pkg] of this.pkgs) {
      const webs = pkg.manifest?.contributes?.adapters?.filter((a) => a.sourceKinds?.includes('web') && a.web) ?? [];
      if (!webs.length) continue;
      const ages = webs.map((a) => a.web!.session?.maxAgeDays).filter((n): n is number => typeof n === 'number' && n > 0);
      out.push({ pluginId: id, partitions: [...new Set(webs.map((a) => webPartition(id, a.web!.session?.partition)))], ...(ages.length ? { maxAgeDays: Math.min(...ages) } : {}) });
    }
    return out;
  }

  // ---------------- H5：files.* ----------------

  /** 按 resourceId → 根 → 授权根列表 → 扩展名检查；通过则返回资源信息（绝对路径只在主进程内使用） */
  checkFileAccess(pluginId: string, adapterId: string, resourceId: string) {
    const pkg = this.usable(pluginId);
    const a = adapterOf(pkg.manifest, adapterId);
    if (!a || !a.sourceKinds.includes('file')) throw new PluginAccessError('invalid-request', `适配器 ${adapterId} 不是文件适配器`);
    const decl = fsReadDecl(a);
    if (!decl) throw new PluginAccessError('permission-denied', '适配器未声明 fs.read');
    const { decision, grant } = grantDecision(this.grants(pluginId), pluginId, adapterId, decl);
    if (decision !== 'granted') throw new PluginAccessError('permission-denied', decision === 'denied' ? '读取权限已被拒绝或撤销' : '尚未授予读取权限');
    if (typeof resourceId !== 'string' || !/^[\w.:-]{1,200}$/.test(resourceId)) throw new PluginAccessError('invalid-request', 'resourceId 不合法');
    const res = this.svc.getResource(resourceId);
    if (!res || !res.exists) throw new PluginAccessError('resource-missing', '文件不可用');
    if (res.kind !== 'file') throw new PluginAccessError('out-of-scope', '只能读取文件');
    const scope = fileScopeError(grant, decl, res);
    if (scope) throw new PluginAccessError('out-of-scope', scope);
    return { res, decl, adapter: a, abs: this.svc.resolveResourcePath(resourceId) };
  }

  file(pluginId: string, adapterId: string, req: PluginFileOp): FileStat | TextReadResult | Uint8Array {
    const { res, abs } = this.auditDenial(pluginId, adapterId, `files.${req?.op} ${this.describeResource(req?.resourceId)}`, () => this.checkFileAccess(pluginId, adapterId, req?.resourceId));
    const st = fs.statSync(abs);
    if (req.op === 'stat') return { resourceId: res.resourceId, name: res.name, ext: res.ext, size: st.size, mtimeMs: Math.round(st.mtimeMs), exists: true, ...(mimeOf(res.ext) ? { mimeType: mimeOf(res.ext) } : {}) };
    if (req.op === 'readText') {
      const max = Math.max(1, Math.min(Number(req.maxBytes) || DEFAULT_TEXT_MAX, HARD_TEXT_MAX));
      const buf = readRange(abs, 0, Math.min(st.size, max));
      return { text: decodeText(buf), truncated: st.size > max, size: st.size, encoding: 'utf-8' };
    }
    if (req.op === 'readBytes') {
      const offset = Math.max(0, Math.floor(Number(req.offset) || 0));
      const length = Math.max(0, Math.min(Math.floor(Number(req.length ?? st.size - offset)), MAX_BYTES_CHUNK, Math.max(0, st.size - offset)));
      return new Uint8Array(readRange(abs, offset, length));
    }
    throw new PluginAccessError('invalid-request', '未知操作');
  }

  /** 为一个插件面板签发 kbfile://plugin/<token>/… 的令牌（每次请求仍按当前授权检查） */
  mintFileToken(pluginId: string, adapterId: string): string {
    this.usable(pluginId);
    const t = crypto.randomBytes(18).toString('base64url');
    this.tokens.set(t, { pluginId, adapterId });
    return t;
  }
  releaseFileToken(token: string) {
    this.tokens.delete(token);
  }
  private dropTokens(pluginId: string) {
    for (const [k, v] of this.tokens) if (v.pluginId === pluginId) this.tokens.delete(k);
  }

  /** kbfile://plugin/<token>/<resourceId>[/<name>] → 已校验的绝对路径 */
  resolvePluginFileUrl(url: string): string {
    const u = new URL(url);
    if (u.host !== 'plugin') throw new PluginAccessError('invalid-request', 'not a plugin url');
    const [token, rid] = u.pathname.split('/').filter(Boolean);
    const t = token ? this.tokens.get(token) : undefined;
    if (!t) throw new PluginAccessError('permission-denied', '令牌无效');
    const r = decodeURIComponent(rid ?? '');
    return this.auditDenial(t.pluginId, t.adapterId, `kbfile ${this.describeResource(r)}`, () => this.checkFileAccess(t.pluginId, t.adapterId, r)).abs;
  }

  /** kbplugin://<id>/<rel> → 插件包内文件（只读；__kb/ 由宿主提供） */
  resolveAsset(pluginId: string, rel: string): string {
    if (!this.row(pluginId) || !this.pkgs.get(pluginId)) throw new PluginAccessError('plugin-unavailable', '插件未安装');
    const norm = normalizeRelPath(rel);
    if (norm.startsWith('__kb/')) throw new PluginAccessError('invalid-request', 'reserved');
    return resolveInRoot(this.pkgDir(pluginId), norm);
  }

  // ---------------- H7：存储 ----------------

  private key(k: unknown): string {
    if (typeof k !== 'string' || !k || k.length > 256) throw new PluginAccessError('invalid-request', '存储键必须是 1–256 字符的字符串');
    return k;
  }
  storageGet(id: string, k: string): unknown {
    return this.svc.pluginStorageGet(id, this.key(k));
  }
  storageSet(id: string, k: string, value: unknown) {
    const json = JSON.stringify(value ?? null);
    const bytes = Buffer.byteLength(json);
    if (bytes > MAX_VALUE_BYTES) throw new PluginAccessError('quota-exceeded', '单个值不能超过 1 MB');
    const cur = this.svc.db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(value_json AS BLOB))),0) AS n FROM plugin_kv WHERE plugin_id=? AND key<>?').get(id, this.key(k)) as { n: number };
    if (cur.n + bytes > MAX_TOTAL_BYTES) throw new PluginAccessError('quota-exceeded', '插件存储总量不能超过 10 MB');
    this.svc.pluginStorageSet(id, k, value);
  }
  storageDelete(id: string, k: string) {
    this.svc.db.prepare('DELETE FROM plugin_kv WHERE plugin_id=? AND key=?').run(id, this.key(k));
  }
  storageKeys(id: string): string[] {
    return (this.svc.db.prepare('SELECT key FROM plugin_kv WHERE plugin_id=? ORDER BY key').all(id) as { key: string }[]).map((r) => r.key);
  }
  storageUsage(id: string): { bytes: number; keys: number } {
    const r = this.svc.db.prepare('SELECT COUNT(*) AS k, COALESCE(SUM(LENGTH(CAST(value_json AS BLOB)) + LENGTH(CAST(key AS BLOB))),0) AS n FROM plugin_kv WHERE plugin_id=?').get(id) as { k: number; n: number };
    return { bytes: r.n, keys: r.k };
  }

  // ---------------- H8：批量计划 ----------------

  planPreview(pluginId: string, adapterId: string, plan: FileopsPlan): PlanPreviewDto {
    const title = String((plan as { title?: unknown } | null)?.title ?? '').slice(0, 100) || '（未命名计划）';
    const n = Array.isArray((plan as { steps?: unknown } | null)?.steps) ? plan.steps.length : 0;
    let dto: PlanPreviewDto;
    try {
      dto = this.planPreviewInner(pluginId, adapterId, plan);
    } catch (e) {
      if (this.row(pluginId)) this.audit(pluginId, adapterId, 'plan-blocked', `「${title}」${n} 步：${(e as Error).message}`, e instanceof PluginAccessError ? e.code : null);
      throw e;
    }
    this.audit(pluginId, adapterId, 'plan-submitted', `「${dto.title}」${dto.steps.length} 步：${dto.steps.map((x) => `${x.op} ${x.rootName}/${x.relPath}`).join('；')}${dto.blocked ? '（有冲突，不能批准）' : ''}`);
    return dto;
  }

  private planPreviewInner(pluginId: string, adapterId: string, plan: FileopsPlan): PlanPreviewDto {
    const pkg = this.usable(pluginId);
    const a = adapterOf(pkg.manifest, adapterId);
    const decl = a?.permissions.find((p) => p.kind === 'fileops.write');
    if (!a || !decl || decl.kind !== 'fileops.write') throw new PluginAccessError('permission-denied', '适配器未声明 fileops.write');
    if (grantDecision(this.grants(pluginId), pluginId, adapterId, decl).decision !== 'granted') throw new PluginAccessError('permission-denied', '未授予修改文件的权限');
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 100) throw new PluginAccessError('invalid-request', '计划必须包含 1–100 个步骤');
    let total = 0;
    const steps = plan.steps.map((s) => {
      if (!s || !['write', 'move', 'trash'].includes(s.op)) throw new PluginAccessError('invalid-request', '未知步骤类型');
      if (!decl.operations.includes(s.op)) throw new PluginAccessError('out-of-scope', `未声明的操作 ${s.op}`);
      if (s.op === 'write' && typeof s.content !== 'string') throw new PluginAccessError('invalid-request', 'write 步骤缺少 content');
      if (s.op === 'move' && typeof s.toRelPath !== 'string') throw new PluginAccessError('invalid-request', 'move 步骤缺少 toRelPath');
      total += s.content ? Buffer.byteLength(s.content) : 0;
      // 每一步的资源必须在本适配器的读取授权范围内
      this.checkFileAccess(pluginId, adapterId, s.resourceId);
      return { op: s.op, resourceId: s.resourceId, ...(s.content !== undefined ? { content: String(s.content) } : {}), ...(s.toRelPath !== undefined ? { toRelPath: String(s.toRelPath) } : {}), ...(s.expectedHash ? { expectedHash: String(s.expectedHash) } : {}) };
    });
    if (total > 5 * 1024 * 1024) throw new PluginAccessError('invalid-request', '计划内容超过 5 MB');
    const clean: FileopsPlan = { title: String(plan.title ?? '').slice(0, 200) || '（未命名计划）', steps };
    const checks = this.engine.preview(clean);
    const now = Date.now();
    for (const [k, p] of this.plans) if (now - p.at > PLAN_TTL_MS) this.plans.delete(k);
    const planId = crypto.randomUUID();
    this.plans.set(planId, { pluginId, adapterId, plan: clean, at: now });
    const roots = new Map(this.svc.listRoots().map((r) => [r.id, r.name]));
    return {
      planId,
      pluginId,
      pluginName: pkg.manifest!.name,
      adapterId,
      title: clean.title,
      engine: this.engine.name,
      blocked: checks.some((c) => c.conflicts.length > 0),
      steps: checks.map((c) => ({
        op: c.step.op,
        resourceId: c.step.resourceId,
        rootName: c.preview ? (roots.get(c.preview.rootId) ?? '') : '',
        relPath: c.preview?.relPath ?? '',
        ...(c.step.toRelPath ? { toRelPath: c.step.toRelPath } : {}),
        summary: c.preview?.summary ?? '',
        ...(c.step.op === 'write' ? { bytes: Buffer.byteLength(c.step.content ?? '') } : {}),
        conflicts: c.conflicts,
      })),
    };
  }

  planExecute(planId: string): FileopsResult {
    const p = this.plans.get(planId);
    if (!p) return { ok: false, reason: 'conflict', detail: '计划已过期或不存在' };
    this.plans.delete(planId);
    try {
      this.usable(p.pluginId);
      for (const s of p.plan.steps) this.checkFileAccess(p.pluginId, p.adapterId, s.resourceId);
    } catch (e) {
      const res: FileopsResult = { ok: false, reason: e instanceof PluginAccessError && e.code === 'out-of-scope' ? 'out-of-scope' : 'permission-denied', detail: String((e as Error).message) };
      if (this.row(p.pluginId)) this.audit(p.pluginId, p.adapterId, 'plan-failed', `「${p.plan.title}」批准后复查未通过：${res.detail}`, res.reason);
      return res;
    }
    const r = this.engine.execute(p.plan, `plugin:${p.pluginId}`);
    if (r.ok) this.audit(p.pluginId, p.adapterId, 'plan-approved', `「${p.plan.title}」已批准并执行 ${r.opIds.length} 步（操作记录 #${r.opIds.join(', #')}）`);
    else this.audit(p.pluginId, p.adapterId, 'plan-failed', `「${p.plan.title}」执行失败：${r.detail}（已执行 ${r.opIds.length} 步）`, 'conflict');
    return r.ok ? { ok: true, opIds: r.opIds } : { ok: false, reason: 'conflict', detail: r.detail + (r.opIds.length ? `（已执行 ${r.opIds.length} 步，可在操作记录中撤销）` : '') };
  }

  planDiscard(planId: string): FileopsResult {
    const p = this.plans.get(planId);
    this.plans.delete(planId);
    if (p && this.row(p.pluginId)) this.audit(p.pluginId, p.adapterId, 'plan-rejected', `「${p.plan.title}」被用户拒绝（${p.plan.steps.length} 步未执行）`);
    return { ok: false, reason: 'user-rejected' };
  }
}

// ---------------- helpers ----------------

function findGrantOf(grants: readonly PermissionGrant[], pluginId: string, adapterId: string, permissionId: string): PermissionGrant | undefined {
  return grants.find((g) => g.pluginId === pluginId && g.adapterId === adapterId && g.permissionId === permissionId);
}

function readRange(abs: string, offset: number, length: number): Buffer {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = length ? fs.readSync(fd, buf, 0, length, offset) : 0;
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

const MIME: Record<string, string> = { json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };
export function mimeOf(ext: string): string | undefined {
  return MIME[ext.toLowerCase()];
}

/** 复制插件包：不跟随符号链接、跳过 node_modules/.git、限制文件数与总大小 */
function copyPackage(src: string, dst: string) {
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string) => {
    fs.mkdirSync(to, { recursive: true });
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '__kb') continue;
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        files++;
        bytes += fs.statSync(a).size;
        if (files > MAX_PKG_FILES) throw new Error(`插件包文件过多（上限 ${MAX_PKG_FILES}）`);
        if (bytes > MAX_PKG_BYTES) throw new Error('插件包超过 50 MB');
        fs.copyFileSync(a, b);
      }
    }
  };
  try {
    walk(src, dst);
  } catch (e) {
    fs.rmSync(dst, { recursive: true, force: true });
    throw e;
  }
}
