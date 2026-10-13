import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import {
  createRoot,
  ensureResource,
  getResource,
  migrate as migrateIdentity,
  resolveInsideRoot,
  setMount,
  updateLocation,
} from "@kb/identity-watch";
import { createFileOps } from "../src/index.js";

const symlinkNote = path.join(os.tmpdir(), "kb-fileops-symlink-attempt.txt");

it("覆盖、删除、移动后 op_log.resource_id 等于 W2 的资料 ID，移动后 ID 不变", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-id-"));
  const root = path.join(base, "root");
  const dataDir = path.join(base, "data");
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, "dir"));
  fs.mkdirSync(dataDir);
  const original = Buffer.from([0x10, 0x00, 0xff]);
  const goneBytes = Buffer.from([0x22, 0x33]);
  const moveBytes = Buffer.from("move-me");
  fs.writeFileSync(path.join(root, "note.bin"), original);
  fs.writeFileSync(path.join(root, "gone.bin"), goneBytes);
  fs.writeFileSync(path.join(root, "dir", "a.bin"), moveBytes);
  const db = new Database(path.join(dataDir, "ops.db"));
  try {
    migrateIdentity(db);
    const rootId = createRoot(db, { name: "联调根" });
    setMount(db, rootId, root);
    const noteId = ensureResource(db, rootId, "note.bin");
    const goneId = ensureResource(db, rootId, "gone.bin");
    const moveId = ensureResource(db, rootId, "dir/a.bin");
    const ops = createFileOps({
      db,
      dataDir,
      resolveInsideRoot,
      ensureResource,
      onMoved(resourceId, before, after) {
        return updateLocation(db, resourceId, before, after);
      },
    });
    ops.migrate();

    const created = await ops.apply(
      { type: "create", rootId, relPath: "fresh.txt", content: "new" },
      { actor: "ui" },
    );
    expect(created.status).toBe("ok");
    const createdId = resourceIdOf(db, created.opId);
    expect(createdId).toBeTruthy();
    expect(getResource(db, createdId)?.id).toBe(createdId);
    expect(getResource(db, createdId)?.relPath).toBe("fresh.txt");

    const written = await ops.apply(
      { type: "write", rootId, relPath: "note.bin", content: Buffer.from([9, 9]) },
      { actor: "ui" },
    );
    expect(written.status).toBe("ok");
    expect(resourceIdOf(db, written.opId)).toBe(noteId);
    expect(getResource(db, noteId)?.id).toBe(noteId);

    const deleted = await ops.apply(
      { type: "delete", rootId, relPath: "gone.bin" },
      { actor: "ui" },
    );
    expect(deleted.status).toBe("ok");
    expect(resourceIdOf(db, deleted.opId)).toBe(goneId);
    expect(fs.existsSync(path.join(root, "gone.bin"))).toBe(false);

    const moved = await ops.apply(
      { type: "move", rootId, fromRelPath: "dir/a.bin", toRelPath: "dir/b.bin" },
      { actor: "ui" },
    );
    expect(moved.status).toBe("ok");
    expect(resourceIdOf(db, moved.opId)).toBe(moveId);
    const snap = getResource(db, moveId);
    expect(snap).not.toBeNull();
    expect(snap!.id).toBe(moveId);
    expect(snap!.relPath).toBe("dir/b.bin");
    expect(fs.existsSync(path.join(root, "dir", "a.bin"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "dir", "b.bin"))).toEqual(moveBytes);
  } finally {
    db.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

it("经 identity-watch 的 resolveInsideRoot 拒绝指向根外的 junction", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-iw-"));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const dataDir = path.join(base, "data");
  const symlinkPath = path.join(root, "sym-out");
  const junction = path.join(root, "jump");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(dataDir);
  const marker = path.join(outside, "marker.txt");
  fs.writeFileSync(marker, "keep");

  let symlinkError: string | null = null;
  try {
    fs.symlinkSync(outside, symlinkPath, "dir");
  } catch (error) {
    symlinkError = errorText(error);
  }
  fs.writeFileSync(
    symlinkNote,
    symlinkError === null ? "SYMLINK_OK" : `SYMLINK_FAIL\n${symlinkError}`,
    "utf8",
  );

  let db: Database.Database | null = null;
  try {
    execFileSync("cmd.exe", ["/d", "/c", "mklink", "/J", junction, outside], {
      windowsHide: true,
    });
    db = new Database(path.join(dataDir, "ops.db"));
    migrateIdentity(db);
    const rootId = createRoot(db, { name: "联调根" });
    setMount(db, rootId, root);
    const ops = createFileOps({
      db,
      dataDir,
      resolveInsideRoot,
      ensureResource,
      onMoved(resourceId, before, after) {
        return updateLocation(db, resourceId, before, after);
      },
    });
    ops.migrate();

    const inside = await ops.apply(
      { type: "create", rootId, relPath: "plain.txt", content: "inside" },
      { actor: "ui" },
    );
    expect(inside.status).toBe("ok");
    expect(fs.readFileSync(path.join(root, "plain.txt"), "utf8")).toBe("inside");
    expect(fs.readdirSync(outside)).toEqual(["marker.txt"]);

    await expectRejected(ops, db, rootId, "jump/escaped.txt", outside);
    if (symlinkError === null) {
      await expectRejected(ops, db, rootId, "sym-out/escaped.txt", outside);
    }
    expect(fs.readFileSync(marker, "utf8")).toBe("keep");
    expect(fs.readdirSync(outside)).toEqual(["marker.txt"]);
  } finally {
    removeLink(junction);
    removeLink(symlinkPath);
    if (db) {
      try {
        db.close();
      } catch {
        // 重复关闭时忽略。
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function resourceIdOf(db: Database.Database, opId: string): string {
  const row = db.prepare("SELECT resource_id FROM op_log WHERE id = ?").get(opId) as {
    resource_id: string | null;
  };
  expect(row.resource_id).toEqual(expect.any(String));
  return row.resource_id as string;
}

async function expectRejected(
  ops: ReturnType<typeof createFileOps>,
  db: Database.Database,
  rootId: string,
  relPath: string,
  outside: string,
): Promise<void> {
  const preview = await ops.preview({
    type: "create",
    rootId,
    relPath,
    content: "should-not-land",
  });
  expect(preview.conflicts.some((item) => item.code === "outside-root")).toBe(true);
  const applied = await ops.apply(
    { type: "create", rootId, relPath, content: "should-not-land" },
    { actor: "ui" },
  );
  expect(applied.status).toBe("rejected");
  const row = db.prepare("SELECT status FROM op_log WHERE id = ?").get(applied.opId) as { status: string };
  expect(row.status).not.toBe("ok");
  expect(fs.existsSync(path.join(outside, "escaped.txt"))).toBe(false);
}

function removeLink(link: string): void {
  if (!fs.existsSync(link)) return;
  try {
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink()) return;
  } catch {
    return;
  }
  try {
    fs.rmdirSync(link);
  } catch {
    try {
      fs.unlinkSync(link);
    } catch {
      // 留给上层递归删除；不要对 junction 做 /s。
    }
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const extra = error as NodeJS.ErrnoException & { stderr?: Buffer; stdout?: Buffer };
    const parts = [extra.code, error.name, error.message];
    if (extra.stderr?.length) parts.push(extra.stderr.toString("utf8"));
    if (extra.stdout?.length) parts.push(extra.stdout.toString("utf8"));
    return parts.filter((part) => part && part.length > 0).join("\n");
  }
  return String(error);
}
