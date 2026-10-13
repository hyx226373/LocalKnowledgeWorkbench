/**
 * 外部程序项目的主进程宿主（第 9 轮合并接线，docs/09 R1/R2）：
 *  - 应用档案（AppProfile）：用户在工作台里选定的“程序 + 参数模板 + 槽位取值”，存在 layout 键 `app.profile:<id>`（随数据迁移包导出；槽位只存资源 ID）；
 *  - 启动：插件只能启动**该条目应用档案里的那一个**组合（程序、模板、槽位逐项一致），其余检查由 AppLaunchService 完成（授权、签名、频率、单实例、备份）；
 *  - 退出后：备份范围内被改动的文件记入操作记录（op='write'，via='external-app'），与原位编辑的保存走同一套撤销；
 *    工作台在外部程序退出前就关闭了 → 下次启动时对比所有未结束会话的目标文件哈希（reconcileStartup），有改动就补记，
 *    标注「工作台关闭期间的外部修改」；程序仍在运行的，把当时的内容记为新基准，等它退出后再记之后的修改。
 *    工作台运行中，程序没退出之前不记任何改动。
 */
import crypto from 'node:crypto';
import { expandArgs } from '../../shared/adapter-sdk/policy';
import type { AppProfile, LaunchRequest, LaunchResult, ProcessHandleInfo, ProcessLaunchPermission, SlotValue } from '../../shared/adapter-sdk/types';
import { adapterOf } from '../../shared/grants';
import { isHardUndoConflict, type WorkbenchService } from '../service/WorkbenchService';
import { AppBackupStore, type FileChange } from './appBackup';
import { AppLaunchService, defaultIsAlive, type AppLaunchDeps } from './appLauncher';
import type { AppChangesEvent, AppProfileInput, AppUndoOutcome } from '../../shared/appIpc';

export const APP_PROFILE_KEY = (id: string) => `app.profile:${id}`;

export type { AppProfileInput, AppChangesEvent, AppUndoOutcome };

export type PlatformDeps = Pick<AppLaunchDeps, 'findExe' | 'verifyExe' | 'spawn' | 'argvPath' | 'confirmUnprotected' | 'now' | 'isAlive'>;

export const CLOSED_PERIOD_LABEL = '工作台关闭期间的外部修改';

function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export class AppHost {
  readonly store: AppBackupStore;
  readonly launcher: AppLaunchService;
  private undoable = new Map<string, AppChangesEvent>();
  private changeListeners = new Set<(e: AppChangesEvent) => void>();
  /** 上次运行时启动、工作台重启后仍在运行的程序：等它退出（轮询 isAlive）后再记之后的修改 */
  private watching = new Map<string, { pid: number; who: { pluginId: string; adapterId: string; itemId: string; programName: string } }>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly isAlive: (pid: number) => boolean;
  private readonly pollMs: number;

  constructor(
    private svc: WorkbenchService,
    platform: PlatformDeps,
    opts: { store?: AppBackupStore; pollMs?: number } = {},
  ) {
    this.isAlive = platform.isAlive ?? defaultIsAlive;
    this.pollMs = opts.pollMs ?? 0;
    this.store = opts.store ?? new AppBackupStore(svc.dataDir);
    this.launcher = new AppLaunchService(
      {
        plugins: () => svc.plugins.list(),
        resolveResource: (rid) => {
          const r = svc.getResource(rid);
          if (!r || !r.exists || r.kind !== 'file') return null;
          const root = svc.listRoots().find((x) => x.id === r.rootId);
          if (!root || root.status !== 'ok') return null;
          return { rootId: r.rootId, rootPath: root.path, relPath: r.relPath, abs: svc.resolveResourcePath(rid), ext: r.ext };
        },
        rootPathOf: (id) => svc.listRoots().find((x) => x.id === id && x.status === 'ok')?.path ?? null,
        audit: (pluginId, adapterId, kind, detail) => {
          try {
            svc.plugins.audit(pluginId, adapterId, kind, detail);
          } catch {
            /* 审计失败不影响启动 */
          }
        },
        onExited: (info) => this.reconcile(info.launchId, info, false, info.changes),
        ...platform,
      },
      this.store,
    );
  }

  onChanges(fn: (e: AppChangesEvent) => void): () => void {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }
  onStatus(fn: (pluginId: string, h: ProcessHandleInfo) => void): () => void {
    return this.launcher.onStatus(fn);
  }

  // ---------------- 应用档案 ----------------

  private declFor(adapterId: string): { pluginId: string; decl: ProcessLaunchPermission } {
    for (const p of this.svc.plugins.list()) {
      const a = p.manifest ? adapterOf(p.manifest, adapterId) : undefined;
      if (!a) continue;
      if (!a.sourceKinds.includes('app') || a.displayMode !== 'external-managed') throw new Error(`适配器 ${adapterId} 不是外部程序适配器`);
      const decl = a.permissions.find((x): x is ProcessLaunchPermission => x.kind === 'process.launch');
      if (!decl) throw new Error('适配器未声明 process.launch');
      return { pluginId: p.id, decl };
    }
    throw new Error(`没有找到适配器 ${adapterId}（插件未安装？）`);
  }

  /** 新建应用档案：程序、模板必须在声明中；槽位按模板校验（资源必须是已注册根内存在的文件且扩展名允许） */
  createProfile(input: AppProfileInput): AppProfile {
    const { decl } = this.declFor(String(input?.adapterId));
    const spec = decl.programs.find((g) => g.programId === input.programId);
    if (!spec) throw new Error(`未声明的程序 ${input.programId}`);
    const slots: Record<string, SlotValue> = {};
    for (const [k, v] of Object.entries(input.launch?.slots ?? {})) {
      if (v?.type === 'resource') slots[k] = { type: 'resource', resourceId: String(v.resourceId) };
      else if (v?.type === 'int') slots[k] = { type: 'int', value: Number(v.value) };
      else if (v?.type === 'enum') slots[k] = { type: 'enum', value: String(v.value) };
      else throw new Error(`槽位 ${k} 不合法`);
    }
    const req: LaunchRequest = { programId: spec.programId, templateId: String(input.launch?.templateId), slots };
    const ex = expandArgs(spec, req, (rid) => {
      const r = this.svc.getResource(rid);
      return r && r.exists && r.kind === 'file' ? { absPath: 'C:\\kb-profile-check\\' + r.name.replace(/[\\/:*?"<>|]/g, '_'), ext: r.ext } : null;
    });
    if (!ex.ok) throw new Error(`应用档案不合法：${ex.reason}${ex.detail ? `（${ex.detail}）` : ''}`);
    const tpl = spec.argTemplates.find((t) => t.id === req.templateId)!;
    const profile: AppProfile = {
      appProfileId: `ap-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      adapterId: input.adapterId,
      programId: spec.programId,
      label: (input.label?.trim() || `${spec.displayName} · ${tpl.label}`).slice(0, 120),
      launch: { templateId: req.templateId, slots },
    };
    this.svc.setLayout(APP_PROFILE_KEY(profile.appProfileId), profile);
    return profile;
  }

  getProfile(id: string): AppProfile | null {
    if (typeof id !== 'string' || !/^[\w.:-]{1,200}$/.test(id)) return null;
    const v = this.svc.getLayout(APP_PROFILE_KEY(id)) as AppProfile | null;
    return v && typeof v === 'object' && v.appProfileId === id ? v : null;
  }

  // ---------------- 启动 ----------------

  /** 插件经 ctx.process.launch 发起；只允许与条目应用档案完全一致的组合 */
  async launch(pluginId: string, adapterId: string, itemId: string, appProfileId: string, req: LaunchRequest): Promise<LaunchResult> {
    const profile = this.getProfile(appProfileId);
    if (!profile || profile.adapterId !== adapterId) return { ok: false, reason: 'permission-denied', detail: '应用档案不存在或不属于该适配器' };
    if (req?.programId !== profile.programId || req?.templateId !== profile.launch.templateId || canon(req?.slots ?? {}) !== canon(profile.launch.slots ?? {}))
      return { ok: false, reason: 'permission-denied', detail: '只能按应用档案中用户选定的程序、模板和文件启动' };
    return this.launcher.launch(pluginId, adapterId, itemId, { programId: profile.programId, templateId: profile.launch.templateId, slots: profile.launch.slots });
  }

  // ---------------- 退出后：记入操作记录 ----------------

  private rootPathOf = (id: string) => this.svc.listRoots().find((x) => x.id === id && x.status === 'ok')?.path ?? null;

  /**
   * 把基准之后被修改的文件记入操作记录。final = 会话已结束（记完标记为已比较）；
   * 否则（程序仍在运行）记完把当前内容设为新基准，等程序退出后再比较。
   */
  private reconcile(launchId: string, who: { pluginId: string; adapterId: string; itemId: string; programName: string }, afterRestart: boolean, changes?: FileChange[], final = true): AppChangesEvent | null {
    const rec = this.store.get(launchId);
    if (!rec || this.store.isReconciled(launchId)) return null;
    const rootPathOf = this.rootPathOf;
    const list = changes ?? this.store.compare(launchId, rootPathOf);
    const base = this.store.baseline(launchId);
    const files: AppChangesEvent['files'] = [];
    for (const c of list) {
      if (c.change === 'unchanged') continue;
      if (!rootPathOf(c.rootId)) continue; // 根离线/未映射：无法判断，也无法恢复，下次再比较
      const f = base.find((x) => x.rootId === c.rootId && x.relPath === c.relPath);
      if (!f) continue;
      const blob = f.blob ? this.store.blobPath(launchId, f.blob) : null;
      if (f.blob && !blob) continue;
      const op = this.svc.recordExternalWrite(c.rootId, c.relPath, blob, `app:${who.pluginId}`, { launchId, programId: rec.programId, program: who.programName, change: c.change, ...(afterRestart ? { afterRestart: true, label: CLOSED_PERIOD_LABEL } : {}) });
      files.push({ rootId: c.rootId, relPath: c.relPath, change: c.change, opId: op.id });
    }
    if (list.some((c) => c.change !== 'unchanged' && !rootPathOf(c.rootId))) return null; // 有离线的根：先不标记，等根恢复后再比较
    if (final) this.store.markReconciled(launchId, { opIds: files.map((f) => f.opId) });
    else if (files.length) this.store.checkpoint(launchId, rootPathOf);
    const ev: AppChangesEvent = { launchId, pluginId: who.pluginId, adapterId: who.adapterId, itemId: who.itemId, programName: who.programName, afterRestart, files };
    if (files.length) {
      this.undoable.set(launchId, ev);
      this.svc.emit('fs-change', files.map((f) => ({ rootId: f.rootId, relPath: f.relPath, type: 'change' })));
      for (const l of this.changeListeners) l(ev);
    }
    return ev;
  }

  /**
   * 工作台启动时：对比所有未结束的外部程序会话（上次运行时启动、还没比较过的）中目标文件的哈希，
   * 有改动就补记进操作记录，标注「工作台关闭期间的外部修改」。
   *  - 程序已经退出（或无法判断：没有 pid、超过保留期）→ 记完即结束这个会话；
   *  - 程序仍在运行 → 记完把当前内容设为新基准，开始轮询，等它退出后只记基准之后的修改（不标注关闭期间）。
   */
  reconcileStartup(): AppChangesEvent[] {
    const out: AppChangesEvent[] = [];
    for (const rec of this.store.unreconciled()) {
      if (this.launcher.owner(rec.launchId)) continue; // 本次运行中启动：退出时再记
      const name = this.svc.plugins.list().find((p) => p.id === rec.pluginId)?.manifest?.contributes.adapters.flatMap((a) => a.permissions).find((x): x is ProcessLaunchPermission => x.kind === 'process.launch')?.programs.find((g) => g.programId === rec.programId)?.displayName ?? rec.programId;
      const who = { pluginId: rec.pluginId, adapterId: rec.adapterId, itemId: rec.itemId ?? '', programName: name };
      const sess = this.store.session(rec.launchId);
      const fresh = Date.now() - rec.at < this.store.limits.retentionDays * 24 * 3600 * 1000; // 超过保留期的 pid 很可能已被复用
      const alive = !!sess && fresh && this.isAlive(sess.pid);
      const ev = this.reconcile(rec.launchId, who, true, undefined, !alive);
      if (ev?.files.length) out.push(ev);
      if (alive) this.watching.set(rec.launchId, { pid: sess!.pid, who });
    }
    if (this.watching.size && this.pollMs > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => this.pollSessions(), this.pollMs);
    }
    return out;
  }

  /** 重启后仍在运行的程序：退出了就比较（只记新基准之后的修改）并结束会话 */
  pollSessions(): AppChangesEvent[] {
    const out: AppChangesEvent[] = [];
    for (const [launchId, w] of [...this.watching]) {
      if (this.isAlive(w.pid)) continue;
      this.watching.delete(launchId);
      const ev = this.reconcile(launchId, w.who, false, undefined, true);
      if (ev?.files.length) out.push(ev);
    }
    if (!this.watching.size && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    return out;
  }

  /** 仍在等待退出的上次会话（诊断 / 测试） */
  watchingSessions(): string[] {
    return [...this.watching.keys()];
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.watching.clear();
  }

  /** 最近一次（本次运行中）记入操作记录的外部改动 */
  pendingChanges(itemId?: string): AppChangesEvent[] {
    return [...this.undoable.values()].filter((e) => !itemId || e.itemId === itemId);
  }

  /** 撤销某次外部程序启动造成的改动（逐个文件撤销对应的操作记录；冲突时先返回让界面确认） */
  undoExternal(launchId: string, force = false): AppUndoOutcome {
    const ev = this.undoable.get(launchId);
    if (!ev) return { status: 'nothing' };
    const pending = ev.files.filter((f) => {
      const op = this.svc.listOps(100000).find((o) => o.id === f.opId);
      return op && !op.undoneAt;
    });
    if (!pending.length) {
      this.undoable.delete(launchId);
      return { status: 'nothing' };
    }
    const conflicts: string[] = [];
    for (const f of pending) {
      const pv = this.svc.previewUndo(f.opId);
      const hard = pv.conflicts.filter(isHardUndoConflict);
      if (hard.length) return { status: 'unrecoverable', detail: hard.map((c) => `${f.relPath}：${c}`) };
      conflicts.push(...pv.conflicts.map((c) => `${f.relPath}：${c}`));
    }
    if (conflicts.length && !force) return { status: 'conflict', detail: conflicts };
    for (const f of pending) this.svc.undo(f.opId, conflicts.length ? 'keep-both' : 'fail', 'user');
    this.undoable.delete(launchId);
    return { status: 'undone', files: pending.map((f) => f.relPath) };
  }
}
