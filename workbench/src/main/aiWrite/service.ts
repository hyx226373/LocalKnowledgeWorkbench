/**
 * AI 写入通道的落盘。
 * 高档：把链接区和 Agent 资料里的高档文件复制到收件箱，批准后按字节写回。不再在资料夹里新建 .kb-stage。
 * 旧的 plan.json 仍可批准。
 * 中档：软件备份。写完审查；不过则留在待批准，不自动还原。
 * 低档：软件备份，写完即放行。
 * 快速通道：不备份。
 * 数据放在调用方给的目录（应用目录 agent-data），不写 %LOCALAPPDATA%\LocalKnowledgeWorkbench。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import {
  applyUnifiedDiff,
  composeScopedLink,
  defaultSettings,
  isInside,
  isLocalKnowledgeUserData,
  MEDIUM_REVIEW_LABEL,
  normPath,
  normalizeHash,
  normalizeSettings,
  parsePlanFiles,
  reviewMediumChange,
  rootKey,
  strongestTier,
  tierFor,
  toWriteChannelSnapshot,
  type AiWriteApplyDecision,
  type AiWriteApplyResult,
  type AiWriteApproveResult,
  type AiWriteChangeView,
  type AiWriteDiscardResult,
  type AiWriteLegacyStage,
  type AiWriteLinkStatus,
  type AiWritePending,
  type AiWritePlanDropInput,
  type AiWritePlanDropResult,
  type AiWritePlanFileView,
  type AiWritePlanView,
  type AiWriteSettings,
  type LinkItem,
  type MediumReviewReason,
  type PlanFileInput,
  type WriteChannelSnapshot,
  type WriteTier,
} from '../../shared/aiWriteChannel';
import { resolveAgentDataRoot } from '../agentPanel/paths';
import { InboxEngine, type InboxLimits, type InboxSource } from './inboxCopy';

const MAX_ARM = 400;
const CHILD_CAP = 40;
const MAX_BYTES = 1_000_000;
const SKIP = new Set(['.git', 'node_modules', '.kb-stage', '$recycle.bin']);

export interface AiWriteRoot {
  path: string;
  name?: string;
}

interface ExpectedMap {
  [key: string]: { [rel: string]: string };
}

interface ConflictRec {
  id: string;
  path: string;
  expectedHash: string;
  previousHash: string;
  actualHash: string;
  bytesFile: string;
  canRestore: boolean;
  reasons?: MediumReviewReason[];
  zoneKey?: string;
  rel?: string;
  deleted?: boolean;
}

interface StagedPlan {
  planId: string;
  source: string;
  zonePath: string;
  files: PlanFileInput[];
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

export class AiWriteChannel {
  readonly dir: string;
  private readonly watchEnabled: boolean;
  private readonly now: () => Date;
  private settings: AiWriteSettings = defaultSettings();
  private roots: AiWriteRoot[] = [];
  private expected: ExpectedMap = {};
  private conflicts: ConflictRec[] = [];
  private plans: StagedPlan[] = [];
  private watchers: FSWatcher[] = [];
  private watchGen = 0;
  private quiet = new Set<string>();
  private started = false;
  /** 虚拟路径 id → 文件夹绝对路径。 */
  private zonePaths = new Map<string, string>();
  /** null 表示该高档区可以写任意相对路径；Set 只允许点名的文件。 */
  private highAllow = new Map<string, Set<string> | null>();
  private readonly inbox: InboxEngine;

  constructor(dir: string, opts?: { watch?: boolean; now?: () => Date; randomId?: () => string; trash?: (file: string) => Promise<void>; limits?: Partial<InboxLimits> }) {
    if (isLocalKnowledgeUserData(dir)) throw new Error('禁止写入 %LOCALAPPDATA%\\LocalKnowledgeWorkbench');
    this.dir = path.resolve(dir);
    if (isLocalKnowledgeUserData(this.dir)) throw new Error('禁止写入 %LOCALAPPDATA%\\LocalKnowledgeWorkbench');
    this.watchEnabled = opts?.watch === true;
    this.now = opts?.now ?? (() => new Date());
    this.inbox = new InboxEngine({
      dir: this.dir,
      now: this.now,
      randomId: opts?.randomId,
      trash: opts?.trash,
      limits: opts?.limits,
      backup: (key, rel, bytes) => this.backup(key, rel, bytes),
      assertSafe: (target) => this.assertSafe(target),
      writeFile: (file, bytes) => this.quietly(file, bytes),
      inboxRoot: () => this.settings.inboxRoot,
      discardConfirm: () => this.settings.inboxDiscardConfirm !== false,
    });
  }

  start(): void {
    if (this.started) return;
    this.assertSafe(this.dir);
    fs.mkdirSync(this.dir, { recursive: true });
    this.settings = this.readSettings();
    this.expected = this.readJson<ExpectedMap>(path.join(this.dir, 'expected.json')) ?? {};
    this.conflicts = this.readJson<ConflictRec[]>(path.join(this.dir, 'conflicts.json')) ?? [];
    this.inbox.pruneEnded();
    this.started = true;
  }

  async close(): Promise<void> {
    this.watchGen++;
    const open = this.watchers;
    this.watchers = [];
    await Promise.all(open.map((item) => Promise.resolve(item.close()).catch(() => undefined)));
  }

  getSettings(): AiWriteSettings {
    this.ensure();
    return this.settings;
  }

  setSettings(input: unknown): AiWriteSettings {
    this.ensure();
    const rawRoot = input && typeof input === 'object' && typeof (input as { inboxRoot?: unknown }).inboxRoot === 'string'
      ? (input as { inboxRoot: string }).inboxRoot.trim()
      : '';
    const next = normalizeSettings(input);
    if (rawRoot && !next.inboxRoot) throw new Error('收件箱不能放在 LocalKnowledgeWorkbench 用户目录里');
    if (next.inboxRoot) this.inbox.assertRoot(next.inboxRoot, this.guardZones(next));
    this.settings = next;
    this.atomic(path.join(this.dir, 'channel.json'), JSON.stringify(this.settings, null, 2));
    this.syncRoots(this.roots);
    return this.settings;
  }

  syncRoots(roots: readonly AiWriteRoot[]): void {
    this.ensure();
    this.roots = roots.filter((root) => root.path && !isLocalKnowledgeUserData(root.path)).map((root) => ({ path: path.resolve(root.path), name: root.name }));
    this.refreshScopes();
  }

  addLinkItems(raw: readonly { path?: string; name?: string; kind?: string }[]): LinkItem[] {
    this.ensure();
    const next = [...this.settings.linkItems];
    for (const row of raw) {
      const itemPath = typeof row.path === 'string' ? row.path.trim() : '';
      if (!itemPath || isLocalKnowledgeUserData(itemPath)) continue;
      const abs = path.resolve(itemPath);
      if (isLocalKnowledgeUserData(abs)) continue;
      let kind: 'dir' | 'file' = row.kind === 'file' ? 'file' : 'dir';
      try {
        const st = fs.statSync(abs);
        kind = st.isDirectory() ? 'dir' : 'file';
      } catch {
        /* 路径还不存在时保留调用方给的种类 */
      }
      const item: LinkItem = {
        id: `l_${rootKey(abs)}`,
        path: abs,
        name: (row.name?.trim() || path.basename(abs) || abs).slice(0, 80),
        kind,
      };
      const index = next.findIndex((entry) => entry.path === abs || rootKey(entry.path) === item.id.slice(2));
      if (index >= 0) next[index] = item;
      else next.push(item);
    }
    return this.storeLinkItems(next);
  }

  removeLinkItem(id: string): LinkItem[] {
    this.ensure();
    return this.storeLinkItems(this.settings.linkItems.filter((item) => item.id !== id));
  }

  clearLinkItems(): LinkItem[] {
    this.ensure();
    return this.storeLinkItems([]);
  }

  composeLink(input: { roots: readonly AiWriteRoot[]; entry: string; agentId?: string | null; materials?: readonly { absPath: string; name?: string }[]; target?: string }): string {
    this.syncRoots(input.roots);
    const sources = this.highSources(input.materials ?? []);
    let inboxPath: string | undefined;
    let inboxTarget: string | undefined;
    let truncated = false;
    if (sources.length) {
      if (!this.settings.inboxRoot) throw new Error('请先在设置里选择收件箱根目录');
      const session = this.inbox.prepare(this.settings.inboxRoot, sources, this.guardZones(this.settings));
      inboxPath = session.inboxDir;
      const mapped=input.target?session.files.find(file=>file.sourceAbs && path.resolve(file.sourceAbs)===path.resolve(input.target!)):undefined;
      if(mapped)inboxTarget=path.join(inboxPath,mapped.inboxRel);
      truncated = session.truncated;
      this.scheduleWatch();
    }
    const items = this.settings.linkItems.filter((item) => !isLocalKnowledgeUserData(item.path)).map((item) => {
      const tier = tierFor(item.path, this.settings);
      return {
        path: item.path,
        name: item.name,
        kind: item.kind,
        tier,
        childDirs: item.kind === 'dir' && tier !== 'high' ? this.childDirRels(item.path) : [],
      };
    });
    return composeScopedLink({ items, settings: this.settings, agentId: input.agentId, inboxPath, truncated })+(inboxTarget?'\nInbox target: '+JSON.stringify(inboxTarget):'');
  }

  collect(sessionId?: string): AiWriteChangeView[] {
    this.ensure();
    return this.inbox.collect(sessionId);
  }

  apply(input: { sessionId: string; fileId: string; decision: AiWriteApplyDecision; landingDir?: string }): Promise<AiWriteApplyResult> {
    this.ensure();
    return this.inbox.apply(input).finally(() => this.scheduleWatch());
  }

  planDrop(input: AiWritePlanDropInput): AiWritePlanDropResult {
    this.ensure();
    const inboxRoot = this.settings.inboxRoot ? path.resolve(this.settings.inboxRoot) : path.join(this.dir, 'inbox');
    const targetDir = input.targetRelPath ? path.resolve(input.targetRootPath, input.targetRelPath) : path.resolve(input.targetRootPath);
    return this.inbox.planDrop(inboxRoot, targetDir, input.files);
  }

  /** 资料夹里空的旧 .kb-stage，或只剩已处理计划的。有其它文件的不列入。只列出，不删除。 */
  listLegacyStages(): AiWriteLegacyStage[] {
    this.ensure();
    const parked = this.parkedPlanHashes();
    const found: AiWriteLegacyStage[] = [];
    const seen = new Set<string>();
    const consider = (dir: string) => {
      const abs = path.resolve(dir);
      const key = normPath(abs);
      if (seen.has(key)) return;
      seen.add(key);
      const kind = this.legacyKind(abs, parked);
      if (kind) found.push({ path: abs, kind });
    };
    for (const zone of this.legacyZones()) consider(path.join(zone, '.kb-stage'));
    const mirror = path.join(this.dir, 'stage');
    if (fs.existsSync(mirror)) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(mirror);
      } catch {
        names = [];
      }
      for (const name of names) {
        if (!/^[0-9a-f]{8}$/.test(name)) continue;
        consider(path.join(mirror, name));
      }
    }
    return found;
  }

  /** 用户确认之后才把清单里的目录移入回收站。不在清单里的拒绝。 */
  async trashLegacyStages(paths: readonly string[]): Promise<{ trashed: string[] }> {
    this.ensure();
    if (!paths.length) throw new Error('没有可清理的暂存');
    const trashed: string[] = [];
    for (const raw of paths) {
      if (typeof raw !== 'string' || !raw.trim()) throw new Error('没有可清理的暂存');
      const abs = path.resolve(raw);
      const allowed = this.listLegacyStages().some((row) => path.resolve(row.path) === abs);
      if (!allowed) throw new Error('这项不在可清理清单里');
      await this.inbox.trashPath(abs);
      trashed.push(abs);
    }
    return { trashed };
  }

  discardSession(sessionId?: string, confirm = false): Promise<AiWriteDiscardResult> {
    this.ensure();
    return this.inbox.discard(sessionId, confirm).finally(() => this.scheduleWatch());
  }

  linkStatus(): AiWriteLinkStatus {
    this.ensure();
    const rows = this.settings.linkItems.filter((item) => !isLocalKnowledgeUserData(item.path)).map((item) => ({
      id: item.id,
      kind: item.kind,
      path: item.path,
      name: item.name,
      tier: tierFor(item.path, this.settings),
      copied: 0,
      skipped: 0,
    }));
    return this.inbox.status({
      rows,
      hasHigh: rows.some((row) => row.tier === 'high'),
      inboxConfigured: Boolean(this.settings.inboxRoot),
    });
  }

  /** 监视器发现收件箱有写入时调用。只做标记，不进入批准。 */
  noteInboxActivity(absOrId: string): void {
    this.ensure();
    const sessionId = /^s_[0-9a-f]{8}$/.test(absOrId) ? absOrId : this.inbox.sessionIdForPath(absOrId);
    if (sessionId) this.inbox.markDirty(sessionId);
  }

  pending(): AiWritePending {
    this.ensure();
    this.scanInboxes();
    return {
      plans: this.plans.map((plan) => this.planView(plan)),
      conflicts: this.conflicts.map((row) => ({
        id: row.id,
        path: row.path,
        expectedHash: row.expectedHash,
        previousHash: row.previousHash,
        actualHash: row.actualHash,
        canRestore: row.canRestore,
        ...(row.reasons?.length ? { reasons: row.reasons.map((code) => MEDIUM_REVIEW_LABEL[code] ?? code) } : {}),
      })),
      changes: this.inbox.changeViews(),
    };
  }

  approve(planId: string, force = false): AiWriteApproveResult {
    this.ensure();
    this.scanInboxes();
    const plan = this.plans.find((item) => item.planId === planId);
    if (!plan) throw new Error('计划不存在或已经处理');
    const prepared: { abs: string; zone: string; rel: string; before: Buffer | null; next: Buffer; expected: string; actual: string }[] = [];
    for (const file of plan.files) {
      const target = this.resolveVirtual(file.virtualPath);
      const before = fs.existsSync(target.abs) && fs.statSync(target.abs).isFile() ? fs.readFileSync(target.abs) : null;
      const actual = before ? sha256(before) : '';
      const expected = normalizeHash(file.expectedHash);
      if (!force && actual !== expected) {
        return { ok: false, reason: 'conflict', file: target.abs, expectedHash: expected, actualHash: actual };
      }
      let nextText: string;
      try {
        nextText = file.content !== undefined ? file.content : applyUnifiedDiff(before ? before.toString('utf8') : '', file.unifiedDiff || '');
      } catch (err) {
        throw new Error(err instanceof Error ? err.message : String(err));
      }
      prepared.push({ abs: target.abs, zone: target.zone, rel: target.rel, before, next: Buffer.from(nextText, 'utf8'), expected, actual });
    }
    const written: string[] = [];
    for (const file of prepared) {
      if (file.before) this.backup(rootKey(file.zone), file.rel, file.before);
      this.quietly(file.abs, file.next);
      written.push(file.abs);
    }
    this.park(plan.source, 'processed');
    this.scanInboxes();
    return { ok: true, written };
  }

  reject(planId: string): void {
    this.ensure();
    this.scanInboxes();
    const plan = this.plans.find((item) => item.planId === planId);
    if (!plan) throw new Error('计划不存在或已经处理');
    this.park(plan.source, 'rejected');
    this.scanInboxes();
  }

  resolveConflict(id: string, action: 'keep' | 'restore'): void {
    this.ensure();
    const row = this.conflicts.find((item) => item.id === id);
    if (!row) throw new Error('冲突不存在');
    const located = this.locateConflict(row);
    if (action === 'keep') {
      const escaped = row.reasons?.includes('escape');
      if (row.deleted) {
        if (located) this.clearBaseline(located.key, located.rel);
      } else if (!escaped && row.bytesFile && fs.existsSync(row.bytesFile)) {
        const bytes = fs.readFileSync(row.bytesFile);
        this.quietly(row.path, bytes);
        if (located) {
          this.writePreimage(located.key, located.rel, bytes);
          this.setExpected(located.key, located.rel, sha256(bytes));
        }
      } else if (!escaped) throw new Error('暂存的改动已经不在');
    } else if (row.canRestore && located) {
      const prev = this.readPreimage(located.key, located.rel);
      if (prev) this.quietly(row.path, prev);
    }
    this.conflicts = this.conflicts.filter((item) => item.id !== id);
    this.atomic(path.join(this.dir, 'conflicts.json'), JSON.stringify(this.conflicts));
    if (row.bytesFile && fs.existsSync(row.bytesFile)) fs.rmSync(row.bytesFile, { force: true });
  }

  /** 监视器和工作台测试都走这里。removed 表示文件已被删掉。 */
  ingestPath(absPath: string, removed = false): void {
    this.ensure();
    const abs = path.resolve(absPath);
    if (this.quiet.has(abs)) return;
    if (this.shouldIgnore(abs)) return;
    const hit = this.hitFor(abs);
    if (!hit) return;
    if (!removed) {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) {
        if (hit.tier === 'medium') this.holdReview(abs, hit, Buffer.alloc(0), ['escape'], false);
        return;
      }
      if (!st.isFile() || st.size > MAX_BYTES) return;
    }
    const next = removed ? Buffer.alloc(0) : fs.readFileSync(abs);
    const key = rootKey(hit.zone);
    const prev = this.readPreimage(key, hit.rel);
    const prevHash = prev ? sha256(prev) : '';
    const expected = this.expected[key]?.[hit.rel] ?? null;
    const nextHash = sha256(next);
    if (!removed && prev && prevHash === nextHash) return;
    if (hit.tier === 'low') {
      this.acceptWrite(key, hit.rel, prev, prevHash, next, nextHash, removed);
      return;
    }
    let real = abs;
    if (!removed) {
      try {
        real = fs.realpathSync(abs);
      } catch {
        real = abs;
      }
    }
    const reasons = reviewMediumChange({
      previousHash: prevHash,
      expectedHash: expected,
      hadFile: expected !== null || prev !== null,
      zonePath: hit.zone,
      absPath: abs,
      rel: hit.rel,
      previousText: prev ? prev.toString('utf8') : '',
      nextText: next.toString('utf8'),
      markdown: /\.(md|markdown)$/i.test(abs),
    });
    if (!isInside(hit.zone, real)) reasons.push('escape');
    const unique = [...new Set(reasons)];
    if (unique.length) {
      this.holdReview(abs, hit, next, unique, removed);
      return;
    }
    this.acceptWrite(key, hit.rel, prev, prevHash, next, nextHash, removed);
  }

  private storeLinkItems(items: LinkItem[]): LinkItem[] {
    this.settings = normalizeSettings({ ...this.settings, linkItems: items });
    this.atomic(path.join(this.dir, 'channel.json'), JSON.stringify(this.settings, null, 2));
    this.refreshScopes();
    return this.settings.linkItems;
  }

  private guardZones(settings: AiWriteSettings): string[] {
    return [
      ...this.roots.map((root) => root.path),
      ...settings.folders.map((folder) => folder.path),
      ...settings.linkItems.filter((item) => item.kind === 'dir').map((item) => item.path),
    ].filter((item) => item && !isLocalKnowledgeUserData(item));
  }

  /** 链接区里档位为高的项，加上调用方给的高档文件。默认档为高也不扫描整个根。 */
  private highSources(materials: readonly { absPath: string; name?: string }[]): InboxSource[] {
    const dirs: InboxSource[] = [];
    const files: InboxSource[] = [];
    for (const item of this.settings.linkItems) {
      if (isLocalKnowledgeUserData(item.path)) continue;
      const abs = path.resolve(item.path);
      if (tierFor(abs, this.settings) !== 'high') continue;
      const source: InboxSource = { abs, name: item.name, kind: item.kind, parentItemId: item.id };
      if (item.kind === 'dir') dirs.push(source);
      else files.push(source);
    }
    for (const material of materials) {
      if (!material.absPath || isLocalKnowledgeUserData(material.absPath)) continue;
      const abs = path.resolve(material.absPath);
      if (tierFor(abs, this.settings) !== 'high') continue;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink() || !st.isFile()) continue;
      files.push({ abs, name: material.name?.trim() || path.basename(abs), kind: 'file', parentItemId: `m_${rootKey(abs)}` });
    }
    const kept: InboxSource[] = [];
    const seen = new Set<string>();
    const covered = (abs: string) => kept.some((item) => item.kind === 'dir' && (normPath(abs) === normPath(item.abs) || normPath(abs).startsWith(`${normPath(item.abs)}/`)));
    for (const dir of [...dirs].sort((a, b) => a.abs.length - b.abs.length)) {
      const key = normPath(dir.abs);
      if (seen.has(key) || covered(dir.abs)) continue;
      seen.add(key);
      kept.push(dir);
    }
    for (const file of files) {
      const key = normPath(file.abs);
      if (seen.has(key) || covered(file.abs)) continue;
      seen.add(key);
      kept.push(file);
    }
    return kept;
  }

  private refreshScopes(): void {
    for (const dir of this.mediumDirs()) this.armDir(dir);
    for (const dir of this.lowDirs()) this.armDir(dir);
    const skills = this.realSkillsDir();
    if (skills) this.armDir(skills);
    for (const file of [...this.looseFiles('medium'), ...this.looseFiles('low')]) this.armFile(file);
    this.indexZones();
    if (this.watchEnabled) void this.restartWatch();
  }

  private acceptWrite(key: string, rel: string, prev: Buffer | null, prevHash: string, next: Buffer, nextHash: string, removed: boolean): void {
    if (prev && prevHash !== nextHash) this.backup(key, rel, prev);
    if (removed) {
      this.clearBaseline(key, rel);
      return;
    }
    this.writePreimage(key, rel, next);
    this.setExpected(key, rel, nextHash);
  }

  private holdReview(abs: string, hit: { zone: string; rel: string }, next: Buffer, reasons: MediumReviewReason[], removed: boolean): void {
    const key = rootKey(hit.zone);
    const prev = this.readPreimage(key, hit.rel);
    const prevHash = prev ? sha256(prev) : '';
    const expected = this.expected[key]?.[hit.rel] ?? '';
    const nextHash = sha256(next);
    if (this.conflicts.some((item) => item.path === abs && item.actualHash === nextHash)) return;
    if (prev) this.backup(key, hit.rel, prev);
    const id = createHash('sha256').update(`${abs}\0${nextHash}\0${reasons.join(',')}`).digest('hex').slice(0, 16);
    const escaped = reasons.includes('escape');
    const bytesFile = !removed && !escaped ? path.join(this.dir, 'conflicts', `${id}.bin`) : '';
    if (bytesFile) this.atomic(bytesFile, next);
    this.conflicts.push({
      id,
      path: abs,
      expectedHash: expected,
      previousHash: prevHash,
      actualHash: nextHash,
      bytesFile,
      canRestore: Boolean(prev) && !escaped,
      reasons,
      zoneKey: key,
      rel: hit.rel,
      deleted: removed,
    });
    this.atomic(path.join(this.dir, 'conflicts.json'), JSON.stringify(this.conflicts));
  }

  private locateConflict(row: ConflictRec): { key: string; rel: string } | null {
    if (row.zoneKey && row.rel) return { key: row.zoneKey, rel: row.rel };
    const zone = this.coveringDir(row.path, 'medium') ?? this.coveringDir(row.path, 'low');
    if (!zone) return null;
    return { key: rootKey(zone), rel: path.relative(zone, row.path).split(path.sep).join('/') };
  }

  private clearBaseline(key: string, rel: string): void {
    const file = this.preimagePath(key, rel);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    const bucket = this.expected[key];
    if (!bucket || !(rel in bucket)) return;
    delete bucket[rel];
    this.expected[key] = bucket;
    this.atomic(path.join(this.dir, 'expected.json'), JSON.stringify(this.expected));
  }

  private ensure(): void {
    if (!this.started) this.start();
  }

  private assertSafe(target: string): void {
    if (isLocalKnowledgeUserData(target)) throw new Error('禁止写入 %LOCALAPPDATA%\\LocalKnowledgeWorkbench');
  }

  private atomic(file: string, data: Buffer | string): void {
    this.assertSafe(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.kb-tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }

  private quietly(file: string, data: Buffer): void {
    const abs = path.resolve(file);
    this.quiet.add(abs);
    try {
      this.atomic(abs, data);
    } finally {
      const timer = setTimeout(() => this.quiet.delete(abs), 400);
      timer.unref?.();
    }
  }

  private readSettings(): AiWriteSettings {
    const file = path.join(this.dir, 'channel.json');
    if (!fs.existsSync(file)) return defaultSettings();
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return defaultSettings();
    }
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private zones(): { path: string; name?: string; tier: WriteTier }[] {
    const list: { path: string; name?: string; tier: WriteTier }[] = [];
    for (const root of this.roots) list.push({ path: root.path, name: root.name, tier: tierFor(root.path, this.settings) });
    for (const rule of this.settings.folders) {
      if (isLocalKnowledgeUserData(rule.path)) continue;
      const resolved = path.resolve(rule.path);
      if (list.some((zone) => zone.path === resolved)) continue;
      list.push({ path: resolved, name: path.basename(resolved), tier: rule.tier });
    }
    return list;
  }

  private isDir(abs: string): boolean {
    try {
      return fs.statSync(abs).isDirectory();
    } catch {
      return false;
    }
  }

  private pushDir(dirs: string[], abs: string): void {
    if (!abs || isLocalKnowledgeUserData(abs) || !this.isDir(abs)) return;
    if (dirs.some((dir) => abs === dir || abs.startsWith(`${dir}${path.sep}`))) return;
    const nested = dirs.filter((dir) => dir.startsWith(`${abs}${path.sep}`));
    for (const dir of nested) dirs.splice(dirs.indexOf(dir), 1);
    dirs.push(abs);
  }

  private dirsFor(tier: WriteTier): string[] {
    const dirs: string[] = [];
    for (const zone of this.zones()) if (zone.tier === tier) this.pushDir(dirs, zone.path);
    for (const item of this.settings.linkItems) {
      if (item.kind !== 'dir' || isLocalKnowledgeUserData(item.path)) continue;
      const abs = path.resolve(item.path);
      if (tierFor(abs, this.settings) === tier) this.pushDir(dirs, abs);
    }
    return dirs;
  }

  private highDirs(): string[] {
    return this.dirsFor('high');
  }

  private mediumDirs(): string[] {
    return this.dirsFor('medium');
  }

  private lowDirs(): string[] {
    return this.dirsFor('low');
  }

  /**
   * 蒸馏落点用的档位：有链接项时取最强档，否则用默认档。
   * 和重生链接里的 distill 档位同一条规则。
   */
  private distillTier(): WriteTier {
    const items = this.settings.linkItems.filter((item) => item.path && !isLocalKnowledgeUserData(item.path));
    if (!items.length) return this.settings.defaultTier;
    return strongestTier(items.map((item) => tierFor(item.path, this.settings)));
  }

  /** 中、低档才对技能库做软件备份。高档走收件箱，快速通道不备份。 */
  private skillBackupTier(): 'medium' | 'low' | null {
    const tier = this.distillTier();
    return tier === 'medium' || tier === 'low' ? tier : null;
  }

  /** <agent-data>/skills。通道目录是 <agent-data>/ai-write。 */
  private skillsDir(): string {
    return path.resolve(this.dir, '..', 'skills');
  }

  /** 真实目录才纳入备份。符号链接不跟随，避免把库外文件收进预映像。 */
  private realSkillsDir(): string | null {
    if (!this.skillBackupTier()) return null;
    const dir = this.skillsDir();
    if (!dir || isLocalKnowledgeUserData(dir)) return null;
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
      return dir;
    } catch {
      return null;
    }
  }

  private skillHit(abs: string): { tier: 'medium' | 'low'; zone: string; rel: string } | null {
    const tier = this.skillBackupTier();
    const zone = this.realSkillsDir();
    if (!tier || !zone) return null;
    const target = path.resolve(abs);
    if (target === zone || !target.startsWith(`${zone}${path.sep}`)) return null;
    const rel = path.relative(zone, target).split(path.sep).join('/');
    if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) return null;
    return { tier, zone, rel };
  }

  private outsideSkills(root: string, skills: string, watched: string): boolean {
    const abs = path.resolve(watched);
    const base = path.resolve(root);
    const zone = path.resolve(skills);
    if (abs === base) return false;
    if (abs === zone || abs.startsWith(`${zone}${path.sep}`)) return this.shouldIgnore(abs);
    return true;
  }

  private looseFiles(tier: WriteTier): string[] {
    const dirs = this.dirsFor(tier);
    const out: string[] = [];
    for (const item of this.settings.linkItems) {
      if (item.kind !== 'file' || isLocalKnowledgeUserData(item.path)) continue;
      const abs = path.resolve(item.path);
      if (tierFor(abs, this.settings) !== tier) continue;
      if (dirs.some((dir) => abs === dir || abs.startsWith(`${dir}${path.sep}`))) continue;
      if (!fs.existsSync(abs)) continue;
      out.push(abs);
    }
    return out;
  }

  private coveringDir(abs: string, tier: WriteTier): string | null {
    const target = path.resolve(abs);
    let best: string | null = null;
    for (const dir of this.dirsFor(tier)) {
      if (target === dir || target.startsWith(`${dir}${path.sep}`)) {
        if (!best || dir.length > best.length) best = dir;
      }
    }
    return best;
  }

  private hitFor(abs: string): { tier: 'medium' | 'low'; zone: string; rel: string } | null {
    const skillHit = this.skillHit(abs);
    if (skillHit) return skillHit;
    const tier = tierFor(abs, this.settings);
    if (tier !== 'medium' && tier !== 'low') return null;
    const zone = this.coveringDir(abs, tier);
    if (zone && abs !== zone) {
      const rel = path.relative(zone, abs).split(path.sep).join('/');
      if (!rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) return null;
      return { tier, zone, rel };
    }
    if (this.looseFiles(tier).some((file) => path.resolve(file) === abs)) {
      return { tier, zone: path.dirname(abs), rel: path.basename(abs) };
    }
    return null;
  }

  private indexZones(): void {
    this.zonePaths.clear();
    this.highAllow.clear();
    const open = (dir: string) => {
      const key = rootKey(dir);
      this.zonePaths.set(key, dir);
      this.highAllow.set(key, null);
    };
    for (const dir of this.highDirs()) open(dir);
    for (const item of this.settings.linkItems) {
      if (isLocalKnowledgeUserData(item.path)) continue;
      const abs = path.resolve(item.path);
      if (tierFor(abs, this.settings) !== 'high' || item.kind !== 'file') continue;
      const parent = path.dirname(abs);
      const key = rootKey(parent);
      if (this.highAllow.get(key) === null && this.zonePaths.has(key)) continue;
      if (!this.zonePaths.has(key)) this.zonePaths.set(key, parent);
      const allow = this.highAllow.get(key);
      const set = allow ?? new Set<string>();
      set.add(path.basename(abs));
      this.highAllow.set(key, set);
    }
  }

  private zoneByKey(key: string): string | null {
    return this.zonePaths.get(key) ?? null;
  }

  private childDirRels(dir: string): string[] {
    const out: string[] = [];
    let truncated = false;
    const visit = (abs: string, rel: string, depth: number) => {
      if (depth > 3) return;
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs);
      } catch {
        return;
      }
      names.sort();
      for (const name of names) {
        if (SKIP.has(name.toLowerCase())) continue;
        const child = path.join(abs, name);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(child);
        } catch {
          continue;
        }
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        if (out.length >= CHILD_CAP) {
          truncated = true;
          return;
        }
        const next = rel ? `${rel}/${name}` : name;
        out.push(next);
        visit(child, next, depth + 1);
        if (truncated) return;
      }
    };
    if (this.isDir(dir)) visit(dir, '', 0);
    if (truncated) out.push('（子文件夹已截断）');
    return out;
  }

  private armDir(dir: string): void {
    const key = rootKey(dir);
    for (const file of this.walk(dir, MAX_ARM)) {
      if (this.readPreimage(key, file.rel)) continue;
      this.writePreimage(key, file.rel, file.bytes);
      if (!this.expected[key]?.[file.rel]) this.setExpected(key, file.rel, file.hash);
    }
  }

  private armFile(abs: string): void {
    const key = rootKey(path.dirname(abs));
    const rel = path.basename(abs);
    if (this.readPreimage(key, rel)) return;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_BYTES) return;
    const bytes = fs.readFileSync(abs);
    this.writePreimage(key, rel, bytes);
    if (!this.expected[key]?.[rel]) this.setExpected(key, rel, sha256(bytes));
  }

  private walk(dir: string, cap: number): { rel: string; hash: string; bytes: Buffer }[] {
    const out: { rel: string; hash: string; bytes: Buffer }[] = [];
    const visit = (abs: string, rel: string, depth: number) => {
      if (out.length >= cap || depth > 8) return;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        if (SKIP.has(path.basename(abs).toLowerCase()) && rel) return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          return;
        }
        names.sort();
        for (const name of names) {
          if (SKIP.has(name.toLowerCase())) continue;
          visit(path.join(abs, name), rel ? `${rel}/${name}` : name, depth + 1);
        }
        return;
      }
      if (!st.isFile() || st.size > MAX_BYTES) return;
      const bytes = fs.readFileSync(abs);
      out.push({ rel, hash: sha256(bytes), bytes });
    };
    visit(dir, '', 0);
    return out;
  }

  private preimagePath(key: string, rel: string): string {
    const safe = rel.split('/').filter((part) => part && part !== '.' && part !== '..');
    return path.join(this.dir, 'preimage', key, ...safe);
  }

  private readPreimage(key: string, rel: string): Buffer | null {
    const file = this.preimagePath(key, rel);
    try {
      return fs.readFileSync(file);
    } catch {
      return null;
    }
  }

  private writePreimage(key: string, rel: string, bytes: Buffer): void {
    this.atomic(this.preimagePath(key, rel), bytes);
  }

  private setExpected(key: string, rel: string, hash: string): void {
    const bucket = this.expected[key] ?? {};
    bucket[rel] = hash;
    this.expected[key] = bucket;
    this.atomic(path.join(this.dir, 'expected.json'), JSON.stringify(this.expected));
  }

  private backup(key: string, rel: string, bytes: Buffer): void {
    const safe = rel.split('/').filter((part) => part && part !== '.' && part !== '..');
    const base = safe.pop() || 'file';
    const dest = path.join(this.dir, 'backups', key, ...safe, `${base}.${stamp(this.now())}.${sha256(bytes).slice(0, 12)}.bak`);
    this.atomic(dest, bytes);
  }

  private scheduleWatch(): void {
    if (this.watchEnabled) void this.restartWatch();
  }

  private outsideInbox(root: string, watched: string): boolean {
    const abs = path.resolve(watched);
    const base = path.resolve(root);
    return abs !== base && !abs.startsWith(`${base}${path.sep}`);
  }

  private legacyZones(): string[] {
    const zones: string[] = [];
    const push = (abs: string) => {
      if (!abs || isLocalKnowledgeUserData(abs)) return;
      const resolved = path.resolve(abs);
      if (!zones.includes(resolved)) zones.push(resolved);
    };
    for (const root of this.roots) push(root.path);
    for (const rule of this.settings.folders) push(rule.path);
    for (const item of this.settings.linkItems) {
      if (isLocalKnowledgeUserData(item.path)) continue;
      const abs = path.resolve(item.path);
      push(item.kind === 'file' ? path.dirname(abs) : abs);
    }
    return zones;
  }

  private parkedPlanHashes(): Set<string> {
    const hashes = new Set<string>();
    const take = (abs: string) => {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          return;
        }
        for (const name of names) take(path.join(abs, name));
        return;
      }
      if (!st.isFile()) return;
      try {
        hashes.add(sha256(fs.readFileSync(abs)));
      } catch {
        /* 读不到的已处理计划不拿来对照 */
      }
    };
    take(path.join(this.dir, 'processed'));
    take(path.join(this.dir, 'rejected'));
    return hashes;
  }

  /** 空目录，或每个文件都是已处理计划的副本。符号链接和其它文件都不列入。 */
  private legacyKind(dir: string, parked: ReadonlySet<string>): 'empty' | 'processed-plan' | null {
    const base = path.basename(dir);
    const mirror = path.resolve(this.dir, 'stage');
    const underMirror = path.resolve(path.dirname(dir)) === mirror && /^[0-9a-f]{8}$/.test(base);
    if (base !== '.kb-stage' && !underMirror) return null;
    if (isLocalKnowledgeUserData(dir)) return null;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return null;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
    let files = 0;
    let processed = 0;
    let blocked = false;
    const walk = (abs: string) => {
      if (blocked) return;
      let cur: fs.Stats;
      try {
        cur = fs.lstatSync(abs);
      } catch {
        blocked = true;
        return;
      }
      if (cur.isSymbolicLink()) {
        blocked = true;
        return;
      }
      if (cur.isDirectory()) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          blocked = true;
          return;
        }
        for (const name of names) walk(path.join(abs, name));
        return;
      }
      if (!cur.isFile()) {
        blocked = true;
        return;
      }
      files += 1;
      if (!path.basename(abs).toLowerCase().endsWith('.json')) {
        blocked = true;
        return;
      }
      try {
        if (parked.has(sha256(fs.readFileSync(abs)))) processed += 1;
        else blocked = true;
      } catch {
        blocked = true;
      }
    };
    walk(dir);
    if (blocked) return null;
    if (files === 0) return 'empty';
    if (processed === files) return 'processed-plan';
    return null;
  }

  private shouldIgnore(abs: string): boolean {
    if (abs === this.dir || abs.startsWith(`${this.dir}${path.sep}`)) return true;
    const parts = abs.split(path.sep).map((part) => part.toLowerCase());
    return parts.some((part) => SKIP.has(part));
  }

  private async restartWatch(): Promise<void> {
    const gen = ++this.watchGen;
    const old = this.watchers;
    this.watchers = [];
    await Promise.all(old.map((item) => Promise.resolve(item.close()).catch(() => undefined)));
    if (!this.watchEnabled || gen !== this.watchGen) return;
    const opened: FSWatcher[] = [];
    const watchOpts = {
      ignoreInitial: true,
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      ignored: (watched: string) => this.shouldIgnore(watched),
    };
    const backupDirs = [...this.mediumDirs(), ...this.lowDirs()];
    const skills = this.realSkillsDir();
    if (skills && !backupDirs.some((dir) => path.resolve(dir) === skills)) backupDirs.push(skills);
    for (const dir of backupDirs) {
      opened.push(watch(dir, watchOpts).on('add', (file) => this.ingestPath(file)).on('change', (file) => this.ingestPath(file)).on('unlink', (file) => this.ingestPath(file, true)));
    }
    if (!skills && this.skillBackupTier()) {
      const root = path.resolve(this.dir, '..');
      const skillsPath = this.skillsDir();
      if (!isLocalKnowledgeUserData(root) && !isLocalKnowledgeUserData(skillsPath)) {
        opened.push(watch(root, {
          ignoreInitial: true,
          depth: 8,
          followSymlinks: false,
          awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
          ignored: (watched: string) => this.outsideSkills(root, skillsPath, String(watched)),
        }).on('add', (file) => this.ingestPath(String(file)))
          .on('change', (file) => this.ingestPath(String(file)))
          .on('unlink', (file) => this.ingestPath(String(file), true)));
      }
    }
    for (const file of [...this.looseFiles('medium'), ...this.looseFiles('low')]) {
      opened.push(watch(file, { ignoreInitial: true }).on('change', () => this.ingestPath(file)).on('unlink', () => this.ingestPath(file, true)));
    }
    for (const dir of this.inbox.openInboxDirs()) {
      opened.push(watch(dir, {
        ignoreInitial: true,
        depth: 8,
        followSymlinks: false,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
        ignored: (watched: string) => this.outsideInbox(dir, watched),
      }).on('add', (file) => this.noteInboxActivity(String(file)))
        .on('change', (file) => this.noteInboxActivity(String(file)))
        .on('unlink', (file) => this.noteInboxActivity(String(file))));
    }
    if (gen !== this.watchGen) {
      await Promise.all(opened.map((item) => Promise.resolve(item.close()).catch(() => undefined)));
      return;
    }
    this.watchers = opened;
  }

  private scanInboxes(): void {
    const found: StagedPlan[] = [];
    const take = (inbox: string, zone: string) => {
      if (!fs.existsSync(inbox)) return;
      let names: string[] = [];
      try {
        names = fs.readdirSync(inbox);
      } catch {
        return;
      }
      for (const name of names) {
        if (!name.endsWith('.json') || name.endsWith('.kb-tmp')) continue;
        const source = path.join(inbox, name);
        try {
          const parsed = JSON.parse(fs.readFileSync(source, 'utf8')) as unknown;
          const files = parsePlanFiles(parsed);
          const planId = createHash('sha256').update(fs.readFileSync(source)).digest('hex').slice(0, 16);
          found.push({ planId, source, zonePath: zone, files });
        } catch {
          /* 没写完或格式不对的计划先留在暂存区 */
        }
      }
    };
    for (const dir of this.highDirs()) {
      take(path.join(dir, '.kb-stage', 'inbox'), dir);
      take(path.join(this.dir, 'stage', rootKey(dir), 'inbox'), dir);
    }
    this.plans = found;
  }

  private resolveVirtual(virtualPath: string): { abs: string; rel: string; zone: string } {
    const match = /^kb-stage:\/\/([0-9a-f]{8})\/(.+)$/i.exec(virtualPath.trim());
    if (!match) throw new Error('虚拟路径无法对应到暂存区');
    const key = match[1]!.toLowerCase();
    const rel = match[2]!.replace(/\\/g, '/');
    if (rel.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('虚拟路径越出暂存区');
    const zone = this.zoneByKey(key);
    if (!zone) throw new Error('虚拟路径没有对应的文件夹');
    const allow = this.highAllow.get(key);
    if (allow && !allow.has(rel)) throw new Error('虚拟路径不在链接区给出的文件里');
    const abs = path.resolve(zone, ...rel.split('/'));
    const root = path.resolve(zone);
    if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) throw new Error('虚拟路径越出暂存区');
    this.assertSafe(abs);
    return { abs, rel, zone: root };
  }

  private planView(plan: StagedPlan): AiWritePlanView {
    const files: AiWritePlanFileView[] = [];
    for (const file of plan.files) {
      let rel = file.virtualPath;
      let oldText = '';
      let newText = '';
      let actual = '';
      let note: string | undefined;
      let conflict = false;
      try {
        const target = this.resolveVirtual(file.virtualPath);
        rel = target.rel;
        const before = fs.existsSync(target.abs) && fs.statSync(target.abs).isFile() ? fs.readFileSync(target.abs) : null;
        actual = before ? sha256(before) : '';
        oldText = clip(before ? before.toString('utf8') : '');
        newText = clip(file.content !== undefined ? file.content : applyUnifiedDiff(before ? before.toString('utf8') : '', file.unifiedDiff || ''));
        conflict = actual !== normalizeHash(file.expectedHash);
      } catch (err) {
        conflict = true;
        note = err instanceof Error ? err.message : String(err);
      }
      files.push({ virtualPath: file.virtualPath, rel, expectedHash: normalizeHash(file.expectedHash), actualHash: actual, conflict, oldText, newText, note });
    }
    return { planId: plan.planId, rootName: path.basename(plan.zonePath), virtualRoot: `kb-stage://${rootKey(plan.zonePath)}`, files };
  }

  private park(source: string, bucket: 'processed' | 'rejected'): void {
    const dest = path.join(this.dir, bucket, `${path.basename(source, '.json')}.${stamp(this.now())}.json`);
    this.assertSafe(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(source, dest);
  }
}

function clip(text: string): string {
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…（预览已截断）` : text;
}

/** 给入口写入器。没有 channel.json 就不追加字段。进行中的会话才带收件箱目录。 */
export function loadWriteChannelSnapshot(roots: readonly AiWriteRoot[]): WriteChannelSnapshot | undefined {
  try {
    const resolved = resolveAgentDataRoot();
    if (!resolved || isLocalKnowledgeUserData(resolved.root)) return undefined;
    const dir = path.join(resolved.root, 'ai-write');
    const file = path.join(dir, 'channel.json');
    if (isLocalKnowledgeUserData(file) || !fs.existsSync(file)) return undefined;
    return toWriteChannelSnapshot(normalizeSettings(JSON.parse(fs.readFileSync(file, 'utf8'))), roots, readOpenInboxDir(dir));
  } catch {
    return undefined;
  }
}

function readOpenInboxDir(aiWriteDir: string): string | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(aiWriteDir, 'sessions', 'index.json'), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return undefined;
    for (let i = raw.length - 1; i >= 0; i -= 1) {
      const row = raw[i] as { status?: unknown; inboxDir?: unknown };
      if (!row || (row.status !== 'open' && row.status !== 'collected')) continue;
      if (typeof row.inboxDir !== 'string') continue;
      const inboxDir = row.inboxDir.trim();
      if (inboxDir && !isLocalKnowledgeUserData(inboxDir)) return inboxDir;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
