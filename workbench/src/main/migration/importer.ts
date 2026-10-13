/**
 * 导入迁移包：校验 → 暂存 → 根目录映射校验 → 自动备份当前数据 → 单事务替换元数据 → 替换主题包/插件包 → 扫描新位置。
 * 任何一步失败都从备份恢复（元数据库整表回写 + 文件夹换回），见 docs/12 §5–§6。不依赖 Electron。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DB_VERSION, openDb } from '../service/db';
import { toRelPath } from '../service/paths';
import type { WorkbenchService } from '../service/WorkbenchService';
import { readZip } from './zip';
import { referencedResourceIds } from '../service/workspaceRefs';
import { integrityCheck, replaceTablesFrom, userVersion, vacuumInto } from './snapshot';
import {
  ENTRY_DB,
  ENTRY_MANIFEST,
  IMPORT_REPLACE_TABLES,
  LOCAL_LAYOUT_KEY,
  MIGRATION_FORMAT,
  MIGRATION_FORMAT_VERSION,
  basenameAnyStyle,
  type MigrationManifest,
} from './format';

export const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
export const BACKUP_DIR_NAME = 'migration-backups';
export const KEEP_BACKUPS = 5;

export class MigrationError extends Error {
  constructor(msg: string, public readonly detail: { restored?: boolean; backupDir?: string; cause?: string } = {}) {
    super(msg);
    this.name = 'MigrationError';
  }
}

export interface LoadedPackage {
  manifest: MigrationManifest;
  entries: Map<string, Buffer>;
}

/** 读取并校验迁移包（格式、版本、每个文件的大小与 sha256） */
export function loadPackage(file: string): LoadedPackage {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new MigrationError('请选择迁移包文件（.kbmigrate.zip）');
  if (st.size > MAX_PACKAGE_BYTES) throw new MigrationError('迁移包超过 1 GB 上限');
  const entries = readZip(fs.readFileSync(file));
  const mf = entries.get(ENTRY_MANIFEST);
  if (!mf) throw new MigrationError('不是迁移包：缺少 manifest.json');
  let manifest: MigrationManifest;
  try {
    manifest = JSON.parse(mf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new MigrationError('manifest.json 不是有效的 JSON');
  }
  if (manifest?.format !== MIGRATION_FORMAT) throw new MigrationError('不是工作台数据迁移包（format 不匹配）');
  if (typeof manifest.formatVersion !== 'number' || manifest.formatVersion > MIGRATION_FORMAT_VERSION)
    throw new MigrationError(`迁移包格式版本 ${manifest.formatVersion} 比本应用支持的 ${MIGRATION_FORMAT_VERSION} 新，请先升级应用`);
  if (manifest.formatVersion < 1) throw new MigrationError(`不支持的迁移包格式版本 ${manifest.formatVersion}`);
  if (typeof manifest.dbSchemaVersion !== 'number' || manifest.dbSchemaVersion > DB_VERSION)
    throw new MigrationError(`迁移包的数据库版本 ${manifest.dbSchemaVersion} 比本应用的 ${DB_VERSION} 新，请先升级应用`);
  if (!Array.isArray(manifest.files) || !Array.isArray(manifest.roots)) throw new MigrationError('manifest.json 缺少 files/roots');
  const listed = new Set<string>();
  for (const f of manifest.files) {
    const b = entries.get(f.path);
    if (!b) throw new MigrationError(`迁移包不完整：缺少 ${f.path}`);
    if (b.length !== f.size || crypto.createHash('sha256').update(b).digest('hex') !== f.sha256) throw new MigrationError(`迁移包已损坏：${f.path} 校验和不符`);
    listed.add(f.path);
  }
  if (!listed.has(ENTRY_DB)) throw new MigrationError('迁移包缺少元数据库');
  for (const name of entries.keys()) {
    if ((name.startsWith('themes/') || name.startsWith('plugins/') || name.startsWith('db/')) && !listed.has(name)) throw new MigrationError(`迁移包含有清单外的文件：${name}`);
  }
  for (const r of manifest.roots) if (typeof r?.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(r.id)) throw new MigrationError('manifest.roots 中有不合法的根 id');
  return { manifest, entries };
}

export interface RootSuggestion {
  rootId: string;
  name: string;
  sourcePath: string;
  /** 建议的新路径（存在的文件夹）；null = 没找到 */
  suggested: string | null;
  reason: 'same-path' | 'under-base' | null;
}

/**
 * 为每个根给出新路径建议：先在用户给的上级文件夹 baseDirs 下找同名文件夹（按原路径最后一段或根名称；
 * 不论原路径是 Windows 还是 POSIX 风格）；找不到时，若原路径在本机仍存在（同一台电脑换数据目录）→ 原路径。
 */
export function suggestMappings(manifest: MigrationManifest, baseDirs: string[] = []): RootSuggestion[] {
  return manifest.roots.map((r) => {
    for (const b of baseDirs) {
      for (const cand of [basenameAnyStyle(r.sourcePath), r.name]) {
        const p = path.join(b, cand);
        if (cand && isDir(p)) return { rootId: r.id, name: r.name, sourcePath: r.sourcePath, suggested: p, reason: 'under-base' as const };
      }
    }
    const same = r.sourcePath && path.isAbsolute(r.sourcePath) && isDir(r.sourcePath) ? r.sourcePath : null;
    if (same) return { rootId: r.id, name: r.name, sourcePath: r.sourcePath, suggested: same, reason: 'same-path' as const };
    return { rootId: r.id, name: r.name, sourcePath: r.sourcePath, suggested: null, reason: null };
  });
}

/** rootId → 新路径；null/缺省 = 暂不映射（根显示“离线”，之后可重新映射） */
export type RootMappings = Record<string, string | null | undefined>;

export function validateMappings(svc: WorkbenchService, manifest: MigrationManifest, mappings: RootMappings): Map<string, string> {
  const ids = new Set(manifest.roots.map((r) => r.id));
  const out = new Map<string, string>();
  const dataReal = fs.realpathSync.native(svc.dataDir);
  const errors: string[] = [];
  for (const [id, p] of Object.entries(mappings ?? {})) {
    if (p === null || p === undefined || p === '') continue;
    const name = manifest.roots.find((r) => r.id === id)?.name ?? id;
    if (!ids.has(id)) {
      errors.push(`未知的根 ${id}`);
      continue;
    }
    if (typeof p !== 'string' || !path.isAbsolute(p)) {
      errors.push(`「${name}」的新路径必须是本机的绝对路径：${p}`);
      continue;
    }
    if (!isDir(p)) {
      errors.push(`「${name}」的新路径不是可访问的文件夹：${p}`);
      continue;
    }
    const real = fs.realpathSync.native(p);
    if (toRelPath(real, dataReal) !== null || toRelPath(dataReal, real) !== null) {
      errors.push(`「${name}」的新路径与应用数据目录重叠：${p}`);
      continue;
    }
    for (const [oid, op] of out) {
      const o = fs.realpathSync.native(op);
      if (toRelPath(o, real) !== null || toRelPath(real, o) !== null)
        errors.push(`「${name}」与「${manifest.roots.find((r) => r.id === oid)?.name}」的新路径重叠`);
    }
    out.set(id, path.resolve(p));
  }
  if (errors.length) throw new MigrationError(errors.join('；'));
  return out;
}

// ---------------- 备份与回退 ----------------

export interface BackupInfo {
  dir: string;
  createdAt: string;
  reason: string;
  dbSchemaVersion: number;
  integrityCheck: string;
}

export function backupsRoot(svc: WorkbenchService) {
  return path.join(svc.dataDir, BACKUP_DIR_NAME);
}

function stamp(d = new Date()) {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`;
}

/** 当前数据的完整备份：元数据库一致快照（含 root_mounts、操作记录等全部表）+ 主题包 + 插件包 */
export function createBackup(svc: WorkbenchService, reason: string): BackupInfo {
  const dir = path.join(backupsRoot(svc), `${stamp()}-${reason.replace(/[^a-z0-9-]/gi, '')}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbf = path.join(dir, 'workbench.db');
  vacuumInto(svc.db, dbf);
  const chk = integrityCheck(dbf);
  if (chk !== 'ok') throw new MigrationError(`备份完整性检查失败：${chk}`);
  for (const [src, name] of [[svc.themesDir, 'themes'], [svc.plugins.dir, 'plugins']] as const)
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, name), { recursive: true });
  const info: BackupInfo = { dir, createdAt: new Date().toISOString(), reason, dbSchemaVersion: userVersion(dbf), integrityCheck: chk };
  fs.writeFileSync(path.join(dir, 'backup.json'), JSON.stringify({ ...info, dir: undefined }, null, 2));
  pruneBackups(svc, dir);
  return info;
}

export function listBackups(svc: WorkbenchService): BackupInfo[] {
  const root = backupsRoot(svc);
  if (!fs.existsSync(root)) return [];
  const out: BackupInfo[] = [];
  for (const d of fs.readdirSync(root).sort().reverse()) {
    const dir = path.join(root, d);
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'backup.json'), 'utf8'));
      if (fs.existsSync(path.join(dir, 'workbench.db'))) out.push({ ...j, dir });
    } catch {
      /* 不完整的备份（例如备份过程中断电）：不列出 */
    }
  }
  return out;
}

function pruneBackups(svc: WorkbenchService, keepDir: string) {
  const all = listBackups(svc);
  for (const b of all.slice(KEEP_BACKUPS)) if (b.dir !== keepDir) fs.rmSync(b.dir, { recursive: true, force: true });
}

/** 把一个文件夹整体替换为另一个（先改名旧的，成功后删除；失败换回） */
function swapDir(target: string, src: string | null) {
  const old = `${target}.old-${process.pid}-${Date.now()}`;
  const had = fs.existsSync(target);
  if (had) fs.renameSync(target, old);
  try {
    fs.mkdirSync(target, { recursive: true });
    if (src && fs.existsSync(src)) fs.cpSync(src, target, { recursive: true });
  } catch (e) {
    fs.rmSync(target, { recursive: true, force: true });
    if (had) fs.renameSync(old, target);
    throw e;
  }
  if (had) fs.rmSync(old, { recursive: true, force: true });
}

/** 从备份恢复（导入失败时自动调用；也可在界面上手动“恢复到导入前”）。 */
export function restoreBackup(svc: WorkbenchService, dir: string) {
  const dbf = path.join(dir, 'workbench.db');
  if (!fs.existsSync(dbf)) throw new MigrationError(`备份不存在：${dir}`);
  if (userVersion(dbf) > DB_VERSION) throw new MigrationError('备份来自更新版本的应用，不能恢复');
  cancelAllScans(svc);
  // 整表回写（所有普通表，含 root_mounts、op_log、index_state…），一个事务
  replaceTablesFrom(svc.db, dbf);
  swapDir(svc.themesDir, path.join(dir, 'themes'));
  swapDir(svc.plugins.dir, path.join(dir, 'plugins'));
  refreshPluginHost(svc);
  svc.emit('roots-changed');
  svc.emit('favorites-changed');
}

function cancelAllScans(svc: WorkbenchService) {
  for (const r of svc.listRoots()) svc.cancelScan(r.id);
}

/** 数据替换后让插件宿主重新载入（PluginHostService.reload：清空令牌与未执行的计划，按新的 plugins 表与插件目录重读） */
export function refreshPluginHost(svc: WorkbenchService) {
  svc.plugins.reload();
}

// ---------------- 导入 ----------------

export interface ImportOptions {
  /** 等待已映射根目录的扫描完成再返回（默认 true），返回值中的缺失数才准确 */
  waitForScan?: boolean;
  /** 测试用：在某一步之后模拟失败，验证回退 */
  failAt?: 'after-db' | 'after-files' | 'after-scan';
  machineId?: string;
}

export interface ImportPackageResult {
  backup: BackupInfo;
  mapped: { rootId: string; name: string; path: string }[];
  unmapped: { rootId: string; name: string }[];
  tables: Record<string, number>;
  currentWorkspaceId: string | null;
  /** 映射后找不到的资源（扫描后）：被收藏/工作区引用的数量与总数 */
  missing: { referenced: number; total: number };
  scanned: boolean;
}

export async function importPackage(svc: WorkbenchService, file: string, mappings: RootMappings, opts: ImportOptions = {}): Promise<ImportPackageResult> {
  const pkg = loadPackage(file);
  const m = pkg.manifest;
  const mapped = validateMappings(svc, m, mappings);
  // 暂存：解出元数据库与文件夹，迁移到当前 schema 并检查完整性（这一步失败不影响当前数据）
  const staging = path.join(svc.dataDir, `migration-staging-${process.pid}-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    const dbf = path.join(staging, 'workbench.db');
    fs.writeFileSync(dbf, pkg.entries.get(ENTRY_DB)!);
    if (integrityCheck(dbf) !== 'ok') throw new MigrationError('迁移包中的数据库完整性检查失败');
    openDb(dbf).close(); // 旧版本包：在暂存副本上执行数据库迁移
    if (userVersion(dbf) !== DB_VERSION) throw new MigrationError('迁移包中的数据库无法升级到当前版本');
    for (const [name, buf] of pkg.entries) {
      if (!name.startsWith('themes/') && !name.startsWith('plugins/')) continue;
      const abs = path.join(staging, ...name.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
    }
    // 自动备份当前数据（失败则不导入）
    const backup = createBackup(svc, 'before-import');
    const now = Date.now();
    const machineId = opts.machineId ?? os.hostname();
    cancelAllScans(svc);
    let tables: Record<string, number> = {};
    try {
      tables = replaceTablesFrom(svc.db, dbf, {
        tables: [...IMPORT_REPLACE_TABLES, 'root_mounts', 'index_state'],
        keepLayoutKey: LOCAL_LAYOUT_KEY,
        inTransaction: (db) => {
          db.exec('DELETE FROM root_mounts; DELETE FROM index_state;');
          const ins = db.prepare('INSERT INTO root_mounts(root_id, local_path, machine_id, updated_at) VALUES (?,?,?,?)');
          for (const [id, p] of mapped) ins.run(id, p, machineId, now);
          // 已映射：交给扫描重新判断；未映射：标记缺失（记录保留，映射后自动恢复）
          const setNull = db.prepare('UPDATE resources SET missing_since=NULL, file_key=NULL WHERE root_id=?');
          const setMiss = db.prepare('UPDATE resources SET missing_since=COALESCE(missing_since, ?), file_key=NULL WHERE root_id=?');
          for (const r of db.prepare('SELECT id FROM roots').all() as { id: string }[]) {
            if (mapped.has(r.id)) setNull.run(r.id);
            else setMiss.run(now, r.id);
          }
        },
      });
      if (opts.failAt === 'after-db') throw new Error('模拟失败：写入元数据之后');
      swapDir(svc.themesDir, path.join(staging, 'themes'));
      swapDir(svc.plugins.dir, path.join(staging, 'plugins'));
      if (opts.failAt === 'after-files') throw new Error('模拟失败：替换主题包/插件包之后');
      refreshPluginHost(svc);
      svc.emit('roots-changed');
      svc.emit('favorites-changed');
      let scanned = false;
      if (opts.waitForScan !== false) {
        await Promise.all([...mapped.keys()].map((id) => svc.scanRoot(id)));
        scanned = true;
      } else for (const id of mapped.keys()) void svc.scanRoot(id);
      if (opts.failAt === 'after-scan') throw new Error('模拟失败：扫描之后');
      // 被引用 = 收藏、工作区条目（标签），或工作资料（集合，layout 键 workspace.refs:*，第 9 轮合并）
      const refd = referencedResourceIds(svc.db);
      const missRows = svc.db
        .prepare(
          `SELECT r.id, CASE WHEN EXISTS (SELECT 1 FROM favorites f WHERE f.resource_id=r.id)
              OR EXISTS (SELECT 1 FROM workspace_items w WHERE w.source_kind='file' AND w.ref=r.id) THEN 1 ELSE 0 END AS ref
           FROM resources r WHERE r.missing_since IS NOT NULL`,
        )
        .all() as { id: string; ref: number }[];
      const miss = { total: missRows.length, referenced: missRows.filter((x) => x.ref === 1 || refd.has(x.id)).length };
      const cur = svc.getLayout('workspace.current');
      return {
        backup,
        mapped: [...mapped].map(([rootId, p]) => ({ rootId, name: m.roots.find((r) => r.id === rootId)?.name ?? rootId, path: p })),
        unmapped: m.roots.filter((r) => !mapped.has(r.id)).map((r) => ({ rootId: r.id, name: r.name })),
        tables,
        currentWorkspaceId: typeof cur === 'string' ? cur : null,
        missing: { referenced: miss.referenced ?? 0, total: miss.total },
        scanned,
      };
    } catch (e) {
      let restored = false;
      let cause = String((e as Error).message ?? e);
      try {
        restoreBackup(svc, backup.dir);
        restored = true;
      } catch (re) {
        cause += `；自动恢复也失败：${(re as Error).message}（备份在 ${backup.dir}）`;
      }
      throw new MigrationError(restored ? `导入失败，已恢复到导入前的数据：${cause}` : `导入失败：${cause}`, { restored, backupDir: backup.dir, cause });
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function isDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
