import { createHash } from 'node:crypto';
import { createReadStream, promises as fs, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { planBackupFiles } from './collect';
import { powershellExe, writeHelperScript } from './helperScript';
import { prepareDirpack, removePartial } from './prepareDirpack';
import {
  candidateRel,
  currentFile,
  DIRPACK_FILE,
  dirZipName,
  handoffFile,
  isUnderStudyDev,
  LayoutError,
  parseCurrent,
  parseDirpack,
  parseHandoff,
  parseUpdaterState,
  readCurrent,
  READY_MARKER_FILE,
  READY_SCHEMA,
  RESTART_TO_UPDATE_BODY,
  RESTART_TO_UPDATE_TITLE,
  stateFile,
  updaterExe,
  writeAtomicJson,
  type DirPackManifest,
} from '../../shared/layout';
import { downloadVerified, hashFileSha512, PackageRejectedError, readGzipMagic } from '../../shared/update/download';
import { dirpackSource, loadDirpack } from '../../shared/update/dirpack';
import { artifactSource, resolveFeed, type FeedTarget } from '../../shared/update/feed';
import { parseLatestYml, safeArtifactName } from '../../shared/update/latestYml';
import { rotateBackups } from '../../shared/update/rotate';
import { decideAfterSelfCheck, judgeSelfCheck, type SelfCheckInput } from '../../shared/update/selfCheck';
import type { BackupRecord, ByteProgress, PendingUpdate, UpdateJournal, UpdateSettings, UpdateSnapshot } from '../../shared/update/types';
import { isNewer } from '../../shared/update/version';

export interface UpdateHooks {
  currentVersion: string;
  userDataDir: string;
  roamingDir: string;
  /** 打包后的安装目录。开发运行且没有测试目录时为 null，避免把 Electron 目录整份拷走。 */
  installDir: string | null;
  defaultFeed: string;
  backupSqlite: (src: string, dest: string) => Promise<void>;
  prepareShutdown: () => Promise<'closed' | 'timeout'>;
  closeDatabase: () => Promise<void>;
  spawnDetached: (file: string, args: string[], env: NodeJS.ProcessEnv) => void | Promise<void>;
  requestExit: () => void;
  showReason: (title: string, body: string) => Promise<void>;
  confirmQuit?: (title: string, body: string) => Promise<boolean>;
  selfCheckOverride?: () => Partial<SelfCheckInput> | null;
  damageBeforeRollback?: () => Promise<void>;
  applyMode: 'nsis' | 'copy' | 'dirpack';
  /** 测试注入。缺省用 PowerShell Expand-Archive。 */
  extractDirpack?: (zip: string, dest: string, signal?: AbortSignal) => Promise<void>;
  noRelaunch: boolean;
  helperDone: string;
  relaunchPath: string | null;
}

export const QUIT_BEFORE_UPGRADE_TITLE = '请先退出工作台';
export const QUIT_BEFORE_UPGRADE_BODY =
  '请先退出工作台（窗口+托盘），然后继续。确认后将关闭窗口和托盘，并打开安装程序。';

const EMPTY_JOURNAL: UpdateJournal = { backups: [] };

/** 源上没有 latest.yml，或内容是空的，或 HTTP 404。其它错误仍算检查失败。 */
function isAbsentLatest(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return true;
  return /HTTP 404\b/.test(String((err as Error | undefined)?.message ?? err));
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

export class UpdateService {
  private settings: UpdateSettings;
  private journal: UpdateJournal = { backups: [] };
  private phase: UpdateSnapshot['phase'] = 'idle';
  private progress: ByteProgress | null = null;
  private error: string | null = null;
  private info: string | null = null;
  private listeners = new Set<() => void>();
  private inflight: Promise<UpdateSnapshot> | null = null;
  private leaving = false;
  private windowLoaded = false;
  private windowTimer: NodeJS.Timeout | null = null;
  private startup: SelfCheckInput = { dbOpened: false, migrationOk: false, windowLoaded: false };
  private startupArmed = false;
  private hist: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private lastP99: number | null = null;
  private verifiedPath: string | null = null;
  private downloadAbort: AbortController | null = null;
  private dirpackHandoff: string | null = null;

  constructor(private readonly hooks: UpdateHooks) {
    this.settings = { feed: hooks.defaultFeed, autoCheck: true, rateLimitBytesPerSec: null };
  }

  private get settingsFile() {
    return path.join(this.hooks.userDataDir, 'update-settings.json');
  }
  private get journalFile() {
    return path.join(this.hooks.userDataDir, 'update-journal.json');
  }
  private get downloadDir() {
    return path.join(this.hooks.userDataDir, 'update-downloads');
  }
  private get backupRoot() {
    return path.join(this.hooks.userDataDir, 'update-backups');
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  eventLoopP99(): number | null {
    return this.lastP99;
  }

  snapshot(): UpdateSnapshot {
    const available = this.journal.available;
    const newer = available && isNewer(available.version, this.hooks.currentVersion) ? available : null;
    return {
      currentVersion: this.hooks.currentVersion,
      feed: this.settings.feed,
      autoCheck: this.settings.autoCheck,
      rateLimitBytesPerSec: this.settings.rateLimitBytesPerSec,
      lastCheckAt: this.journal.lastCheckAt ?? null,
      phase: this.phase,
      available: newer
        ? {
            version: newer.version,
            notes: newer.notes,
            fileName: newer.fileName,
            sha512: newer.sha512,
            size: newer.size,
            blockMapSize: newer.blockMapSize,
            unsigned: true,
          }
        : null,
      progress: this.phase === 'downloading' ? this.progress : null,
      error: this.error,
      info: this.info,
      backups: [...this.journal.backups]
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .map((item) => ({ id: item.id, createdAt: item.createdAt, version: item.version })),
      unsignedNotice: '未签名',
      installOnQuit: this.journal.installOnQuit === true && !!newer?.verified,
      downloaded: this.phase === 'ready' && !!newer?.verified && !!this.verifiedPath,
      layout: this.hooks.applyMode === 'dirpack' ? 'dirpack' : 'nsis',
      previousVersion: this.previousFromPointer(),
    };
  }

  private push() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error('[update] listener', err);
      }
    }
  }

  private async persist(): Promise<void> {
    await writeJson(this.journalFile, this.journal);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.hooks.userDataDir, { recursive: true });
    const saved = await readJson<Partial<UpdateSettings>>(this.settingsFile, {});
    this.settings = {
      feed: typeof saved.feed === 'string' && saved.feed.trim() ? saved.feed : this.hooks.defaultFeed,
      autoCheck: saved.autoCheck !== false,
      rateLimitBytesPerSec: typeof saved.rateLimitBytesPerSec === 'number' && saved.rateLimitBytesPerSec > 0 ? saved.rateLimitBytesPerSec : null,
    };
    if (process.env.KB_UPDATE_FEED) this.settings.feed = process.env.KB_UPDATE_FEED;
    if (process.env.KB_UPDATE_AUTO_CHECK === '0') this.settings.autoCheck = false;
    if (process.env.KB_UPDATE_RATE_LIMIT) {
      const n = Number(process.env.KB_UPDATE_RATE_LIMIT);
      if (Number.isFinite(n) && n > 0) this.settings.rateLimitBytesPerSec = Math.floor(n);
    }
    const journal = await readJson<UpdateJournal>(this.journalFile, EMPTY_JOURNAL);
    this.journal = { ...journal, backups: Array.isArray(journal.backups) ? journal.backups : [] };
    await this.restoreReady();
    this.push();
  }

  private async restoreReady(): Promise<void> {
    const available = this.journal.available;
    this.verifiedPath = null;
    if (!available?.downloadedPath || !available.verified) return;
    if (!isNewer(available.version, this.hooks.currentVersion)) {
      available.verified = false;
      this.journal.installOnQuit = false;
      return;
    }
    try {
      const digest = await hashFileSha512(available.downloadedPath);
      if (digest !== available.sha512) {
        available.verified = false;
        await fs.rm(available.downloadedPath, { force: true }).catch(() => undefined);
        return;
      }
      this.verifiedPath = available.downloadedPath;
      this.phase = 'ready';
      this.info = `已下载 ${available.version}，未签名`;
    } catch {
      available.verified = false;
    }
  }

  async saveSettings(patch: Partial<UpdateSettings>): Promise<UpdateSnapshot> {
    if (typeof patch.feed === 'string') {
      resolveFeed(patch.feed);
      this.settings.feed = patch.feed.trim();
    }
    if (typeof patch.autoCheck === 'boolean') this.settings.autoCheck = patch.autoCheck;
    if (patch.rateLimitBytesPerSec === null) this.settings.rateLimitBytesPerSec = null;
    if (typeof patch.rateLimitBytesPerSec === 'number') {
      if (!Number.isFinite(patch.rateLimitBytesPerSec) || patch.rateLimitBytesPerSec <= 0) throw new Error('限速必须是正整数，单位是字节/秒');
      this.settings.rateLimitBytesPerSec = Math.floor(patch.rateLimitBytesPerSec);
    }
    await writeJson(this.settingsFile, this.settings);
    this.push();
    return this.snapshot();
  }

  check(): Promise<UpdateSnapshot> {
    if (this.inflight) return this.inflight;
    this.inflight = this.checkInner().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  cancelDownload(): void {
    this.downloadAbort?.abort();
  }

  private async checkInner(): Promise<UpdateSnapshot> {
    if (this.leaving) return this.snapshot();
    this.phase = 'checking';
    this.error = null;
    this.info = null;
    this.progress = null;
    this.journal.lastCheckAt = new Date().toISOString();
    await this.persist().catch(() => undefined);
    this.push();
    try {
      const feed = resolveFeed(this.settings.feed);
      if (this.hooks.applyMode === 'dirpack') return await this.checkDirpack(feed);
      const text = await this.readLatest(feed);
      if (!text.trim()) return await this.markCurrent();
      const latest = parseLatestYml(text);
      const fileName = safeArtifactName(latest.path || latest.files[0]?.url || '');
      const file = latest.files.find((item) => safeArtifactName(item.url) === fileName) ?? latest.files[0];
      if (!file) throw new Error('latest.yml 没有安装包');
      const size = file.size;
      const sha512 = file.sha512 || latest.sha512;
      if (!Number.isInteger(size) || size <= 0 || !sha512) throw new Error('latest.yml 缺少大小或 SHA512');
      this.journal.lastCheckAt = new Date().toISOString();
      if (!isNewer(latest.version, this.hooks.currentVersion)) {
        this.phase = 'idle';
        this.journal.available = undefined;
        this.journal.installOnQuit = false;
        this.verifiedPath = null;
        this.info = '已是最新';
        await this.persist();
        this.push();
        return this.snapshot();
      }
      const notes = latest.releaseNotes?.trim() || '';
      const dest = path.join(this.downloadDir, fileName);
      this.journal.available = {
        version: latest.version,
        notes,
        fileName,
        sha512,
        size,
        blockMapSize: file.blockMapSize ?? null,
        downloadedPath: dest,
        verified: false,
      };
      await this.persist();
      this.phase = 'downloading';
      this.progress = { transferred: 0, total: size };
      this.push();
      this.beginLoop();
      try {
        await downloadVerified({
          source: artifactSource(feed, file.url || fileName),
          dest,
          expectedSha512: sha512,
          expectedSize: size,
          rateLimitBytesPerSec: this.settings.rateLimitBytesPerSec,
          onProgress: (progress) => {
            this.progress = progress;
            this.phase = 'downloading';
            this.push();
          },
        });
        if (file.blockMapSize && file.blockMapSize > 0) {
          const blockName = `${fileName}.blockmap`;
          const blockDest = path.join(this.downloadDir, blockName);
          await this.copyBlockmap(feed, blockName, blockDest, file.blockMapSize);
        }
        this.phase = 'verifying';
        this.progress = null;
        this.push();
        const digest = await hashFileSha512(dest);
        if (digest !== sha512) {
          await fs.rm(dest, { force: true }).catch(() => undefined);
          throw new PackageRejectedError('SHA512 不一致，安装包已丢弃');
        }
      } finally {
        this.endLoop();
      }
      this.journal.available.verified = true;
      this.verifiedPath = dest;
      this.phase = 'ready';
      this.info = `已下载 ${latest.version}，未签名`;
      await this.persist();
      this.push();
      return this.snapshot();
    } catch (err) {
      if (isAbsentLatest(err)) return await this.markCurrent();
      await this.cleanupDirpackPartial(err);
      this.phase = 'failed';
      this.progress = null;
      this.verifiedPath = null;
      if (this.journal.available) {
        this.journal.available.verified = false;
        if (this.journal.available.downloadedPath) {
          await fs.rm(this.journal.available.downloadedPath, { force: true }).catch(() => undefined);
          await fs.rm(`${this.journal.available.downloadedPath}.blockmap`, { force: true }).catch(() => undefined);
        }
      }
      this.error = err instanceof PackageRejectedError ? err.message : String((err as Error).message ?? err);
      await this.persist().catch(() => undefined);
      this.push();
      return this.snapshot();
    }
  }

  private beginLoop() {
    this.hist?.disable();
    this.hist = monitorEventLoopDelay({ resolution: 20 });
    this.hist.enable();
  }

  private endLoop() {
    if (!this.hist) return;
    const p99 = this.hist.percentile(99);
    this.lastP99 = Number.isFinite(p99) ? p99 / 1e6 : null;
    this.hist.disable();
    this.hist = null;
  }

  /** 没有安装包可下：记下检查时间，界面显示已是最新。 */
  private async markCurrent(): Promise<UpdateSnapshot> {
    this.phase = 'idle';
    this.journal.available = undefined;
    this.journal.installOnQuit = false;
    this.verifiedPath = null;
    this.info = '已是最新';
    this.error = null;
    this.progress = null;
    await this.persist();
    this.push();
    return this.snapshot();
  }

  private async readLatest(feed: FeedTarget): Promise<string> {
    if (feed.kind === 'dir') return fs.readFile(feed.latestFile, 'utf8');
    const res = await fetch(feed.latestUrl);
    if (!res.ok) throw new Error(`读取 latest.yml 失败 HTTP ${res.status}`);
    return res.text();
  }

  private async copyBlockmap(feed: FeedTarget, name: string, dest: string, expectedSize: number): Promise<void> {
    const source = artifactSource(feed, name);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new PackageRejectedError(`blockmap 下载失败 HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length !== expectedSize) throw new PackageRejectedError(`blockmap 大小不一致：收到 ${buf.length}，声明 ${expectedSize}`);
      await fs.writeFile(dest, buf);
    } else {
      await fs.copyFile(source, dest);
      const st = await fs.stat(dest);
      if (st.size !== expectedSize) throw new PackageRejectedError(`blockmap 大小不一致：收到 ${st.size}，声明 ${expectedSize}`);
    }
    if (!(await readGzipMagic(dest))) {
      await fs.rm(dest, { force: true }).catch(() => undefined);
      throw new PackageRejectedError('blockmap 不是 gzip，安装包已丢弃');
    }
  }

  async installOnQuit(): Promise<UpdateSnapshot> {
    if (!this.snapshot().downloaded || !this.verifiedPath) throw new Error('还没有校验通过的安装包');
    this.journal.installOnQuit = true;
    await this.persist();
    this.info = '将在下次退出时升级';
    this.push();
    return this.snapshot();
  }

  /** 托盘「立即升级」和设置页走同一条。不经过渲染进程。 */
  async installNow(): Promise<void> {
    if (this.leaving) return;
    if (!this.snapshot().downloaded || !this.verifiedPath || !this.journal.available) throw new Error('还没有校验通过的安装包');
    const digest = await hashFileSha512(this.verifiedPath);
    if (digest !== this.journal.available.sha512) {
      await fs.rm(this.verifiedPath, { force: true }).catch(() => undefined);
      this.verifiedPath = null;
      this.journal.available.verified = false;
      this.phase = 'failed';
      this.error = 'SHA512 不一致，安装包已丢弃';
      await this.persist();
      this.push();
      throw new PackageRejectedError(this.error);
    }
    const dirpack = this.hooks.applyMode === 'dirpack';
    const title = dirpack ? RESTART_TO_UPDATE_TITLE : QUIT_BEFORE_UPGRADE_TITLE;
    const body = dirpack ? RESTART_TO_UPDATE_BODY : QUIT_BEFORE_UPGRADE_BODY;
    console.log('[update] confirm-quit: ' + body);
    if (this.hooks.confirmQuit) {
      const accepted = await this.hooks.confirmQuit(title, body);
      if (!accepted) {
        console.log('[update] confirm-quit: cancelled');
        return;
      }
    } else {
      await this.hooks.showReason(title, body);
    }
    this.phase = 'installing';
    this.journal.installOnQuit = false;
    this.error = null;
    this.push();
    const backup = await this.backupOrStay(this.hooks.currentVersion);
    if (dirpack) {
      await this.commitDirpackAndExit(backup.id);
      return;
    }
    this.leaving = true;
    const pending: PendingUpdate = {
      fromVersion: this.hooks.currentVersion,
      toVersion: this.journal.available.version,
      backupId: backup.id,
      at: new Date().toISOString(),
    };
    this.journal.pending = pending;
    await this.persist();
    await this.hooks.prepareShutdown();
    await this.hooks.closeDatabase();
    await this.spawnApply(this.verifiedPath, this.journal.available.version);
    this.hooks.requestExit();
  }

  async prepareQuitInstall(): Promise<boolean> {
    if (this.leaving || !this.journal.installOnQuit || !this.verifiedPath || !this.journal.available?.verified) return false;
    if (!isNewer(this.journal.available.version, this.hooks.currentVersion)) return false;
    const digest = await hashFileSha512(this.verifiedPath);
    if (digest !== this.journal.available.sha512) {
      this.error = 'SHA512 不一致，安装包已丢弃';
      this.journal.available.verified = false;
      this.journal.installOnQuit = false;
      await fs.rm(this.verifiedPath, { force: true }).catch(() => undefined);
      await this.persist();
      return false;
    }
    let backup: BackupRecord;
    try {
      backup = await this.makeBackup(this.hooks.currentVersion);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.error = `退出时备份失败，没有升级：${message}`;
      this.push();
      await this.hooks.showReason('升级没有开始', this.error).catch(() => undefined);
      return false;
    }
    if (this.hooks.applyMode === 'dirpack') {
      try {
        this.dirpackHandoff = await this.writeDirpackHandoff(backup.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.error = `交接文件没有写好，没有升级：${message}`;
        this.push();
        await this.hooks.showReason('升级没有开始', this.error).catch(() => undefined);
        return false;
      }
    }
    if (this.hooks.applyMode !== 'dirpack') {
      this.journal.pending = {
        fromVersion: this.hooks.currentVersion,
        toVersion: this.journal.available.version,
        backupId: backup.id,
        at: new Date().toISOString(),
      };
    }
    this.journal.installOnQuit = false;
    await this.persist();
    this.leaving = true;
    return true;
  }

  async spawnQuitInstall(): Promise<void> {
    if (!this.verifiedPath || !this.journal.available) return;
    if (this.hooks.applyMode === 'dirpack') {
      if (!this.dirpackHandoff) return;
      await this.spawnDirpackUpdater(this.dirpackHandoff);
      return;
    }
    await this.spawnApply(this.verifiedPath, this.journal.available.version);
  }

  private async spawnApply(payload: string, version: string): Promise<void> {
    if (this.hooks.applyMode === 'dirpack') throw new Error('目录包不能启动 NSIS 安装程序');
    if (this.hooks.applyMode === 'nsis') {
      const args = process.env.KB_UPDATE_INSTALL_SILENT === '1' ? ['/S', '--updated'] : ['--updated'];
      const installLog = process.env.KB_UPDATE_INSTALL_LOG;
      if (installLog) args.push('/LOG=' + installLog);
      console.log('[update] spawn-installer args=' + JSON.stringify(args));
      await this.hooks.spawnDetached(payload, args, cleanEnv());
      return;
    }
    const script = await writeHelperScript();
    const env = helperEnv({
      KB_HELPER_MODE: 'apply',
      KB_HELPER_PAYLOAD: payload,
      KB_HELPER_VERSION: version,
      KB_HELPER_INSTALL_DIR: this.hooks.installDir || '',
      KB_HELPER_DONE: this.hooks.helperDone,
      KB_HELPER_LOG: `${this.hooks.helperDone}.log`,
      KB_HELPER_RELAUNCH: this.hooks.noRelaunch ? '-' : this.hooks.relaunchPath || '-',
    });
    await this.hooks.spawnDetached(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], env);
  }

  armStartup(input: SelfCheckInput): void {
    this.startup = input;
    this.startupArmed = true;
    if (!this.journal.pending) return;
    if (!input.dbOpened || !input.migrationOk) {
      const judged = judgeSelfCheck({ ...input, windowLoaded: false });
      if (!judged.ok) void this.rollback('self-check', judged.reason, this.journal.pending.backupId);
      return;
    }
    const waitMs = Number(process.env.KB_UPDATE_SELF_CHECK_MS || 30000);
    this.windowTimer = setTimeout(() => {
      if (this.windowLoaded || !this.journal.pending) return;
      void this.rollback('self-check', '主窗口没有加载完成', this.journal.pending.backupId);
    }, Number.isFinite(waitMs) ? waitMs : 30000);
    this.windowTimer.unref?.();
  }

  noteWindowLoaded(): void {
    this.windowLoaded = true;
    if (this.windowTimer) clearTimeout(this.windowTimer);
    void this.writeReadyMarker();
    if (!this.startupArmed || !this.journal.pending) return;
    const override = this.hooks.selfCheckOverride?.() ?? null;
    const input: SelfCheckInput = {
      dbOpened: this.startup.dbOpened,
      migrationOk: this.startup.migrationOk,
      windowLoaded: true,
      dbError: this.startup.dbError,
      migrationError: this.startup.migrationError,
      ...override,
    };
    const judged = judgeSelfCheck(input);
    const decision = decideAfterSelfCheck(this.journal.pending, judged);
    if (decision.action === 'clear') {
      void this.clearPending(true);
      return;
    }
    if (decision.action === 'rollback') void this.rollback('self-check', decision.reason, decision.backupId);
  }

  private async clearPending(ok: boolean, reason?: string): Promise<void> {
    this.journal.lastSelfCheck = { ok, reason, at: new Date().toISOString(), version: this.hooks.currentVersion };
    if (ok) this.journal.pending = undefined;
    this.info = ok ? '新版本自检通过' : this.info;
    await this.persist();
    this.push();
  }

  async rollback(kind: 'manual' | 'self-check', reason: string, backupId?: string): Promise<void> {
    if (this.leaving && kind === 'manual') return;
    if (this.hooks.installDir && isUnderStudyDev(this.hooks.installDir)) {
      throw new Error('拒绝在 study_dev 下回滚');
    }
    if (this.hooks.applyMode === 'dirpack') {
      await this.rollbackDirpack(kind, reason);
      return;
    }
    await this.rollbackInstallTree(kind, reason, backupId);
  }

  /** 目录包只把指针交给更新器。不写 current.json，也不把用户目录交给 helper。 */
  private async rollbackDirpack(kind: 'manual' | 'self-check', reason: string): Promise<void> {
    const installDir = this.hooks.installDir;
    if (!installDir) throw new Error('没有安装目录，不能回滚');
    const previous = await this.readPrevious(installDir);
    if (!previous) throw new Error('没有上一版可恢复');
    await this.markRollback(kind, reason);
    const args = ['--rollback'];
    console.log('[update] spawn-updater args=' + JSON.stringify(args));
    await this.hooks.spawnDetached(updaterExe(installDir), args, updaterSpawnEnv());
    await this.hooks.prepareShutdown().catch(() => undefined);
    await this.hooks.closeDatabase().catch(() => undefined);
    this.hooks.requestExit();
  }

  /** 没有 current.json 的 copy／nsis 只复制安装树。用户目录四个变量必须是 -。 */
  private async rollbackInstallTree(kind: 'manual' | 'self-check', reason: string, backupId?: string): Promise<void> {
    const rec = this.pickBackup(backupId);
    if (!rec) throw new Error('没有可回滚的备份');
    await this.markRollback(kind, reason);
    await this.hooks.prepareShutdown().catch(() => undefined);
    await this.hooks.closeDatabase().catch(() => undefined);
    const script = await writeHelperScript();
    const installSrc = path.join(rec.dir, 'install');
    const env = helperEnv({
      KB_HELPER_MODE: 'rollback',
      KB_HELPER_INSTALL_SRC: this.hooks.installDir ? installSrc : '-',
      KB_HELPER_INSTALL_DST: this.hooks.installDir || '-',
      KB_HELPER_LOCAL_SRC: '-',
      KB_HELPER_LOCAL_DST: '-',
      KB_HELPER_ROAM_SRC: '-',
      KB_HELPER_ROAM_DST: '-',
      KB_HELPER_DONE: this.hooks.helperDone,
      KB_HELPER_LOG: `${this.hooks.helperDone}.log`,
      KB_HELPER_RELAUNCH: this.hooks.noRelaunch ? '-' : this.hooks.relaunchPath || '-',
    });
    await this.hooks.spawnDetached(powershellExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], env);
    this.hooks.requestExit();
  }

  private async markRollback(kind: 'manual' | 'self-check', reason: string): Promise<void> {
    this.leaving = true;
    this.phase = 'rolling-back';
    this.error = reason;
    this.push();
    const reasonFile = path.join(this.hooks.userDataDir, 'update-rollback-reason.txt');
    await fs.mkdir(this.hooks.userDataDir, { recursive: true }).catch(() => undefined);
    await fs.writeFile(reasonFile, `${kind}\n${reason}\n`, 'utf8').catch(() => undefined);
    if (kind === 'self-check' && this.hooks.damageBeforeRollback) await this.hooks.damageBeforeRollback();
    if (kind === 'self-check' && process.env.KB_UPDATE_TEST_HOOK !== '1') {
      await this.hooks.showReason('已回滚到上一版', reason);
    } else if (kind === 'manual' && process.env.KB_UPDATE_TEST_HOOK !== '1') {
      await this.hooks.showReason('正在回滚到上一版', reason);
    }
    console.log(`[update] rollback ${kind}: ${reason}`);
  }

  private async readPrevious(installDir: string): Promise<string | null> {
    try {
      return (await readCurrent(installDir)).previous;
    } catch (err) {
      if (err instanceof LayoutError && err.message === 'current.json 不存在') return null;
      throw err;
    }
  }

  private previousFromPointer(): string | null {
    if (this.hooks.applyMode !== 'dirpack') return null;
    const installDir = this.hooks.installDir;
    if (!installDir || isUnderStudyDev(installDir)) return null;
    try {
      return parseCurrent(readFileSync(currentFile(installDir), 'utf8')).previous;
    } catch {
      return null;
    }
  }

  private pickBackup(id?: string): BackupRecord | undefined {
    if (id) return this.journal.backups.find((item) => item.id === id);
    return [...this.journal.backups].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
  }

  /** 备份失败时保持进程可继续检查和重试，并清掉半成品目录。 */
  private async backupOrStay(version: string): Promise<BackupRecord> {
    try {
      return await this.makeBackup(version);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.phase = 'ready';
      this.error = `备份失败，没有开始升级：${message}`;
      this.info = null;
      this.push();
      await this.hooks.showReason('升级没有开始', this.error).catch(() => undefined);
      throw err instanceof Error ? err : new Error(this.error);
    }
  }

  private async makeBackup(version: string): Promise<BackupRecord> {
    const id = `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const dir = path.join(this.backupRoot, id);
    try {
      await this.copyScope(this.hooks.userDataDir, path.join(dir, 'local'));
      if (path.resolve(this.hooks.roamingDir) !== path.resolve(this.hooks.userDataDir)) {
        await this.copyScope(this.hooks.roamingDir, path.join(dir, 'roaming'));
      }
      if (this.hooks.installDir) {
        await copyInstallTree(this.hooks.installDir, path.join(dir, 'install'));
      }
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    const rec: BackupRecord = { id, createdAt: new Date().toISOString(), version, dir };
    const rotated = rotateBackups(this.journal.backups, rec, 3);
    for (const old of rotated.remove) await fs.rm(old.dir, { recursive: true, force: true }).catch(() => undefined);
    this.journal.backups = rotated.keep;
    try {
      await this.persist();
    } catch (err) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return rec;
  }

  /** 目录包只读 dirpack.json。旁边的 latest.yml 保持原样，NSIS setup 不当成目录包。 */
  private async checkDirpack(feed: FeedTarget): Promise<UpdateSnapshot> {
    const manifest = await this.readDirpack(feed);
    const fileName = safeArtifactName(manifest.file);
    const size = manifest.size;
    const sha512 = manifest.sha512;
    if (!isNewer(manifest.version, this.hooks.currentVersion)) {
      this.phase = 'idle';
      this.journal.available = undefined;
      this.journal.installOnQuit = false;
      this.verifiedPath = null;
      this.info = '已是最新';
      await this.persist();
      this.push();
      return this.snapshot();
    }
    const dest = path.join(this.downloadDir, fileName);
    this.journal.available = {
      version: manifest.version,
      notes: manifest.notes?.trim() || '',
      fileName,
      sha512,
      size,
      blockMapSize: null,
      downloadedPath: dest,
      verified: false,
    };
    await this.persist();
    this.phase = 'downloading';
    this.progress = { transferred: 0, total: size };
    this.push();
    const ac = new AbortController();
    this.downloadAbort = ac;
    this.beginLoop();
    try {
      await downloadVerified({
        source: this.sourceForDirpack(feed, manifest),
        dest,
        expectedSha512: sha512,
        expectedSize: size,
        rateLimitBytesPerSec: this.settings.rateLimitBytesPerSec,
        signal: ac.signal,
        onProgress: (progress) => {
          this.progress = progress;
          this.phase = 'downloading';
          this.push();
        },
      });
      this.phase = 'verifying';
      this.progress = null;
      this.push();
      const digest = await hashFileSha512(dest);
      if (digest !== sha512) {
        await fs.rm(dest, { force: true }).catch(() => undefined);
        throw new PackageRejectedError('SHA512 不一致，安装包已丢弃');
      }
      if (!this.hooks.installDir) throw new Error('没有安装目录，不能准备目录包');
      if (isUnderStudyDev(this.hooks.installDir)) throw new Error('拒绝在 study_dev 下准备目录包');
      await prepareDirpack({
        zipPath: dest,
        installRoot: this.hooks.installDir,
        version: manifest.version,
        expectedSize: size,
        expectedSha512: sha512,
        signal: ac.signal,
        extract: this.hooks.extractDirpack,
        onProgress: (progress) => {
          this.progress = { transferred: progress.transferred, total: progress.total };
          this.phase = progress.stage === 'extract' ? 'downloading' : 'verifying';
          this.push();
        },
      });
    } finally {
      this.downloadAbort = null;
      this.endLoop();
    }
    if (this.journal.available) this.journal.available.verified = true;
    this.verifiedPath = dest;
    this.phase = 'ready';
    this.info = `已下载 ${manifest.version}，未签名`;
    await this.persist();
    this.push();
    return this.snapshot();
  }

  private async readDirpack(feed: FeedTarget): Promise<DirPackManifest> {
    if (feed.kind === 'dir') return loadDirpack(feed.dir);
    const res = await fetch(`${feed.baseUrl}${DIRPACK_FILE}`);
    if (!res.ok) throw new Error(`读取 dirpack.json 失败 HTTP ${res.status}`);
    return parseDirpack(await res.text());
  }

  private sourceForDirpack(feed: FeedTarget, manifest: DirPackManifest): string {
    if (feed.kind === 'dir') return dirpackSource(feed.dir, manifest);
    return artifactSource(feed, manifest.file);
  }

  private async cleanupDirpackPartial(err: unknown): Promise<void> {
    if (this.hooks.applyMode !== 'dirpack') return;
    const version = this.journal.available?.version;
    const root = this.hooks.installDir;
    if (!version || !root) return;
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('下载已取消')) return;
    await removePartial(root, version).catch((cleanupErr) => {
      console.error('[update] remove partial', cleanupErr);
    });
  }

  private async commitDirpackAndExit(backupId: string): Promise<void> {
    let handoffPath: string;
    try {
      handoffPath = await this.writeDirpackHandoff(backupId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.phase = 'ready';
      this.error = `交接文件没有写好，没有开始升级：${message}`;
      this.info = null;
      this.push();
      await this.hooks.showReason('升级没有开始', this.error).catch(() => undefined);
      throw err instanceof Error ? err : new Error(this.error ?? message);
    }
    this.dirpackHandoff = handoffPath;
    this.leaving = true;
    await this.persist();
    await this.hooks.prepareShutdown();
    await this.hooks.closeDatabase();
    await this.spawnDirpackUpdater(handoffPath);
    this.hooks.requestExit();
  }

  private async writeDirpackHandoff(backupId: string): Promise<string> {
    const available = this.journal.available;
    const installDir = this.hooks.installDir;
    if (!available) throw new Error('还没有校验通过的安装包');
    if (!installDir) throw new Error('没有安装目录，不能交接更新器');
    if (isUnderStudyDev(installDir)) throw new Error('拒绝在 study_dev 下交接更新');
    const createdAt = new Date().toISOString();
    const handoff = {
      schema: 1 as const,
      fromVersion: this.hooks.currentVersion,
      toVersion: available.version,
      candidateRel: candidateRel(available.version),
      sha512: available.sha512,
      size: available.size,
      packageName: dirZipName(available.version),
      userDataDir: this.hooks.userDataDir,
      installRoot: installDir,
      backupId,
      createdAt,
    };
    parseHandoff(JSON.stringify(handoff));
    const state = {
      schema: 1 as const,
      phase: 'ready' as const,
      fromVersion: this.hooks.currentVersion,
      toVersion: available.version,
      candidateRel: candidateRel(available.version),
      error: null,
      logFile: null,
      attempt: 0,
      startedAt: null,
      updatedAt: createdAt,
    };
    parseUpdaterState(JSON.stringify(state));
    const handoffPath = handoffFile(installDir);
    await writeAtomicJson(handoffPath, handoff, undefined, 'updater/handoff.json');
    await writeAtomicJson(stateFile(installDir), state, undefined, 'updater/state.json');
    return handoffPath;
  }

  private async spawnDirpackUpdater(handoffPath: string): Promise<void> {
    const installDir = this.hooks.installDir;
    if (!installDir) throw new Error('没有安装目录，不能交接更新器');
    const args = ['--handoff', handoffPath];
    console.log('[update] spawn-updater args=' + JSON.stringify(args));
    await this.hooks.spawnDetached(updaterExe(installDir), args, cleanEnv());
  }

  private async writeReadyMarker(): Promise<void> {
    try {
      const file = path.join(this.hooks.userDataDir, READY_MARKER_FILE);
      await fs.mkdir(this.hooks.userDataDir, { recursive: true });
      const body = { schema: READY_SCHEMA, version: this.hooks.currentVersion, at: new Date().toISOString() };
      await fs.writeFile(file, JSON.stringify(body), 'utf8');
    } catch (err) {
      console.error('[update] ready marker', err);
    }
  }

  private async copyScope(root: string, dest: string): Promise<void> {
    let files: Awaited<ReturnType<typeof planBackupFiles>> = [];
    try {
      files = await planBackupFiles(root);
    } catch {
      return;
    }
    for (const file of files) {
      const target = path.join(dest, file.rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      if (file.kind === 'sqlite') await this.hooks.backupSqlite(file.abs, target);
      else await fs.copyFile(file.abs, target);
    }
  }
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  return env;
}

function updaterSpawnEnv(): NodeJS.ProcessEnv {
  const env = cleanEnv();
  delete env.KB_HELPER_MODE;
  delete env.KB_HELPER_LOCAL_SRC;
  delete env.KB_HELPER_LOCAL_DST;
  delete env.KB_HELPER_ROAM_SRC;
  delete env.KB_HELPER_ROAM_DST;
  return env;
}

function helperEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PATHEXT: process.env.PATHEXT,
    COMSPEC: process.env.COMSPEC,
    KB_HELPER_PID: String(process.pid),
    ...extra,
  };
}

type AsarDirent = { name: string; isDirectory: () => boolean };

interface InstallRawFs {
  promises: {
    cp: (src: string, dest: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
    readdir: (dir: string, opts: { withFileTypes: true }) => Promise<AsarDirent[]>;
    stat: (file: string) => Promise<{ size: number }>;
  };
  createReadStream: (file: string) => NodeJS.ReadableStream;
}

function loadOriginalFs(): InstallRawFs | null {
  try {
    const req = createRequire(process.execPath);
    const mod = req('original-fs') as InstallRawFs;
    if (typeof mod.promises?.cp !== 'function' || typeof mod.createReadStream !== 'function') return null;
    return mod;
  } catch {
    return null;
  }
}

async function hashStream(open: (file: string) => NodeJS.ReadableStream, file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = open(file);
    stream.on('data', (chunk: Buffer | string) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve());
  });
  return hash.digest('hex');
}

async function listAsarRel(readdir: InstallRawFs['promises']['readdir'], root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const child = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.name.endsWith('.asar')) {
        out.push(child);
        continue;
      }
      if (ent.isDirectory()) await walk(path.join(dir, ent.name), child);
    }
  };
  await walk(root, '');
  return out;
}

/** 安装目录里的 asar 必须按文件字节拷贝。Electron 打过补丁的 fs 会把 app.asar 当成目录。 */
async function copyInstallTree(src: string, dest: string): Promise<void> {
  const raw = loadOriginalFs();
  if (raw) {
    await raw.promises.cp(src, dest, { recursive: true, force: true });
    await assertAsarBytes(raw, src, dest);
    return;
  }
  const proc = process as NodeJS.Process & { noAsar?: boolean };
  const prev = proc.noAsar;
  proc.noAsar = true;
  try {
    await fs.cp(src, dest, { recursive: true, force: true });
    await assertAsarBytes(null, src, dest);
  } finally {
    proc.noAsar = prev;
  }
}

async function assertAsarBytes(raw: InstallRawFs | null, srcRoot: string, destRoot: string): Promise<void> {
  const readdir = raw
    ? raw.promises.readdir.bind(raw.promises)
    : (dir: string, opts: { withFileTypes: true }) => fs.readdir(dir, opts);
  const stat = raw ? raw.promises.stat.bind(raw.promises) : (file: string) => fs.stat(file);
  const open = raw ? raw.createReadStream.bind(raw) : (file: string) => createReadStream(file);
  const rels = await listAsarRel(readdir, srcRoot);
  for (const rel of rels) {
    const srcFile = path.join(srcRoot, rel);
    const destFile = path.join(destRoot, rel);
    const srcStat = await stat(srcFile);
    const destStat = await stat(destFile).catch(() => null);
    if (!destStat || srcStat.size !== destStat.size) throw new Error(`安装备份与原文件字节不一致：${rel}`);
    const [srcHash, destHash] = await Promise.all([hashStream(open, srcFile), hashStream(open, destFile)]);
    if (srcHash !== destHash) throw new Error(`安装备份与原文件字节不一致：${rel}`);
  }
}
