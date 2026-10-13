import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { createFileOps, type FileOps, type ResolveInsideRoot } from "@kb/fileops";
import { createPlanService, type PlanService } from "../src/index.ts";

export interface Fixture {
  base: string;
  root: string;
  rootId: string;
  db: Database.Database;
  svc: PlanService;
  ensureCalls(): number;
  sawOverwrite(): boolean;
  restoreModes(): string[];
  addRoot(rootId: string, abs: string): string;
  close(): void;
}

export function openFixture(label: string, opts?: { migratePlan?: boolean }): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `kb-plan-${label}-`));
  const rootPath = path.join(base, "root");
  fs.mkdirSync(rootPath, { recursive: true });
  const root = fs.realpathSync(rootPath);
  const dataDir = path.join(base, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "plan.db"));
  db.pragma("journal_mode = DELETE");
  const rootId = "root-a";
  const roots = new Map<string, string>([[rootId, root]]);
  let ensureCalls = 0;
  let sawOverwrite = false;
  const restoreModes: string[] = [];
  const raw = createFileOps({
    db,
    dataDir,
    resolveInsideRoot: lexicalResolve(roots),
    ensureResource() {
      ensureCalls += 1;
      return randomUUID();
    },
    onMoved() {
      return undefined;
    },
  });
  raw.migrate();
  const fileOps: FileOps = {
    migrate: () => raw.migrate(),
    preview: (op) => raw.preview(op),
    apply(op, applyOpts) {
      if (applyOpts.overwrite === true) sawOverwrite = true;
      return raw.apply(op, applyOpts);
    },
    previewRestore: (id) => raw.previewRestore(id),
    restore(id, restoreOpts) {
      restoreModes.push(restoreOpts.onConflict);
      return raw.restore(id, restoreOpts);
    },
    listExpired: (now) => raw.listExpired(now),
    purgeExpired: (now) => raw.purgeExpired(now),
    recoverIncomplete: () => raw.recoverIncomplete(),
  };
  mount(db, rootId, root);
  const svc = createPlanService({ db, fileOps });
  if (opts?.migratePlan !== false) svc.migrate();
  return {
    base,
    root,
    rootId,
    db,
    svc,
    ensureCalls: () => ensureCalls,
    sawOverwrite: () => sawOverwrite,
    restoreModes: () => restoreModes,
    addRoot(id, abs) {
      fs.mkdirSync(abs, { recursive: true });
      const real = fs.realpathSync(abs);
      roots.set(id, real);
      mount(db, id, real);
      return real;
    },
    close() {
      db.close();
      removeTree(base);
    },
  };
}

export function seedResource(db: Database.Database, rootId: string, relPath: string, id: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      rel_path_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      missing INTEGER NOT NULL DEFAULT 0
    );
  `);
  const key = process.platform === "win32" ? relPath.toLowerCase() : relPath;
  db.prepare(
    `INSERT INTO resources (id, root_id, rel_path, rel_path_key, kind, missing)
     VALUES (?, ?, ?, ?, 'file', 0)`,
  ).run(id, rootId, relPath, key);
}

export function snapshot(root: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (dir: string, rel: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const child = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs, child);
      else if (st.isFile()) out.set(child, fs.readFileSync(abs));
    }
  };
  walk(root, "");
  return out;
}

function mount(db: Database.Database, rootId: string, abs: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS root_mounts (
      root_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      local_path TEXT NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (root_id, machine_id)
    );
  `);
  const real = fs.realpathSync(abs);
  db.prepare(
    `INSERT INTO root_mounts (root_id, machine_id, local_path, updated_at)
     VALUES (?, 'test', ?, ?)
     ON CONFLICT(root_id, machine_id) DO UPDATE SET local_path = excluded.local_path, updated_at = excluded.updated_at`,
  ).run(rootId, real, Date.now());
}

function lexicalResolve(roots: Map<string, string>): ResolveInsideRoot {
  return (_db, rootId, relPath) => {
    const root = roots.get(rootId);
    if (!root) throw new Error(`unknown root ${rootId}`);
    if (typeof relPath !== "string" || relPath.length === 0) throw new Error("empty path");
    if (relPath.includes("\0") || relPath.includes("\\") || relPath.includes(":")) throw new Error("bad path");
    if (relPath.startsWith("/") || relPath.startsWith("\\\\")) throw new Error("absolute");
    const parts = relPath.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error("traversal");
    const abs = path.resolve(root, ...parts);
    const rel = path.relative(root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("outside root");
    return { rootId, relPath, absPath: abs, resourceId: null };
  };
}

function removeTree(dir: string): void {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      const until = Date.now() + 40;
      while (Date.now() < until) {
        // Windows 上数据库句柄释放稍慢。
      }
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
