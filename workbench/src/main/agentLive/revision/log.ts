import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentCursor,
  ChangeSegment,
  ChangesIndex,
  CurrentMarker,
  GetContentArgs,
  GetContentResult,
  GetDiffArgs,
  GetDiffResult,
  LiveEntryWriter,
  LiveEvent,
  LiveReconcileSource,
  LiveRevisionLog,
  WorkspaceMarker,
} from '../../../shared/agentLive/types';
import { contentFileAbs, readContentMeta, readStoredText, storeTextVersion } from './contentStore';
import { DIFF_TIMEOUT_MS, diffTooLarge, unifiedDiff } from './diffText';
import { AgentLiveError, assertSafeId } from './errors';
import { atomicWriteFile, promoteTmpFile, promoteTmpTree, readJson } from './fsio';
import { formatHash, hashBuffer, hashFile, hashHex, isSecretPath, sameHash } from './hash';
import { projectEvent } from './jsonl';
import { readSegments, segmentName } from './segments';
import { withStateLock } from './stateLock';
import { isTransientPath, textKind } from './textKind';

/** 0.11 取代 0.2 的 250ms。窗口从第一笔事件起算，中间再来的事件不顺延。 */
export const DEFAULT_DEBOUNCE_MS = 300;
export const DEFAULT_RECONCILE_MS = 30_000;
export const DEFAULT_RETAIN_REVISIONS = 1000;
export const DEFAULT_RETAIN_MS = 14 * 24 * 60 * 60 * 1000;
export const DEFAULT_SEGMENT_REVISIONS = 50;
export const DEFAULT_SEGMENT_BYTES = 64 * 1024;
const PAGE_LINES = 200;
const KEEP_TEXTS = 3;

interface Fingerprint {
  /** -1 表示只从日志恢复了哈希，还不知道大小和修改时间。 */
  size: number;
  mtimeMs: number;
  contentHash: string;
  missing?: boolean;
}

interface Bucket {
  revision: number;
  oldestRevision: number;
  segments: ChangeSegment[];
  revisionTimes: Record<string, string>;
  pendingUnlinks: string[];
}

interface WsState extends Bucket {
  workspaceName: string;
  snapshotRevision: number;
  fingerprints: Record<string, Fingerprint>;
  texts: Record<string, string[]>;
}

interface CurrentState extends Bucket {
  workspaceId: string | null;
  /** 只在切换工作区时 +1，与工作区 revision 分开计数。 */
  currentRevision: number;
}

interface PersistedState {
  schemaVersion: 1;
  current: CurrentState;
  workspaces: Record<string, WsState>;
}

interface Prepared extends LiveEvent {
  bytes?: Buffer;
}

interface Waiter {
  resolve: (rev: number) => void;
  reject: (err: unknown) => void;
}

interface PendingBatch {
  events: LiveEvent[];
  waiters: Waiter[];
  armed: boolean;
  timer?: NodeJS.Timeout;
}

export interface LiveRevisionOptions {
  bridgeRoot: string;
  stateFile?: string;
  appVersion?: string;
  now?: () => Date;
  debounceMs?: number;
  reconcileMs?: number;
  retainRevisions?: number;
  retainMs?: number;
  segmentMaxRevisions?: number;
  segmentMaxBytes?: number;
  entryWriter?: LiveEntryWriter;
  reconcileSource?: LiveReconcileSource;
  trace?: (step: string, info?: { file?: string }) => void;
}

export interface AgentLiveRevision extends LiveRevisionLog {
  close(): Promise<void>;
  whenReady(): Promise<void>;
  setActiveWorkspace(workspaceId: string, workspaceName?: string): Promise<number>;
  oldest(workspaceId: string): number;
  currentPointer(): { workspaceId: string | null; currentRevision: number };
  getContent(args: GetContentArgs, signal?: AbortSignal): Promise<GetContentResult>;
  getDiff(args: GetDiffArgs, signal?: AbortSignal): Promise<GetDiffResult>;
  readCursor(agentId: string): AgentCursor | null;
  cursorState(agentId: string): 'missing' | 'ok' | 'expired';
}

function emptyBucket(): Bucket {
  return { revision: 0, oldestRevision: 0, segments: [], revisionTimes: {}, pendingUnlinks: [] };
}

function emptyState(): PersistedState {
  return { schemaVersion: 1, current: { ...emptyBucket(), workspaceId: null, currentRevision: 0 }, workspaces: {} };
}

const TOP_KNOWN = new Set(['schemaVersion', 'current', 'workspaces']);
const CURRENT_KNOWN = new Set([
  'workspaceId',
  'currentRevision',
  'revision',
  'oldestRevision',
  'segments',
  'revisionTimes',
  'pendingUnlinks',
]);
const WS_KNOWN = new Set([
  'workspaceName',
  'revision',
  'oldestRevision',
  'snapshotRevision',
  'segments',
  'fingerprints',
  'texts',
  'pendingUnlinks',
  'revisionTimes',
]);

function unknownKeys(obj: object, known: Set<string>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!known.has(key)) extra[key] = value;
  }
  return extra;
}

function mergeContent(events: LiveEvent[]): LiveEvent[] {
  const out: LiveEvent[] = [];
  const index = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'content.changed' && event.materialId) {
      const at = index.get(event.materialId);
      if (at === undefined) {
        index.set(event.materialId, out.length);
        out.push({ ...event });
      } else {
        const prev = out[at]!;
        out[at] = { ...prev, ...event, prevContentHash: prev.prevContentHash ?? event.prevContentHash };
      }
    } else {
      out.push({ ...event });
    }
  }
  return out;
}

function chunkLines(text: string, size: number): string[] {
  const lines = text.split(/\n/);
  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += size) pages.push(lines.slice(i, i + size).join('\n'));
  return pages.length ? pages : [''];
}

export function createLiveRevisionLog(opts: LiveRevisionOptions): AgentLiveRevision {
  return new RevisionLog(opts);
}

class RevisionLog implements AgentLiveRevision {
  private readonly bridgeRoot: string;
  private readonly stateFile: string;
  private readonly appVersion: string;
  private readonly now: () => Date;
  private readonly debounceMs: number;
  private readonly reconcileMs: number;
  private readonly retainRevisions: number;
  private readonly retainMs: number;
  private readonly segmentMaxRevisions: number;
  private readonly segmentMaxBytes: number;
  private readonly writer?: LiveEntryWriter;
  private readonly source?: LiveReconcileSource;
  private readonly trace: (step: string, info?: { file?: string }) => void;
  private state: PersistedState;
  private readonly pending = new Map<string, PendingBatch>();
  private chain: Promise<void> = Promise.resolve();
  private ready: Promise<void>;
  private closed = false;
  private reconcileTimer?: NodeJS.Timeout;
  private diffTail: Promise<void> = Promise.resolve();
  /** 正在发布的工作区。发布中途新来的事件只进待发桶，结束后立刻补发一次。 */
  private readonly publishing = new Set<string>();
  /** 组 1 放在同一状态文件里的字段。保存时从磁盘再读一次，避免整文件覆盖丢掉。 */
  private passthrough: Record<string, unknown> = {};
  private currentExtra: Record<string, unknown> = {};
  private workspaceExtra = new Map<string, Record<string, unknown>>();

  constructor(opts: LiveRevisionOptions) {
    this.bridgeRoot = path.resolve(opts.bridgeRoot);
    this.stateFile = opts.stateFile ?? path.join(path.dirname(this.bridgeRoot), 'agent-live-state.json');
    this.appVersion = opts.appVersion ?? '0.2.0';
    this.now = opts.now ?? (() => new Date());
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.reconcileMs = opts.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.retainRevisions = opts.retainRevisions ?? DEFAULT_RETAIN_REVISIONS;
    this.retainMs = opts.retainMs ?? DEFAULT_RETAIN_MS;
    this.segmentMaxRevisions = opts.segmentMaxRevisions ?? DEFAULT_SEGMENT_REVISIONS;
    this.segmentMaxBytes = opts.segmentMaxBytes ?? DEFAULT_SEGMENT_BYTES;
    this.writer = opts.entryWriter;
    this.source = opts.reconcileSource;
    this.trace = opts.trace ?? (() => undefined);
    fs.mkdirSync(this.bridgeRoot, { recursive: true });
    promoteTmpFile(this.stateFile);
    this.state = this.loadState();
    this.adoptDisk();
    this.ready = this.finishRecover();
    if (this.reconcileMs > 0) {
      this.reconcileTimer = setInterval(() => {
        void this.enqueue(async () => {
          await this.ready;
          await this.reconcile();
        });
      }, this.reconcileMs);
      this.reconcileTimer.unref?.();
    }
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  current(workspaceId: string): number {
    return this.state.workspaces[workspaceId]?.revision ?? 0;
  }

  oldest(workspaceId: string): number {
    return this.state.workspaces[workspaceId]?.oldestRevision ?? 0;
  }

  currentPointer(): { workspaceId: string | null; currentRevision: number } {
    return { workspaceId: this.state.current.workspaceId, currentRevision: this.state.current.currentRevision };
  }

  append(workspaceId: string, events: LiveEvent[]): Promise<number> {
    assertSafeId(workspaceId, 'workspaceId');
    if (this.closed) return Promise.reject(new AgentLiveError('closed', '修订日志已关闭'));
    const bucket = this.arm(workspaceId);
    bucket.events.push(...events);
    return new Promise((resolve, reject) => bucket.waiters.push({ resolve, reject }));
  }

  async setActiveWorkspace(workspaceId: string, workspaceName?: string): Promise<number> {
    assertSafeId(workspaceId, 'workspaceId');
    if (this.closed) throw new AgentLiveError('closed', '修订日志已关闭');
    return this.enqueue(async () => {
      await this.ready;
      const ws = this.ensure(workspaceId);
      if (workspaceName?.trim()) ws.workspaceName = workspaceName.trim();
      if (this.state.current.workspaceId === workspaceId) {
        await this.writeCurrentMarker();
        await this.save();
        return this.state.current.currentRevision;
      }
      await this.publishSwitch([
        {
          type: 'workspace.switched',
          workspaceId,
          ...(this.state.current.workspaceId ? { fromWorkspaceId: this.state.current.workspaceId } : {}),
          toWorkspaceId: workspaceId,
          toRevision: ws.revision,
          workspaceName: ws.workspaceName,
        },
      ]);
      return this.state.current.currentRevision;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const id of [...this.pending.keys()]) this.flush(id);
    for (let i = 0; i < 20; i++) {
      const pending = this.chain;
      await pending;
      for (const id of [...this.pending.keys()]) this.flush(id);
      if (this.chain === pending && this.pending.size === 0 && this.publishing.size === 0) break;
    }
    await this.ready.catch(() => undefined);
  }

  readCursor(agentId: string): AgentCursor | null {
    assertSafeId(agentId, 'agentId');
    const parsed = readJson<AgentCursor>(path.join(this.bridgeRoot, 'cursors', `${agentId}.json`));
    if (!parsed || typeof parsed.revision !== 'number' || !Number.isFinite(parsed.revision)) return null;
    return parsed;
  }

  cursorState(agentId: string): 'missing' | 'ok' | 'expired' {
    const cursor = this.readCursor(agentId);
    if (!cursor) return 'missing';
    const workspaceId = cursor.workspaceId || this.state.current.workspaceId;
    if (!workspaceId) return 'ok';
    return cursor.revision < this.oldest(workspaceId) ? 'expired' : 'ok';
  }

  async getContent(args: GetContentArgs, _signal?: AbortSignal): Promise<GetContentResult> {
    await this.ready;
    assertSafeId(args.materialId, 'materialId');
    if (args.workspaceId) assertSafeId(args.workspaceId, 'workspaceId');
    const found = this.locate(args.materialId, args.workspaceId);
    if (!found) throw new AgentLiveError('not_found', '没有这份工作资料的可读内容');
    const meta = readContentMeta(found.wsDir, args.materialId);
    const versions = meta.versions ?? [];
    const wanted = args.contentHash
      ? versions.find((item) => sameHash(item.contentHash, args.contentHash))
      : versions[versions.length - 1];
    if (!wanted) {
      if (meta.status === 'generating') throw new AgentLiveError('generating', '可读内容生成中');
      throw new AgentLiveError('not_found', '没有这份内容');
    }
    const abs = contentFileAbs(found.wsDir, args.materialId, wanted.contentHash);
    if (!abs || !fs.existsSync(abs)) {
      if (meta.status === 'generating') throw new AgentLiveError('generating', '可读内容生成中');
      throw new AgentLiveError('not_found', '内容文件不在');
    }
    const text = fs.readFileSync(abs, 'utf8');
    const base = {
      materialId: args.materialId,
      workspaceId: found.workspaceId,
      contentHash: wanted.contentHash,
      absPath: abs,
      totalLength: text.length,
    };
    if (args.page !== undefined) {
      if (!Number.isInteger(args.page) || args.page < 1) throw new AgentLiveError('bad_args', 'page 必须是从 1 开始的整数');
      const pages = text.includes('\f') ? text.split('\f') : chunkLines(text, PAGE_LINES);
      const slice = pages[args.page - 1];
      if (slice === undefined) throw new AgentLiveError('not_found', '没有这一页');
      return { ...base, text: slice, offset: 0, length: slice.length, page: args.page, pageCount: pages.length };
    }
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new AgentLiveError('bad_args', 'offset 必须是非负整数');
    const length = args.length ?? Math.max(0, text.length - offset);
    if (!Number.isInteger(length) || length < 0) throw new AgentLiveError('bad_args', 'length 必须是非负整数');
    const slice = text.slice(offset, offset + length);
    return { ...base, text: slice, offset: Math.min(offset, text.length), length: slice.length };
  }

  async getDiff(args: GetDiffArgs, signal?: AbortSignal): Promise<GetDiffResult> {
    await this.ready;
    assertSafeId(args.materialId, 'materialId');
    if (args.workspaceId) assertSafeId(args.workspaceId, 'workspaceId');
    const fromHex = hashHex(args.fromHash);
    const toHex = hashHex(args.toHash);
    if (!fromHex || !toHex) throw new AgentLiveError('bad_args', 'fromHash 和 toHash 必须是 sha256');
    const found = this.locate(args.materialId, args.workspaceId);
    if (!found) throw new AgentLiveError('not_found', '没有这份工作资料');
    const fromHash = formatHash(fromHex);
    const toHash = formatHash(toHex);
    const relDir = path.join(found.wsDir, 'diff', args.materialId);
    const abs = path.join(relDir, `${fromHex}__${toHex}.diff`);
    if (fs.existsSync(abs)) {
      return {
        materialId: args.materialId,
        workspaceId: found.workspaceId,
        fromHash,
        toHash,
        diffSupported: true,
        diff: fs.readFileSync(abs, 'utf8'),
        absPath: abs,
        deferred: false,
      };
    }
    const fromText = readStoredText(found.wsDir, args.materialId, fromHash);
    const toText = readStoredText(found.wsDir, args.materialId, toHash);
    if (fromText === null || toText === null) throw new AgentLiveError('not_found', '缺少对比用的文本副本');
    const diff = await this.runDiff(() =>
      unifiedDiff(fromText, toText, { fromHash, toHash, signal, deadline: Date.now() + DIFF_TIMEOUT_MS }),
    );
    await atomicWriteFile(abs, diff);
    return {
      materialId: args.materialId,
      workspaceId: found.workspaceId,
      fromHash,
      toHash,
      diffSupported: true,
      diff,
      absPath: abs,
      deferred: diffTooLarge(diff),
    };
  }

  private async runDiff<T>(job: () => T): Promise<T> {
    const run = this.diffTail.then(() => job());
    this.diffTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private arm(workspaceId: string): PendingBatch {
    let bucket = this.pending.get(workspaceId);
    if (!bucket) {
      bucket = { events: [], waiters: [], armed: false };
      this.pending.set(workspaceId, bucket);
    }
    if (this.publishing.has(workspaceId)) {
      bucket.armed = true;
      return bucket;
    }
    if (!bucket.armed) {
      bucket.armed = true;
      if (this.debounceMs <= 0) queueMicrotask(() => this.flush(workspaceId));
      else bucket.timer = setTimeout(() => this.flush(workspaceId), this.debounceMs);
    }
    return bucket;
  }

  /** 发布结束后把待发桶立刻发出去，不再等一轮防抖。 */
  private kickFollow(workspaceId: string): void {
    const more = this.pending.get(workspaceId);
    if (!more || more.events.length === 0 || this.publishing.has(workspaceId)) return;
    if (more.timer) clearTimeout(more.timer);
    more.timer = undefined;
    more.armed = false;
    this.flush(workspaceId);
  }

  private flush(workspaceId: string): void {
    const bucket = this.pending.get(workspaceId);
    if (!bucket) return;
    if (bucket.timer) clearTimeout(bucket.timer);
    bucket.timer = undefined;
    if (this.publishing.has(workspaceId)) {
      bucket.armed = true;
      return;
    }
    this.pending.delete(workspaceId);
    const events = bucket.events.slice();
    const waiters = bucket.waiters.slice();
    void this.enqueue(async () => {
      this.publishing.add(workspaceId);
      try {
        await this.ready;
        const rev = await this.deliver(workspaceId, events);
        for (const waiter of waiters) waiter.resolve(rev);
      } catch (err) {
        for (const waiter of waiters) waiter.reject(err);
      } finally {
        this.publishing.delete(workspaceId);
        this.kickFollow(workspaceId);
      }
    });
  }

  private async deliver(workspaceId: string, events: LiveEvent[]): Promise<number> {
    const switches = events.filter((event) => event.type === 'workspace.switched');
    const rest = events.filter((event) => event.type !== 'workspace.switched');
    let rev = this.current(workspaceId);
    if (rest.length) rev = await this.publishWorkspace(workspaceId, rest);
    if (switches.length) await this.publishSwitch(switches);
    return rev;
  }

  private async publishWorkspace(workspaceId: string, events: LiveEvent[]): Promise<number> {
    await this.repair(workspaceId);
    const prepared = this.prepare(workspaceId, events);
    if (!prepared.length) {
      await this.save();
      return this.current(workspaceId);
    }
    const ws = this.ensure(workspaceId);
    const named = prepared.find((event) => event.workspaceName)?.workspaceName;
    if (named) ws.workspaceName = named;
    const rev = ws.revision + 1;
    const ts = this.now().toISOString();
    const wsDir = this.wsDir(workspaceId);
    this.trace('content');
    await this.writeContents(ws, wsDir, prepared, ts);
    this.trace('diff');
    await this.writeDiffs(wsDir, prepared);
    const lines = prepared.map((event) => projectEvent(event, rev, ts));
    this.trace('segment');
    const retire = await this.writeSegment(ws, this.changesDir(workspaceId), rev, lines);
    ws.revision = rev;
    ws.revisionTimes[String(rev)] = ts;
    if (ws.oldestRevision === 0) ws.oldestRevision = rev;
    const reset = [...prepared].reverse().find((event) => event.type === 'snapshot.reset');
    const drop = this.retain(ws, this.changesDir(workspaceId));
    this.trace('index');
    await this.writeIndex(this.changesDir(workspaceId), ws.segments, ws.oldestRevision);
    ws.pendingUnlinks.push(...retire, ...drop);
    this.remember(ws, prepared);
    await this.save();
    if (this.writer) {
      this.trace('render');
      await this.writer.render(workspaceId, rev);
    }
    if (reset && reset.snapshotRevision !== undefined) ws.snapshotRevision = reset.snapshotRevision;
    else if (this.writer) ws.snapshotRevision = rev;
    this.trace('marker');
    await atomicWriteFile(path.join(wsDir, 'marker.json'), this.markerJson(this.workspaceMarker(workspaceId)));
    if (this.state.current.workspaceId === workspaceId) {
      this.trace('current-marker');
      await this.writeCurrentMarker();
    }
    await this.unlinkPending(ws);
    await this.save();
    return rev;
  }

  private async publishSwitch(events: LiveEvent[]): Promise<void> {
    const first = events[0];
    const last = events[events.length - 1];
    if (!first || !last) return;
    const to = last.toWorkspaceId || last.workspaceId;
    assertSafeId(to, 'workspaceId');
    const ws = this.ensure(to);
    if (last.workspaceName) ws.workspaceName = last.workspaceName;
    const rev = this.state.current.currentRevision + 1;
    const ts = this.now().toISOString();
    const from = first.fromWorkspaceId || this.state.current.workspaceId || '';
    const line = projectEvent(
      {
        type: 'workspace.switched',
        workspaceId: to,
        ...(from ? { fromWorkspaceId: from } : {}),
        toWorkspaceId: to,
        toRevision: ws.revision,
      },
      rev,
      ts,
    );
    const current = this.state.current;
    const retire = await this.writeSegment(current, path.join(this.currentDir(), 'changes'), rev, [line]);
    current.currentRevision = rev;
    current.revision = rev;
    current.workspaceId = to;
    current.revisionTimes[String(rev)] = ts;
    if (current.oldestRevision === 0) current.oldestRevision = rev;
    const drop = this.retain(current, path.join(this.currentDir(), 'changes'));
    await this.writeIndex(path.join(this.currentDir(), 'changes'), current.segments, current.oldestRevision);
    current.pendingUnlinks.push(...retire, ...drop);
    if (this.writer) await this.writer.render(to, ws.revision);
    await this.writeCurrentMarker();
    await this.unlinkPending(current);
    await this.save();
  }

  private prepare(workspaceId: string, events: LiveEvent[]): Prepared[] {
    const ws = this.ensure(workspaceId);
    const stable = events.filter(
      (event) =>
        !isTransientPath(event.absPath) &&
        !isTransientPath(event.relPath) &&
        !isSecretPath(event.absPath) &&
        !isSecretPath(event.relPath),
    );
    const out: Prepared[] = [];
    for (const event of mergeContent(stable)) {
      if (event.materialId) assertSafeId(event.materialId, 'materialId');
      if (event.type !== 'content.changed') {
        out.push({ ...event, workspaceId });
        continue;
      }
      const fp = event.materialId ? ws.fingerprints[event.materialId] : undefined;
      const observed = this.observe(event, fp);
      if (!observed) {
        out.push({ ...event, workspaceId });
        continue;
      }
      if (observed.missing) {
        out.push({ ...event, workspaceId, type: 'material.missing' });
        continue;
      }
      if (fp && sameHash(fp.contentHash, observed.hash)) {
        const known = fp.size >= 0;
        const sameStat = fp.size === observed.size && fp.mtimeMs === observed.mtimeMs;
        if (!known || sameStat) {
          fp.size = observed.size;
          fp.mtimeMs = observed.mtimeMs;
          fp.missing = false;
          continue;
        }
      }
      out.push({
        ...event,
        workspaceId,
        size: observed.size,
        mtimeMs: observed.mtimeMs,
        contentHash: observed.hash,
        ...((event.prevContentHash || (fp && !fp.missing))
          ? { prevContentHash: event.prevContentHash ?? fp?.contentHash }
          : {}),
        ...(observed.bytes ? { bytes: observed.bytes } : {}),
      });
    }
    return out;
  }

  private observe(
    event: LiveEvent,
    fp: Fingerprint | undefined,
  ): { missing: true } | { missing: false; size: number; mtimeMs: number; hash: string; bytes?: Buffer } | null {
    if (!event.absPath) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(event.absPath);
    } catch {
      return { missing: true };
    }
    if (!st.isFile()) return { missing: true };
    if (fp && !fp.missing && fp.size === st.size && fp.mtimeMs === st.mtimeMs && fp.size >= 0) {
      const hinted = hashHex(event.contentHash);
      if (!hinted || hinted === hashHex(fp.contentHash)) {
        return { missing: false, size: st.size, mtimeMs: st.mtimeMs, hash: fp.contentHash };
      }
    }
    const bytes = fs.readFileSync(event.absPath);
    return { missing: false, size: st.size, mtimeMs: st.mtimeMs, hash: hashBuffer(bytes), bytes };
  }

  private async writeContents(ws: WsState, wsDir: string, events: Prepared[], ts: string): Promise<void> {
    for (const event of events) {
      if (!event.materialId || !event.bytes || !event.absPath || !event.contentHash) continue;
      if (event.type !== 'content.changed' && event.type !== 'material.added' && event.type !== 'material.restored') continue;
      if (textKind(event.absPath, event.bytes) !== 'text') {
        event.diffSupported = false;
        continue;
      }
      const text = new TextDecoder('utf-8').decode(event.bytes);
      event.content = await storeTextVersion(wsDir, event.materialId, event.contentHash, text, ts);
      const list = (ws.texts[event.materialId] ?? []).filter((item) => !sameHash(item, event.contentHash));
      list.push(event.contentHash);
      while (list.length > KEEP_TEXTS) list.shift();
      ws.texts[event.materialId] = list;
    }
  }

  private async writeDiffs(wsDir: string, events: Prepared[]): Promise<void> {
    for (const event of events) {
      if (event.type !== 'content.changed' || event.diffSupported === false) continue;
      if (!event.materialId || !event.contentHash || !event.prevContentHash || !event.bytes) continue;
      const prev = readStoredText(wsDir, event.materialId, event.prevContentHash);
      if (prev === null) continue;
      const next = new TextDecoder('utf-8').decode(event.bytes);
      let diff = '';
      try {
        diff = unifiedDiff(prev, next, {
          fromHash: event.prevContentHash,
          toHash: event.contentHash,
          deadline: Date.now() + DIFF_TIMEOUT_MS,
        });
      } catch {
        continue;
      }
      if (diffTooLarge(diff)) continue;
      const fromHex = hashHex(event.prevContentHash);
      const toHex = hashHex(event.contentHash);
      if (!fromHex || !toHex) continue;
      await atomicWriteFile(path.join(wsDir, 'diff', event.materialId, `${fromHex}__${toHex}.diff`), diff);
      event.diff = `diff/${event.materialId}/${fromHex}__${toHex}.diff`;
    }
  }

  private async writeSegment(bucket: Bucket, dir: string, rev: number, lines: string[]): Promise<string[]> {
    await fs.promises.mkdir(dir, { recursive: true });
    const chunk = lines.map((line) => (line.endsWith('\n') ? line : `${line}\n`)).join('');
    const last = bucket.segments[bucket.segments.length - 1];
    const retire: string[] = [];
    if (last) {
      const lastPath = path.join(dir, last.file);
      if (fs.existsSync(lastPath)) {
        const lastBytes = fs.statSync(lastPath).size;
        const lastCount = last.to - last.from + 1;
        const full = lastCount >= this.segmentMaxRevisions || lastBytes + Buffer.byteLength(chunk) > this.segmentMaxBytes;
        if (!full) {
          const file = segmentName(last.from, rev);
          if (file !== last.file) retire.push(lastPath);
          last.file = file;
          last.to = rev;
          await atomicWriteFile(path.join(dir, file), fs.readFileSync(lastPath, 'utf8') + chunk);
          return retire;
        }
      }
    }
    const file = segmentName(rev, rev);
    bucket.segments.push({ from: rev, to: rev, file });
    await atomicWriteFile(path.join(dir, file), chunk);
    return retire;
  }

  private retain(bucket: Bucket, dir: string): string[] {
    const seen = new Set<number>();
    for (const seg of bucket.segments) {
      for (let rev = seg.from; rev <= seg.to; rev++) seen.add(rev);
    }
    for (const key of Object.keys(bucket.revisionTimes)) {
      const rev = Number(key);
      if (Number.isFinite(rev)) seen.add(rev);
    }
    const revs = [...seen].filter((rev) => rev > 0 && rev <= bucket.revision).sort((a, b) => a - b);
    if (!revs.length) return [];
    const byCount = revs[Math.max(0, revs.length - this.retainRevisions)]!;
    const cutoff = this.now().getTime() - this.retainMs;
    const byAge =
      revs.find((rev) => {
        const raw = bucket.revisionTimes[String(rev)];
        return !!raw && Date.parse(raw) >= cutoff;
      }) ?? revs[revs.length - 1]!;
    const keep = Math.min(byCount, byAge);
    if (keep <= bucket.oldestRevision) return [];
    bucket.oldestRevision = keep;
    const drop: string[] = [];
    bucket.segments = bucket.segments.filter((seg) => {
      if (seg.to < keep) {
        drop.push(path.join(dir, seg.file));
        return false;
      }
      return true;
    });
    for (const rev of revs) {
      if (rev < keep) delete bucket.revisionTimes[String(rev)];
    }
    return drop;
  }

  private remember(ws: WsState, events: Prepared[]): void {
    for (const event of events) {
      if (!event.materialId) continue;
      if (event.type === 'material.missing' && ws.fingerprints[event.materialId]) {
        ws.fingerprints[event.materialId]!.missing = true;
        continue;
      }
      if (event.contentHash && event.size !== undefined && event.mtimeMs !== undefined) {
        ws.fingerprints[event.materialId] = {
          size: event.size,
          mtimeMs: event.mtimeMs,
          contentHash: event.contentHash,
          missing: false,
        };
      } else if (event.type === 'material.restored' && ws.fingerprints[event.materialId]) {
        ws.fingerprints[event.materialId]!.missing = false;
      }
    }
  }

  private async reconcile(): Promise<void> {
    if (!this.source) return;
    for (const workspaceId of Object.keys(this.state.workspaces)) {
      let materials;
      try {
        materials = await this.source.list(workspaceId);
      } catch {
        continue;
      }
      const ws = this.state.workspaces[workspaceId];
      if (!ws) continue;
      const events: LiveEvent[] = [];
      for (const material of materials) {
        const fp = ws.fingerprints[material.materialId];
        if (!fp) continue;
        let st: fs.Stats | null = null;
        try {
          const next = fs.statSync(material.absPath);
          st = next.isFile() ? next : null;
        } catch {
          st = null;
        }
        if (!st) {
          if (!fp.missing) {
            events.push({
              type: 'material.missing',
              workspaceId,
              materialId: material.materialId,
              resourceId: material.resourceId,
              sourceId: material.sourceId,
              relPath: material.relPath,
              absPath: material.absPath,
            });
          }
          continue;
        }
        if (fp.missing) {
          events.push({
            type: 'material.restored',
            workspaceId,
            materialId: material.materialId,
            resourceId: material.resourceId,
            sourceId: material.sourceId,
            relPath: material.relPath,
            absPath: material.absPath,
          });
        }
        if (!fp.missing && fp.size === st.size && fp.mtimeMs === st.mtimeMs) continue;
        let hash = '';
        try {
          hash = hashFile(material.absPath);
        } catch {
          continue;
        }
        if (sameHash(hash, fp.contentHash) && fp.size === st.size && fp.mtimeMs === st.mtimeMs) continue;
        events.push({
          type: 'content.changed',
          workspaceId,
          materialId: material.materialId,
          resourceId: material.resourceId,
          sourceId: material.sourceId,
          relPath: material.relPath,
          absPath: material.absPath,
          prevContentHash: fp.contentHash,
          size: st.size,
          mtimeMs: st.mtimeMs,
          contentHash: hash,
        });
      }
      if (events.length) await this.publishWorkspace(workspaceId, events);
    }
  }

  private async repair(workspaceId: string): Promise<void> {
    const ws = this.state.workspaces[workspaceId];
    if (!ws || ws.revision <= 0) return;
    const marker = readJson<WorkspaceMarker>(path.join(this.wsDir(workspaceId), 'marker.json'));
    if ((marker?.revision ?? 0) < ws.revision) {
      if (this.writer) {
        await this.writer.render(workspaceId, ws.revision);
        ws.snapshotRevision = Math.max(ws.snapshotRevision, ws.revision);
      }
      await atomicWriteFile(path.join(this.wsDir(workspaceId), 'marker.json'), this.markerJson(this.workspaceMarker(workspaceId)));
      if (this.state.current.workspaceId === workspaceId) await this.writeCurrentMarker();
      await this.save();
    }
    if (ws.pendingUnlinks.length) await this.unlinkPending(ws);
  }

  private async finishRecover(): Promise<void> {
    for (const id of Object.keys(this.state.workspaces)) await this.repair(id);
  }

  private async unlinkPending(bucket: Bucket): Promise<void> {
    const files = bucket.pendingUnlinks.splice(0);
    for (const file of files) {
      this.trace('unlink', { file: path.basename(file) });
      await fs.promises.rm(file, { force: true });
    }
  }

  private locate(materialId: string, workspaceId?: string): { workspaceId: string; wsDir: string } | null {
    const ids = workspaceId ? [workspaceId] : Object.keys(this.state.workspaces);
    for (const id of ids) {
      const wsDir = this.wsDir(id);
      if (fs.existsSync(path.join(wsDir, 'content', materialId))) return { workspaceId: id, wsDir };
    }
    if (workspaceId) return null;
    const root = path.join(this.bridgeRoot, 'live', 'ws');
    if (!fs.existsSync(root)) return null;
    for (const id of fs.readdirSync(root)) {
      const wsDir = path.join(root, id);
      if (fs.existsSync(path.join(wsDir, 'content', materialId))) return { workspaceId: id, wsDir };
    }
    return null;
  }

  private ensure(workspaceId: string): WsState {
    let ws = this.state.workspaces[workspaceId];
    if (!ws) {
      ws = {
        ...emptyBucket(),
        workspaceName: workspaceId,
        snapshotRevision: 0,
        fingerprints: {},
        texts: {},
      };
      this.state.workspaces[workspaceId] = ws;
    }
    ws.pendingUnlinks ??= [];
    ws.fingerprints ??= {};
    ws.texts ??= {};
    ws.segments ??= [];
    ws.revisionTimes ??= {};
    return ws;
  }

  private wsDir(workspaceId: string): string {
    return path.join(this.bridgeRoot, 'live', 'ws', workspaceId);
  }

  private changesDir(workspaceId: string): string {
    return path.join(this.wsDir(workspaceId), 'changes');
  }

  private currentDir(): string {
    return path.join(this.bridgeRoot, 'live', 'current');
  }

  private workspaceMarker(workspaceId: string): WorkspaceMarker {
    const ws = this.ensure(workspaceId);
    return {
      schemaVersion: 1,
      kind: 'workspace',
      workspaceId,
      workspaceName: ws.workspaceName,
      revision: ws.revision,
      oldestRevision: ws.oldestRevision,
      snapshotRevision: ws.snapshotRevision,
      generatedAt: this.now().toISOString(),
      appVersion: this.appVersion,
    };
  }

  private markerJson(marker: WorkspaceMarker | CurrentMarker): string {
    const copy = { ...marker };
    let body = JSON.stringify(copy);
    if (Buffer.byteLength(body) < 512) return body;
    copy.workspaceName = copy.workspaceName.slice(0, 40);
    body = JSON.stringify(copy);
    if (Buffer.byteLength(body) >= 512) copy.workspaceName = marker.workspaceName.slice(0, 8);
    return JSON.stringify(copy);
  }

  private async writeCurrentMarker(): Promise<void> {
    const id = this.state.current.workspaceId;
    if (!id) return;
    const ws = this.ensure(id);
    const marker: CurrentMarker = {
      schemaVersion: 1,
      kind: 'current',
      workspaceId: id,
      workspaceName: ws.workspaceName,
      revision: ws.revision,
      oldestRevision: ws.oldestRevision,
      snapshotRevision: ws.snapshotRevision,
      generatedAt: this.now().toISOString(),
      appVersion: this.appVersion,
      currentRevision: this.state.current.currentRevision,
      wsDir: `../ws/${id}`,
    };
    await fs.promises.mkdir(this.currentDir(), { recursive: true });
    await atomicWriteFile(path.join(this.currentDir(), 'marker.json'), this.markerJson(marker));
  }

  private async writeIndex(dir: string, segments: ChangeSegment[], oldestRevision: number): Promise<void> {
    const index: ChangesIndex = { segments, oldestRevision };
    await atomicWriteFile(path.join(dir, 'index.json'), JSON.stringify(index));
  }

  private quarantineState(): void {
    const bad = `${this.stateFile}.bad`;
    try {
      if (fs.existsSync(bad)) fs.rmSync(bad, { force: true });
      fs.renameSync(this.stateFile, bad);
    } catch {
      /* 隔离失败就留在原地，内存仍从空状态或桥目录恢复 */
    }
  }

  private loadState(): PersistedState {
    if (!fs.existsSync(this.stateFile)) return emptyState();
    let text = '';
    try {
      text = fs.readFileSync(this.stateFile, 'utf8');
    } catch {
      return emptyState();
    }
    let parsed: PersistedState & Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as PersistedState & Record<string, unknown>;
    } catch {
      this.quarantineState();
      return emptyState();
    }
    if (parsed && typeof parsed.schemaVersion === 'number' && parsed.schemaVersion !== 1) {
      throw new AgentLiveError('unsupported_schema', `不支持 agent-live-state.json schemaVersion ${parsed.schemaVersion}`);
    }
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.workspaces !== 'object' || !parsed.workspaces || typeof parsed.current !== 'object' || !parsed.current) {
      this.quarantineState();
      return emptyState();
    }
    this.passthrough = unknownKeys(parsed, TOP_KNOWN);
    this.currentExtra = unknownKeys(parsed.current, CURRENT_KNOWN);
    this.workspaceExtra.clear();
    for (const [id, ws] of Object.entries(parsed.workspaces)) {
      if (ws && typeof ws === 'object') this.workspaceExtra.set(id, unknownKeys(ws, WS_KNOWN));
    }
    parsed.current.pendingUnlinks ??= [];
    parsed.current.segments ??= [];
    if (!parsed.current.revisionTimes || Array.isArray(parsed.current.revisionTimes)) parsed.current.revisionTimes = {};
    parsed.current.currentRevision ??= parsed.current.revision ?? 0;
    parsed.current.revision ??= parsed.current.currentRevision ?? 0;
    for (const ws of Object.values(parsed.workspaces)) {
      ws.pendingUnlinks ??= [];
      ws.segments ??= [];
      ws.revisionTimes ??= {};
      ws.fingerprints ??= {};
      ws.texts ??= {};
    }
    return parsed;
  }

  private adoptDisk(): void {
    const live = path.join(this.bridgeRoot, 'live');
    promoteTmpTree(live);
    const wsRoot = path.join(live, 'ws');
    if (fs.existsSync(wsRoot)) {
      for (const id of fs.readdirSync(wsRoot)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) continue;
        const dir = path.join(wsRoot, id);
        if (!fs.statSync(dir).isDirectory()) continue;
        const ws = this.ensure(id);
        const marker = readJson<WorkspaceMarker>(path.join(dir, 'marker.json'));
        const parsed = readSegments(path.join(dir, 'changes'));
        const segMax = parsed.reduce((max, seg) => Math.max(max, ...seg.lines.map((line) => line.rev), seg.to), 0);
        ws.revision = Math.max(ws.revision, marker?.revision ?? 0, segMax);
        ws.oldestRevision = Math.max(ws.oldestRevision, marker?.oldestRevision ?? 0);
        ws.snapshotRevision = Math.max(ws.snapshotRevision, marker?.snapshotRevision ?? 0);
        if (marker?.workspaceName) ws.workspaceName = marker.workspaceName;
        if (parsed.length) ws.segments = parsed.map((seg) => ({ from: seg.from, to: seg.to, file: seg.file }));
        for (const seg of parsed) {
          for (const line of seg.lines) {
            try {
              const obj = JSON.parse(line.raw) as LiveEvent;
              if (!obj.materialId) continue;
              if (obj.type === 'content.changed' && obj.contentHash) {
                const prev = ws.fingerprints[obj.materialId];
                if (!prev || prev.size < 0) {
                  ws.fingerprints[obj.materialId] = { size: -1, mtimeMs: -1, contentHash: obj.contentHash, missing: false };
                }
              }
              if (obj.type === 'material.missing' && ws.fingerprints[obj.materialId]) {
                ws.fingerprints[obj.materialId]!.missing = true;
              }
            } catch {
              /* 跳过坏行 */
            }
          }
        }
        const contentRoot = path.join(dir, 'content');
        if (fs.existsSync(contentRoot)) {
          for (const materialId of fs.readdirSync(contentRoot)) {
            const meta = readContentMeta(dir, materialId);
            if (meta.versions?.length) ws.texts[materialId] = meta.versions.map((item) => item.contentHash);
          }
        }
      }
    }
    const marker = readJson<CurrentMarker>(path.join(live, 'current', 'marker.json'));
    const parsed = readSegments(path.join(live, 'current', 'changes'));
    const segMax = parsed.reduce((max, seg) => Math.max(max, ...seg.lines.map((line) => line.rev), seg.to), 0);
    this.state.current.currentRevision = Math.max(this.state.current.currentRevision, marker?.currentRevision ?? 0, segMax);
    this.state.current.revision = this.state.current.currentRevision;
    this.state.current.oldestRevision = Math.max(this.state.current.oldestRevision, marker?.oldestRevision ?? 0);
    if (marker?.workspaceId) this.state.current.workspaceId = marker.workspaceId;
    if (parsed.length) this.state.current.segments = parsed.map((seg) => ({ from: seg.from, to: seg.to, file: seg.file }));
  }

  private async save(): Promise<void> {
    await withStateLock(`${this.stateFile}.lock`, async () => {
      const passthrough = { ...this.passthrough };
      const currentExtra = { ...this.currentExtra };
      const workspaceExtra = new Map(this.workspaceExtra);
      const disk = readJson<Record<string, unknown>>(this.stateFile);
      if (disk && disk.schemaVersion === 1) {
        Object.assign(passthrough, unknownKeys(disk, TOP_KNOWN));
        if (disk.current && typeof disk.current === 'object') {
          Object.assign(currentExtra, unknownKeys(disk.current as object, CURRENT_KNOWN));
        }
        if (disk.workspaces && typeof disk.workspaces === 'object') {
          for (const [id, ws] of Object.entries(disk.workspaces as Record<string, unknown>)) {
            if (!ws || typeof ws !== 'object') continue;
            workspaceExtra.set(id, { ...(workspaceExtra.get(id) ?? {}), ...unknownKeys(ws, WS_KNOWN) });
          }
        }
      }
      this.passthrough = passthrough;
      this.currentExtra = currentExtra;
      this.workspaceExtra = workspaceExtra;
      const workspaces: Record<string, unknown> = {};
      for (const [id, ws] of Object.entries(this.state.workspaces)) {
        workspaces[id] = { ...(workspaceExtra.get(id) ?? {}), ...ws };
      }
      await atomicWriteFile(
        this.stateFile,
        JSON.stringify({ ...passthrough, schemaVersion: 1, current: { ...currentExtra, ...this.state.current }, workspaces }),
      );
    });
  }
}
