import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isWithinDir, normalizeRelPath } from "./lex.js";
import type {
  Actor,
  ApplyResult,
  Conflict,
  FileOp,
  FileOps,
  FileOpsDeps,
  OnConflict,
  PreviewResult,
  RecoveryItem,
} from "./types.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const CRASH_POINT = "after-backup";
const DRIFT = "当前内容与操作完成时不一致";

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
  phase: string | null;
  root_id: string | null;
  temp_path: string | null;
}

interface StagingRow {
  id: string;
  op_id: string;
  root_id: string;
  rel_path: string;
  stored_path: string;
  size: number;
  content_hash: string;
  created_at: number;
  expires_at: number;
  restored_at: number | null;
  purged_at: number | null;
}

interface HashMeta {
  relPath: string;
  rootId?: string;
  fromRelPath?: string;
  toRelPath?: string;
  existed?: boolean;
  size?: number;
  hash?: string;
  staged?: boolean;
  stagingId?: string;
  storedPath?: string;
}

interface ResolvedPath {
  relPath: string;
  absPath: string;
  resourceId: string | null;
}

interface ActionCreate {
  kind: "create";
  rootId: string;
  relPath: string;
  absPath: string;
  bytes: Buffer;
}

interface ActionWrite {
  kind: "write";
  rootId: string;
  relPath: string;
  absPath: string;
  bytes: Buffer;
  resourceId: string | null;
}

interface ActionMove {
  kind: "move";
  op: "move" | "rename";
  rootId: string;
  toRootId: string;
  fromRel: string;
  toRel: string;
  fromAbs: string;
  toAbs: string;
  caseOnly: boolean;
  resourceId: string | null;
}

interface ActionDelete {
  kind: "delete";
  rootId: string;
  relPath: string;
  absPath: string;
  resourceId: string | null;
}

type Action = ActionCreate | ActionWrite | ActionMove | ActionDelete;

interface Evaluation {
  summary: string;
  affected: string[];
  conflicts: Conflict[];
  action: Action | null;
  /** 拒绝时写入 op_log 的目标资料 ID。解析不到则为 null。 */
  targetResourceId: string | null;
}

type Payload =
  | { kind: "bytes"; bytes: Buffer }
  | { kind: "staged"; stagingId: string; storedPath: string; bytes: Buffer }
  | { kind: "relocate"; fromAbs: string; fromRel: string; fromRootId: string; bytes: Buffer }
  | { kind: "remove"; absPath: string; bytes: Buffer };

interface RestorePlan {
  summary: string;
  affected: string[];
  conflicts: Conflict[];
  rootId: string | null;
  destinationRel: string;
  destinationAbs: string | null;
  payload: Payload | null;
  renameOk: boolean;
  overwriteOk: boolean;
  sourceOp: string;
}

export function createFileOps(deps: FileOpsDeps): FileOps {
  if (!deps || typeof deps !== "object") {
    throw new Error("createFileOps: deps 无效");
  }
  if (!deps.db) throw new Error("createFileOps: db 无效");
  if (typeof deps.dataDir !== "string" || deps.dataDir.length === 0) {
    throw new Error("createFileOps: dataDir 无效");
  }
  if (typeof deps.resolveInsideRoot !== "function") {
    throw new Error("createFileOps: resolveInsideRoot 无效");
  }
  if (typeof deps.ensureResource !== "function") {
    throw new Error("createFileOps: ensureResource 无效");
  }
  if (typeof deps.onMoved !== "function") {
    throw new Error("createFileOps: onMoved 无效");
  }
  const retentionMs = deps.retentionMs ?? THIRTY_DAYS_MS;
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new Error("createFileOps: retentionMs 无效");
  }

  const db = deps.db;
  const dataDir = path.resolve(deps.dataDir);

  function backupDir(): string {
    return path.join(dataDir, "backups");
  }

  function stagingDir(): string {
    return path.join(dataDir, "staging");
  }

  function assertMigrated(): void {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'op_log'")
      .get();
    if (!row) throw new Error("调用前需要先 migrate()");
  }

  function migrate(): void {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(backupDir(), { recursive: true });
    fs.mkdirSync(stagingDir(), { recursive: true });
    db.exec(`
      CREATE TABLE IF NOT EXISTS op_log (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        op TEXT NOT NULL,
        resource_id TEXT,
        before_json TEXT,
        after_json TEXT,
        backup_ref TEXT,
        status TEXT NOT NULL,
        error TEXT,
        phase TEXT,
        root_id TEXT,
        temp_path TEXT
      );
      CREATE TABLE IF NOT EXISTS backups (
        hash TEXT PRIMARY KEY,
        size INTEGER NOT NULL,
        stored_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staging_entries (
        id TEXT PRIMARY KEY,
        op_id TEXT NOT NULL,
        root_id TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        restored_at INTEGER,
        purged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_op_log_status ON op_log(status);
      CREATE INDEX IF NOT EXISTS idx_staging_expires ON staging_entries(expires_at);
      CREATE INDEX IF NOT EXISTS idx_staging_op ON staging_entries(op_id);
    `);
    ensureColumn("op_log", "phase", "TEXT");
    ensureColumn("op_log", "root_id", "TEXT");
    ensureColumn("op_log", "temp_path", "TEXT");
    ensureColumn("staging_entries", "restored_at", "INTEGER");
    ensureColumn("staging_entries", "purged_at", "INTEGER");
  }

  function ensureColumn(table: string, column: string, definition: string): void {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((col) => col.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  function insertOp(row: {
    id: string;
    ts?: number;
    actor: string;
    op: string;
    rootId?: string | null;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    backupRef?: string | null;
    status: string;
    error?: string | null;
    phase?: string | null;
    tempPath?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO op_log (
        id, ts, actor, op, resource_id, before_json, after_json, backup_ref, status, error, phase, root_id, temp_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.ts ?? Date.now(),
      row.actor,
      row.op,
      row.resourceId ?? null,
      row.before === undefined ? null : JSON.stringify(row.before),
      row.after === undefined ? null : JSON.stringify(row.after),
      row.backupRef ?? null,
      row.status,
      row.error ?? null,
      row.phase ?? null,
      row.rootId ?? null,
      row.tempPath ?? null,
    );
  }

  function markOp(
    id: string,
    status: string,
    phase: string | null,
    error: string | null,
    extra?: { after?: unknown; backupRef?: string | null; tempPath?: string | null },
  ): void {
    if (extra && (extra.after !== undefined || extra.backupRef !== undefined || extra.tempPath !== undefined)) {
      const current = getOp(id);
      db.prepare(
        `UPDATE op_log
         SET status = ?, phase = ?, error = ?, after_json = ?, backup_ref = ?, temp_path = ?
         WHERE id = ?`,
      ).run(
        status,
        phase,
        error,
        extra.after !== undefined ? JSON.stringify(extra.after) : (current?.after_json ?? null),
        extra.backupRef !== undefined ? extra.backupRef : (current?.backup_ref ?? null),
        extra.tempPath !== undefined ? extra.tempPath : (current?.temp_path ?? null),
        id,
      );
      return;
    }
    db.prepare("UPDATE op_log SET status = ?, phase = ?, error = ? WHERE id = ?").run(
      status,
      phase,
      error,
      id,
    );
  }

  function getOp(id: string): OpRow | undefined {
    return db.prepare("SELECT * FROM op_log WHERE id = ?").get(id) as OpRow | undefined;
  }

  function reject(params: {
    opId: string;
    actor: string;
    op: string;
    rootId?: string | null;
    resourceId?: string | null;
    before?: unknown;
    error: string;
  }): ApplyResult {
    const resourceId =
      typeof params.resourceId === "string" && params.resourceId.length > 0 ? params.resourceId : null;
    const existing = getOp(params.opId);
    if (existing && existing.status === "pending") {
      markOp(params.opId, "rejected", "rejected", params.error);
      return { opId: params.opId, status: "rejected" };
    }
    if (!existing) {
      insertOp({
        id: params.opId,
        actor: params.actor,
        op: params.op,
        rootId: params.rootId,
        resourceId,
        before: params.before,
        status: "rejected",
        error: params.error,
        phase: "rejected",
      });
    }
    return { opId: params.opId, status: "rejected" };
  }

  async function resolveOne(rootId: string, relInput: string): Promise<
    | { ok: true; path: ResolvedPath }
    | { ok: false; conflicts: Conflict[] }
  > {
    if (typeof rootId !== "string" || rootId.length === 0) {
      return {
        ok: false,
        conflicts: [{ code: "conflict", relPath: String(relInput ?? ""), message: "rootId 无效" }],
      };
    }
    const lex = normalizeRelPath(relInput);
    if (!lex.ok) return { ok: false, conflicts: [lex.conflict] };
    let resolved: unknown;
    try {
      resolved = await deps.resolveInsideRoot(db, rootId, lex.relPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        conflicts: [
          {
            code: "outside-root",
            relPath: lex.relPath,
            message: `路径未通过根目录校验: ${message}`,
          },
        ],
      };
    }
    const abs =
      resolved && typeof resolved === "object" ? (resolved as { absPath?: unknown }).absPath : undefined;
    if (typeof abs !== "string" || !path.isAbsolute(abs)) {
      return {
        ok: false,
        conflicts: [
          {
            code: "outside-root",
            relPath: lex.relPath,
            message: "resolveInsideRoot 没有返回绝对路径",
          },
        ],
      };
    }
    const resourceRaw =
      resolved && typeof resolved === "object"
        ? (resolved as { resourceId?: unknown }).resourceId
        : undefined;
    const resourceId = typeof resourceRaw === "string" && resourceRaw.length > 0 ? resourceRaw : null;
    return {
      ok: true,
      path: { relPath: lex.relPath, absPath: path.resolve(abs), resourceId },
    };
  }

  async function notifyMoved(
    resourceId: string | null,
    before: { rootId: string; relPath: string },
    after: { rootId: string; relPath: string },
  ): Promise<void> {
    if (!resourceId) return;
    await deps.onMoved(resourceId, before, after);
  }

  function linkedResourceId(sourceOpId: string): string | null {
    const id = getOp(sourceOpId)?.resource_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  async function rememberCreated(opId: string, rootId: string, relPath: string): Promise<void> {
    const resourceId = await deps.ensureResource(db, rootId, relPath);
    if (typeof resourceId !== "string" || resourceId.length === 0) {
      throw new Error("ensureResource 没有返回资料 ID");
    }
    db.prepare("UPDATE op_log SET resource_id = ? WHERE id = ?").run(resourceId, opId);
  }

  function parentConflict(absPath: string, relPath: string): Conflict | null {
    let probe = path.dirname(absPath);
    const stop = path.parse(absPath).root;
    while (probe.length > stop.length) {
      const kind = lstatKind(probe);
      if (kind === "dir") return null;
      if (kind === "absent") {
        probe = path.dirname(probe);
        continue;
      }
      return { code: "conflict", relPath, message: "父路径不是目录" };
    }
    return null;
  }

  async function evaluate(op: FileOp): Promise<Evaluation> {
    if (op.type === "create" || op.type === "write") {
      const resolved = await resolveOne(op.rootId, op.relPath);
      if (!resolved.ok) {
        return {
          summary: op.type === "create" ? `拒绝创建 ${op.relPath}` : `拒绝写入 ${op.relPath}`,
          affected: [String(op.relPath ?? "")],
          conflicts: resolved.conflicts,
          targetResourceId: null,
          action: null,
        };
      }
      const { relPath, absPath } = resolved.path;
      const bytes = readContent(op.content);
      const conflicts: Conflict[] = [];
      if (!bytes) conflicts.push({ code: "conflict", relPath, message: "内容必须是字符串或字节" });
      const parent = parentConflict(absPath, relPath);
      if (parent) conflicts.push(parent);
      const kind = lstatKind(absPath);
      if (op.type === "create") {
        if (kind === "file") conflicts.push({ code: "exists", relPath, message: "文件已存在" });
        else if (kind !== "absent") {
          conflicts.push({ code: "conflict", relPath, message: "路径已存在且不是普通文件" });
        }
        const blocked = conflicts.some((item) => item.code !== "exists") || kind !== "absent" || !bytes;
        return {
          summary: conflicts.length ? `无法创建 ${relPath}` : `创建 ${relPath}`,
          affected: [relPath],
          conflicts,
          targetResourceId: resolved.path.resourceId,
          action:
            blocked || !bytes
              ? null
              : { kind: "create", rootId: op.rootId, relPath, absPath, bytes },
        };
      }
      if (kind === "absent") conflicts.push({ code: "missing", relPath, message: "要覆盖的文件不存在" });
      else if (kind !== "file") {
        conflicts.push({ code: "conflict", relPath, message: "要覆盖的路径不是普通文件" });
      }
      return {
        summary: conflicts.length
          ? `无法覆盖 ${relPath}`
          : `覆盖写入 ${relPath}（先按 sha256 备份原文件）`,
        affected: [relPath],
        conflicts,
        targetResourceId: resolved.path.resourceId,
        action:
          conflicts.length || !bytes
            ? null
            : {
                kind: "write",
                rootId: op.rootId,
                relPath,
                absPath,
                bytes,
                resourceId: resolved.path.resourceId,
              },
      };
    }

    if (op.type === "move" || op.type === "rename") {
      const toRootId = op.type === "move" && op.toRootId ? op.toRootId : op.rootId;
      const from = await resolveOne(op.rootId, op.fromRelPath);
      const to = await resolveOne(toRootId, op.toRelPath);
      const conflicts: Conflict[] = [];
      if (!from.ok) conflicts.push(...from.conflicts);
      if (!to.ok) conflicts.push(...to.conflicts);
      const affected = [
        from.ok ? from.path.relPath : String(op.fromRelPath ?? ""),
        to.ok ? to.path.relPath : String(op.toRelPath ?? ""),
      ];
      const verb = op.type === "rename" ? "重命名" : "移动";
      if (!from.ok || !to.ok) {
        return {
          summary: `拒绝${verb}`,
          affected,
          conflicts,
          targetResourceId: to.ok ? to.path.resourceId : null,
          action: null,
        };
      }
      const parent = parentConflict(to.path.absPath, to.path.relPath);
      if (parent) conflicts.push(parent);
      if (toRootId === op.rootId && from.path.relPath === to.path.relPath) {
        conflicts.push({ code: "conflict", relPath: to.path.relPath, message: "源路径和目标路径相同" });
      }
      const fromKind = lstatKind(from.path.absPath);
      if (fromKind === "absent") {
        conflicts.push({ code: "missing", relPath: from.path.relPath, message: "源文件不存在" });
      } else if (fromKind !== "file") {
        conflicts.push({ code: "conflict", relPath: from.path.relPath, message: "源路径不是普通文件" });
      }
      const caseOnly =
        from.path.relPath !== to.path.relPath && sameFile(from.path.absPath, to.path.absPath);
      const toKind = lstatKind(to.path.absPath);
      if (!caseOnly && toKind === "file") {
        conflicts.push({ code: "exists", relPath: to.path.relPath, message: "目标文件已存在" });
      } else if (!caseOnly && toKind !== "absent") {
        conflicts.push({ code: "conflict", relPath: to.path.relPath, message: "目标路径不是普通文件" });
      }
      const hard = conflicts.filter((item) => item.code !== "exists");
      const action: ActionMove | null =
        hard.length === 0 && fromKind === "file"
          ? {
              kind: "move",
              op: op.type,
              rootId: op.rootId,
              toRootId,
              fromRel: from.path.relPath,
              toRel: to.path.relPath,
              fromAbs: from.path.absPath,
              toAbs: to.path.absPath,
              caseOnly,
              resourceId: from.path.resourceId,
            }
          : null;
      const summary = conflicts.length
        ? `无法${verb} ${from.path.relPath} → ${to.path.relPath}`
        : `${verb} ${from.path.relPath} → ${to.path.relPath}`;
      return { summary, affected, conflicts, targetResourceId: to.path.resourceId, action };
    }

    const resolved = await resolveOne(op.rootId, op.relPath);
    if (!resolved.ok) {
      return {
        summary: `拒绝删除 ${op.relPath}`,
        affected: [String(op.relPath ?? "")],
        conflicts: resolved.conflicts,
        targetResourceId: null,
        action: null,
      };
    }
    const kind = lstatKind(resolved.path.absPath);
    const conflicts: Conflict[] = [];
    if (kind === "absent") {
      conflicts.push({ code: "missing", relPath: resolved.path.relPath, message: "文件不存在" });
    } else if (kind !== "file") {
      conflicts.push({ code: "conflict", relPath: resolved.path.relPath, message: "只能删除普通文件" });
    }
    return {
      summary: conflicts.length
        ? `无法删除 ${resolved.path.relPath}`
        : `删除 ${resolved.path.relPath}（移入应用暂存区，不进系统回收站）`,
      affected: [resolved.path.relPath],
      conflicts,
      targetResourceId: resolved.path.resourceId,
      action: conflicts.length
        ? null
        : {
            kind: "delete",
            rootId: op.rootId,
            relPath: resolved.path.relPath,
            absPath: resolved.path.absPath,
            resourceId: resolved.path.resourceId,
          },
    };
  }

  function canRun(op: FileOp, conflicts: Conflict[], overwrite: boolean): boolean {
    if (conflicts.length === 0) return true;
    if ((op.type === "move" || op.type === "rename") && overwrite) {
      return conflicts.every((item) => item.code === "exists");
    }
    return false;
  }

  async function preview(op: FileOp): Promise<PreviewResult> {
    assertMigrated();
    const ev = await evaluate(op);
    return { summary: ev.summary, affected: ev.affected, conflicts: ev.conflicts };
  }

  async function apply(op: FileOp, opts: { actor: Actor; overwrite?: boolean }): Promise<ApplyResult> {
    assertMigrated();
    const opId = randomUUID();
    const actor = opts?.actor;
    const overwrite = opts?.overwrite === true;
    if (!isActor(actor)) {
      return reject({
        opId,
        actor: String(actor),
        op: op.type,
        rootId: op.rootId,
        error: "actor 必须是 ui 或 agent:<name>",
      });
    }
    const ev = await evaluate(op);
    if (!canRun(op, ev.conflicts, overwrite) || !ev.action) {
      return reject({
        opId,
        actor,
        op: op.type,
        rootId: op.rootId,
        resourceId: ev.targetResourceId,
        before: { conflicts: ev.conflicts },
        error: ev.conflicts.map(formatConflict).join("; ") || "无法执行",
      });
    }
    try {
      if (ev.action.kind === "create") await commitCreate(ev.action, opId, actor);
      else if (ev.action.kind === "write") commitWrite(ev.action, opId, actor);
      else if (ev.action.kind === "move") await commitMove(ev.action, opId, actor, overwrite);
      else commitDelete(ev.action, opId, actor);
      const row = getOp(opId);
      if (!row || row.status !== "ok") {
        return { opId, status: "rejected" };
      }
      return { opId, status: "ok" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as NodeJS.ErrnoException).code;
      const existing = getOp(opId);
      if (code === "EEXIST") {
        if (existing?.status === "pending") markOp(opId, "rejected", "rejected", message);
        else if (!existing) {
          return reject({ opId, actor, op: op.type, rootId: op.rootId, error: message });
        }
        return { opId, status: "rejected" };
      }
      if (existing?.status === "pending") markOp(opId, "incomplete", "recovered", message);
      throw err;
    }
  }

  async function commitCreate(action: ActionCreate, opId: string, actor: Actor): Promise<void> {
    const again = lstatKind(action.absPath);
    if (again !== "absent") {
      throw existsError("文件已存在");
    }
    const hash = sha256(action.bytes);
    const before = { relPath: action.relPath, existed: false };
    const after = { relPath: action.relPath, existed: true, size: action.bytes.length, hash };
    insertOp({
      id: opId,
      actor,
      op: "create",
      rootId: action.rootId,
      before,
      after,
      status: "pending",
      phase: "started",
    });
    const tmp = tempPathFor(action.absPath, opId);
    writeTemp(tmp, action.bytes);
    db.prepare("UPDATE op_log SET temp_path = ?, phase = ? WHERE id = ?").run(tmp, "temp_written", opId);
    commitNewFile(tmp, action.absPath);
    await rememberCreated(opId, action.rootId, action.relPath);
    markOp(opId, "ok", "committed", null);
  }

  function commitWrite(action: ActionWrite, opId: string, actor: Actor): void {
    const again = lstatKind(action.absPath);
    if (again !== "file") throw new Error("要覆盖的文件不存在或不是普通文件");
    const previous = fs.readFileSync(action.absPath);
    const before = {
      relPath: action.relPath,
      existed: true,
      size: previous.length,
      hash: sha256(previous),
    };
    const after = {
      relPath: action.relPath,
      existed: true,
      size: action.bytes.length,
      hash: sha256(action.bytes),
    };
    insertOp({
      id: opId,
      actor,
      op: "write",
      rootId: action.rootId,
      resourceId: action.resourceId,
      before,
      status: "pending",
      phase: "started",
    });
    const backupRef = ensureBackup(action.absPath);
    db.prepare("UPDATE op_log SET backup_ref = ?, phase = ? WHERE id = ?").run(
      backupRef,
      "backed_up",
      opId,
    );
    // 备份行已提交。此钩子在替换目标之前退出，原文件字节保持不变。
    crashIf(CRASH_POINT);
    db.prepare("UPDATE op_log SET after_json = ? WHERE id = ?").run(JSON.stringify(after), opId);
    const tmp = tempPathFor(action.absPath, opId);
    writeTemp(tmp, action.bytes);
    db.prepare("UPDATE op_log SET temp_path = ?, phase = ? WHERE id = ?").run(tmp, "temp_written", opId);
    fs.renameSync(tmp, action.absPath);
    markOp(opId, "ok", "committed", null);
  }

  async function commitMove(
    action: ActionMove,
    opId: string,
    actor: Actor,
    overwrite: boolean,
  ): Promise<void> {
    const fromKind = lstatKind(action.fromAbs);
    if (fromKind !== "file") throw new Error("源文件不存在或不是普通文件");
    const toKind = lstatKind(action.toAbs);
    if (!action.caseOnly && toKind === "file" && !overwrite) {
      throw existsError("目标文件已存在");
    }
    if (!action.caseOnly && toKind !== "absent" && toKind !== "file") {
      throw new Error("目标路径不是普通文件");
    }
    const source = fs.readFileSync(action.fromAbs);
    const meta = {
      fromRelPath: action.fromRel,
      toRelPath: action.toRel,
      size: source.length,
      hash: sha256(source),
    };
    const before = { rootId: action.rootId, relPath: action.fromRel, ...meta };
    const after = { rootId: action.toRootId, relPath: action.toRel, ...meta };
    insertOp({
      id: opId,
      actor,
      op: action.op,
      rootId: action.rootId,
      resourceId: action.resourceId,
      before,
      after,
      status: "pending",
      phase: "started",
    });
    let backupRef: string | null = null;
    if (!action.caseOnly && toKind === "file") {
      backupRef = ensureBackup(action.toAbs);
      db.prepare("UPDATE op_log SET backup_ref = ?, phase = ? WHERE id = ?").run(
        backupRef,
        "backed_up",
        opId,
      );
      crashIf(CRASH_POINT);
    }
    fs.mkdirSync(path.dirname(action.toAbs), { recursive: true });
    if (action.caseOnly) {
      renameCaseOnly(action.fromAbs, action.toAbs, opId);
    } else if (toKind === "file") {
      replaceWithRename(action.fromAbs, action.toAbs, opId);
    } else {
      moveFile(action.fromAbs, action.toAbs);
    }
    db.prepare("UPDATE op_log SET phase = ? WHERE id = ?").run("moved", opId);
    await notifyMoved(
      action.resourceId,
      { rootId: action.rootId, relPath: action.fromRel },
      { rootId: action.toRootId, relPath: action.toRel },
    );
    markOp(opId, "ok", "committed", null, { backupRef });
  }

  function commitDelete(action: ActionDelete, opId: string, actor: Actor): void {
    if (lstatKind(action.absPath) !== "file") throw new Error("文件不存在或不是普通文件");
    const bytes = fs.readFileSync(action.absPath);
    const hash = sha256(bytes);
    const stagingId = randomUUID();
    const stored = stagedFilePath(stagingId, action.relPath);
    if (!isWithinDir(stagingDir(), stored)) throw new Error("暂存路径越出 dataDir");
    const before = { relPath: action.relPath, size: bytes.length, hash };
    const after = {
      relPath: action.relPath,
      staged: true,
      stagingId,
      storedPath: stored,
      hash,
      size: bytes.length,
    };
    insertOp({
      id: opId,
      actor,
      op: "delete",
      rootId: action.rootId,
      resourceId: action.resourceId,
      before,
      after,
      status: "pending",
      phase: "started",
      tempPath: stored,
    });
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    moveIntoStaging(action.absPath, stored);
    db.prepare("UPDATE op_log SET phase = ? WHERE id = ?").run("moved", opId);
    const now = Date.now();
    db.prepare(
      `INSERT INTO staging_entries (
        id, op_id, root_id, rel_path, stored_path, size, content_hash, created_at, expires_at, restored_at, purged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      stagingId,
      opId,
      action.rootId,
      action.relPath,
      stored,
      bytes.length,
      hash,
      now,
      now + retentionMs,
    );
    markOp(opId, "ok", "committed", null);
  }

  async function previewRestore(opId: string): Promise<PreviewResult> {
    assertMigrated();
    const plan = await planRestore(opId);
    return { summary: plan.summary, affected: plan.affected, conflicts: plan.conflicts };
  }

  async function restore(
    opId: string,
    opts: { actor: Actor; onConflict: OnConflict },
  ): Promise<ApplyResult> {
    assertMigrated();
    const restoreId = randomUUID();
    const actor = opts?.actor;
    if (!isActor(actor)) {
      return reject({
        opId: restoreId,
        actor: String(actor),
        op: "restore",
        before: { restoresOpId: opId },
        error: "actor 必须是 ui 或 agent:<name>",
      });
    }
    const onConflict = opts?.onConflict;
    if (onConflict !== "cancel" && onConflict !== "rename" && onConflict !== "overwrite") {
      return reject({
        opId: restoreId,
        actor,
        op: "restore",
        before: { restoresOpId: opId },
        error: "onConflict 无效",
      });
    }
    const plan = await planRestore(opId);
    if (plan.conflicts.length === 0 && plan.payload && plan.destinationAbs && plan.rootId) {
      try {
        await runCleanRestore({
          restoreId,
          actor,
          sourceOpId: opId,
          plan,
        });
        return finishRestore(restoreId);
      } catch (err) {
        return failRestore(restoreId, actor, opId, err);
      }
    }
    if (plan.conflicts.length > 0 && onConflict === "cancel") {
      return reject({
        opId: restoreId,
        actor,
        op: "restore",
        rootId: plan.rootId,
        before: { restoresOpId: opId, onConflict, conflicts: plan.conflicts },
        error: "cancel",
      });
    }
    if (!plan.payload || !plan.destinationAbs || !plan.rootId) {
      return reject({
        opId: restoreId,
        actor,
        op: "restore",
        rootId: plan.rootId,
        before: { restoresOpId: opId, onConflict, conflicts: plan.conflicts },
        error: plan.conflicts.map(formatConflict).join("; ") || "无法恢复",
      });
    }
    if (onConflict === "rename") {
      if (!plan.renameOk) {
        return reject({
          opId: restoreId,
          actor,
          op: "restore",
          rootId: plan.rootId,
          before: { restoresOpId: opId, onConflict },
          error: plan.conflicts.map(formatConflict).join("; ") || "无法改名恢复",
        });
      }
      try {
        const alt = pickAlternate(plan.destinationRel, plan.destinationAbs);
        if (!alt) throw new Error("找不到不冲突的新名字");
        const altResolved = await resolveOne(plan.rootId, alt);
        if (!altResolved.ok) throw new Error(altResolved.conflicts.map(formatConflict).join("; "));
        placeBytes({
          restoreId,
          actor,
          sourceOpId: opId,
          rootId: plan.rootId,
          relPath: alt,
          absPath: altResolved.path.absPath,
          bytes: payloadBytes(plan.payload),
          onConflict,
          replaces: false,
          stagingId: plan.payload.kind === "staged" ? plan.payload.stagingId : null,
        });
        return finishRestore(restoreId);
      } catch (err) {
        return failRestore(restoreId, actor, opId, err);
      }
    }
    if (!plan.overwriteOk) {
      return reject({
        opId: restoreId,
        actor,
        op: "restore",
        rootId: plan.rootId,
        before: { restoresOpId: opId, onConflict },
        error: plan.conflicts.map(formatConflict).join("; ") || "无法覆盖恢复",
      });
    }
    try {
      const destKind = lstatKind(plan.destinationAbs);
      if (destKind === "dir" || destKind === "other") {
        return reject({
          opId: restoreId,
          actor,
          op: "restore",
          rootId: plan.rootId,
          before: { restoresOpId: opId, onConflict },
          error: "目标不是普通文件，拒绝覆盖",
        });
      }
      if (plan.payload.kind === "remove") {
        undoCreateFile({
          restoreId,
          actor,
          sourceOpId: opId,
          rootId: plan.rootId,
          relPath: plan.destinationRel,
          absPath: plan.destinationAbs,
          onConflict,
        });
        return finishRestore(restoreId);
      }
      if (plan.payload.kind === "relocate") {
        await overwriteRelocate({
          restoreId,
          actor,
          sourceOpId: opId,
          rootId: plan.rootId,
          relPath: plan.destinationRel,
          absPath: plan.destinationAbs,
          fromAbs: plan.payload.fromAbs,
          fromRel: plan.payload.fromRel,
          fromRootId: plan.payload.fromRootId,
          onConflict,
        });
        return finishRestore(restoreId);
      }
      placeBytes({
        restoreId,
        actor,
        sourceOpId: opId,
        rootId: plan.rootId,
        relPath: plan.destinationRel,
        absPath: plan.destinationAbs,
        bytes: payloadBytes(plan.payload),
        onConflict,
        replaces: true,
        stagingId: plan.payload.kind === "staged" ? plan.payload.stagingId : null,
      });
      return finishRestore(restoreId);
    } catch (err) {
      return failRestore(restoreId, actor, opId, err);
    }
  }

  async function planRestore(opId: string): Promise<RestorePlan> {
    const row = getOp(opId);
    if (!row) {
      return emptyPlan(`找不到操作 ${opId}`, [
        { code: "missing", relPath: "", message: `找不到操作 ${opId}` },
      ]);
    }
    if (row.status !== "ok") {
      return emptyPlan(`操作 ${opId} 状态为 ${row.status}，不能恢复`, [
        { code: "conflict", relPath: "", message: "只能恢复 status=ok 的操作" },
      ]);
    }
    if (row.op === "restore") {
      return emptyPlan("不能恢复一条 restore 记录", [
        { code: "conflict", relPath: "", message: "不能恢复一条 restore 记录" },
      ]);
    }
    const before = parseJson<HashMeta>(row.before_json);
    const after = parseJson<HashMeta>(row.after_json);
    if (!row.root_id || !before || !after) {
      return emptyPlan("操作记录缺少恢复所需的路径或内容", [
        { code: "conflict", relPath: "", message: "操作记录不完整" },
      ]);
    }
    if (row.op === "write") return planUndoWrite(row, before, after);
    if (row.op === "create") return planUndoCreate(row, before, after);
    if (row.op === "delete") return planUndoDelete(row, before, after);
    if (row.op === "move" || row.op === "rename") return planUndoMove(row, before, after);
    return emptyPlan(`不能恢复操作类型 ${row.op}`, [
      { code: "conflict", relPath: "", message: `不能恢复操作类型 ${row.op}` },
    ]);
  }

  async function planUndoWrite(row: OpRow, before: HashMeta, after: HashMeta): Promise<RestorePlan> {
    const relPath = after.relPath;
    const resolved = await resolveOne(row.root_id as string, relPath);
    if (!resolved.ok) {
      return {
        ...emptyPlan(`无法恢复 ${relPath}`, resolved.conflicts),
        rootId: row.root_id,
        destinationRel: relPath,
        sourceOp: row.op,
      };
    }
    const bytes = readBackup(row.backup_ref);
    const conflicts: Conflict[] = [];
    if (!bytes || !before.hash || sha256(bytes) !== before.hash) {
      conflicts.push({ code: "missing", relPath, message: "找不到覆盖前的备份或备份哈希不一致" });
    }
    const kind = lstatKind(resolved.path.absPath);
    if (kind === "dir" || kind === "other") {
      conflicts.push({ code: "conflict", relPath, message: "目标不是普通文件" });
    } else if (kind === "file" && after.hash) {
      const current = sha256(fs.readFileSync(resolved.path.absPath));
      if (current !== after.hash) conflicts.push({ code: "conflict", relPath, message: DRIFT });
    }
    const resolvable = conflicts.length > 0 && conflicts.every(isResolvableConflict) && !!bytes;
    return {
      summary: conflicts.length ? `恢复 ${relPath} 到覆盖前有冲突` : `将 ${relPath} 恢复为覆盖前的字节`,
      affected: [relPath],
      conflicts,
      rootId: row.root_id,
      destinationRel: relPath,
      destinationAbs: resolved.path.absPath,
      payload: bytes ? { kind: "bytes", bytes } : null,
      renameOk: resolvable && kind !== "dir" && kind !== "other",
      overwriteOk: !!bytes && kind !== "dir" && kind !== "other" && conflicts.every(isResolvableConflict),
      sourceOp: row.op,
    };
  }

  async function planUndoCreate(row: OpRow, _before: HashMeta, after: HashMeta): Promise<RestorePlan> {
    const relPath = after.relPath;
    const resolved = await resolveOne(row.root_id as string, relPath);
    if (!resolved.ok) {
      return {
        ...emptyPlan(`无法撤销创建 ${relPath}`, resolved.conflicts),
        rootId: row.root_id,
        destinationRel: relPath,
        sourceOp: row.op,
      };
    }
    const kind = lstatKind(resolved.path.absPath);
    const conflicts: Conflict[] = [];
    let bytes: Buffer | null = null;
    if (kind === "absent") {
      conflicts.push({ code: "missing", relPath, message: "创建的文件已不在" });
    } else if (kind !== "file") {
      conflicts.push({ code: "conflict", relPath, message: "创建的路径不是普通文件" });
    } else {
      bytes = fs.readFileSync(resolved.path.absPath);
      if (after.hash && sha256(bytes) !== after.hash) {
        conflicts.push({ code: "conflict", relPath, message: DRIFT });
      }
    }
    const drifted = conflicts.some((item) => item.message === DRIFT);
    return {
      summary: conflicts.length ? `撤销创建 ${relPath} 有冲突` : `撤销创建 ${relPath}（移入应用暂存区）`,
      affected: [relPath],
      conflicts,
      rootId: row.root_id,
      destinationRel: relPath,
      destinationAbs: resolved.path.absPath,
      payload: bytes ? { kind: "remove", absPath: resolved.path.absPath, bytes } : null,
      renameOk: false,
      overwriteOk: drifted && kind === "file",
      sourceOp: row.op,
    };
  }

  async function planUndoDelete(row: OpRow, before: HashMeta, _after: HashMeta): Promise<RestorePlan> {
    const relPath = before.relPath;
    const staging = db
      .prepare(
        `SELECT * FROM staging_entries
         WHERE op_id = ? AND purged_at IS NULL AND restored_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(row.id) as StagingRow | undefined;
    const resolved = await resolveOne(row.root_id as string, relPath);
    const conflicts: Conflict[] = [];
    if (!resolved.ok) conflicts.push(...resolved.conflicts);
    let bytes: Buffer | null = null;
    if (!staging || !isWithinDir(stagingDir(), staging.stored_path) || !fs.existsSync(staging.stored_path)) {
      conflicts.push({ code: "missing", relPath, message: "暂存文件不存在" });
    } else {
      bytes = fs.readFileSync(staging.stored_path);
      if (sha256(bytes) !== staging.content_hash) {
        conflicts.push({ code: "conflict", relPath, message: "暂存文件哈希不一致" });
      }
    }
    if (resolved.ok) {
      const kind = lstatKind(resolved.path.absPath);
      if (kind === "file") conflicts.push({ code: "exists", relPath, message: "原路径已存在文件" });
      else if (kind !== "absent") conflicts.push({ code: "conflict", relPath, message: "原路径不是普通文件" });
    }
    const destinationAbs = resolved.ok ? resolved.path.absPath : null;
    const destKind = destinationAbs ? lstatKind(destinationAbs) : "other";
    const resolvable =
      !!bytes &&
      conflicts.length > 0 &&
      conflicts.every(isResolvableConflict) &&
      destKind !== "dir" &&
      destKind !== "other";
    return {
      summary: conflicts.length ? `恢复已删除的 ${relPath} 有冲突` : `将暂存文件恢复到 ${relPath}`,
      affected: [relPath],
      conflicts,
      rootId: row.root_id,
      destinationRel: relPath,
      destinationAbs,
      payload:
        bytes && staging
          ? { kind: "staged", stagingId: staging.id, storedPath: staging.stored_path, bytes }
          : null,
      renameOk: resolvable,
      overwriteOk: resolvable || (!!bytes && conflicts.length === 0),
      sourceOp: row.op,
    };
  }

  async function planUndoMove(row: OpRow, before: HashMeta, after: HashMeta): Promise<RestorePlan> {
    const fromRel = after.relPath;
    const toRel = before.relPath;
    const currentRoot = after.rootId || row.root_id || "";
    const backRoot = before.rootId || row.root_id || "";
    const current = await resolveOne(currentRoot, fromRel);
    const back = await resolveOne(backRoot, toRel);
    const conflicts: Conflict[] = [];
    if (!current.ok) conflicts.push(...current.conflicts);
    if (!back.ok) conflicts.push(...back.conflicts);
    let bytes: Buffer | null = null;
    if (current.ok) {
      const kind = lstatKind(current.path.absPath);
      if (kind === "absent") conflicts.push({ code: "missing", relPath: fromRel, message: "移动后的文件不存在" });
      else if (kind !== "file") conflicts.push({ code: "conflict", relPath: fromRel, message: "移动后的路径不是普通文件" });
      else {
        bytes = fs.readFileSync(current.path.absPath);
        if (before.hash && sha256(bytes) !== before.hash) {
          conflicts.push({ code: "conflict", relPath: fromRel, message: DRIFT });
        }
      }
    }
    let destKind: ReturnType<typeof lstatKind> = "absent";
    if (back.ok) {
      destKind = lstatKind(back.path.absPath);
      const caseOnly = current.ok && sameFile(current.path.absPath, back.path.absPath);
      if (!caseOnly && destKind === "file") {
        conflicts.push({ code: "exists", relPath: toRel, message: "原路径已存在文件" });
      } else if (!caseOnly && destKind !== "absent") {
        conflicts.push({ code: "conflict", relPath: toRel, message: "原路径不是普通文件" });
      }
    }
    const drifted = conflicts.some((item) => item.message === DRIFT);
    const resolvable =
      !!bytes &&
      !drifted &&
      conflicts.length > 0 &&
      conflicts.every(isResolvableConflict) &&
      destKind !== "dir" &&
      destKind !== "other";
    return {
      summary: conflicts.length
        ? `恢复位置 ${fromRel} → ${toRel} 有冲突`
        : `将 ${fromRel} 移回 ${toRel}`,
      affected: [fromRel, toRel],
      conflicts,
      rootId: backRoot,
      destinationRel: toRel,
      destinationAbs: back.ok ? back.path.absPath : null,
      payload:
        bytes && current.ok
          ? { kind: "relocate", fromAbs: current.path.absPath, fromRel, fromRootId: currentRoot, bytes }
          : null,
      renameOk: resolvable,
      overwriteOk: resolvable,
      sourceOp: row.op,
    };
  }

  async function runCleanRestore(args: {
    restoreId: string;
    actor: Actor;
    sourceOpId: string;
    plan: RestorePlan;
  }): Promise<void> {
    const plan = args.plan;
    if (!plan.payload || !plan.destinationAbs || !plan.rootId) throw new Error("无法恢复");
    if (plan.payload.kind === "remove") {
      undoCreateFile({
        restoreId: args.restoreId,
        actor: args.actor,
        sourceOpId: args.sourceOpId,
        rootId: plan.rootId,
        relPath: plan.destinationRel,
        absPath: plan.destinationAbs,
        onConflict: "overwrite",
      });
      return;
    }
    if (plan.payload.kind === "relocate") {
      const fromKind = lstatKind(plan.payload.fromAbs);
      const toKind = lstatKind(plan.destinationAbs);
      if (fromKind !== "file") throw new Error("移动后的文件不存在");
      if (toKind !== "absent" && !sameFile(plan.payload.fromAbs, plan.destinationAbs)) {
        throw existsError("原路径已存在文件");
      }
      insertOp({
        id: args.restoreId,
        actor: args.actor,
        op: "restore",
        rootId: plan.rootId,
        resourceId: linkedResourceId(args.sourceOpId),
        before: {
          restoresOpId: args.sourceOpId,
          relPath: plan.payload.fromRel,
          onConflict: "clean",
        },
        status: "pending",
        phase: "started",
      });
      fs.mkdirSync(path.dirname(plan.destinationAbs), { recursive: true });
      if (!sameFile(plan.payload.fromAbs, plan.destinationAbs)) {
        moveFile(plan.payload.fromAbs, plan.destinationAbs);
      }
      await notifyMoved(
        linkedResourceId(args.sourceOpId),
        { rootId: plan.payload.fromRootId, relPath: plan.payload.fromRel },
        { rootId: plan.rootId, relPath: plan.destinationRel },
      );
      const hash = sha256(plan.payload.bytes);
      markOp(args.restoreId, "ok", "committed", null, {
        after: { relPath: plan.destinationRel, existed: true, hash, size: plan.payload.bytes.length, applied: true },
      });
      return;
    }
    placeBytes({
      restoreId: args.restoreId,
      actor: args.actor,
      sourceOpId: args.sourceOpId,
      rootId: plan.rootId,
      relPath: plan.destinationRel,
      absPath: plan.destinationAbs,
      bytes: payloadBytes(plan.payload),
      onConflict: "overwrite",
      replaces: lstatKind(plan.destinationAbs) === "file",
      stagingId: plan.payload.kind === "staged" ? plan.payload.stagingId : null,
    });
  }

  function placeBytes(args: {
    restoreId: string;
    actor: Actor;
    sourceOpId: string;
    rootId: string;
    relPath: string;
    absPath: string;
    bytes: Buffer;
    onConflict: OnConflict | "clean";
    replaces: boolean;
    stagingId: string | null;
  }): void {
    const again = lstatKind(args.absPath);
    if (args.replaces && again !== "file") throw new Error("要覆盖的文件不存在");
    if (!args.replaces && again !== "absent") throw existsError("目标已存在");
    let backupRef: string | null = null;
    insertOp({
      id: args.restoreId,
      actor: args.actor,
      op: "restore",
      rootId: args.rootId,
      resourceId: linkedResourceId(args.sourceOpId),
      before: { restoresOpId: args.sourceOpId, relPath: args.relPath, onConflict: args.onConflict },
      status: "pending",
      phase: "started",
    });
    if (args.replaces) {
      backupRef = ensureBackup(args.absPath);
      db.prepare("UPDATE op_log SET backup_ref = ?, phase = ? WHERE id = ?").run(
        backupRef,
        "backed_up",
        args.restoreId,
      );
      crashIf(CRASH_POINT);
    }
    const after = {
      relPath: args.relPath,
      existed: true,
      size: args.bytes.length,
      hash: sha256(args.bytes),
      applied: true,
      onConflict: args.onConflict,
    };
    db.prepare("UPDATE op_log SET after_json = ? WHERE id = ?").run(JSON.stringify(after), args.restoreId);
    const tmp = tempPathFor(args.absPath, args.restoreId);
    writeTemp(tmp, args.bytes);
    db.prepare("UPDATE op_log SET temp_path = ?, phase = ? WHERE id = ?").run(
      tmp,
      "temp_written",
      args.restoreId,
    );
    if (args.replaces) fs.renameSync(tmp, args.absPath);
    else commitNewFile(tmp, args.absPath);
    if (args.stagingId) {
      const staging = db
        .prepare("SELECT stored_path FROM staging_entries WHERE id = ?")
        .get(args.stagingId) as { stored_path: string } | undefined;
      db.prepare("UPDATE staging_entries SET restored_at = ? WHERE id = ? AND restored_at IS NULL").run(
        Date.now(),
        args.stagingId,
      );
      if (
        staging &&
        staging.stored_path !== args.absPath &&
        isWithinDir(stagingDir(), staging.stored_path)
      ) {
        fs.rmSync(staging.stored_path, { force: true });
        const parent = path.dirname(staging.stored_path);
        if (isWithinDir(stagingDir(), parent)) {
          try {
            fs.rmdirSync(parent);
          } catch {
            // 同目录还有别的暂存文件时不删除。
          }
        }
      }
    }
    markOp(args.restoreId, "ok", "committed", null, { backupRef });
  }

  function undoCreateFile(args: {
    restoreId: string;
    actor: Actor;
    sourceOpId: string;
    rootId: string;
    relPath: string;
    absPath: string;
    onConflict: OnConflict | "clean";
  }): void {
    if (lstatKind(args.absPath) !== "file") throw new Error("创建的文件已不在");
    const stagingId = randomUUID();
    const stored = stagedFilePath(stagingId, args.relPath);
    if (!isWithinDir(stagingDir(), stored)) throw new Error("暂存路径越出 dataDir");
    insertOp({
      id: args.restoreId,
      actor: args.actor,
      op: "restore",
      rootId: args.rootId,
      resourceId: linkedResourceId(args.sourceOpId),
      before: { restoresOpId: args.sourceOpId, relPath: args.relPath, onConflict: args.onConflict },
      status: "pending",
      phase: "started",
      tempPath: stored,
    });
    const backupRef = ensureBackup(args.absPath);
    db.prepare("UPDATE op_log SET backup_ref = ?, phase = ? WHERE id = ?").run(
      backupRef,
      "backed_up",
      args.restoreId,
    );
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    const bytes = fs.readFileSync(args.absPath);
    moveIntoStaging(args.absPath, stored);
    const now = Date.now();
    db.prepare(
      `INSERT INTO staging_entries (
        id, op_id, root_id, rel_path, stored_path, size, content_hash, created_at, expires_at, restored_at, purged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(
      stagingId,
      args.restoreId,
      args.rootId,
      args.relPath,
      stored,
      bytes.length,
      sha256(bytes),
      now,
      now + retentionMs,
    );
    markOp(args.restoreId, "ok", "committed", null, {
      after: { relPath: args.relPath, existed: false, staged: true, stagingId, storedPath: stored, applied: true },
      backupRef,
    });
  }

  async function overwriteRelocate(args: {
    restoreId: string;
    actor: Actor;
    sourceOpId: string;
    rootId: string;
    relPath: string;
    absPath: string;
    fromAbs: string;
    fromRel: string;
    fromRootId: string;
    onConflict: OnConflict;
  }): Promise<void> {
    if (lstatKind(args.fromAbs) !== "file") throw new Error("移动后的文件不存在");
    const destKind = lstatKind(args.absPath);
    if (destKind === "dir" || destKind === "other") throw new Error("原路径不是普通文件");
    insertOp({
      id: args.restoreId,
      actor: args.actor,
      op: "restore",
      rootId: args.rootId,
      resourceId: linkedResourceId(args.sourceOpId),
      before: { restoresOpId: args.sourceOpId, relPath: args.relPath, onConflict: args.onConflict },
      status: "pending",
      phase: "started",
    });
    let backupRef: string | null = null;
    if (destKind === "file") {
      backupRef = ensureBackup(args.absPath);
      db.prepare("UPDATE op_log SET backup_ref = ?, phase = ? WHERE id = ?").run(
        backupRef,
        "backed_up",
        args.restoreId,
      );
      crashIf(CRASH_POINT);
      replaceWithRename(args.fromAbs, args.absPath, args.restoreId);
    } else {
      moveFile(args.fromAbs, args.absPath);
    }
    await notifyMoved(
      linkedResourceId(args.sourceOpId),
      { rootId: args.fromRootId, relPath: args.fromRel },
      { rootId: args.rootId, relPath: args.relPath },
    );
    const bytes = fs.readFileSync(args.absPath);
    markOp(args.restoreId, "ok", "committed", null, {
      after: {
        relPath: args.relPath,
        existed: true,
        size: bytes.length,
        hash: sha256(bytes),
        applied: true,
        onConflict: args.onConflict,
      },
      backupRef,
    });
  }

  function finishRestore(restoreId: string): ApplyResult {
    const row = getOp(restoreId);
    if (!row || row.status !== "ok") return { opId: restoreId, status: "rejected" };
    return { opId: restoreId, status: "ok" };
  }

  function failRestore(restoreId: string, actor: Actor, sourceOpId: string, err: unknown): ApplyResult {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as NodeJS.ErrnoException).code;
    const existing = getOp(restoreId);
    if (existing?.status === "ok") return { opId: restoreId, status: "ok" };
    if (code === "EEXIST" || existing?.status === "pending") {
      if (existing?.status === "pending") {
        markOp(restoreId, code === "EEXIST" ? "rejected" : "incomplete", "recovered", message);
        return { opId: restoreId, status: code === "EEXIST" ? "rejected" : "rejected" };
      }
    }
    if (!existing) {
      return reject({
        opId: restoreId,
        actor,
        op: "restore",
        before: { restoresOpId: sourceOpId },
        error: message,
      });
    }
    if (existing.status === "pending") markOp(restoreId, "incomplete", "recovered", message);
    if (code === "EEXIST") return { opId: restoreId, status: "rejected" };
    throw err instanceof Error ? err : new Error(message);
  }

  async function listExpired(now?: number): Promise<Array<{ id: string; relPath: string; storedPath: string; expiresAt: number }>> {
    assertMigrated();
    const ts = now ?? Date.now();
    const rows = db
      .prepare(
        `SELECT id, rel_path AS relPath, stored_path AS storedPath, expires_at AS expiresAt
         FROM staging_entries
         WHERE purged_at IS NULL AND restored_at IS NULL AND expires_at <= ?
         ORDER BY expires_at ASC, id ASC`,
      )
      .all(ts) as Array<{ id: string; relPath: string; storedPath: string; expiresAt: number }>;
    return rows;
  }

  async function purgeExpired(now?: number): Promise<void> {
    assertMigrated();
    const rows = await listExpired(now);
    const purgedAt = now ?? Date.now();
    for (const row of rows) {
      if (!row.storedPath || !isWithinDir(stagingDir(), row.storedPath)) {
        throw new Error(`拒绝清理暂存区之外的路径: ${row.storedPath}`);
      }
      if (fs.existsSync(row.storedPath)) fs.rmSync(row.storedPath, { force: true });
      const parent = path.dirname(row.storedPath);
      if (isWithinDir(stagingDir(), parent)) {
        try {
          fs.rmdirSync(parent);
        } catch {
          // 目录非空或已被删除时保留。
        }
      }
      db.prepare("UPDATE staging_entries SET purged_at = ? WHERE id = ?").run(purgedAt, row.id);
    }
  }

  async function recoverIncomplete(): Promise<RecoveryItem[]> {
    assertMigrated();
    const rows = db
      .prepare("SELECT * FROM op_log WHERE status = 'pending' ORDER BY ts ASC, id ASC")
      .all() as OpRow[];
    const out: RecoveryItem[] = [];
    for (const row of rows) out.push(await recoverOne(row));
    return out;
  }

  async function recoverOne(row: OpRow): Promise<RecoveryItem> {
    safeDeleteTemp(row);
    if (row.op === "delete") return recoverDelete(row);
    if (row.op === "move" || row.op === "rename") return recoverMove(row);
    return recoverWriteLike(row);
  }

  async function recoverWriteLike(row: OpRow): Promise<RecoveryItem> {
    const after = parseJson<HashMeta>(row.after_json);
    if (
      after?.hash &&
      after.relPath &&
      row.root_id &&
      (row.phase === "temp_written" || row.phase === "replaced")
    ) {
      let landed = false;
      try {
        const resolved = await resolveOne(row.root_id, after.relPath);
        if (resolved.ok && lstatKind(resolved.path.absPath) === "file") {
          const hash = sha256(fs.readFileSync(resolved.path.absPath));
          const tempGone = !row.temp_path || !fs.existsSync(row.temp_path);
          landed = hash === after.hash && tempGone;
        }
      } catch {
        landed = false;
      }
      if (landed) {
        try {
          if (row.op === "create" && !row.resource_id) {
            await rememberCreated(row.id, row.root_id, after.relPath);
          }
          markOp(row.id, "ok", "committed", null);
          return { opId: row.id, status: "ok", error: null };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          markOp(row.id, "incomplete", "recovered", message);
          return { opId: row.id, status: "incomplete", error: message };
        }
      }
    }
    const error = "操作在替换目标前中断，原文件未改";
    markOp(row.id, "incomplete", "recovered", error);
    return { opId: row.id, status: "incomplete", error };
  }

  async function recoverDelete(row: OpRow): Promise<RecoveryItem> {
    const before = parseJson<HashMeta>(row.before_json);
    const stored = row.temp_path;
    let origIsFile = false;
    if (before?.relPath && row.root_id) {
      try {
        const resolved = await resolveOne(row.root_id, before.relPath);
        if (resolved.ok) origIsFile = lstatKind(resolved.path.absPath) === "file";
      } catch {
        origIsFile = false;
      }
    }
    const storedOk =
      !!stored && isWithinDir(stagingDir(), stored) && lstatKind(stored) === "file";
    if (!origIsFile && storedOk && before?.relPath && row.root_id && stored) {
      const bytes = fs.readFileSync(stored);
      const after = parseJson<HashMeta>(row.after_json);
      const stagingId = after?.stagingId ?? randomUUID();
      const existing = db
        .prepare("SELECT id FROM staging_entries WHERE op_id = ? AND purged_at IS NULL")
        .get(row.id);
      if (!existing) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO staging_entries (
            id, op_id, root_id, rel_path, stored_path, size, content_hash, created_at, expires_at, restored_at, purged_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        ).run(
          stagingId,
          row.id,
          row.root_id,
          before.relPath,
          stored,
          bytes.length,
          sha256(bytes),
          now,
          now + retentionMs,
        );
      }
      markOp(row.id, "ok", "committed", null);
      return { opId: row.id, status: "ok", error: null };
    }
    if (origIsFile && storedOk && stored) {
      fs.rmSync(stored, { force: true });
      const parent = path.dirname(stored);
      if (isWithinDir(stagingDir(), parent)) {
        try {
          fs.rmdirSync(parent);
        } catch {
          // 忽略非空目录。
        }
      }
      const error = "删除未完成，已去掉暂存副本，原文件还在";
      markOp(row.id, "incomplete", "recovered", error);
      return { opId: row.id, status: "incomplete", error };
    }
    const error = "删除在完成前中断";
    markOp(row.id, "incomplete", "recovered", error);
    return { opId: row.id, status: "incomplete", error };
  }

  async function recoverMove(row: OpRow): Promise<RecoveryItem> {
    const before = parseJson<HashMeta>(row.before_json);
    const after = parseJson<HashMeta>(row.after_json);
    if (before?.relPath && after?.relPath && row.root_id && before.hash) {
      try {
        const srcRoot = before.rootId || row.root_id;
        const dstRoot = after.rootId || row.root_id;
        const src = await resolveOne(srcRoot, before.relPath);
        const dst = await resolveOne(dstRoot, after.relPath);
        const srcExists = src.ok && lstatKind(src.path.absPath) === "file";
        const dstExists = dst.ok && lstatKind(dst.path.absPath) === "file";
        if (!srcExists && dstExists && dst.ok) {
          const hash = sha256(fs.readFileSync(dst.path.absPath));
          if (hash === before.hash) {
            try {
              await notifyMoved(
                row.resource_id,
                { rootId: srcRoot, relPath: before.relPath },
                { rootId: dstRoot, relPath: after.relPath },
              );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              markOp(row.id, "incomplete", "recovered", message);
              return { opId: row.id, status: "incomplete", error: message };
            }
            markOp(row.id, "ok", "committed", null);
            return { opId: row.id, status: "ok", error: null };
          }
        }
      } catch {
        // 落到未完成。
      }
    }
    const error = "移动在完成前中断，已避免继续改动";
    markOp(row.id, "incomplete", "recovered", error);
    return { opId: row.id, status: "incomplete", error };
  }

  function safeDeleteTemp(row: OpRow): void {
    if (!row.temp_path || !isOurTemp(row.temp_path, row.id)) return;
    if (row.op === "delete") return;
    if (!fs.existsSync(row.temp_path)) return;
    const inData = isWithinDir(dataDir, row.temp_path);
    const base = path.basename(row.temp_path);
    if (!inData && !base.endsWith(".kb-tmp")) return;
    if (lstatKind(row.temp_path) !== "file") return;
    fs.rmSync(row.temp_path, { force: true });
  }

  function ensureBackup(absPath: string): string {
    const data = fs.readFileSync(absPath);
    const hash = sha256(data);
    const stored = path.join(backupDir(), hash);
    if (!isWithinDir(backupDir(), stored)) throw new Error("备份路径越出 dataDir");
    fs.mkdirSync(backupDir(), { recursive: true });
    if (!fs.existsSync(stored)) {
      const tmp = path.join(backupDir(), `.${hash}.${randomUUID()}.kb-tmp`);
      writeTemp(tmp, data);
      try {
        fs.renameSync(tmp, stored);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        if (!fs.existsSync(stored)) throw err;
      }
    }
    db.prepare(
      "INSERT OR IGNORE INTO backups (hash, size, stored_path, created_at) VALUES (?, ?, ?, ?)",
    ).run(hash, data.length, stored, Date.now());
    return hash;
  }

  function readBackup(hash: string | null): Buffer | null {
    if (!hash) return null;
    const row = db
      .prepare("SELECT stored_path FROM backups WHERE hash = ?")
      .get(hash) as { stored_path: string } | undefined;
    if (!row || !isWithinDir(backupDir(), row.stored_path)) return null;
    if (lstatKind(row.stored_path) !== "file") return null;
    const data = fs.readFileSync(row.stored_path);
    if (sha256(data) !== hash) return null;
    return data;
  }

  function stagedFilePath(stagingId: string, relPath: string): string {
    return path.join(stagingDir(), stagingId, baseName(relPath));
  }

  function moveIntoStaging(fromAbs: string, stored: string): void {
    try {
      fs.renameSync(fromAbs, stored);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV") throw err;
      const tmp = `${stored}.${randomUUID()}.kb-tmp`;
      fs.copyFileSync(fromAbs, tmp);
      fs.renameSync(tmp, stored);
      fs.rmSync(fromAbs, { force: true });
    }
  }

  function crashIf(point: string): void {
    if (process.env.KB_FILEOPS_CRASH_POINT !== point) return;
    try {
      db.close();
    } catch {
      // 数据库可能已经关掉。
    }
    process.exit(91);
  }

  function pickAlternate(relPath: string, absPath: string): string | null {
    const slash = relPath.lastIndexOf("/");
    const dir = slash === -1 ? "" : relPath.slice(0, slash);
    const base = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const ext = dot > 0 ? base.slice(dot) : "";
    const stem = ext ? base.slice(0, -ext.length) : base;
    for (let i = 1; i < 1000; i += 1) {
      const name = i === 1 ? `${stem}.restored${ext}` : `${stem}.restored-${i}${ext}`;
      const rel = dir ? `${dir}/${name}` : name;
      const abs = path.join(path.dirname(absPath), name);
      if (lstatKind(abs) === "absent") return rel;
    }
    return null;
  }

  return {
    migrate,
    preview,
    apply,
    previewRestore,
    restore,
    listExpired,
    purgeExpired,
    recoverIncomplete,
  };
}

function readContent(content: string | Uint8Array): Buffer | null {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) {
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  }
  return null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function lstatKind(absPath: string): "absent" | "file" | "dir" | "other" {
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return "other";
    if (st.isFile()) return "file";
    if (st.isDirectory()) return "dir";
    return "other";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
}

function sameFile(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function isActor(actor: unknown): actor is Actor {
  return actor === "ui" || (typeof actor === "string" && /^agent:[^:]+$/.test(actor));
}

function formatConflict(conflict: Conflict): string {
  return `${conflict.code}: ${conflict.relPath}: ${conflict.message}`;
}

function isResolvableConflict(conflict: Conflict): boolean {
  return conflict.code === "exists" || (conflict.code === "conflict" && conflict.message === DRIFT);
}

function tempPathFor(absPath: string, opId: string): string {
  return path.join(path.dirname(absPath), `.${path.basename(absPath)}.${opId}.kb-tmp`);
}

function isOurTemp(tempPath: string, opId: string): boolean {
  const base = path.basename(tempPath);
  return base.endsWith(".kb-tmp") && base.includes(opId);
}

function writeTemp(tmp: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  const fh = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fh, data);
    fs.fsyncSync(fh);
  } finally {
    fs.closeSync(fh);
  }
}

function commitNewFile(tmp: string, absPath: string): void {
  try {
    fs.linkSync(tmp, absPath);
    fs.unlinkSync(tmp);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      fs.rmSync(tmp, { force: true });
      throw existsError("文件已存在");
    }
    if (code !== "ENOTSUP" && code !== "EXDEV" && code !== "EPERM") {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
  if (lstatKind(absPath) !== "absent") {
    fs.rmSync(tmp, { force: true });
    throw existsError("文件已存在");
  }
  fs.renameSync(tmp, absPath);
}

function moveFile(fromAbs: string, toAbs: string): void {
  try {
    fs.renameSync(fromAbs, toAbs);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EXDEV") throw err;
  }
  copyThenUnlink(fromAbs, toAbs);
}

function copyThenUnlink(fromAbs: string, toAbs: string): void {
  const tmp = path.join(path.dirname(toAbs), `.${path.basename(toAbs)}.${randomUUID()}.kb-tmp`);
  try {
    fs.copyFileSync(fromAbs, tmp);
    fs.renameSync(tmp, toAbs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // 目标已经是正式文件。在删源文件之前退出，两边都还在。
  if (process.env.KB_FILEOPS_CRASH_POINT === "exdev-before-unlink") process.exit(91);
  fs.rmSync(fromAbs, { force: true });
}

function replaceWithRename(fromAbs: string, toAbs: string, opId: string): void {
  try {
    fs.renameSync(fromAbs, toAbs);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EXDEV") {
      copyThenUnlink(fromAbs, toAbs);
      return;
    }
    if (code !== "EEXIST" && code !== "EPERM") throw err;
    const aside = tempPathFor(toAbs, `${opId}-aside`);
    fs.renameSync(toAbs, aside);
    try {
      fs.renameSync(fromAbs, toAbs);
    } catch (inner) {
      try {
        fs.renameSync(aside, toAbs);
      } catch {
        // 回滚失败时保留 aside，交给调用方看错误。
      }
      throw inner;
    }
    fs.rmSync(aside, { force: true });
  }
}

function renameCaseOnly(fromAbs: string, toAbs: string, opId: string): void {
  const tmp = tempPathFor(fromAbs, `${opId}-case`);
  fs.renameSync(fromAbs, tmp);
  try {
    fs.renameSync(tmp, toAbs);
  } catch (err) {
    try {
      fs.renameSync(tmp, fromAbs);
    } catch {
      // 保留临时名，错误继续抛出。
    }
    throw err;
  }
}

function existsError(message: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = "EEXIST";
  return err;
}

function payloadBytes(payload: Payload): Buffer {
  return payload.bytes;
}

function parseJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function baseName(relPath: string): string {
  const index = relPath.lastIndexOf("/");
  return index === -1 ? relPath : relPath.slice(index + 1);
}

function emptyPlan(summary: string, conflicts: Conflict[]): RestorePlan {
  return {
    summary,
    affected: [],
    conflicts,
    rootId: null,
    destinationRel: "",
    destinationAbs: null,
    payload: null,
    renameOk: false,
    overwriteOk: false,
    sourceOp: "",
  };
}
