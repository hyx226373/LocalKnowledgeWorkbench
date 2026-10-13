/**
 * 外部程序进程代理（H10 的主进程部分 + H12 启动前备份），SDK 规范 §6.4。
 *
 * 只做主进程判定与执行，不依赖 Electron；IPC / 界面接线见 docs/09-接口请求.md（R1）。
 * 每次 launch 的顺序（任何一步失败都不启动）：
 *   1. 插件已安装、已启用、兼容；适配器是 app 适配器（displayMode = external-managed）；
 *   2. process.launch 已授权，且授权时的 declHash 与当前声明一致（声明变化 → 需重新授权）；
 *   3. programId 在声明中；按 exeCandidates 找到 exe 并通过签名/哈希/版本校验（verifyExe，Windows 实现见 winVerify.ts）；
 *   4. 频率限制（10 s 内 ≤ 5 次）、单实例（同一条目同一程序同时一个）；
 *   5. SDK expandArgs 按固定模板展开参数；资源槽位只接受已注册根内存在的普通文件（resolveResource 已做越界/realpath 检查）；
 *   6. AppBackupStore 备份目标文件 + 声明的附加文件（D6 收紧版）；目标超限时需 confirmUnprotected() 由用户确认；
 *   7. spawn(exe, argv)：参数数组、shell:false，不经 cmd.exe；退出后比较备份哈希，记录哪些文件被外部修改。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { expandArgs, satisfies } from '../../shared/adapter-sdk/policy';
import type { AdapterContribution, LaunchRequest, LaunchResult, ProcessHandleInfo, ProcessLaunchPermission, ProgramDetection, ProgramSpec } from '../../shared/adapter-sdk/types';
import type { AdapterPluginDto } from '../../shared/pluginIpc';
import { adapterOf, grantDecision } from '../../shared/grants';
import { AppBackupStore, type BackupTarget, type FileChange } from './appBackup';

export interface ResolvedAppResource {
  rootId: string;
  rootPath: string;
  relPath: string;
  abs: string;
  ext: string;
}

export interface ExeVerification {
  ok: boolean;
  reason?: ProgramDetection['reason'];
  publisher?: string;
  version?: string;
}

export interface SpawnedProcess {
  pid: number | undefined;
  onExit(cb: (code: number | null) => void): void;
}

export interface AppLaunchDeps {
  /** 主进程插件列表（PluginHostService.list()）：manifest、授权、启用状态、校验错误 */
  plugins(): AdapterPluginDto[];
  /** resourceId → 已注册根内存在的普通文件；越界/不存在/不是文件 → null */
  resolveResource(resourceId: string): ResolvedAppResource | null;
  /** 根 id → 根的绝对路径（比较/恢复备份用） */
  rootPathOf(rootId: string): string | null;
  /** 按 exeCandidates 找第一个存在的 exe（缺省：展开环境变量令牌 + 文件存在） */
  findExe?(spec: ProgramSpec): string | null;
  /** 签名/哈希/版本校验。缺省：只在 Windows 上可用（见 winVerify.ts），其他平台一律 unsupported-os */
  verifyExe(exePath: string, spec: ProgramSpec): Promise<ExeVerification>;
  /** 启动进程（缺省 child_process.spawn，shell:false，detached） */
  spawn?(exePath: string, argv: string[]): SpawnedProcess;
  /** 目标文件超过备份上限时询问用户“不备份也启动？”（缺省：否） */
  confirmUnprotected?(info: { pluginName: string; programName: string; detail: string }): Promise<boolean>;
  /** 资源绝对路径 → 传给程序的路径（缺省原样；单测在非 Windows 上把它映射成 Windows 路径以通过 expandArgs 的绝对路径检查） */
  argvPath?(abs: string): string;
  /** 审计（插件管理页可见） */
  audit?(pluginId: string, adapterId: string, kind: 'app-launch' | 'app-blocked' | 'app-exit', detail: string): void;
  /** 进程退出、比较完备份之后（宿主把被改动的文件记入操作记录，见 appHost.ts） */
  onExited?(info: { launchId: string; pluginId: string; adapterId: string; itemId: string; programName: string; changes: FileChange[] }): void;
  /** 进程是否仍在运行（工作台重启后判断上次启动的程序；缺省 process.kill(pid, 0)） */
  isAlive?(pid: number): boolean;
  now?(): number;
}

/** 缺省的“进程是否仍在运行”：signal 0 只做存在性检查（Windows 上 Node 同样支持）；EPERM = 存在但无权发信号 */
export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

interface Tracked extends ProcessHandleInfo {
  pluginId: string;
  adapterId: string;
  itemId: string;
  changes?: FileChange[];
}

const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 5;

export class AppLaunchService {
  private procs = new Map<string, Tracked>();
  private recent = new Map<string, number[]>();
  private listeners = new Set<(pluginId: string, h: ProcessHandleInfo) => void>();
  constructor(
    private deps: AppLaunchDeps,
    readonly backups: AppBackupStore,
  ) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  onStatus(fn: (pluginId: string, h: ProcessHandleInfo) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 查找插件 + app 适配器 + process.launch 声明；不可用时返回失败原因 */
  private resolve(pluginId: string, adapterId: string): { dto: AdapterPluginDto; adapter: AdapterContribution; decl: ProcessLaunchPermission } | { error: string } {
    const dto = this.deps.plugins().find((p) => p.id === pluginId);
    if (!dto || !dto.manifest) return { error: '插件未安装' };
    if (!dto.enabled) return { error: '插件已停用' };
    if (dto.errors.length) return { error: `插件不兼容：${dto.errors[0]}` };
    const adapter = adapterOf(dto.manifest, adapterId);
    if (!adapter || !adapter.sourceKinds.includes('app') || adapter.displayMode !== 'external-managed') return { error: `适配器 ${adapterId} 不是外部程序适配器` };
    const decl = adapter.permissions.find((p): p is ProcessLaunchPermission => p.kind === 'process.launch');
    if (!decl) return { error: '适配器未声明 process.launch' };
    return { dto, adapter, decl };
  }

  async detect(pluginId: string, adapterId: string, programId: string): Promise<ProgramDetection> {
    const r = this.resolve(pluginId, adapterId);
    const spec = 'error' in r ? undefined : r.decl.programs.find((g) => g.programId === programId);
    if (!spec) return { programId, installed: false, verified: false, reason: 'not-found' };
    const exe = (this.deps.findExe ?? defaultFindExe)(spec);
    if (!exe) return { programId, installed: false, verified: false, reason: 'not-found' };
    const v = await this.deps.verifyExe(exe, spec);
    return { programId, installed: true, verified: v.ok, ...(v.version ? { version: v.version } : {}), ...(v.ok ? {} : { reason: v.reason ?? 'publisher-mismatch' }) };
  }

  async launch(pluginId: string, adapterId: string, itemId: string, req: LaunchRequest): Promise<LaunchResult> {
    const blocked = (reason: Exclude<LaunchResult, { ok: true }>['reason'], detail?: string): LaunchResult => {
      this.deps.audit?.(pluginId, adapterId, 'app-blocked', `${req?.programId ?? '?'}/${req?.templateId ?? '?'}：${reason}${detail ? `（${detail}）` : ''}`);
      return { ok: false, reason, ...(detail ? { detail } : {}) };
    };
    const r = this.resolve(pluginId, adapterId);
    if ('error' in r) return blocked('permission-denied', r.error);
    const { dto, decl } = r;
    if (grantDecision(dto.grants, pluginId, adapterId, decl).decision !== 'granted') return blocked('permission-denied', '尚未授权或授权已失效（声明变化需重新授权）');
    const spec = decl.programs.find((g) => g.programId === req?.programId);
    if (!spec) return blocked('unknown-program', String(req?.programId));
    const exe = (this.deps.findExe ?? defaultFindExe)(spec);
    if (!exe) return blocked('not-installed');
    const v = await this.deps.verifyExe(exe, spec);
    if (!v.ok) return blocked('verification-failed', v.reason);
    if (spec.verify.versionRange && !(v.version && satisfies(v.version.split('.').slice(0, 3).join('.'), spec.verify.versionRange))) return blocked('verification-failed', 'version-out-of-range');
    const key = `${pluginId}|${itemId}`;
    const now = this.now();
    const times = (this.recent.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
    if (times.length >= RATE_MAX) return blocked('rate-limited');
    if (spec.singleInstance !== false && [...this.procs.values()].some((p) => p.pluginId === pluginId && p.itemId === itemId && p.programId === spec.programId && (p.status === 'running' || p.status === 'starting')))
      return blocked('already-running');
    // 资源槽位 → 已注册根内文件
    const targets: BackupTarget[] = [];
    const ex = expandArgs(spec, req, (rid) => {
      const res = this.deps.resolveResource(rid);
      if (!res) return null;
      targets.push({ rootId: res.rootId, rootPath: res.rootPath, relPath: res.relPath });
      return { absPath: (this.deps.argvPath ?? ((x: string) => x))(res.abs), ext: res.ext };
    });
    if (!ex.ok) return blocked(ex.reason, ex.detail);
    times.push(now);
    this.recent.set(key, times);
    const launchId = `L${now.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    let backup: ProcessHandleInfo['backup'];
    if (targets.length) {
      let out = this.backups.backup({ launchId, pluginId, adapterId, programId: spec.programId, itemId }, targets, spec.backup, false);
      if (!out.ok && out.reason === 'backup-over-limit') {
        const yes = (await this.deps.confirmUnprotected?.({ pluginName: dto.name, programName: spec.displayName, detail: out.detail })) ?? false;
        if (!yes) return blocked('backup-over-limit', out.detail);
        out = this.backups.backup({ launchId, pluginId, adapterId, programId: spec.programId, itemId }, targets, spec.backup, true);
      }
      if (!out.ok) return blocked(out.reason, out.detail);
      backup = out.summary;
    }
    let child: SpawnedProcess;
    try {
      child = (this.deps.spawn ?? defaultSpawn)(exe, ex.argv);
    } catch (e) {
      return blocked('spawn-failed', String((e as Error).message).slice(0, 120));
    }
    const h: Tracked = {
      launchId,
      programId: spec.programId,
      templateId: req.templateId,
      status: 'running',
      ...(child.pid !== undefined ? { pid: child.pid } : {}),
      startedAt: now,
      window: { tracking: spec.windowTracking, state: spec.windowTracking === 'none' ? 'not-tracked' : 'searching' },
      ...(backup ? { backup } : {}),
      pluginId,
      adapterId,
      itemId,
    };
    this.procs.set(launchId, h);
    // 记下 pid：工作台在程序退出前关闭的话，下次启动据此判断程序是否仍在运行（appHost.reconcileStartup）
    if (backup && child.pid !== undefined) this.backups.setSession(launchId, { pid: child.pid, startedAt: now });
    this.deps.audit?.(pluginId, adapterId, 'app-launch', `${spec.displayName}「${req.templateId}」${backup ? `；启动前备份 ${backup.files} 个文件${backup.skipped ? `，${backup.skipped} 个因上限未备份` : ''}${backup.targetUnprotected ? '；目标文件超限未备份（用户已确认）' : ''}` : ''}`);
    child.onExit((code) => {
      h.status = code === 0 ? 'exited' : 'crashed';
      h.exitCode = code;
      h.window = { ...h.window, state: h.window.tracking === 'none' ? 'not-tracked' : 'lost' };
      if (backup) h.changes = this.backups.compare(launchId, this.deps.rootPathOf);
      const changed = h.changes?.filter((c) => c.change !== 'unchanged') ?? [];
      this.deps.audit?.(pluginId, adapterId, 'app-exit', `${spec.displayName} 退出（代码 ${code ?? '?'}）${changed.length ? `；备份范围内被修改：${changed.map((c) => c.relPath).join('、')}（可在操作记录中撤销）` : ''}`);
      try {
        if (backup) this.deps.onExited?.({ launchId, pluginId, adapterId, itemId, programName: spec.displayName, changes: h.changes ?? [] });
      } catch (e) {
        console.error('[app] 记录外部改动失败', e);
      }
      for (const l of this.listeners) l(pluginId, strip(h));
    });
    return { ok: true, handle: strip(h) };
  }

  /** 仅该插件启动的进程（适配器可见形式：无 exe 路径与 argv） */
  list(pluginId: string): ProcessHandleInfo[] {
    return [...this.procs.values()].filter((p) => p.pluginId === pluginId).map(strip);
  }

  /** 宿主内部：某次启动属于哪个插件/条目（界面撤销入口校验用） */
  owner(launchId: string): { pluginId: string; adapterId: string; itemId: string } | null {
    const p = this.procs.get(launchId);
    return p ? { pluginId: p.pluginId, adapterId: p.adapterId, itemId: p.itemId } : null;
  }

  /** 退出后：备份范围内哪些文件被外部修改（宿主界面用；不给插件） */
  changes(launchId: string): FileChange[] | undefined {
    return this.procs.get(launchId)?.changes;
  }
}

function strip(h: Tracked): ProcessHandleInfo {
  const { pluginId: _p, adapterId: _a, itemId: _i, changes: _c, ...rest } = h;
  return JSON.parse(JSON.stringify(rest));
}

const ENV_TOKENS: Record<string, string> = { WINDIR: 'WINDIR', SystemRoot: 'SystemRoot', ProgramFiles: 'ProgramFiles', 'ProgramFiles(x86)': 'ProgramFiles(x86)', LOCALAPPDATA: 'LOCALAPPDATA' };

/** %ProgramFiles%\… → 展开后第一个存在的 exe；只在 Windows 上有意义 */
export function defaultFindExe(spec: ProgramSpec, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  for (const c of spec.exeCandidates) {
    const m = /^%([^%]+)%(.*)$/.exec(c);
    let p = c;
    if (m) {
      const name = ENV_TOKENS[m[1]!];
      const val = name ? env[name] : undefined;
      if (!val) continue;
      p = val.replace(/\\+$/, '') + m[2];
    }
    if (exists(p)) return p;
  }
  return null;
}

function defaultSpawn(exe: string, argv: string[]): SpawnedProcess {
  const child = nodeSpawn(exe, argv, { shell: false, detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: false });
  child.unref();
  let done = false;
  return {
    pid: child.pid,
    onExit: (cb) => {
      const fire = (code: number | null) => {
        if (!done) (done = true), cb(code);
      };
      child.once('exit', (code) => fire(code));
      // spawn 失败（exe 被删除/无权限）以 error 事件异步报告：按异常退出处理，不能让主进程崩溃
      child.once('error', () => fire(null));
    },
  };
}
