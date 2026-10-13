import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createFileOps } from '@kb/fileops';
import type { FileOp } from '@kb/fileops';
import { createPlanService } from '@kb/plan';
import {
  PathEscapeError,
  createRoot,
  ensureResource,
  migrate as migrateIdentity,
  resolveInsideRoot,
  setMount,
  updateLocation,
} from '@kb/identity-watch';
import { closeIndexer, extractText, migrate as migrateIndexer, searchGrouped, startIndex } from '@kb/indexer';
import { ApiError, PathRejectedError } from './errors.ts';
import { setIntegrationState } from './integration.ts';
import type { WorkbenchOptions, WorkbenchRootInput } from './options.ts';
import { decodeUtf8Bounded, fileSize, readBounded } from './read-bounded.ts';
import type {
  ApplyRequest,
  ApplyResult,
  DirEntry,
  OnConflict,
  OpLogEntry,
  OpName,
  PdfPageText,
  PlanStepOp,
  PreviewRequest,
  PreviewResult,
  ReadResult,
  RestoreRequest,
  RestoreResult,
  RootInfo,
  SearchResult,
  ServiceCtx,
  WorkbenchServices,
} from './types.ts';

const TEXT_EXT = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.csv',
  '.log',
  '.text',
  '.html',
  '.htm',
  '.xml',
  '.yml',
  '.yaml',
  '.css',
  '.svg',
  '.tsv',
]);

type AgentActor = `agent:${string}`;
type OnConflictMode = OnConflict;

interface FileOpMove {
  type: 'move' | 'rename';
  rootId: string;
  fromRelPath: string;
  toRelPath: string;
}

interface FileOpsConflict {
  code: string;
  relPath: string;
  message: string;
}

interface StoredPreview {
  id: string;
  actor: string;
  rootId: string;
  op: 'move' | 'rename' | 'restore';
  fileOp?: FileOpMove;
  restoreOpId?: string;
  fromPath?: string;
  toPath?: string;
  conflicts: string[];
}

interface OpRow {
  id: string;
  ts: number;
  actor: string;
  op: string;
  resource_id: string | null;
  before_json: string | null;
  after_json: string | null;
  backup_ref: string | null;
  status: string;
  error: string | null;
  root_id: string | null;
}

export async function createIntegratedWorkbench(opts: WorkbenchOptions): Promise<WorkbenchServices> {
  if (!opts.dataDir) throw new Error('dataDir is required');
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const dbPath = path.join(opts.dataDir, 'workbench.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  try {
    const roots = new Map<string, RootInfo>();
    migrateIdentity(db);
    for (const root of opts.roots) {
      const mounted = mountRoot(db, root);
      if (roots.has(mounted.id)) throw new Error(`duplicate root: ${mounted.id}`);
      roots.set(mounted.id, mounted);
    }

    const fileOps = createFileOps({
      db,
      dataDir: opts.dataDir,
      resolveInsideRoot,
      ensureResource,
      onMoved(resourceId, before, after) {
        return updateLocation(db, resourceId, before, after);
      },
    });
    fileOps.migrate();
    const planService = createPlanService({ db, fileOps });
    planService.migrate();
    migrateIndexer(db);

    setIntegrationState({
      paths: 'identity-watch',
      search: 'indexer',
      fileops: 'fileops',
      detail: [
        '路径校验只调用 @kb/identity-watch 的 resolveInsideRoot。越界是 PathEscapeError。',
        'createRoot 与 setMount 登记根目录，本包不写 roots 和 root_mounts。',
        'createFileOps 的 resolveInsideRoot、ensureResource 是 identity-watch 的同名函数。onMoved 转给 updateLocation。',
        '直接 ops.restore 对 agent 令牌返回 plan_required。恢复只能作为计划步骤，由界面批准后执行。',
        'fileops.migrate() 之后 plan.migrate()。agent 令牌不能批准或执行计划，也不能直接 ops.apply。',
        'search.query 首次对已登记根 startIndex，然后返回 indexer 的 searchGrouped。资料 ID 用 ensureResource / resolveInsideRoot。',
        'fs.read 的 PDF 正文调用 @kb/indexer 的 extractText。',
      ],
    });

    const previews = new Map<string, StoredPreview>();
    let indexing: Promise<void> | null = null;
    let closed = false;

    function resolvePath(rootId: string, userPath: string): { absolutePath: string; relPath: string } {
      const root = roots.get(rootId);
      if (!root) throw new ApiError(404, -32004, 'root_not_found');
      let resolved: { absPath: string; relPath: string };
      try {
        resolved = resolveInsideRoot(db, rootId, userPath);
      } catch (error) {
        if (isPathEscape(error)) throw new PathRejectedError(error instanceof Error ? error.message : 'outside');
        throw error;
      }
      return { absolutePath: resolved.absPath, relPath: resolved.relPath };
    }

    function ensureKnown(rootId: string, relPath: string): void {
      const resolved = resolveInsideRoot(db, rootId, relPath);
      if (resolved.resourceId) return;
      if (!fs.existsSync(resolved.absPath)) return;
      const stat = fs.statSync(resolved.absPath);
      if (!stat.isFile() && !stat.isDirectory()) return;
      ensureResource(db, rootId, resolved.relPath);
    }

    function ensureIndex(): Promise<void> {
      if (!indexing) {
        indexing = indexRoots(db, dbPath, roots).catch((error: unknown) => {
          indexing = null;
          throw error;
        });
      }
      return indexing;
    }

    const services: WorkbenchServices = {
      async registeredRoots() {
        return [...roots.values()];
      },

      resolvePath,

      async close() {
        if (closed) return;
        closed = true;
        if (indexing) await indexing.catch(() => undefined);
        await closeIndexer();
        db.close();
      },

      async listDirectory(ctx, rootId, relPath) {
        assertTokenRoot(ctx, rootId);
        const dir = resolvePath(rootId, relPath);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(dir.absolutePath);
        } catch {
          throw new ApiError(404, -32004, 'not_found');
        }
        if (!stat.isDirectory()) throw new ApiError(400, -32602, 'not_a_directory');
        const names = await fsp.readdir(dir.absolutePath);
        const entries: DirEntry[] = [];
        for (const name of names) {
          const childRel = dir.relPath ? `${dir.relPath}/${name}` : name;
          const lexical = path.win32.join(dir.absolutePath, name);
          let lst: fs.Stats;
          try {
            lst = await fsp.lstat(lexical);
          } catch {
            continue;
          }
          if (lst.isSymbolicLink()) {
            try {
              const resolved = resolvePath(rootId, childRel);
              const st = await fsp.stat(resolved.absolutePath);
              entries.push({
                name,
                relPath: childRel,
                kind: st.isDirectory() ? 'dir' : 'file',
                size: st.size,
              });
            } catch {
              entries.push({ name, relPath: childRel, kind: 'dir', size: 0 });
            }
            continue;
          }
          entries.push({
            name,
            relPath: childRel,
            kind: lst.isDirectory() ? 'dir' : 'file',
            size: lst.isFile() ? lst.size : 0,
          });
        }
        entries.sort((a, b) => a.relPath.localeCompare(b.relPath));
        return entries;
      },

      async readFile(ctx, rootId, relPath, readOpts) {
        assertTokenRoot(ctx, rootId);
        const target = resolvePath(rootId, relPath);
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(target.absolutePath);
        } catch {
          throw new ApiError(404, -32004, 'not_found');
        }
        if (!stat.isFile()) throw new ApiError(400, -32602, 'not_a_file');
        const maxBytes = readOpts.maxBytes;
        if (await isPdf(target.absolutePath)) {
          const size = await fileSize(target.absolutePath);
          if (size > maxBytes) throw new ApiError(413, -32005, 'file_too_large', { size, maxBytes });
          const pages = await readPdfPages(target.absolutePath);
          return {
            rootId,
            relPath: target.relPath,
            kind: 'pdf',
            pages,
            text: pages.map((page) => page.text).join('\n'),
            truncated: false,
            bytesRead: size,
            size,
          } satisfies ReadResult;
        }
        if (!isTextFile(target.absolutePath)) {
          const { buf } = await readBounded(target.absolutePath, Math.min(maxBytes, 512));
          if (buf.includes(0)) throw new ApiError(415, -32006, 'unsupported_type');
        }
        const { buf, size, truncated } = await readBounded(target.absolutePath, maxBytes);
        if (!isTextFile(target.absolutePath) && buf.includes(0)) {
          throw new ApiError(415, -32006, 'unsupported_type');
        }
        return {
          rootId,
          relPath: target.relPath,
          kind: 'text',
          text: decodeUtf8Bounded(buf, truncated),
          truncated,
          bytesRead: buf.length,
          size,
        };
      },

      async search(ctx, query, searchOpts) {
        const needle = query.trim();
        if (!needle) throw new ApiError(400, -32602, 'empty_query');
        if (needle.length > 500) throw new ApiError(400, -32602, 'query_too_long');
        const limit = clamp(searchOpts.limit ?? 20, 1, 50);
        let rootIds = ctx.rootIds.filter((id) => roots.has(id));
        if (searchOpts.rootId) {
          assertTokenRoot(ctx, searchOpts.rootId);
          if (!roots.has(searchOpts.rootId)) throw new ApiError(404, -32004, 'root_not_found');
          rootIds = [searchOpts.rootId];
        }
        await ensureIndex();
        const grouped = searchGrouped(db, needle, { limit, rootIds });
        const hits = grouped.hits.filter((hit) => rootIds.includes(hit.rootId));
        return { hits, truncated: grouped.truncated };
      },

      async preview(ctx, req: PreviewRequest) {
        if (req.op === 'restore') {
          const opId = requiredString(req.opId, 'opId');
          const source = loadOp(db, opId);
          if (!source || source.status !== 'ok' || source.op === 'restore') {
            throw new ApiError(404, -32004, 'op_not_found');
          }
          if (!source.root_id || !ctx.rootIds.includes(source.root_id)) {
            throw new ApiError(403, -32003, 'root_forbidden', { rootId: source.root_id });
          }
          const result = await fileOps.previewRestore(opId);
          const stored = savePreview(previews, {
            actor: ctx.actor,
            rootId: source.root_id,
            op: 'restore',
            restoreOpId: opId,
            conflicts: result.conflicts.map(formatConflict),
          });
          return previewResult(stored);
        }
        if (req.op !== 'move' && req.op !== 'rename') throw new ApiError(400, -32602, 'unsupported_op');
        const rootId = requiredString(req.rootId, 'rootId');
        assertTokenRoot(ctx, rootId);
        const from = resolvePath(rootId, requiredString(req.fromPath, 'fromPath'));
        const to = resolvePath(rootId, requiredString(req.toPath, 'toPath'));
        if (from.relPath.toLowerCase() === to.relPath.toLowerCase()) {
          throw new ApiError(400, -32602, 'same_path');
        }
        ensureKnown(rootId, from.relPath);
        const fileOp: FileOpMove = {
          type: req.op,
          rootId,
          fromRelPath: from.relPath,
          toRelPath: to.relPath,
        };
        const result = await fileOps.preview(fileOp);
        const stored = savePreview(previews, {
          actor: ctx.actor,
          rootId,
          op: req.op,
          fileOp,
          fromPath: from.relPath,
          toPath: to.relPath,
          conflicts: result.conflicts.map(formatConflict),
        });
        return previewResult(stored);
      },

      async apply(ctx, req: ApplyRequest) {
        requireWrite(ctx);
        const previewId = requiredString(req.previewId, 'previewId');
        const preview = previews.get(previewId);
        if (!preview) throw new ApiError(404, -32004, 'preview_not_found');
        previews.delete(previewId);
        assertTokenRoot(ctx, preview.rootId);
        if (preview.actor !== ctx.actor) throw new ApiError(403, -32003, 'actor_mismatch');
        if (preview.conflicts.length > 0) {
          throw new ApiError(409, -32009, 'conflict', { conflicts: preview.conflicts });
        }
        const actor = agentActor(ctx);
        if (preview.op === 'restore') {
          const onConflict = requireOnConflict(req.onConflict);
          return runRestore(db, fileOps, ctx, requiredString(preview.restoreOpId, 'opId'), onConflict);
        }
        if (!preview.fileOp) throw new ApiError(400, -32602, 'invalid_params');
        const applied = await fileOps.apply(preview.fileOp, { actor });
        if (applied.status !== 'ok') throw new ApiError(409, -32009, 'conflict', { opId: applied.opId });
        const row = loadOp(db, applied.opId);
        return {
          opId: applied.opId,
          op: preview.op,
          actor: ctx.actor,
          status: 'ok',
          rootId: preview.rootId,
          resourceId: resourceIdFrom(row?.resource_id),
          fromPath: preview.fromPath,
          toPath: preview.toPath,
        } satisfies ApplyResult;
      },

      async restore(ctx, req: RestoreRequest) {
        requireWrite(ctx);
        const onConflict = requireOnConflict(req.onConflict);
        if (req.previewId) {
          const preview = previews.get(req.previewId);
          if (!preview) throw new ApiError(404, -32004, 'preview_not_found');
          previews.delete(req.previewId);
          if (preview.op !== 'restore' || !preview.restoreOpId) {
            throw new ApiError(400, -32602, 'not_a_restore_preview');
          }
          if (preview.conflicts.length > 0) {
            throw new ApiError(409, -32009, 'conflict', { conflicts: preview.conflicts });
          }
          assertTokenRoot(ctx, preview.rootId);
          return runRestore(db, fileOps, ctx, preview.restoreOpId, onConflict);
        }
        return runRestore(db, fileOps, ctx, requiredString(req.opId, 'opId'), onConflict);
      },

      async log(ctx, logOpts) {
        const limit = clamp(logOpts.limit ?? 100, 1, 500);
        if (logOpts.rootId) assertTokenRoot(ctx, logOpts.rootId);
        const allowed = ctx.rootIds.filter((id) => id.length > 0);
        if (allowed.length === 0) return [];
        const placeholders = allowed.map(() => '?').join(', ');
        const params: Array<string | number> = [...allowed];
        let rootSql = '';
        if (logOpts.rootId) {
          rootSql = ' AND root_id = ?';
          params.push(logOpts.rootId);
        }
        params.push(limit);
        const rows = db
          .prepare(
            `SELECT id, ts, actor, op, resource_id, before_json, after_json, backup_ref, status, error, root_id
             FROM op_log
             WHERE root_id IN (${placeholders})${rootSql}
             ORDER BY ts DESC, id DESC
             LIMIT ?`,
          )
          .all(...params) as OpRow[];
        return rows.map(toLogEntry);
      },

      async plansCreate(ctx, req) {
        if (typeof req.title !== 'string' || req.title.length === 0) {
          throw new ApiError(400, -32602, 'invalid_params', { name: 'title' });
        }
        for (const op of req.ops) assertOpRoots(ctx, op, db);
        try {
          return await planService.createPlan({ actor: agentActor(ctx), title: req.title, ops: req.ops });
        } catch (error) {
          throw mapPlanError(error);
        }
      },

      async plansPreview(ctx, planId) {
        try {
          const existing = await planService.getPlan(planId);
          assertPlanRoots(ctx, existing, db);
          return await planService.previewPlan(planId);
        } catch (error) {
          throw mapPlanError(error);
        }
      },

      async plansGet(ctx, planId) {
        try {
          const existing = await planService.getPlan(planId);
          assertPlanRoots(ctx, existing, db);
          return existing;
        } catch (error) {
          throw mapPlanError(error);
        }
      },
    };
    return services;
  } catch (error) {
    db.close();
    throw error;
  }
}

function mountRoot(db: Database.Database, root: WorkbenchRootInput): RootInfo {
  if (!root.name) throw new Error('root name is required');
  if (!root.localPath || !fs.existsSync(root.localPath) || !fs.statSync(root.localPath).isDirectory()) {
    throw new Error(`root is not a directory: ${root.id ?? root.name}`);
  }
  const localPath = fs.realpathSync(root.localPath);
  const wanted = root.id && root.id.length > 0 ? root.id : undefined;
  const existing = wanted
    ? (db.prepare('SELECT id FROM roots WHERE id = ?').get(wanted) as { id: string } | undefined)
    : undefined;
  const created = existing
    ? existing.id
    : createRoot(db, wanted ? { id: wanted, name: root.name } : { name: root.name });
  if (typeof created !== 'string' || created.length === 0) throw new Error('createRoot did not return an id');
  setMount(db, created, localPath);
  const sample = firstFileRel(localPath);
  if (sample) ensureResource(db, created, sample);
  return { id: created, name: root.name, localPath };
}

function firstFileRel(rootAbs: string): string | null {
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() ?? '';
    const abs = rel ? path.win32.join(rootAbs, ...rel.split('/')) : rootAbs;
    let names: string[];
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      const childRel = rel ? `${rel}/${name}` : name;
      const childAbs = path.win32.join(abs, name);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) return childRel;
      if (stat.isDirectory()) stack.push(childRel);
    }
  }
  return null;
}

async function indexRoots(db: Database.Database, dbPath: string, roots: Map<string, RootInfo>): Promise<void> {
  for (const root of roots.values()) {
    const job = startIndex({
      rootId: root.id,
      localPath: root.localPath,
      dbPath,
      resolveResourceId(rootId, relPath) {
        const resolved = resolveInsideRoot(db, rootId, relPath);
        if (resolved.resourceId) return resolved.resourceId;
        return ensureResource(db, rootId, relPath);
      },
      mode: 'full',
    });
    const result = await Promise.race([
      job.done,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`索引超时: ${root.id}`)), 60_000);
      }),
    ]);
    if (result.status !== 'completed') {
      throw new Error(`索引未完成: ${root.id} ${result.status}`);
    }
    if (result.errors.length > 0 && result.filesProcessed.length === 0) {
      throw new Error(result.errors.map((item) => `${item.path}: ${item.error}`).join('\n'));
    }
  }
}

function isPathEscape(error: unknown): boolean {
  if (error instanceof PathEscapeError) return true;
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; name?: unknown };
  return record.code === 'PATH_ESCAPE' || record.name === 'PathEscapeError';
}

function assertTokenRoot(ctx: ServiceCtx, rootId: string): void {
  if (!ctx.rootIds.includes(rootId)) throw new ApiError(403, -32003, 'root_forbidden', { rootId });
}

function assertOpRoots(ctx: ServiceCtx, op: PlanStepOp, db: Database.Database): void {
  if (op.type === 'restore') {
    const row = db.prepare('SELECT root_id FROM op_log WHERE id = ?').get(op.opId) as
      | { root_id: string | null }
      | undefined;
    if (!row?.root_id) throw new ApiError(404, -32004, 'op_not_found');
    assertTokenRoot(ctx, row.root_id);
    return;
  }
  assertTokenRoot(ctx, op.rootId);
  if (op.type === 'move' && op.toRootId) assertTokenRoot(ctx, op.toRootId);
}

function assertPlanRoots(ctx: ServiceCtx, plan: { steps: Array<{ op: PlanStepOp }> }, db: Database.Database): void {
  for (const step of plan.steps) assertOpRoots(ctx, step.op, db);
}

function mapPlanError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (isPlanError(error)) {
    if (error.code === 'not_found') throw new ApiError(404, -32004, 'plan_not_found');
    if (error.code === 'unknown_step') throw new ApiError(400, -32602, 'unknown_step');
    if (error.code === 'not_approved') throw new ApiError(409, -32009, 'not_approved');
    if (error.code === 'user_approval_required') throw new ApiError(403, -32003, 'user_approval_required');
    if (error.code === 'approval_stale') throw new ApiError(409, -32009, 'approval_stale');
    throw new ApiError(400, -32602, 'invalid_params', { message: error.message });
  }
  throw error;
}

function isPlanError(error: unknown): error is { code: string; message: string } {
  if (!error || typeof error !== 'object') return false;
  const record = error as { name?: unknown; code?: unknown; message?: unknown };
  return record.name === 'PlanError' && typeof record.code === 'string' && typeof record.message === 'string';
}

function requireWrite(ctx: ServiceCtx): void {
  if (ctx.permission !== 'readwrite') throw new ApiError(403, -32003, 'read_only');
  agentActor(ctx);
}

function agentActor(ctx: ServiceCtx): AgentActor {
  if (!ctx.actor.startsWith('agent:') || ctx.actor === 'agent:') throw new ApiError(400, -32602, 'actor');
  return ctx.actor as AgentActor;
}

function requireOnConflict(value: OnConflictMode | undefined): OnConflictMode {
  if (value === 'cancel' || value === 'rename' || value === 'overwrite') return value;
  throw new ApiError(400, -32602, 'invalid_params', { name: 'onConflict' });
}

function requiredString(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new ApiError(400, -32602, 'invalid_params', { name });
  return value;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function formatConflict(conflict: FileOpsConflict): string {
  return `${conflict.code}: ${conflict.message}`;
}

function savePreview(previews: Map<string, StoredPreview>, input: Omit<StoredPreview, 'id'>): StoredPreview {
  const preview: StoredPreview = { ...input, id: randomBytes(16).toString('hex') };
  previews.set(preview.id, preview);
  return preview;
}

function previewResult(preview: StoredPreview): PreviewResult {
  return {
    previewId: preview.id,
    op: preview.op,
    rootId: preview.rootId,
    fromPath: preview.fromPath,
    toPath: preview.toPath,
    opId: preview.restoreOpId,
    willWrite: false,
    actor: preview.actor,
    conflicts: preview.conflicts,
  };
}

async function runRestore(
  db: Database.Database,
  fileOps: ReturnType<typeof createFileOps>,
  ctx: ServiceCtx,
  opId: string,
  onConflict: OnConflictMode,
): Promise<RestoreResult> {
  const source = loadOp(db, opId);
  if (!source || source.status !== 'ok' || source.op === 'restore') throw new ApiError(404, -32004, 'op_not_found');
  if (!source.root_id || !ctx.rootIds.includes(source.root_id)) {
    throw new ApiError(403, -32003, 'root_forbidden', { rootId: source.root_id });
  }
  const applied = await fileOps.restore(opId, { actor: agentActor(ctx), onConflict });
  if (applied.status !== 'ok') throw new ApiError(409, -32009, 'conflict', { opId: applied.opId });
  const row = loadOp(db, applied.opId);
  const before = parseJson(source.before_json) as { relPath?: string } | null;
  const after = parseJson(source.after_json) as { relPath?: string } | null;
  return {
    opId: applied.opId,
    op: 'restore',
    actor: ctx.actor,
    status: 'ok',
    rootId: source.root_id,
    resourceId: resourceIdFrom(row?.resource_id),
    restoredOpId: opId,
    fromPath: typeof after?.relPath === 'string' ? after.relPath : '',
    toPath: typeof before?.relPath === 'string' ? before.relPath : '',
  };
}

function loadOp(db: Database.Database, id: string): OpRow | undefined {
  return db.prepare('SELECT * FROM op_log WHERE id = ?').get(id) as OpRow | undefined;
}

function resourceIdFrom(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function toLogEntry(row: OpRow): OpLogEntry {
  return {
    id: row.id,
    ts: new Date(row.ts).toISOString(),
    actor: row.actor,
    op: row.op as OpName,
    resourceId: resourceIdFrom(row.resource_id),
    rootId: row.root_id ?? '',
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    backupRef: row.backup_ref,
    status: row.status === 'ok' ? 'ok' : 'error',
    error: row.error,
  };
}

function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

async function readPdfPages(absolutePath: string): Promise<PdfPageText[]> {
  const extracted = await extractText(absolutePath);
  if (!Array.isArray(extracted)) throw new ApiError(500, -32603, 'pdf_extract_failed');
  return extracted.map((item) => {
    if (!item || typeof item.page !== 'number' || typeof item.text !== 'string') {
      throw new ApiError(500, -32603, 'pdf_extract_failed');
    }
    return { page: item.page, text: item.text };
  });
}

async function isPdf(absolutePath: string): Promise<boolean> {
  if (path.extname(absolutePath).toLowerCase() === '.pdf') return true;
  const fh = await fsp.open(absolutePath, 'r');
  try {
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fh.read(buf, 0, 5, 0);
    return buf.subarray(0, bytesRead).toString('utf8') === '%PDF-';
  } finally {
    await fh.close();
  }
}

function isTextFile(absolutePath: string): boolean {
  return TEXT_EXT.has(path.extname(absolutePath).toLowerCase());
}
