/**
 * 高档收件箱副本。清单和备份都在 ai-write 目录，不放进收件箱，也不写进资料夹。
 * 原件只在用户批准之后才写。删除原件只走调用方给的回收站函数。
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isInside,
  isLocalKnowledgeUserData,
  normPath,
  rootKey,
  DISCARD_PENDING_WARNING,
  type AiWriteApplyDecision,
  type AiWriteApplyResult,
  type AiWriteChangeView,
  type AiWriteDiscardResult,
  type AiWriteLinkStatus,
  type AiWritePlanDropResult,
  type InboxChangeOp,
} from '../../shared/aiWriteChannel';
import { skillLandingFromInboxRel } from '../../shared/skillLibrary';
import { assertIncomingSkillSize, backupSkillDirectory, locateSkillFile, skillDestAllowed } from '../skills/library';

const SKIP = new Set(['.git', 'node_modules', '.kb-stage', '$recycle.bin']);
const DAY_MS = 24 * 60 * 60 * 1000;
const PREVIEW_CAP = 20_000;
const PREVIEW_READ = 256 * 1024;

export interface InboxLimits {
  maxFile: number;
  maxFiles: number;
  maxTotal: number;
}

export const DEFAULT_INBOX_LIMITS: InboxLimits = {
  maxFile: 32 * 1024 * 1024,
  maxFiles: 2000,
  maxTotal: 512 * 1024 * 1024,
};

export interface InboxSource {
  abs: string;
  name: string;
  kind: 'dir' | 'file';
  parentItemId: string;
}

export interface SessionFileRec {
  id: string;
  role: 'copy' | 'created';
  inboxRel: string;
  sourceAbs?: string;
  landingAbs: string;
  parentItemId: string;
  copyHash: string;
  copySize: number;
  binary: boolean;
}

export interface SessionChangeRec {
  fileId: string;
  op: InboxChangeOp;
  inboxHash: string;
  originHash: string;
  decision?: AiWriteApplyDecision;
  pairId?: string;
  binary: boolean;
  nextSize: number;
  needsLanding: boolean;
}

export interface SessionDirRec {
  inboxRel: string;
  sourceAbs: string;
  parentItemId: string;
}

export interface SessionStatRec {
  parentItemId: string;
  copied: number;
  skipped: number;
  reason?: string;
}

export type SessionStatus = 'open' | 'collected' | 'applied' | 'rejected' | 'discarded';

export interface SessionDoc {
  v: 1;
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  endedAt?: string;
  inboxDir: string;
  truncated: boolean;
  skipped: number;
  sourceKey: string;
  dirty: boolean;
  files: SessionFileRec[];
  dirs: SessionDirRec[];
  changes: SessionChangeRec[];
  stats: SessionStatRec[];
}

interface IndexRow {
  sessionId: string;
  status: SessionStatus;
  createdAt: string;
  inboxDir: string;
  sourceCount: number;
}

export interface InboxEngineOpts {
  dir: string;
  now: () => Date;
  randomId?: () => string;
  trash?: (file: string) => Promise<void>;
  limits?: Partial<InboxLimits>;
  /** 当前设置里的收件箱根。删除会话目录时用来做 realpath 边界。 */
  inboxRoot?: () => string | undefined;
  /** 结束会话前是否要用户确认待删清单。默认要。 */
  discardConfirm?: () => boolean;
  backup: (zoneKey: string, rel: string, bytes: Buffer) => void;
  assertSafe: (target: string) => void;
  writeFile: (file: string, bytes: Buffer) => void;
}

interface ListedFile {
  hash: string;
  size: number;
  binary: boolean;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))}KB`;
  const mb = n / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)}MB`;
}

function sanitizeName(name: string): string {
  const base = name.replace(/[\\/]/g, '').replace(/^\.+/, '').replace(/[\u0000-\u001f]/g, '').trim();
  if (!base || base === '.' || base === '..') return 'item';
  return base.slice(0, 80);
}

function isSessionId(value: string): boolean {
  return /^s_[0-9a-f]{8}$/.test(value);
}

/**
 * 符号链接或 Windows 联接点。
 * Node 的 lstat 把联接点报成符号链接。Windows 上再读一次 readlink，避免漏掉只标了重解析点的目录。
 */
function isLinkOrJunction(abs: string, st: fs.Stats): boolean {
  if (st.isSymbolicLink()) return true;
  if (process.platform !== 'win32') return false;
  try {
    fs.readlinkSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** 严格在根里面。等于根不算。 */
function strictlyUnder(parent: string, child: string): boolean {
  const root = normPath(parent);
  const target = normPath(child);
  return target.startsWith(`${root}/`);
}

/**
 * 核对会话目录能否删。
 * 收件箱根和目标都做 realpath，目标必须严格落在根的真实路径里，且不能等于根。
 * 从目标走到收件箱根，每一段都 lstat。目标、根，或这一段上的符号链接 / Windows 联接点都拒绝。
 * 根以上的系统路径不拦（有的环境里临时目录本身是符号链接），那些由两边的 realpath 对齐。
 */
function assertSessionPath(root: string, target: string): void {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  if (normPath(rootAbs) === normPath(targetAbs)) throw new Error('不能删除收件箱根');
  if (normPath(path.dirname(targetAbs)) !== normPath(rootAbs)) throw new Error('收件箱路径异常');
  let cur = targetAbs;
  const seen = new Set<string>();
  while (normPath(cur) !== normPath(rootAbs)) {
    if (seen.has(normPath(cur))) throw new Error('收件箱路径异常');
    seen.add(normPath(cur));
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && normPath(cur) === normPath(targetAbs)) {
        cur = path.dirname(cur);
        continue;
      }
      throw new Error('收件箱路径异常');
    }
    if (isLinkOrJunction(cur, st)) throw new Error('收件箱路径含有符号链接，已拒绝删除');
    const parent = path.dirname(cur);
    if (parent === cur) throw new Error('收件箱路径异常');
    cur = parent;
  }
  let rootSt: fs.Stats;
  try {
    rootSt = fs.lstatSync(rootAbs);
  } catch {
    throw new Error('收件箱路径异常');
  }
  if (isLinkOrJunction(rootAbs, rootSt)) throw new Error('收件箱路径含有符号链接，已拒绝删除');
  if (!rootSt.isDirectory()) throw new Error('收件箱路径异常');
  const rootReal = fs.realpathSync(rootAbs);
  if (normPath(rootReal) === normPath(targetAbs)) throw new Error('不能删除收件箱根');
  let targetSt: fs.Stats;
  try {
    targetSt = fs.lstatSync(targetAbs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error('收件箱路径异常');
  }
  if (isLinkOrJunction(targetAbs, targetSt)) throw new Error('收件箱路径含有符号链接，已拒绝删除');
  if (!targetSt.isDirectory()) throw new Error('收件箱路径异常');
  const targetReal = fs.realpathSync(targetAbs);
  if (normPath(targetReal) === normPath(rootReal)) throw new Error('不能删除收件箱根');
  if (!strictlyUnder(rootReal, targetReal)) throw new Error('收件箱路径越出根目录');
}

/**
 * 数会话目录里的普通文件。遇到符号链接或联接点就抛出，调用方不得再删。
 * 这里选择整单拒绝，而不是只解除链接本身：检查之后、动手之前，链接可能被换成目录。
 * 只 unlink 链接仍可能跟着删到外面。整单拒绝时链接目标和会话目录都留在原地，一个文件都不删。
 */
function countFilesOrRefuse(dir: string): number {
  let files = 0;
  const walk = (abs: string) => {
    const st = fs.lstatSync(abs);
    if (isLinkOrJunction(abs, st)) throw new Error('收件箱里有符号链接，已拒绝删除');
    if (st.isDirectory()) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(abs);
      } catch {
        throw new Error('收件箱路径异常');
      }
      for (const name of names) walk(path.join(abs, name));
      return;
    }
    if (!st.isFile()) throw new Error('收件箱路径异常');
    files += 1;
  };
  walk(dir);
  return files;
}

function relParts(rel: string): string[] {
  const parts = rel.split('/').filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) throw new Error('路径越出收件箱');
  return parts;
}

export class InboxEngine {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly randomId?: () => string;
  private readonly trashFn?: (file: string) => Promise<void>;
  private readonly inboxRoot: () => string | undefined;
  private readonly discardNeedsConfirm: () => boolean;
  private readonly limits: InboxLimits;
  private readonly backup: InboxEngineOpts['backup'];
  private readonly assertSafe: (target: string) => void;
  private readonly writeFile: (file: string, bytes: Buffer) => void;
  /** 正在复制的收件箱。这段时间的监视事件不算「未收取」。 */
  private readonly hushed = new Set<string>();

  constructor(opts: InboxEngineOpts) {
    this.dir = opts.dir;
    this.now = opts.now;
    this.randomId = opts.randomId;
    this.trashFn = opts.trash;
    this.inboxRoot = opts.inboxRoot ?? (() => undefined);
    this.discardNeedsConfirm = opts.discardConfirm ?? (() => true);
    this.limits = { ...DEFAULT_INBOX_LIMITS, ...opts.limits };
    this.backup = opts.backup;
    this.assertSafe = opts.assertSafe;
    this.writeFile = opts.writeFile;
  }

  assertRoot(root: string, zones: readonly string[]): void {
    const trimmed = root.trim();
    if (!trimmed) throw new Error('请先在设置里选择收件箱根目录');
    if (!path.isAbsolute(trimmed)) throw new Error('收件箱根必须是绝对路径');
    const abs = path.resolve(trimmed);
    if (isLocalKnowledgeUserData(abs) || isLocalKnowledgeUserData(trimmed)) throw new Error('收件箱不能放在 LocalKnowledgeWorkbench 用户目录里');
    const agentData = this.agentDataRoot();
    if (isInside(agentData, abs) || isInside(abs, agentData)) throw new Error('收件箱不能放在 agent-data 里');
    for (const zone of zones) {
      if (!zone || isLocalKnowledgeUserData(zone)) continue;
      const resolved = path.resolve(zone);
      if (isInside(resolved, abs)) throw new Error('收件箱不能放在资料目录里');
      if (isInside(abs, resolved)) throw new Error('收件箱不能包住资料目录');
    }
  }

  prepare(inboxRoot: string, sources: readonly InboxSource[], zones: readonly string[]): SessionDoc {
    this.assertRoot(inboxRoot, zones);
    const root = path.resolve(inboxRoot);
    for (const source of sources) {
      if (isInside(root, source.abs)) throw new Error('收件箱不能包住要复制的资料');
    }
    fs.mkdirSync(root, { recursive: true });
    this.assertRealDir(root);
    const sourceKey = hashSources(sources);
    const reusable = this.findReusable(root, sourceKey);
    if (reusable) return reusable;
    const sessionId = this.allocId();
    const inboxDir = path.join(root, sessionId);
    this.hushed.add(path.resolve(inboxDir));
    const doc: SessionDoc = {
      v: 1,
      sessionId,
      status: 'open',
      createdAt: this.now().toISOString(),
      inboxDir,
      truncated: false,
      skipped: 0,
      sourceKey,
      dirty: false,
      files: [],
      dirs: [],
      changes: [],
      stats: [],
    };
    try {
      fs.mkdirSync(inboxDir);
      this.assertRealDir(inboxDir, root);
      this.copySources(doc, sources);
      this.save(doc);
      this.upsertIndex(doc, sources.length);
    } catch (err) {
      this.rollbackPrepared(root, inboxDir, sessionId);
      throw err;
    } finally {
      this.hushed.delete(path.resolve(inboxDir));
    }
    return doc;
  }

  planDrop(
    inboxRoot: string,
    targetDir: string,
    files: { name: string; sourceAbs?: string; resourceId?: string }[],
  ): AiWritePlanDropResult {
    fs.mkdirSync(inboxRoot, { recursive: true });
    const sessionId = this.allocId();
    const inboxDir = path.join(inboxRoot, sessionId);
    fs.mkdirSync(inboxDir, { recursive: true });
    this.hushed.add(path.resolve(inboxDir));

    const doc: SessionDoc = {
      v: 1,
      sessionId,
      status: 'collected',
      createdAt: this.now().toISOString(),
      inboxDir,
      truncated: false,
      skipped: 0,
      sourceKey: `drop:${sessionId}`,
      dirty: false,
      files: [],
      dirs: [],
      changes: [],
      stats: [],
    };

    let nameClash = false;
    for (const f of files) {
      const fileId = this.allocId();
      let bytes = Buffer.alloc(0);
      if (f.sourceAbs && fs.existsSync(f.sourceAbs)) {
        try {
          bytes = fs.readFileSync(f.sourceAbs);
        } catch {
          bytes = Buffer.alloc(0);
        }
      }
      const inboxRel = f.name;
      const inboxCopyPath = path.join(inboxDir, inboxRel);
      fs.mkdirSync(path.dirname(inboxCopyPath), { recursive: true });
      fs.writeFileSync(inboxCopyPath, bytes);

      const copyHash = sha256(bytes);
      const dest = path.join(targetDir, f.name);
      let op: InboxChangeOp = 'create';
      let originHash = '';
      if (fs.existsSync(dest)) {
        nameClash = true;
        op = 'conflict';
        try {
          originHash = sha256(fs.readFileSync(dest));
        } catch {
          originHash = '';
        }
      }

      doc.files.push({
        id: fileId,
        role: 'created',
        inboxRel,
        sourceAbs: f.sourceAbs,
        landingAbs: dest,
        parentItemId: '',
        copyHash,
        copySize: bytes.length,
        binary: bytes.includes(0),
      });

      doc.changes.push({
        fileId,
        op,
        inboxHash: copyHash,
        originHash,
        binary: bytes.includes(0),
        nextSize: bytes.length,
        needsLanding: false,
      });
    }

    this.save(doc);
    this.upsertIndex(doc, files.length);
    this.hushed.delete(path.resolve(inboxDir));
    return {
      sessionId,
      fileIds: doc.files.map((f) => f.id),
      nameClash,
    };
  }

  collect(sessionId?: string): AiWriteChangeView[] {
    const doc = this.mustInProgress(sessionId);
    const listed = this.listInbox(doc.inboxDir);
    const changes: SessionChangeRec[] = [];
    const mapped = new Set(doc.files.filter((file) => file.role === 'copy').map((file) => file.inboxRel));
    doc.files = doc.files.filter((file) => file.role === 'copy');
    for (const file of doc.files) {
      const hit = listed.get(file.inboxRel);
      if (!hit) {
        const originHash = this.originHash(file.sourceAbs);
        changes.push({
          fileId: file.id,
          op: 'missing',
          inboxHash: '',
          originHash,
          binary: file.binary,
          nextSize: 0,
          needsLanding: false,
        });
        continue;
      }
      if (hit.hash === file.copyHash) continue;
      const originHash = this.originHash(file.sourceAbs);
      const drifted = originHash !== file.copyHash;
      changes.push({
        fileId: file.id,
        op: drifted ? 'conflict' : 'modify',
        inboxHash: hit.hash,
        originHash,
        binary: hit.binary || file.binary,
        nextSize: hit.size,
        needsLanding: false,
      });
    }
    for (const [rel, hit] of listed) {
      if (mapped.has(rel)) continue;
      const landing = this.inferLanding(doc, rel);
      const id = `c_${sha256(Buffer.from(rel)).slice(0, 12)}`;
      const originHash = landing.abs ? this.originHash(landing.abs) : '';
      doc.files.push({
        id,
        role: 'created',
        inboxRel: rel,
        landingAbs: landing.abs,
        parentItemId: landing.parentItemId,
        copyHash: '',
        copySize: 0,
        binary: hit.binary,
      });
      changes.push({
        fileId: id,
        op: originHash ? 'conflict' : 'create',
        inboxHash: hit.hash,
        originHash,
        binary: hit.binary,
        nextSize: hit.size,
        needsLanding: landing.needsChoice,
      });
    }
    this.markRenames(doc, changes);
    doc.changes = changes;
    doc.status = 'collected';
    doc.dirty = false;
    this.save(doc);
    this.upsertIndex(doc);
    return this.viewsOf(doc);
  }

  async apply(input: { sessionId: string; fileId: string; decision: AiWriteApplyDecision; landingDir?: string }): Promise<AiWriteApplyResult> {
    const doc = this.must(input.sessionId);
    if (doc.status !== 'collected' && doc.status !== 'open') throw new Error('会话已经结束');
    if (doc.dirty) throw new Error('收件箱还有未收取的改动');
    const change = doc.changes.find((row) => row.fileId === input.fileId);
    const file = doc.files.find((row) => row.id === input.fileId);
    if (!change || !file) throw new Error('改动不存在或已经处理');
    if (change.decision) throw new Error('这项已经处理过');
    if (input.decision === 'reject') {
      change.decision = 'reject';
      await this.finishIfDone(doc);
      return { ok: true };
    }
    if (input.decision === 'delete') return this.applyDelete(doc, file, change);
    if (input.decision !== 'approve' && input.decision !== 'overwrite') throw new Error('无法处理这项改动');
    if (change.op === 'missing' || (change.op === 'rename' && file.role === 'copy')) throw new Error('副本缺失不能当作写入。要删除原件请确认删除');
    if (change.op === 'conflict' && input.decision !== 'overwrite') {
      return { ok: false, reason: 'conflict', file: file.sourceAbs || file.landingAbs || file.inboxRel, expectedHash: file.copyHash, actualHash: change.originHash };
    }
    if (change.needsLanding) {
      if (!input.landingDir) throw new Error('请选择目标文件夹');
      file.landingAbs = this.landingFile(input.landingDir, file.inboxRel);
      change.needsLanding = false;
    }
    const dest = file.role === 'copy' ? file.sourceAbs || '' : file.landingAbs;
    if (!dest) throw new Error('请选择目标文件夹');
    this.assertDest(dest, doc);
    const bytes = this.readInboxFile(doc, file.inboxRel);
    const skillLanding = locateSkillFile(this.agentDataRoot(), dest);
    if (skillLanding) assertIncomingSkillSize(this.agentDataRoot(), dest, bytes);
    if (file.role === 'copy' && input.decision !== 'overwrite') {
      const now = this.originHash(file.sourceAbs);
      if (now !== file.copyHash) {
        change.op = 'conflict';
        change.originHash = now;
        this.save(doc);
        return { ok: false, reason: 'conflict', file: dest, expectedHash: file.copyHash, actualHash: now };
      }
    } else if (file.role === 'created' && input.decision !== 'overwrite' && this.originHash(dest)) {
      const now = this.originHash(dest);
      change.op = 'conflict';
      change.originHash = now;
      this.save(doc);
      return { ok: false, reason: 'conflict', file: dest, expectedHash: '', actualHash: now };
    }
    const current = this.readRegular(dest);
    if (skillLanding && input.decision === 'overwrite') {
      const skillDir = path.join(this.agentDataRoot(), 'skills', skillLanding.name);
      if (fs.existsSync(skillDir) && !fs.lstatSync(skillDir).isSymbolicLink()) backupSkillDirectory(skillDir, this.dir, skillLanding.name, this.now());
    }
    if (current) this.backup(rootKey(path.dirname(dest)), path.basename(dest), current);
    this.writeFile(dest, bytes);
    change.decision = input.decision;
    await this.finishIfDone(doc);
    return { ok: true };
  }

  /**
   * 结束会话。
   * 每次都先返回待删清单（needsConfirm），用户确认后才用 shell.trashItem 把整个副本目录移入回收站。
   * 结束会话不用 fs.rmSync。设置 inboxDiscardConfirm === false 时免确认，但仍进回收站。
   * 有未批准的变更或待批准条目时，清单上带醒目提示。
   * 路径守卫在删除之前执行，符号链接和越界直接拒绝。
   */
  async discard(sessionId?: string, confirm = false): Promise<AiWriteDiscardResult> {
    const target = sessionId ? this.must(sessionId) : this.newestInProgress();
    if (!target) throw new Error('没有可结束的会话');
    if (target.status === 'applied' || target.status === 'rejected' || target.status === 'discarded') {
      return this.discardResult(target, { needsConfirm: false, removed: false });
    }
    const pendingCount = this.unsettledCount(target);
    const ready = this.prepareDelete(target);
    const base = this.discardResult(target, {
      inboxDir: ready?.dir ?? path.resolve(target.inboxDir),
      fileCount: ready?.files ?? 0,
      pendingCount,
      warning: pendingCount > 0 ? DISCARD_PENDING_WARNING : '',
      needsConfirm: false,
      removed: false,
    });
    if (!confirm && this.discardNeedsConfirm()) return { ...base, needsConfirm: true };
    const removed = await this.trashInbox(target);
    const settled = target.changes.length > 0 && target.changes.every((row) => !!row.decision) && !target.dirty;
    target.status = settled ? (target.changes.every((row) => row.decision === 'reject') ? 'rejected' : 'applied') : 'discarded';
    target.endedAt = this.now().toISOString();
    target.dirty = false;
    this.save(target);
    this.upsertIndex(target);
    return { ...base, needsConfirm: false, removed, ...(removed ? { via: 'trash' as const } : {}) };
  }

  openInboxDirs(): string[] {
    const out: string[] = [];
    for (const doc of this.inProgress()) {
      const dir = path.resolve(doc.inboxDir);
      if (this.hushed.has(dir)) continue;
      try {
        const st = fs.lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
      } catch {
        continue;
      }
      out.push(dir);
    }
    return out;
  }

  async trashPath(file: string): Promise<void> {
    await this.trash(file);
  }

  markDirty(sessionId: string): void {
    const doc = this.readDoc(sessionId);
    if (!doc) return;
    if (this.hushed.has(path.resolve(doc.inboxDir))) return;
    if (doc.status !== 'open' && doc.status !== 'collected') return;
    if (doc.dirty) return;
    doc.dirty = true;
    this.save(doc);
  }

  sessionIdForPath(abs: string): string | null {
    const target = path.resolve(abs);
    for (const doc of this.inProgress()) {
      if (this.hushed.has(path.resolve(doc.inboxDir))) continue;
      if (isInside(doc.inboxDir, target)) return doc.sessionId;
    }
    return null;
  }

  /** 已结束超过 7 天、且副本目录已不在的记录从 index 去掉。不删副本目录，不碰进行中的会话，不删备份。 */
  pruneEnded(): void {
    const cutoff = this.now().getTime() - 7 * DAY_MS;
    const kept: IndexRow[] = [];
    for (const row of this.readIndex()) {
      const doc = this.readDoc(row.sessionId);
      const status = doc?.status ?? row.status;
      if (status === 'open' || status === 'collected') {
        kept.push(doc ? this.indexRow(doc) : row);
        continue;
      }
      const ended = Date.parse(doc?.endedAt || row.createdAt);
      if (!Number.isFinite(ended) || ended > cutoff) {
        kept.push(doc ? this.indexRow(doc) : row);
        continue;
      }
      // 不自动删副本目录：副本只能经用户确认清单后进回收站。目录还在就留下记录。
      if (doc && fs.existsSync(path.resolve(doc.inboxDir))) {
        kept.push(this.indexRow(doc));
        continue;
      }
      const file = this.sessionFile(row.sessionId);
      if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
    this.writeIndex(kept);
  }

  currentInboxDir(): string | undefined {
    return this.newestInProgress()?.inboxDir;
  }

  status(input: { rows: AiWriteLinkStatus['rows']; hasHigh: boolean; inboxConfigured: boolean }): AiWriteLinkStatus {
    const open = this.inProgress();
    const current = open[0];
    const rows = input.rows.map((row) => {
      const stat = current?.stats.find((item) => item.parentItemId === row.id);
      if (!stat) return row;
      return { ...row, copied: stat.copied, skipped: stat.skipped, ...(stat.reason ? { skipReason: stat.reason } : {}) };
    });
    return {
      needsInbox: input.hasHigh && !input.inboxConfigured,
      rows,
      session: current
        ? {
            sessionId: current.sessionId,
            inboxDir: current.inboxDir,
            status: current.status,
            dirty: current.dirty,
            truncated: current.truncated,
            skipped: current.skipped,
            label: current.dirty ? '有未收取改动' : current.status === 'collected' ? '已收取' : '未收取',
            otherOpen: Math.max(0, open.length - 1),
          }
        : null,
    };
  }

  changeViews(): AiWriteChangeView[] {
    const out: AiWriteChangeView[] = [];
    for (const doc of this.inProgress()) {
      if (doc.dirty || doc.status !== 'collected') continue;
      out.push(...this.viewsOf(doc).filter((view) => {
        const change = doc.changes.find((row) => row.fileId === view.fileId);
        return change && !change.decision;
      }));
    }
    return out;
  }

  private async applyDelete(doc: SessionDoc, file: SessionFileRec, change: SessionChangeRec): Promise<AiWriteApplyResult> {
    if (file.role !== 'copy' || !file.sourceAbs) throw new Error('没有可删除的原件');
    if (change.op !== 'missing' && change.op !== 'rename') throw new Error('这个改动不能删除原件');
    const now = this.originHash(file.sourceAbs);
    if (now !== file.copyHash) {
      change.op = 'conflict';
      change.originHash = now;
      this.save(doc);
      return { ok: false, reason: 'conflict', file: file.sourceAbs, expectedHash: file.copyHash, actualHash: now };
    }
    const current = this.readRegular(file.sourceAbs);
    if (!current) throw new Error('原件已经不在');
    this.backup(rootKey(path.dirname(file.sourceAbs)), path.basename(file.sourceAbs), current);
    await this.trash(file.sourceAbs);
    change.decision = 'delete';
    await this.finishIfDone(doc);
    return { ok: true };
  }

  private async trash(file: string): Promise<void> {
    this.assertSafe(file);
    if (this.trashFn) {
      await this.trashFn(file);
      return;
    }
    if (!process.versions.electron) throw new Error('需要在应用里确认后才能移入回收站');
    const electron = (await import('electron')) as { shell?: { trashItem?: (target: string) => Promise<void> } };
    if (!electron.shell?.trashItem) throw new Error('需要在应用里确认后才能移入回收站');
    await electron.shell.trashItem(file);
  }

  private async finishIfDone(doc: SessionDoc): Promise<void> {
    if (!doc.changes.length || doc.changes.some((row) => !row.decision)) {
      this.save(doc);
      this.upsertIndex(doc);
      return;
    }
    // 每条都已有决定。副本目录不自动删，会话留着，等用户点「结束会话」确认清单后进回收站。
    this.save(doc);
    this.upsertIndex(doc);
  }

  private viewsOf(doc: SessionDoc): AiWriteChangeView[] {
    return doc.changes.map((change) => {
      const file = doc.files.find((row) => row.id === change.fileId);
      const binary = change.binary || file?.binary === true;
      const oldAbs = file?.role === 'copy' ? file.sourceAbs : file?.landingAbs;
      const newAbs = file ? path.join(doc.inboxDir, ...file.inboxRel.split('/')) : '';
      const oldText = !binary && oldAbs && change.op !== 'missing' && change.op !== 'create' ? this.previewText(oldAbs) : '';
      const newText = !binary && newAbs && change.inboxHash ? this.previewText(newAbs) : '';
      return {
        sessionId: doc.sessionId,
        fileId: change.fileId,
        inboxRel: file?.inboxRel || change.fileId,
        op: change.op,
        role: file?.role === 'created' ? 'created' : 'copy',
        binary,
        copySize: file?.copySize ?? 0,
        nextSize: change.nextSize,
        needsLanding: change.needsLanding,
        landingAbs: file?.landingAbs || '',
        oldText,
        newText,
        note: changeNote(change, file),
      };
    });
  }

  private previewText(abs: string): string {
    const buf = this.readRegular(abs);
    if (!buf || buf.includes(0) || buf.length > PREVIEW_READ) return '';
    const text = buf.toString('utf8');
    return text.length > PREVIEW_CAP ? `${text.slice(0, PREVIEW_CAP)}\n…（预览已截断）` : text;
  }

  private markRenames(doc: SessionDoc, changes: SessionChangeRec[]): void {
    for (const missing of changes) {
      if (missing.op !== 'missing') continue;
      const file = doc.files.find((row) => row.id === missing.fileId);
      if (!file?.copyHash) continue;
      if (missing.originHash !== file.copyHash) continue;
      const created = changes.find((row) => row.op === 'create' && row.inboxHash === file.copyHash && row.fileId !== missing.fileId);
      if (!created) continue;
      missing.op = 'rename';
      created.op = 'rename';
      missing.pairId = file.id;
      created.pairId = file.id;
    }
  }

  private inferLanding(doc: SessionDoc, inboxRel: string): { abs: string; parentItemId: string; needsChoice: boolean } {
    const skill = skillLandingFromInboxRel(inboxRel);
    const underCopied = doc.dirs.some((dir) => inboxRel === dir.inboxRel || inboxRel.startsWith(`${dir.inboxRel}/`));
    if (skill && !underCopied) {
      const abs = path.resolve(this.agentDataRoot(), 'skills', skill.name, ...skill.parts);
      const skillDir = path.resolve(this.agentDataRoot(), 'skills', skill.name);
      if (isInside(skillDir, abs)) return { abs, parentItemId: '', needsChoice: false };
    }
    let best: SessionDirRec | null = null;
    for (const dir of doc.dirs) {
      if (inboxRel === dir.inboxRel || inboxRel.startsWith(`${dir.inboxRel}/`)) {
        if (!best || dir.inboxRel.length > best.inboxRel.length) best = dir;
      }
    }
    if (!best) return { abs: '', parentItemId: '', needsChoice: true };
    const rest = inboxRel.slice(best.inboxRel.length + 1);
    if (!rest) return { abs: '', parentItemId: best.parentItemId, needsChoice: true };
    let parts: string[];
    try {
      parts = relParts(rest);
    } catch {
      return { abs: '', parentItemId: best.parentItemId, needsChoice: true };
    }
    const abs = path.resolve(best.sourceAbs, ...parts);
    if (!isInside(best.sourceAbs, abs)) return { abs: '', parentItemId: best.parentItemId, needsChoice: true };
    return { abs, parentItemId: best.parentItemId, needsChoice: false };
  }

  private landingFile(dir: string, inboxRel: string): string {
    const folder = path.resolve(dir);
    if (!path.isAbsolute(dir)) throw new Error('目标文件夹无效');
    if (isLocalKnowledgeUserData(folder)) throw new Error('目标文件夹不能在 LocalKnowledgeWorkbench 用户目录里');
    const agentData = this.agentDataRoot();
    if (isInside(agentData, folder) || isInside(folder, agentData)) throw new Error('目标文件夹不能在 agent-data 里');
    this.assertSafe(folder);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(folder);
    } catch {
      throw new Error('目标文件夹不存在');
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('目标文件夹无效');
    const dest = path.resolve(folder, ...relParts(inboxRel));
    if (!isInside(folder, dest)) throw new Error('目标文件夹无效');
    this.assertDest(dest, null);
    return dest;
  }

  private assertDest(dest: string, doc: SessionDoc | null): void {
    const abs = path.resolve(dest);
    this.assertSafe(abs);
    if (isLocalKnowledgeUserData(abs)) throw new Error('不能写回 LocalKnowledgeWorkbench 用户目录');
    const agentData = this.agentDataRoot();
    if (isInside(agentData, abs)) {
      if (!locateSkillFile(agentData, abs)) throw new Error('不能写回 agent-data');
      if (!skillDestAllowed(agentData, abs)) throw new Error('技能库不能经过符号链接');
    }
    if (doc && isInside(doc.inboxDir, abs)) throw new Error('不能把收件箱当成写回目标');
  }

  private copySources(doc: SessionDoc, sources: readonly InboxSource[]): void {
    const used = new Set<string>();
    const claim = (name: string): string => {
      const clean = sanitizeName(name);
      const ext = path.extname(clean);
      const stem = ext ? clean.slice(0, -ext.length) : clean;
      let rel = clean;
      let n = 2;
      while (used.has(rel.toLowerCase())) {
        rel = `${stem}-${n}${ext}`;
        n += 1;
      }
      used.add(rel.toLowerCase());
      return rel;
    };
    let copied = 0;
    let total = 0;
    let capped = false;
    const bump = (id: string, addCopied: number, addSkipped: number, reason?: string) => {
      let row = doc.stats.find((item) => item.parentItemId === id);
      if (!row) {
        row = { parentItemId: id, copied: 0, skipped: 0 };
        doc.stats.push(row);
      }
      row.copied += addCopied;
      row.skipped += addSkipped;
      if (reason && row.copied === 0) row.reason = reason;
    };
    const takeFile = (src: string, inboxRel: string, landingAbs: string, parentItemId: string, zone: string, zoneRel: string, size: number) => {
      if (size > this.limits.maxFile) {
        doc.skipped += 1;
        doc.truncated = true;
        bump(parentItemId, 0, 1, '超过大小上限');
        return;
      }
      if (capped || copied >= this.limits.maxFiles || total + size > this.limits.maxTotal) {
        capped = true;
        doc.truncated = true;
        doc.skipped += 1;
        bump(parentItemId, 0, 1, '超过数量或总大小上限');
        return;
      }
      const bytes = this.readRegular(src);
      if (!bytes) {
        doc.skipped += 1;
        bump(parentItemId, 0, 1, '无法读取');
        return;
      }
      const parts = relParts(inboxRel);
      const dest = path.resolve(doc.inboxDir, ...parts);
      if (!isInside(doc.inboxDir, dest)) throw new Error('副本路径越出收件箱');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const destStat = fs.existsSync(dest) ? fs.lstatSync(dest) : null;
      if (destStat?.isSymbolicLink()) throw new Error('收件箱里不能写入符号链接');
      fs.writeFileSync(dest, bytes);
      const hash = sha256(bytes);
      doc.files.push({
        id: `f_${sha256(Buffer.from(normPath(src))).slice(0, 12)}`,
        role: 'copy',
        inboxRel,
        sourceAbs: src,
        landingAbs,
        parentItemId,
        copyHash: hash,
        copySize: bytes.length,
        binary: bytes.includes(0),
      });
      this.backup(rootKey(zone), zoneRel, bytes);
      copied += 1;
      total += bytes.length;
      bump(parentItemId, 1, 0);
    };
    const walk = (abs: string, inboxRel: string, landingRoot: string, parentItemId: string, depth: number) => {
      if (depth > 32) return;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        doc.skipped += 1;
        doc.truncated = true;
        bump(parentItemId, 0, 1, '路径不存在');
        return;
      }
      if (st.isSymbolicLink()) {
        doc.skipped += 1;
        bump(parentItemId, 0, 1);
        return;
      }
      const base = path.basename(abs);
      if (depth > 0 && SKIP.has(base.toLowerCase())) return;
      if (st.isDirectory()) {
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          doc.skipped += 1;
          bump(parentItemId, 0, 1, '无法读取');
          return;
        }
        names.sort();
        for (const name of names) {
          if (SKIP.has(name.toLowerCase())) continue;
          const child = path.join(abs, name);
          walk(child, `${inboxRel}/${name}`, landingRoot, parentItemId, depth + 1);
        }
        return;
      }
      if (!st.isFile()) return;
      const inside = path.relative(landingRoot, abs).split(path.sep).join('/');
      if (!inside || inside.split('/').some((part) => !part || part === '.' || part === '..')) {
        doc.skipped += 1;
        bump(parentItemId, 0, 1);
        return;
      }
      takeFile(abs, inboxRel, abs, parentItemId, landingRoot, inside, st.size);
    };
    for (const source of sources) {
      const top = claim(source.name || path.basename(source.abs));
      let st: fs.Stats;
      try {
        st = fs.lstatSync(source.abs);
      } catch {
        doc.skipped += 1;
        doc.truncated = true;
        bump(source.parentItemId, 0, 1, '路径不存在');
        continue;
      }
      if (st.isSymbolicLink()) {
        doc.skipped += 1;
        bump(source.parentItemId, 0, 1);
        continue;
      }
      if (source.kind === 'file') {
        if (!st.isFile()) {
          doc.skipped += 1;
          bump(source.parentItemId, 0, 1, '无法读取');
          continue;
        }
        takeFile(source.abs, top, source.abs, source.parentItemId, path.dirname(source.abs), path.basename(source.abs), st.size);
        continue;
      }
      if (!st.isDirectory() || SKIP.has(path.basename(source.abs).toLowerCase())) {
        doc.skipped += 1;
        bump(source.parentItemId, 0, 1);
        continue;
      }
      doc.dirs.push({ inboxRel: top, sourceAbs: source.abs, parentItemId: source.parentItemId });
      walk(source.abs, top, source.abs, source.parentItemId, 0);
    }
  }

  private listInbox(inboxDir: string): Map<string, ListedFile> {
    const out = new Map<string, ListedFile>();
    if (!fs.existsSync(inboxDir)) return out;
    this.assertRealDir(inboxDir);
    const rootReal = fs.realpathSync(inboxDir);
    const visit = (abs: string, rel: string) => {
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        return;
      }
      if (st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        if (rel && SKIP.has(path.basename(abs).toLowerCase())) return;
        let names: string[] = [];
        try {
          names = fs.readdirSync(abs);
        } catch {
          return;
        }
        names.sort();
        for (const name of names) {
          if (SKIP.has(name.toLowerCase())) continue;
          visit(path.join(abs, name), rel ? `${rel}/${name}` : name);
        }
        return;
      }
      if (!st.isFile() || !rel) return;
      let real = abs;
      try {
        real = fs.realpathSync(abs);
      } catch {
        return;
      }
      if (!isInside(rootReal, real)) return;
      const bytes = fs.readFileSync(real);
      out.set(rel, { hash: sha256(bytes), size: bytes.length, binary: bytes.includes(0) });
    };
    visit(inboxDir, '');
    return out;
  }

  private readInboxFile(doc: SessionDoc, inboxRel: string): Buffer {
    const parts = relParts(inboxRel);
    const abs = path.resolve(doc.inboxDir, ...parts);
    if (!isInside(doc.inboxDir, abs)) throw new Error('路径越出收件箱');
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) throw new Error('不读取收件箱外的文件');
    const real = fs.realpathSync(abs);
    const rootReal = fs.realpathSync(doc.inboxDir);
    if (!isInside(rootReal, real)) throw new Error('不读取收件箱外的文件');
    return fs.readFileSync(real);
  }

  private originHash(abs: string | undefined): string {
    if (!abs) return '';
    const bytes = this.readRegular(abs);
    return bytes ? sha256(bytes) : '';
  }

  private readRegular(abs: string): Buffer | null {
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink() || !st.isFile()) return null;
      return fs.readFileSync(abs);
    } catch {
      return null;
    }
  }

  /** 生产环境目录是 <agent-data>/ai-write。测试里若不是这个名字，只把通道目录本身当成数据目录。 */
  private agentDataRoot(): string {
    return path.basename(this.dir).toLowerCase() === 'ai-write' ? path.dirname(this.dir) : this.dir;
  }

  private assertRealDir(dir: string, parent?: string): void {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('收件箱路径异常');
    if (!parent) return;
    const real = fs.realpathSync(dir);
    const parentReal = fs.realpathSync(parent);
    if (!isInside(parentReal, real)) throw new Error('收件箱路径异常');
  }

  /**
   * 复制失败时回滚刚创建的会话目录。结束会话不走这里。
   * 先做 realpath 守卫并写日志；守卫不通过就留下目录，不调用 rmSync。
   * 预检已整单拒绝符号链接，通过之后的递归删除不会跟着链接走进去。
   */
  private rollbackPrepared(root: string, inboxDir: string, sessionId: string): void {
    const dir = path.resolve(inboxDir);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return;
    }
    if (isLinkOrJunction(dir, st)) {
      console.error('[ai-write] 复制失败后的回滚被拒绝', sessionId);
      return;
    }
    try {
      assertSessionPath(root, dir);
      const files = countFilesOrRefuse(dir);
      this.logDelete(sessionId, files);
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error('[ai-write] 复制失败后的回滚被拒绝', sessionId, err);
    }
  }

  private discardResult(doc: SessionDoc, extra: Partial<AiWriteDiscardResult>): AiWriteDiscardResult {
    return {
      sessionId: doc.sessionId,
      inboxDir: path.resolve(doc.inboxDir),
      fileCount: 0,
      pendingCount: 0,
      warning: '',
      needsConfirm: false,
      removed: false,
      ...extra,
    };
  }

  /** 用户确认仍有未批准变更之后，用注入的 shell.trashItem 进回收站，不用 fs.rmSync。 */
  private async trashInbox(doc: SessionDoc): Promise<boolean> {
    const ready = this.prepareDelete(doc);
    if (!ready) return false;
    this.hushed.add(ready.dir);
    this.logDelete(doc.sessionId, ready.files);
    await this.trash(ready.dir);
    return true;
  }

  private unsettledCount(doc: SessionDoc): number {
    const waiting = doc.changes.filter((row) => !row.decision).length;
    // dirty 是还没列进待批准的改动，单独计 1，避免被算成已经处理完。
    return doc.dirty ? waiting + 1 : waiting;
  }

  private configuredInboxRoot(): string {
    const raw = (this.inboxRoot() ?? '').trim();
    if (!raw || !path.isAbsolute(raw)) throw new Error('收件箱路径异常');
    return path.resolve(raw);
  }

  private prepareDelete(doc: SessionDoc): { dir: string; files: number } | null {
    const dir = path.resolve(doc.inboxDir);
    if (path.basename(dir) !== doc.sessionId || !isSessionId(doc.sessionId)) throw new Error('收件箱路径异常');
    assertSessionPath(this.configuredInboxRoot(), dir);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('收件箱路径异常');
    }
    if (isLinkOrJunction(dir, st)) throw new Error('收件箱路径含有符号链接，已拒绝删除');
    if (!st.isDirectory()) throw new Error('收件箱路径异常');
    return { dir, files: countFilesOrRefuse(dir) };
  }

  private logDelete(sessionId: string, fileCount: number): void {
    const line = `${this.now().toISOString()} session=${sessionId} files=${fileCount}\n`;
    const file = path.join(this.dir, 'inbox-delete.log');
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(file, line);
    console.info(`[ai-write] 删除收件箱副本 session=${sessionId} files=${fileCount}`);
  }

  private findReusable(root: string, sourceKey: string): SessionDoc | null {
    for (const doc of this.inProgress()) {
      if (doc.sourceKey !== sourceKey) continue;
      if (!isInside(root, doc.inboxDir)) continue;
      if (path.basename(doc.inboxDir) !== doc.sessionId) continue;
      if (!fs.existsSync(doc.inboxDir)) continue;
      return doc;
    }
    return null;
  }

  private inProgress(): SessionDoc[] {
    const docs: SessionDoc[] = [];
    for (const row of [...this.readIndex()].reverse()) {
      const doc = this.readDoc(row.sessionId);
      if (!doc) continue;
      if (doc.status !== 'open' && doc.status !== 'collected') continue;
      docs.push(doc);
    }
    return docs;
  }

  private newestInProgress(): SessionDoc | null {
    return this.inProgress()[0] ?? null;
  }

  private mustInProgress(sessionId?: string): SessionDoc {
    const doc = sessionId ? this.must(sessionId) : this.newestInProgress();
    if (!doc) throw new Error('没有可收取的会话');
    if (doc.status !== 'open' && doc.status !== 'collected') throw new Error('会话已经结束');
    return doc;
  }

  private must(sessionId: string): SessionDoc {
    const doc = this.readDoc(sessionId);
    if (!doc) throw new Error('会话不存在');
    return doc;
  }

  private allocId(): string {
    for (let i = 0; i < 5; i += 1) {
      const id = this.randomId ? this.randomId() : `s_${randomBytes(4).toString('hex')}`;
      if (!isSessionId(id)) throw new Error('会话编号无效');
      if (!fs.existsSync(this.sessionFile(id))) return id;
    }
    throw new Error('会话编号冲突');
  }

  private sessionFile(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error('会话编号无效');
    return path.join(this.dir, 'sessions', `${sessionId}.json`);
  }

  private readDoc(sessionId: string): SessionDoc | null {
    if (!isSessionId(sessionId)) return null;
    const file = this.sessionFile(sessionId);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionDoc;
      if (!parsed || parsed.v !== 1 || parsed.sessionId !== sessionId) return null;
      parsed.files ||= [];
      parsed.dirs ||= [];
      parsed.changes ||= [];
      parsed.stats ||= [];
      parsed.dirty = parsed.dirty === true;
      return parsed;
    } catch {
      return null;
    }
  }

  private save(doc: SessionDoc): void {
    const file = this.sessionFile(doc.sessionId);
    this.atomic(file, JSON.stringify(doc, null, 2));
  }

  private readIndex(): IndexRow[] {
    const file = path.join(this.dir, 'sessions', 'index.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [];
      return rows.filter((row): row is IndexRow => Boolean(row && typeof row === 'object' && isSessionId(String((row as IndexRow).sessionId))));
    } catch {
      return [];
    }
  }

  private writeIndex(rows: IndexRow[]): void {
    this.atomic(path.join(this.dir, 'sessions', 'index.json'), JSON.stringify(rows, null, 2));
  }

  private indexRow(doc: SessionDoc, sourceCount?: number): IndexRow {
    const prev = this.readIndex().find((row) => row.sessionId === doc.sessionId);
    return {
      sessionId: doc.sessionId,
      status: doc.status,
      createdAt: doc.createdAt,
      inboxDir: doc.inboxDir,
      sourceCount: sourceCount ?? prev?.sourceCount ?? doc.stats.length,
    };
  }

  private upsertIndex(doc: SessionDoc, sourceCount?: number): void {
    const rows = this.readIndex().filter((row) => row.sessionId !== doc.sessionId);
    rows.push(this.indexRow(doc, sourceCount));
    this.writeIndex(rows);
  }

  private atomic(file: string, data: string): void {
    this.assertSafe(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.kb-tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  }
}

function hashSources(sources: readonly InboxSource[]): string {
  const lines = sources.map((source) => `${source.kind}\0${normPath(source.abs)}`).sort();
  return sha256(Buffer.from(lines.join('\n')));
}

function changeNote(change: SessionChangeRec, file: SessionFileRec | undefined): string | undefined {
  if (change.op === 'modify' && change.binary) return `二进制 ${formatBytes(file?.copySize ?? 0)} → ${formatBytes(change.nextSize)} · 哈希一致`;
  if (change.op === 'modify') return '原件未变';
  if (change.op === 'conflict' && file?.role === 'created') return '目标已存在 · 覆盖会先备份';
  if (change.op === 'conflict') return '复制后原件已变 · 不覆盖';
  if (change.op === 'missing') return '副本缺失（不当作删除，除非改选确认删除）';
  if (change.op === 'rename' && file?.role === 'copy') return '重命名建议 · 副本缺失（不当作删除，除非改选确认删除）';
  if (change.op === 'rename') return '重命名建议 · 新建';
  if (change.op === 'create' && change.needsLanding) return '请选择目标文件夹';
  if (change.op === 'create') return '新建';
  if (change.op === 'delete') return '删除';
  return undefined;
}
