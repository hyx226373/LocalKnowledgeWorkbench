/**
 * 外部程序启动前的备份区（产品决定 D6 收紧版，SDK 规范 §6.4 / H12）。
 *
 * 只备份：资源槽位指向的目标文件 + 适配器在 programs[].backup.include 中声明的、同一已注册根内的附加文件
 * （由 SDK planAppBackup 计算）；**从不复制整个已注册根**。
 *  - 上限：每次启动 ≤ maxFilesPerLaunch 个文件、≤ maxBytesPerLaunch 字节；目标文件本身超限时不备份，由调用方决定是否
 *    在用户确认后“不备份也启动”；
 *  - 保留：retentionDays 天；总量 > maxStoreBytes 时从最旧的启动记录开始删除（prune）；
 *  - 存储：<数据目录>/app-backups/<launchId>/{record.json, f0, f1, …}，record.json 只含根 id + 相对路径 + 哈希，不含绝对路径；
 *  - 程序退出后 compare() 比较哈希；restore() 用临时文件 + rename 写回，写回前把当前内容另存一条记录（恢复本身也可撤销）。
 * 不依赖 Electron，可在单测中直接使用。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_APP_BACKUP_LIMITS, planAppBackup, type AppBackupLimits, type BackupCandidate } from '../../shared/adapter-sdk/policy';
import type { AppBackupDecl, LaunchBackupSummary } from '../../shared/adapter-sdk/types';
import { resolveInRoot } from '../service/paths';

/** 附加文件枚举的硬上限（只在声明了 include 时才枚举目标文件夹的子树） */
const MAX_SCAN_ENTRIES = 5000;
const MAX_SCAN_DEPTH = 8;

export interface BackupFileRecord {
  rootId: string;
  relPath: string;
  size: number;
  sha256: string;
  why: 'target' | 'declared' | 'pre-restore';
  /** 备份文件名（记录目录内） */
  blob: string;
}

export interface LaunchBackupRecord {
  launchId: string;
  pluginId: string;
  adapterId: string;
  programId: string;
  /** 启动它的工作区条目（工作台关闭期间退出的，下次启动比较后把提示显示在该条目的面板上） */
  itemId?: string;
  at: number;
  files: BackupFileRecord[];
  skipped: Array<{ rootId: string; relPath: string; size: number; why: string }>;
  /** 目标文件超过上限、用户确认后未备份就启动 */
  targetUnprotected: boolean;
  bytes: number;
  /** 'launch' = 启动前备份；'pre-restore' = 恢复前对当前内容的备份 */
  kind: 'launch' | 'pre-restore';
}

export interface BackupTarget {
  rootId: string;
  /** 已注册根的绝对路径（仅主进程内部使用，不写入记录） */
  rootPath: string;
  /** 目标文件相对于根的路径（/ 分隔） */
  relPath: string;
}

export type BackupOutcome =
  | { ok: true; record: LaunchBackupRecord; summary: LaunchBackupSummary }
  | { ok: false; reason: 'backup-over-limit'; detail: string; size: number }
  | { ok: false; reason: 'backup-failed'; detail: string };

export type FileChange = { rootId: string; relPath: string; change: 'unchanged' | 'modified' | 'missing' };

/** 会话信息（spawn 之后写入）：工作台重启后据此判断外部程序是否仍在运行 */
export interface LaunchSession {
  pid: number;
  startedAt: number;
}

/**
 * 比较基准：默认是启动前备份；工作台重启时程序仍在运行、已把关闭期间的修改补记进操作记录后，
 * 基准换成当时的内容（checkpoint.json + c0…），之后程序退出时只记基准之后的修改，不重复。
 */
export interface BaselineFile {
  rootId: string;
  relPath: string;
  /** null = 基准时文件不存在 */
  sha256: string | null;
  blob: string | null;
}

export class AppBackupStore {
  readonly dir: string;
  constructor(
    dataDir: string,
    readonly limits: AppBackupLimits = DEFAULT_APP_BACKUP_LIMITS,
    private now: () => number = Date.now,
  ) {
    this.dir = path.join(dataDir, 'app-backups');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * 启动前备份。targets = 每个资源槽位一个目标文件。
   * allowUnprotected：目标文件超过上限时是否“不备份也启动”（必须来自用户确认）。
   */
  backup(meta: { launchId: string; pluginId: string; adapterId: string; programId: string; itemId?: string }, targets: BackupTarget[], decl: AppBackupDecl | undefined, allowUnprotected = false): BackupOutcome {
    if (!/^[\w-]{1,80}$/.test(meta.launchId)) return { ok: false, reason: 'backup-failed', detail: 'launchId 不合法' };
    const planned: Array<{ t: BackupTarget; rel: string; size: number; why: 'target' | 'declared' }> = [];
    const skipped: LaunchBackupRecord['skipped'] = [];
    let unprotected = false;
    let filesLeft = this.limits.maxFilesPerLaunch;
    let bytesLeft = this.limits.maxBytesPerLaunch;
    try {
      for (const t of targets) {
        const abs = resolveInRoot(t.rootPath, t.relPath);
        const st = fs.statSync(abs);
        if (!st.isFile()) return { ok: false, reason: 'backup-failed', detail: '目标不是普通文件' };
        const cands = decl?.include?.length ? this.scan(t) : [];
        const plan = planAppBackup({ relPath: t.relPath, size: st.size }, decl, cands, { maxFilesPerLaunch: filesLeft, maxBytesPerLaunch: bytesLeft });
        if (plan.targetOverLimit) {
          if (!allowUnprotected) return { ok: false, reason: 'backup-over-limit', detail: `文件 ${t.relPath} 为 ${Math.round(st.size / 1024 / 1024)} MB，超过单次备份上限 ${Math.round(this.limits.maxBytesPerLaunch / 1024 / 1024)} MB`, size: st.size };
          unprotected = true;
        }
        for (const f of plan.files) planned.push({ t, rel: f.relPath, size: f.size, why: f.why });
        for (const f of plan.skipped) skipped.push({ rootId: t.rootId, relPath: f.relPath, size: f.size, why: f.why });
        filesLeft -= plan.files.length;
        bytesLeft -= plan.totalBytes;
      }
      const rec = this.write({ ...meta, kind: 'launch' }, planned, skipped, unprotected);
      this.prune();
      return { ok: true, record: rec, summary: { files: rec.files.length, bytes: rec.bytes, skipped: skipped.length, ...(unprotected ? { targetUnprotected: true } : {}) } };
    } catch (e) {
      return { ok: false, reason: 'backup-failed', detail: String((e as Error).message ?? e).replace(/[A-Za-z]:\\[^\s]*|\/[^\s]*/g, '…').slice(0, 200) };
    }
  }

  /** 列出目标文件夹子树中的普通文件（不跟随符号链接；深度/数量有上限），路径相对于根 */
  private scan(t: BackupTarget): BackupCandidate[] {
    const out: BackupCandidate[] = [];
    const slash = t.relPath.lastIndexOf('/');
    const dirRel = slash >= 0 ? t.relPath.slice(0, slash) : '';
    const rootReal = fs.realpathSync(t.rootPath);
    let seen = 0;
    const walk = (rel: string, depth: number) => {
      if (depth > MAX_SCAN_DEPTH || seen > MAX_SCAN_ENTRIES) return;
      const abs = rel ? resolveInRoot(t.rootPath, rel) : rootReal;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (++seen > MAX_SCAN_ENTRIES) return;
        if (e.isSymbolicLink()) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(r, depth + 1);
        else if (e.isFile()) out.push({ relPath: r, size: fs.statSync(path.join(abs, e.name)).size });
      }
    };
    walk(dirRel, 0);
    return out;
  }

  private write(meta: { launchId: string; pluginId: string; adapterId: string; programId: string; kind: LaunchBackupRecord['kind'] }, files: Array<{ t: BackupTarget; rel: string; size: number; why: BackupFileRecord['why'] }>, skipped: LaunchBackupRecord['skipped'], unprotected: boolean): LaunchBackupRecord {
    const final = path.join(this.dir, meta.launchId);
    if (fs.existsSync(final)) throw new Error('备份记录已存在');
    const tmp = `${final}.tmp-${process.pid}`;
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const recFiles: BackupFileRecord[] = [];
      files.forEach((f, i) => {
        const abs = resolveInRoot(f.t.rootPath, f.rel);
        const blob = `f${i}`;
        fs.copyFileSync(abs, path.join(tmp, blob));
        const buf = fs.readFileSync(path.join(tmp, blob));
        recFiles.push({ rootId: f.t.rootId, relPath: f.rel, size: buf.length, sha256: sha256(buf), why: f.why, blob });
      });
      const rec: LaunchBackupRecord = { ...meta, at: this.now(), files: recFiles, skipped, targetUnprotected: unprotected, bytes: recFiles.reduce((n, f) => n + f.size, 0) };
      fs.writeFileSync(path.join(tmp, 'record.json'), JSON.stringify(rec, null, 1));
      fs.renameSync(tmp, final);
      return rec;
    } catch (e) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw e;
    }
  }

  get(launchId: string): LaunchBackupRecord | null {
    if (!/^[\w-]{1,80}$/.test(launchId)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, launchId, 'record.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** 已把改动记入操作记录（或确认无改动）：写 reconciled.json，之后启动时不再重复比较 */
  markReconciled(launchId: string, info: { opIds: number[]; at?: number }): void {
    if (!/^[\w-]{1,80}$/.test(launchId) || !fs.existsSync(path.join(this.dir, launchId))) return;
    fs.writeFileSync(path.join(this.dir, launchId, 'reconciled.json'), JSON.stringify({ opIds: info.opIds, at: info.at ?? this.now() }));
  }
  isReconciled(launchId: string): boolean {
    return /^[\w-]{1,80}$/.test(launchId) && fs.existsSync(path.join(this.dir, launchId, 'reconciled.json'));
  }
  /** 启动前备份中还没有比较过的（工作台在外部程序退出前就关闭了） */
  setSession(launchId: string, s: LaunchSession): void {
    if (!/^[\w-]{1,80}$/.test(launchId) || !fs.existsSync(path.join(this.dir, launchId))) return;
    fs.writeFileSync(path.join(this.dir, launchId, 'session.json'), JSON.stringify({ pid: s.pid, startedAt: s.startedAt }));
  }
  session(launchId: string): LaunchSession | null {
    if (!/^[\w-]{1,80}$/.test(launchId)) return null;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dir, launchId, 'session.json'), 'utf8'));
      return typeof v?.pid === 'number' && v.pid > 0 ? { pid: v.pid, startedAt: Number(v.startedAt) || 0 } : null;
    } catch {
      return null;
    }
  }

  /** 当前比较基准（有 checkpoint 用 checkpoint，否则用启动前备份） */
  baseline(launchId: string): BaselineFile[] {
    const rec = this.get(launchId);
    if (!rec) return [];
    try {
      const cp = JSON.parse(fs.readFileSync(path.join(this.dir, launchId, 'checkpoint.json'), 'utf8')) as { files: BaselineFile[] };
      if (Array.isArray(cp?.files)) return cp.files;
    } catch {
      /* 没有 checkpoint */
    }
    return rec.files.map((f) => ({ rootId: f.rootId, relPath: f.relPath, sha256: f.sha256, blob: f.blob }));
  }

  /** 把备份范围内文件的当前内容记为新的比较基准（c0…，先写临时文件再改名） */
  checkpoint(launchId: string, rootPathOf: (rootId: string) => string | null): void {
    const rec = this.get(launchId);
    if (!rec) return;
    const dir = path.join(this.dir, launchId);
    const files: BaselineFile[] = rec.files.map((f, i) => {
      const rp = rootPathOf(f.rootId);
      const abs = rp ? resolveInRoot(rp, f.relPath) : null;
      if (!abs || !fs.existsSync(abs)) return { rootId: f.rootId, relPath: f.relPath, sha256: null, blob: null };
      const blob = `c${i}`;
      fs.copyFileSync(abs, path.join(dir, `${blob}.tmp`));
      fs.renameSync(path.join(dir, `${blob}.tmp`), path.join(dir, blob));
      return { rootId: f.rootId, relPath: f.relPath, sha256: sha256(fs.readFileSync(path.join(dir, blob))), blob };
    });
    fs.writeFileSync(path.join(dir, 'checkpoint.json.tmp'), JSON.stringify({ at: this.now(), files }));
    fs.renameSync(path.join(dir, 'checkpoint.json.tmp'), path.join(dir, 'checkpoint.json'));
  }

  unreconciled(): LaunchBackupRecord[] {
    return this.list().filter((r) => r.kind === 'launch' && r.files.length > 0 && !this.isReconciled(r.launchId));
  }
  /** 备份文件的绝对路径（记入操作记录时复制到内容备份库） */
  blobPath(launchId: string, blob: string): string | null {
    if (!/^[\w-]{1,80}$/.test(launchId) || !/^[fc]\d{1,4}$/.test(blob)) return null;
    const p = path.join(this.dir, launchId, blob);
    return fs.existsSync(p) ? p : null;
  }

  /** 新的在前 */
  list(): LaunchBackupRecord[] {
    const out: LaunchBackupRecord[] = [];
    for (const name of fs.readdirSync(this.dir)) {
      if (name.includes('.tmp-')) continue;
      const r = this.get(name);
      if (r) out.push(r);
    }
    return out.sort((a, b) => b.at - a.at || (a.launchId < b.launchId ? 1 : -1));
  }

  totalBytes(): number {
    return this.list().reduce((n, r) => n + r.bytes, 0);
  }

  /** 程序退出后：备份范围内每个文件是否被改动 */
  compare(launchId: string, rootPathOf: (rootId: string) => string | null): FileChange[] {
    return this.baseline(launchId).map((f) => {
      const rp = rootPathOf(f.rootId);
      try {
        if (!rp) return { rootId: f.rootId, relPath: f.relPath, change: 'missing' as const };
        const abs = resolveInRoot(rp, f.relPath);
        if (!fs.existsSync(abs)) return { rootId: f.rootId, relPath: f.relPath, change: f.sha256 === null ? ('unchanged' as const) : ('missing' as const) };
        return { rootId: f.rootId, relPath: f.relPath, change: sha256(fs.readFileSync(abs)) === f.sha256 ? ('unchanged' as const) : ('modified' as const) };
      } catch {
        return { rootId: f.rootId, relPath: f.relPath, change: 'missing' as const };
      }
    });
  }

  /**
   * 把备份内容写回（relPath 缺省 = 该记录的全部文件）。写回前把当前内容另存为一条 pre-restore 记录，返回它的 launchId。
   * 只写回记录里列出的文件；根被移除时跳过。
   */
  restore(launchId: string, rootPathOf: (rootId: string) => string | null, relPath?: string): { restored: string[]; undoId: string | null } {
    const rec = this.get(launchId);
    if (!rec) throw new Error('备份记录不存在或已过期');
    const files = rec.files.filter((f) => !relPath || f.relPath === relPath);
    const current: Array<{ t: BackupTarget; rel: string; size: number; why: 'pre-restore' }> = [];
    for (const f of files) {
      const rp = rootPathOf(f.rootId);
      if (!rp) continue;
      const abs = resolveInRoot(rp, f.relPath);
      if (fs.existsSync(abs)) current.push({ t: { rootId: f.rootId, rootPath: rp, relPath: f.relPath }, rel: f.relPath, size: fs.statSync(abs).size, why: 'pre-restore' });
    }
    const undoId = current.length ? this.write({ launchId: `restore-${this.now()}-${crypto.randomBytes(3).toString('hex')}`, pluginId: rec.pluginId, adapterId: rec.adapterId, programId: rec.programId, kind: 'pre-restore' }, current, [], false).launchId : null;
    const restored: string[] = [];
    for (const f of files) {
      const rp = rootPathOf(f.rootId);
      if (!rp) continue;
      const abs = resolveInRoot(rp, f.relPath);
      const tmp = `${abs}.kbrestore-${process.pid}`;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(path.join(this.dir, launchId, f.blob), tmp);
      fs.renameSync(tmp, abs);
      restored.push(f.relPath);
    }
    return { restored, undoId };
  }

  /** 删除超过保留期的记录；总量仍超上限时从最旧开始删除。返回删除的 launchId */
  prune(): string[] {
    const removed: string[] = [];
    const cutoff = this.now() - this.limits.retentionDays * 24 * 3600 * 1000;
    const all = this.list();
    let total = all.reduce((n, r) => n + r.bytes, 0);
    for (const r of [...all].reverse()) {
      if (r.at < cutoff || total > this.limits.maxStoreBytes) {
        fs.rmSync(path.join(this.dir, r.launchId), { recursive: true, force: true });
        total -= r.bytes;
        removed.push(r.launchId);
      }
    }
    for (const name of fs.readdirSync(this.dir)) if (name.includes('.tmp-')) fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
    return removed;
  }
}

function sha256(b: Buffer): string {
  return crypto.createHash('sha256').update(b).digest('hex');
}
