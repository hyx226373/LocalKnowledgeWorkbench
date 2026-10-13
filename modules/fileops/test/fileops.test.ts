import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFileOps, type FileOps } from "../src/index.js";
import { lexicalResolve } from "./helpers.js";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(pkgRoot, "src");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (!dir) continue;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        const until = Date.now() + 50;
        while (Date.now() < until) {
          // Windows 上数据库句柄释放稍慢，短等再删。
        }
      }
    }
  }
});

describe("fileops", () => {
  it("建 op_log、backups、staging_entries，且不碰别的表", () => {
    const ctx = openCtx();
    ctx.db.exec("CREATE TABLE roots (id TEXT)");
    ctx.ops.migrate();
    const names = tableNames(ctx.db);
    expect(names).toContain("op_log");
    expect(names).toContain("backups");
    expect(names).toContain("staging_entries");
    expect(names).toContain("roots");
    expect(columnNames(ctx.db, "op_log")).toEqual(
      expect.arrayContaining([
        "id",
        "ts",
        "actor",
        "op",
        "resource_id",
        "before_json",
        "after_json",
        "backup_ref",
        "status",
        "error",
      ]),
    );
    expect(columnNames(ctx.db, "backups")).toEqual(
      expect.arrayContaining(["hash", "size", "stored_path", "created_at"]),
    );
    ctx.close();
  });

  it("preview 不写盘也不写 op_log，apply 会重新检查", async () => {
    const ctx = openCtx();
    const rel = "notes/a.txt";
    const abs = path.join(ctx.root, "notes", "a.txt");
    const before = countOps(ctx.db);
    const preview = await ctx.ops.preview({
      type: "create",
      rootId: ctx.rootId,
      relPath: rel,
      content: "第一版",
    });
    expect(preview.conflicts).toEqual([]);
    expect(preview.affected).toEqual([rel]);
    expect(preview.summary.length).toBeGreaterThan(0);
    expect(fs.existsSync(abs)).toBe(false);
    expect(countOps(ctx.db)).toBe(before);

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "后来者");
    const applied = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: rel, content: "第一版" },
      { actor: "ui" },
    );
    expect(applied.status).toBe("rejected");
    expect(statusOf(ctx.db, applied.opId)).not.toBe("ok");
    expect(fs.readFileSync(abs, "utf8")).toBe("后来者");
    ctx.close();
  });

  it("创建文本和二进制文件，成功后不留临时文件", async () => {
    const ctx = openCtx();
    const binary = Buffer.from([0, 255, 10, 13, 0x80]);
    const created = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: "笔记/说明.md", content: "你好" },
      { actor: "agent:indexer" },
    );
    expect(created.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "笔记", "说明.md"))).toEqual(Buffer.from("你好", "utf8"));
    const row = opRow(ctx.db, created.opId);
    expect(row.actor).toBe("agent:indexer");
    expect(row.op).toBe("create");
    expect(row.resource_id).toEqual(expect.any(String));
    expect(row.resource_id!.length).toBeGreaterThan(0);
    expect(row.status).toBe("ok");

    const bin = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: "bin.dat", content: binary },
      { actor: "ui" },
    );
    expect(bin.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "bin.dat"))).toEqual(binary);
    expect(opRow(ctx.db, bin.opId).resource_id).toEqual(expect.any(String));
    expect(opRow(ctx.db, bin.opId).resource_id).not.toBe(row.resource_id);
    expect(allFiles(ctx.root).some((file) => file.includes(".kb-tmp"))).toBe(false);
    expect(await ctx.ops.recoverIncomplete()).toEqual([]);
    ctx.close();
  });

  it("覆盖写入可按字节恢复，备份在 dataDir 且相同哈希只存一份", async () => {
    const ctx = openCtx();
    const original = Buffer.from([0x4f, 0x00, 0xff, 0x0a, 0x80, 0x7f, 0x0d]);
    const next = Buffer.from("changed-内容", "utf8");
    fs.writeFileSync(path.join(ctx.root, "note.bin"), original);
    fs.writeFileSync(path.join(ctx.root, "copy.bin"), original);

    const first = await ctx.ops.apply(
      { type: "write", rootId: ctx.rootId, relPath: "note.bin", content: next },
      { actor: "ui" },
    );
    const second = await ctx.ops.apply(
      { type: "write", rootId: ctx.rootId, relPath: "copy.bin", content: Buffer.from("other") },
      { actor: "ui" },
    );
    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "note.bin"))).toEqual(next);

    const firstRow = opRow(ctx.db, first.opId);
    const secondRow = opRow(ctx.db, second.opId);
    expect(firstRow.backup_ref).toBeTruthy();
    expect(firstRow.backup_ref).toBe(secondRow.backup_ref);
    const backup = backupRow(ctx.db, firstRow.backup_ref as string);
    expect(inside(ctx.dataDir, backup.stored_path)).toBe(true);
    expect(inside(ctx.root, backup.stored_path)).toBe(false);
    expect(fs.readFileSync(backup.stored_path)).toEqual(original);
    const backupFiles = fs.readdirSync(path.join(ctx.dataDir, "backups")).filter((name) => !name.endsWith(".kb-tmp"));
    expect(backupFiles).toEqual([firstRow.backup_ref]);

    const preview = await ctx.ops.previewRestore(first.opId);
    expect(preview.conflicts).toEqual([]);
    const restored = await ctx.ops.restore(first.opId, { actor: "agent:w4", onConflict: "overwrite" });
    expect(restored.status).toBe("ok");
    expect(opRow(ctx.db, restored.opId).op).toBe("restore");
    expect(opRow(ctx.db, restored.opId).actor).toBe("agent:w4");
    expect(fs.readFileSync(path.join(ctx.root, "note.bin"))).toEqual(original);
    ctx.close();
  });

  it("删除进应用暂存区而不是回收站，恢复后字节回到原路径", async () => {
    const ctx = openCtx();
    const unique = `kb-fileops-recycle-probe-${randomUUID()}.bin`;
    const original = Buffer.from([1, 2, 3, 4, 5, 0, 255, 9]);
    const abs = path.join(ctx.root, unique);
    fs.writeFileSync(abs, original);
    const deleted = await ctx.ops.apply(
      { type: "delete", rootId: ctx.rootId, relPath: unique },
      { actor: "ui" },
    );
    expect(deleted.status).toBe("ok");
    expect(fs.existsSync(abs)).toBe(false);
    const staging = ctx.db
      .prepare("SELECT * FROM staging_entries WHERE op_id = ?")
      .get(deleted.opId) as { stored_path: string; rel_path: string };
    expect(staging.rel_path).toBe(unique);
    expect(inside(path.join(ctx.dataDir, "staging"), staging.stored_path)).toBe(true);
    expect(inside(ctx.root, staging.stored_path)).toBe(false);
    expect(fs.readFileSync(staging.stored_path)).toEqual(original);
    expect(readSrc().toLowerCase()).not.toMatch(
      /shfileoperation|ifileoperation|shemptyrecyclebin|shell32|\$recycle|node-trash|recycle-bin/,
    );
    const scan = scanRecycleBin(unique);
    if (scan.checked) expect(scan.hits).toEqual([]);
    else process.stdout.write(`RECYCLE_BIN_SCAN_UNTESTED ${scan.note}\n`);

    const preview = await ctx.ops.previewRestore(deleted.opId);
    expect(preview.conflicts).toEqual([]);
    const restored = await ctx.ops.restore(deleted.opId, { actor: "ui", onConflict: "overwrite" });
    expect(restored.status).toBe("ok");
    expect(fs.readFileSync(abs)).toEqual(original);
    const again = await ctx.ops.restore(deleted.opId, { actor: "ui", onConflict: "overwrite" });
    expect(again.status).toBe("rejected");
    expect(fs.readFileSync(abs)).toEqual(original);
    ctx.close();
  });

  it("移动到已存在目标时，不带 overwrite 的 apply 不改任何字节", async () => {
    const ctx = openCtx();
    const source = Buffer.from([9, 9, 9, 1]);
    const target = Buffer.from([8, 8, 8, 2]);
    fs.mkdirSync(path.join(ctx.root, "from"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "from", "a.bin"), source);
    fs.writeFileSync(path.join(ctx.root, "b.bin"), target);
    const op = {
      type: "move" as const,
      rootId: ctx.rootId,
      fromRelPath: "from/a.bin",
      toRelPath: "b.bin",
    };
    const preview = await ctx.ops.preview(op);
    expect(preview.conflicts.length).toBeGreaterThan(0);
    expect(preview.conflicts.some((item) => item.code === "exists")).toBe(true);
    const applied = await ctx.ops.apply(op, { actor: "ui" });
    expect(applied.status).toBe("rejected");
    expect(statusOf(ctx.db, applied.opId)).not.toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "from", "a.bin"))).toEqual(source);
    expect(fs.readFileSync(path.join(ctx.root, "b.bin"))).toEqual(target);

    const overwritten = await ctx.ops.apply(op, { actor: "ui", overwrite: true });
    expect(overwritten.status).toBe("ok");
    expect(fs.existsSync(path.join(ctx.root, "from", "a.bin"))).toBe(false);
    expect(fs.readFileSync(path.join(ctx.root, "b.bin"))).toEqual(source);
    const row = opRow(ctx.db, overwritten.opId);
    expect(JSON.parse(row.before_json as string).relPath).toBe("from/a.bin");
    expect(JSON.parse(row.after_json as string).relPath).toBe("b.bin");
    expect(fs.readFileSync(backupRow(ctx.db, row.backup_ref as string).stored_path)).toEqual(target);
    ctx.close();
  });

  it("改名把前后位置写进 op_log", async () => {
    const ctx = openCtx();
    const bytes = Buffer.from("rename-me");
    fs.mkdirSync(path.join(ctx.root, "dir"), { recursive: true });
    fs.writeFileSync(path.join(ctx.root, "dir", "old.txt"), bytes);
    const applied = await ctx.ops.apply(
      {
        type: "rename",
        rootId: ctx.rootId,
        fromRelPath: "dir/old.txt",
        toRelPath: "dir/new.txt",
      },
      { actor: "ui" },
    );
    expect(applied.status).toBe("ok");
    const row = opRow(ctx.db, applied.opId);
    expect(row.op).toBe("rename");
    const before = JSON.parse(row.before_json as string) as { relPath: string; fromRelPath: string; toRelPath: string };
    const after = JSON.parse(row.after_json as string) as { relPath: string; fromRelPath: string; toRelPath: string };
    expect(before.relPath).toBe("dir/old.txt");
    expect(before.fromRelPath).toBe("dir/old.txt");
    expect(after.relPath).toBe("dir/new.txt");
    expect(after.toRelPath).toBe("dir/new.txt");
    expect(fs.existsSync(path.join(ctx.root, "dir", "old.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ctx.root, "dir", "new.txt"))).toEqual(bytes);

    const back = await ctx.ops.restore(applied.opId, { actor: "ui", onConflict: "cancel" });
    expect(back.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "dir", "old.txt"))).toEqual(bytes);
    expect(fs.existsSync(path.join(ctx.root, "dir", "new.txt"))).toBe(false);
    ctx.close();
  });

  it("restore 的 cancel、rename、overwrite 分别不改、改名和覆盖备份", async () => {
    const ctx = openCtx();
    const oldBytes = Buffer.from([7, 0, 7, 255]);
    const newBytes = Buffer.from([3, 3, 3, 3]);

    const cancelId = await deleteThenReplace(ctx, "cancel.bin", oldBytes, newBytes);
    const cancelPreview = await ctx.ops.previewRestore(cancelId);
    expect(cancelPreview.conflicts.length).toBeGreaterThan(0);
    const cancel = await ctx.ops.restore(cancelId, { actor: "ui", onConflict: "cancel" });
    expect(cancel.status).toBe("rejected");
    expect(opRow(ctx.db, cancel.opId).status).toBe("rejected");
    expect(opRow(ctx.db, cancel.opId).op).toBe("restore");
    expect(fs.readFileSync(path.join(ctx.root, "cancel.bin"))).toEqual(newBytes);
    const cancelStaging = ctx.db
      .prepare("SELECT stored_path, restored_at FROM staging_entries WHERE op_id = ?")
      .get(cancelId) as { stored_path: string; restored_at: number | null };
    expect(cancelStaging.restored_at).toBeNull();
    expect(fs.readFileSync(cancelStaging.stored_path)).toEqual(oldBytes);

    const renameId = await deleteThenReplace(ctx, "rename.bin", oldBytes, newBytes);
    const renamed = await ctx.ops.restore(renameId, { actor: "ui", onConflict: "rename" });
    expect(renamed.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "rename.bin"))).toEqual(newBytes);
    expect(fs.readFileSync(path.join(ctx.root, "rename.restored.bin"))).toEqual(oldBytes);

    const overwriteId = await deleteThenReplace(ctx, "overwrite.bin", oldBytes, newBytes);
    const overwritten = await ctx.ops.restore(overwriteId, { actor: "ui", onConflict: "overwrite" });
    expect(overwritten.status).toBe("ok");
    expect(fs.readFileSync(path.join(ctx.root, "overwrite.bin"))).toEqual(oldBytes);
    const restoreRow = opRow(ctx.db, overwritten.opId);
    expect(restoreRow.op).toBe("restore");
    expect(restoreRow.backup_ref).toBeTruthy();
    expect(fs.readFileSync(backupRow(ctx.db, restoreRow.backup_ref as string).stored_path)).toEqual(newBytes);
    ctx.close();
  });

  it("根外路径一律拒绝，根外没有写出文件", async () => {
    const ctx = openCtx();
    const leak = `leak-${randomUUID()}.txt`;
    const attempts = [
      `../${leak}`,
      `..\\${leak}`,
      `foo/../../${leak}`,
      `C:/Windows/${leak}`,
      `C:\\Windows\\${leak}`,
      `/tmp/${leak}`,
      `\\\\server\\share\\${leak}`,
      "NUL",
      "foo/COM1.txt",
    ];
    for (const relPath of attempts) {
      const applied = await ctx.ops.apply(
        { type: "create", rootId: ctx.rootId, relPath, content: "nope" },
        { actor: "ui" },
      );
      expect(applied.status).toBe("rejected");
      expect(statusOf(ctx.db, applied.opId)).not.toBe("ok");
    }
    expect(allFiles(ctx.base).some((file) => file.includes(leak))).toBe(false);
    expect(fs.readdirSync(ctx.outside)).toEqual([]);

    const laxCalls: string[] = [];
    const lax = createFileOps({
      db: ctx.db,
      dataDir: ctx.dataDir,
      resolveInsideRoot(_db, _rootId, relPath) {
        laxCalls.push(relPath);
        return {
          rootId: ctx.rootId,
          relPath,
          absPath: path.join(ctx.outside, "leaked.txt"),
          resourceId: null,
        };
      },
      ensureResource: () => "unused",
      onMoved: () => {
        throw new Error("不应移动");
      },
    });
    const leaked = await lax.apply(
      { type: "create", rootId: ctx.rootId, relPath: `../${leak}`, content: "x" },
      { actor: "ui" },
    );
    expect(leaked.status).toBe("rejected");
    expect(laxCalls).toEqual([]);
    expect(fs.readdirSync(ctx.outside)).toEqual([]);

    const throwing = createFileOps({
      db: ctx.db,
      dataDir: ctx.dataDir,
      resolveInsideRoot() {
        throw new Error("outside simulated");
      },
      ensureResource: () => "unused",
      onMoved: () => {
        throw new Error("不应移动");
      },
    });
    const thrown = await throwing.apply(
      { type: "create", rootId: ctx.rootId, relPath: "inside.txt", content: "x" },
      { actor: "ui" },
    );
    expect(thrown.status).toBe("rejected");
    expect(statusOf(ctx.db, thrown.opId)).not.toBe("ok");
    expect(fs.existsSync(path.join(ctx.root, "inside.txt"))).toBe(false);
    const badRows = ctx.db.prepare("SELECT status FROM op_log").all() as Array<{ status: string }>;
    expect(badRows.some((row) => row.status === "ok")).toBe(false);
    ctx.close();
  });

  it("删除保留期默认 30 天，listExpired 之后才 purge，且不删暂存区以外的文件", async () => {
    const ctx = openCtx();
    fs.writeFileSync(path.join(ctx.root, "keep.txt"), "k");
    const deleted = await ctx.ops.apply(
      { type: "delete", rootId: ctx.rootId, relPath: "keep.txt" },
      { actor: "ui" },
    );
    expect(deleted.status).toBe("ok");
    const staging = ctx.db
      .prepare("SELECT id, created_at, expires_at, stored_path FROM staging_entries WHERE op_id = ?")
      .get(deleted.opId) as { id: string; created_at: number; expires_at: number; stored_path: string };
    expect(staging.expires_at - staging.created_at).toBe(30 * 24 * 60 * 60 * 1000);
    expect(await ctx.ops.listExpired(staging.expires_at - 1)).toEqual([]);
    const due = await ctx.ops.listExpired(staging.expires_at);
    expect(due).toEqual([
      {
        id: staging.id,
        relPath: "keep.txt",
        storedPath: staging.stored_path,
        expiresAt: staging.expires_at,
      },
    ]);
    expect(fs.existsSync(staging.stored_path)).toBe(true);

    const short = openCtx(1_000);
    fs.writeFileSync(path.join(short.root, "short.txt"), "s");
    const shortDelete = await short.ops.apply(
      { type: "delete", rootId: short.rootId, relPath: "short.txt" },
      { actor: "ui" },
    );
    const shortRow = short.db
      .prepare("SELECT id, created_at, expires_at, stored_path FROM staging_entries WHERE op_id = ?")
      .get(shortDelete.opId) as { id: string; created_at: number; expires_at: number; stored_path: string };
    expect(shortRow.expires_at - shortRow.created_at).toBe(1_000);
    await short.ops.purgeExpired(shortRow.expires_at);
    expect(fs.existsSync(shortRow.stored_path)).toBe(false);
    expect(await short.ops.listExpired(shortRow.expires_at)).toEqual([]);

    fs.writeFileSync(path.join(short.root, "safe.txt"), "safe");
    fs.writeFileSync(path.join(short.root, "gone.txt"), "gone");
    const gone = await short.ops.apply(
      { type: "delete", rootId: short.rootId, relPath: "gone.txt" },
      { actor: "ui" },
    );
    const goneRow = short.db
      .prepare("SELECT id FROM staging_entries WHERE op_id = ?")
      .get(gone.opId) as { id: string };
    short.db
      .prepare("UPDATE staging_entries SET stored_path = ?, expires_at = 0 WHERE id = ?")
      .run(path.join(short.root, "safe.txt"), goneRow.id);
    await expect(short.ops.purgeExpired(1)).rejects.toThrow(/暂存区之外/);
    expect(fs.readFileSync(path.join(short.root, "safe.txt"), "utf8")).toBe("safe");
    ctx.close();
    short.close();
  });

  it("非法 actor、缺文件、目录和相同路径都会拒绝", async () => {
    const ctx = openCtx();
    const badActor = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: "a.txt", content: "x" },
      { actor: "user" as "ui" },
    );
    expect(badActor.status).toBe("rejected");
    expect(fs.existsSync(path.join(ctx.root, "a.txt"))).toBe(false);

    const missing = await ctx.ops.apply(
      { type: "write", rootId: ctx.rootId, relPath: "missing.txt", content: "x" },
      { actor: "ui" },
    );
    expect(missing.status).toBe("rejected");
    expect(fs.existsSync(path.join(ctx.root, "missing.txt"))).toBe(false);

    fs.mkdirSync(path.join(ctx.root, "subdir"));
    const dirDelete = await ctx.ops.apply(
      { type: "delete", rootId: ctx.rootId, relPath: "subdir" },
      { actor: "ui" },
    );
    expect(dirDelete.status).toBe("rejected");
    expect(fs.statSync(path.join(ctx.root, "subdir")).isDirectory()).toBe(true);

    fs.writeFileSync(path.join(ctx.root, "same.txt"), "s");
    const same = await ctx.ops.apply(
      {
        type: "move",
        rootId: ctx.rootId,
        fromRelPath: "same.txt",
        toRelPath: "same.txt",
      },
      { actor: "ui", overwrite: true },
    );
    expect(same.status).toBe("rejected");
    expect(fs.readFileSync(path.join(ctx.root, "same.txt"), "utf8")).toBe("s");
    ctx.close();
  });

  it("子进程在备份之后、替换之前退出，recoverIncomplete 能看到半完成记录", async () => {
    const ctx = openCtx();
    const original = Buffer.from([0x4f, 0x52, 0x49, 0x47, 0x00, 0xff, 0x0a, 0x80]);
    const rel = "note.txt";
    fs.writeFileSync(path.join(ctx.root, rel), original);
    ctx.close();

    const outDir = path.join(pkgRoot, ".crash-build");
    fs.rmSync(outDir, { recursive: true, force: true });
    dirs.push(outDir);
    const require = createRequire(import.meta.url);
    const tsc = require.resolve("typescript/lib/tsc.js");
    execFileSync(process.execPath, [tsc, "-p", path.join(pkgRoot, "tsconfig.build.json"), "--outDir", outDir], {
      cwd: pkgRoot,
      stdio: "pipe",
    });
    const script = path.join(outDir, "test", "crash-child.js");
    expect(fs.existsSync(script)).toBe(true);

    delete process.env.KB_FILEOPS_CRASH_POINT;
    const child = spawn(process.execPath, [script], {
      cwd: pkgRoot,
      windowsHide: true,
      env: {
        ...process.env,
        KB_FILEOPS_CRASH_POINT: "after-backup",
        KB_FILEOPS_DB: path.join(ctx.dataDir, "ops.db"),
        KB_FILEOPS_DATA_DIR: ctx.dataDir,
        KB_FILEOPS_ROOT: ctx.root,
        KB_FILEOPS_ROOT_ID: ctx.rootId,
        KB_FILEOPS_REL: rel,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    expect({ code, stdout, stderr }).toMatchObject({ code: 91 });

    const db = new Database(path.join(ctx.dataDir, "ops.db"));
    const ops = createFileOps({
      db,
      dataDir: ctx.dataDir,
      resolveInsideRoot: lexicalResolve(new Map([[ctx.rootId, ctx.root]])),
      ensureResource: () => "crash-unused",
      onMoved: () => {
        throw new Error("不应移动");
      },
    });
    ops.migrate();
    expect(fs.readFileSync(path.join(ctx.root, rel))).toEqual(original);
    const found = await ops.recoverIncomplete();
    expect(found).toHaveLength(1);
    expect(found[0]?.status).toBe("incomplete");
    expect(found[0]?.error).toBeTruthy();
    const row = opRow(db, found[0]!.opId);
    expect(row.status).toBe("incomplete");
    expect(row.status).not.toBe("ok");
    expect(row.backup_ref).toBeTruthy();
    expect(row.phase).toBe("recovered");
    expect(fs.readFileSync(backupRow(db, row.backup_ref as string).stored_path)).toEqual(original);
    expect(fs.readFileSync(path.join(ctx.root, rel))).toEqual(original);
    expect(allFiles(ctx.root).some((file) => file.includes(".kb-tmp"))).toBe(false);
    expect(await ops.recoverIncomplete()).toEqual([]);
    db.close();
  });

  it("已有文件的 resourceId 写入 op_log，移动和改名后调用 onMoved", async () => {
    const ids = new Map<string, string>([
      ["root-1\0note.bin", "res-note"],
      ["root-1\0gone.bin", "res-gone"],
      ["root-1\0dir/a.bin", "res-move"],
    ]);
    const ctx = openCtx(undefined, ids);
    expect(readSrc()).not.toMatch(/UPDATE\s+resources|INSERT\s+INTO\s+resources/i);
    fs.writeFileSync(path.join(ctx.root, "note.bin"), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(ctx.root, "gone.bin"), Buffer.from([4, 5]));
    fs.mkdirSync(path.join(ctx.root, "dir"));
    fs.writeFileSync(path.join(ctx.root, "dir", "a.bin"), Buffer.from("move"));

    const written = await ctx.ops.apply(
      { type: "write", rootId: ctx.rootId, relPath: "note.bin", content: "next" },
      { actor: "ui" },
    );
    expect(written.status).toBe("ok");
    expect(opRow(ctx.db, written.opId).resource_id).toBe("res-note");

    const deleted = await ctx.ops.apply(
      { type: "delete", rootId: ctx.rootId, relPath: "gone.bin" },
      { actor: "ui" },
    );
    expect(deleted.status).toBe("ok");
    expect(opRow(ctx.db, deleted.opId).resource_id).toBe("res-gone");
    expect(ctx.moved).toEqual([]);

    const moved = await ctx.ops.apply(
      { type: "move", rootId: ctx.rootId, fromRelPath: "dir/a.bin", toRelPath: "dir/b.bin" },
      { actor: "ui" },
    );
    expect(moved.status).toBe("ok");
    expect(opRow(ctx.db, moved.opId).resource_id).toBe("res-move");
    expect(ctx.moved).toEqual([
      { resourceId: "res-move", beforeRel: "dir/a.bin", afterRel: "dir/b.bin" },
    ]);

    const renamed = await ctx.ops.apply(
      { type: "rename", rootId: ctx.rootId, fromRelPath: "dir/b.bin", toRelPath: "dir/c.bin" },
      { actor: "ui" },
    );
    expect(renamed.status).toBe("ok");
    expect(opRow(ctx.db, renamed.opId).resource_id).toBe("res-move");
    expect(ctx.moved[1]).toEqual({
      resourceId: "res-move",
      beforeRel: "dir/b.bin",
      afterRel: "dir/c.bin",
    });
    ctx.close();
  });

  it("create 因目标已存在被拒绝时写入资料 ID，越界拒绝为 NULL", async () => {
    const ids = new Map<string, string>([
      ["root-1\0exists.txt", "res-exists"],
      ["root-1\0src.bin", "res-src"],
      ["root-1\0dst.bin", "res-dst"],
    ]);
    const ctx = openCtx(undefined, ids);
    fs.writeFileSync(path.join(ctx.root, "exists.txt"), "keep");
    const rejected = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: "exists.txt", content: "nope" },
      { actor: "ui" },
    );
    expect(rejected.status).toBe("rejected");
    const row = opRow(ctx.db, rejected.opId);
    expect(row.status).toBe("rejected");
    expect(row.resource_id).toBe("res-exists");
    expect(fs.readFileSync(path.join(ctx.root, "exists.txt"), "utf8")).toBe("keep");

    const escaped = await ctx.ops.apply(
      { type: "create", rootId: ctx.rootId, relPath: "../outside.txt", content: "x" },
      { actor: "ui" },
    );
    expect(escaped.status).toBe("rejected");
    expect(opRow(ctx.db, escaped.opId).resource_id).toBeNull();
    expect(fs.existsSync(path.join(ctx.base, "outside.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(ctx.root, "exists.txt"), "utf8")).toBe("keep");

    const badActor = await ctx.ops.apply(
      { type: "write", rootId: ctx.rootId, relPath: "exists.txt", content: "x" },
      { actor: "bad" as "ui" },
    );
    expect(badActor.status).toBe("rejected");
    expect(opRow(ctx.db, badActor.opId).resource_id).toBeNull();

    fs.writeFileSync(path.join(ctx.root, "src.bin"), Buffer.from("src"));
    fs.writeFileSync(path.join(ctx.root, "dst.bin"), Buffer.from("dst"));
    const moved = await ctx.ops.apply(
      { type: "move", rootId: ctx.rootId, fromRelPath: "src.bin", toRelPath: "dst.bin" },
      { actor: "ui" },
    );
    expect(moved.status).toBe("rejected");
    expect(opRow(ctx.db, moved.opId).resource_id).toBe("res-dst");
    expect(fs.readFileSync(path.join(ctx.root, "src.bin"))).toEqual(Buffer.from("src"));
    expect(fs.readFileSync(path.join(ctx.root, "dst.bin"))).toEqual(Buffer.from("dst"));
    ctx.close();
  });

  it("跨根 move 后字节一致，恢复回到原根原路径，资料 ID 不变", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-xroot-"));
    dirs.push(base);
    const rootA = path.join(base, "root-a");
    const rootB = path.join(base, "root-b");
    const dataDir = path.join(base, "data");
    fs.mkdirSync(rootA);
    fs.mkdirSync(rootB);
    fs.mkdirSync(dataDir);
    const rootIdA = "root-a";
    const rootIdB = "root-b";
    const bytes = Buffer.from([1, 2, 3, 4, 9]);
    fs.writeFileSync(path.join(rootA, "a.bin"), bytes);
    const db = new Database(path.join(dataDir, "ops.db"));
    const ids = new Map<string, string>([[`${rootIdA}\0a.bin`, "res-a"]]);
    const moved: Array<{
      resourceId: string;
      before: { rootId: string; relPath: string };
      after: { rootId: string; relPath: string };
    }> = [];
    try {
      const ops = createFileOps({
        db,
        dataDir,
        resolveInsideRoot: lexicalResolve(
          new Map([
            [rootIdA, rootA],
            [rootIdB, rootB],
          ]),
          ids,
        ),
        ensureResource() {
          return "unused";
        },
        onMoved(resourceId, before, after) {
          moved.push({
            resourceId,
            before: { rootId: before.rootId, relPath: before.relPath },
            after: { rootId: after.rootId, relPath: after.relPath },
          });
          const from = `${before.rootId}\0${before.relPath}`;
          const to = `${after.rootId}\0${after.relPath}`;
          if (ids.get(from) === resourceId) ids.delete(from);
          ids.set(to, resourceId);
        },
      });
      ops.migrate();
      const applied = await ops.apply(
        {
          type: "move",
          rootId: rootIdA,
          fromRelPath: "a.bin",
          toRelPath: "nested/b.bin",
          toRootId: rootIdB,
        },
        { actor: "ui" },
      );
      expect(applied.status).toBe("ok");
      expect(fs.existsSync(path.join(rootA, "a.bin"))).toBe(false);
      expect(fs.readFileSync(path.join(rootB, "nested", "b.bin"))).toEqual(bytes);
      expect(moved).toEqual([
        {
          resourceId: "res-a",
          before: { rootId: rootIdA, relPath: "a.bin" },
          after: { rootId: rootIdB, relPath: "nested/b.bin" },
        },
      ]);
      const row = db.prepare("SELECT * FROM op_log WHERE id = ?").get(applied.opId) as {
        resource_id: string | null;
        root_id: string | null;
        before_json: string;
        after_json: string;
      };
      expect(row.resource_id).toBe("res-a");
      expect(row.root_id).toBe(rootIdA);
      const before = JSON.parse(row.before_json) as { rootId: string; relPath: string };
      const after = JSON.parse(row.after_json) as { rootId: string; relPath: string };
      expect(before.rootId).toBe(rootIdA);
      expect(before.relPath).toBe("a.bin");
      expect(after.rootId).toBe(rootIdB);
      expect(after.relPath).toBe("nested/b.bin");

      const restored = await ops.restore(applied.opId, { actor: "ui", onConflict: "cancel" });
      expect(restored.status).toBe("ok");
      expect(fs.readFileSync(path.join(rootA, "a.bin"))).toEqual(bytes);
      expect(fs.existsSync(path.join(rootB, "nested", "b.bin"))).toBe(false);
      expect(moved[1]).toEqual({
        resourceId: "res-a",
        before: { rootId: rootIdB, relPath: "nested/b.bin" },
        after: { rootId: rootIdA, relPath: "a.bin" },
      });
    } finally {
      db.close();
    }
  });
});

interface Ctx {
  base: string;
  root: string;
  dataDir: string;
  outside: string;
  rootId: string;
  db: Database.Database;
  ops: FileOps;
  ids: Map<string, string>;
  moved: Array<{ resourceId: string; beforeRel: string; afterRel: string }>;
  close: () => void;
}

function openCtx(retentionMs?: number, seed?: Map<string, string>): Ctx {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-"));
  dirs.push(base);
  const root = path.join(base, "root");
  const dataDir = path.join(base, "data");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const rootId = "root-1";
  const db = new Database(path.join(dataDir, "ops.db"));
  const ids = seed ?? new Map<string, string>();
  const moved: Ctx["moved"] = [];
  const ops = createFileOps({
    db,
    dataDir,
    resolveInsideRoot: lexicalResolve(new Map([[rootId, root]]), ids),
    ensureResource(_db, id, relPath) {
      const key = `${id}\0${relPath}`;
      let resourceId = ids.get(key);
      if (!resourceId) {
        resourceId = randomUUID();
        ids.set(key, resourceId);
      }
      return resourceId;
    },
    onMoved(resourceId, before, after) {
      moved.push({ resourceId, beforeRel: before.relPath, afterRel: after.relPath });
      const from = `${before.rootId}\0${before.relPath}`;
      const to = `${after.rootId}\0${after.relPath}`;
      if (ids.get(from) === resourceId) ids.delete(from);
      ids.set(to, resourceId);
    },
    retentionMs,
  });
  ops.migrate();
  return {
    base,
    root,
    dataDir,
    outside,
    rootId,
    db,
    ops,
    ids,
    moved,
    close() {
      db.close();
    },
  };
}

async function deleteThenReplace(ctx: Ctx, name: string, oldBytes: Buffer, newBytes: Buffer): Promise<string> {
  fs.writeFileSync(path.join(ctx.root, name), oldBytes);
  const deleted = await ctx.ops.apply({ type: "delete", rootId: ctx.rootId, relPath: name }, { actor: "ui" });
  expect(deleted.status).toBe("ok");
  fs.writeFileSync(path.join(ctx.root, name), newBytes);
  return deleted.opId;
}

function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

function countOps(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM op_log").get() as { c: number }).c;
}

function statusOf(db: Database.Database, id: string): string {
  return (db.prepare("SELECT status FROM op_log WHERE id = ?").get(id) as { status: string }).status;
}

function opRow(db: Database.Database, id: string): {
  id: string;
  actor: string;
  op: string;
  resource_id: string | null;
  before_json: string | null;
  after_json: string | null;
  backup_ref: string | null;
  status: string;
  phase: string | null;
} {
  return db.prepare("SELECT * FROM op_log WHERE id = ?").get(id) as never;
}

function backupRow(db: Database.Database, hash: string): { stored_path: string; hash: string } {
  return db.prepare("SELECT * FROM backups WHERE hash = ?").get(hash) as { stored_path: string; hash: string };
}

function inside(parent: string, target: string): boolean {
  const prefix = path.resolve(parent).endsWith(path.sep)
    ? path.resolve(parent)
    : path.resolve(parent) + path.sep;
  const child = path.resolve(target);
  if (process.platform === "win32") return child.toLowerCase().startsWith(prefix.toLowerCase());
  return child.startsWith(prefix);
}

function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allFiles(abs));
    else out.push(abs);
  }
  return out;
}

function readSrc(): string {
  return fs
    .readdirSync(srcDir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => fs.readFileSync(path.join(srcDir, name), "utf8"))
    .join("\n");
}

function scanRecycleBin(fileName: string): { checked: boolean; hits: string[]; note: string } {
  const drives = new Set<string>();
  drives.add((process.env.SystemDrive || "C:") + "\\");
  const hits: string[] = [];
  let readable = 0;
  let denied = 0;
  const needleUtf8 = Buffer.from(fileName);
  const needleUtf16 = Buffer.from(fileName, "utf16le");
  for (const drive of drives) {
    walk(path.join(drive, "$Recycle.Bin"), 0);
  }
  return {
    checked: readable > 0,
    hits,
    note: readable > 0 ? `readable=${readable}` : `denied=${denied}`,
  };

  function walk(dir: string, depth: number): void {
    if (depth > 4 || hits.length > 0 || readable > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      readable += 1;
    } catch {
      denied += 1;
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(fileName.toLowerCase())) hits.push(abs);
      if (entry.isDirectory()) walk(abs, depth + 1);
      else if (entry.isFile() && entry.name.startsWith("$I")) {
        try {
          const buf = fs.readFileSync(abs);
          if (buf.length <= 65_536 && (buf.includes(needleUtf8) || buf.includes(needleUtf16))) hits.push(abs);
        } catch {
          denied += 1;
        }
      }
    }
  }
}
