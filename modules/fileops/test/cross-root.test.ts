import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const REL = "dir/note.bin";
const SECOND = process.env.KB_TEST_SECOND_VOLUME?.trim() ?? "";

const bytes = Buffer.concat([
  Buffer.from("cross-root-identity\n"),
  Buffer.from([0, 255, 16, 32, 127, 9]),
]);

if (!SECOND) {
  console.log(
    "SKIP_CROSS_VOLUME 未设置 KB_TEST_SECOND_VOLUME。跨卷 EXDEV 测试已跳过，不算通过。示例：KB_TEST_SECOND_VOLUME=V:\\",
  );
}

it("同卷跨根移动后资料 ID 不变，恢复后回到原根原路径", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-same-"));
  try {
    const srcDir = path.join(base, "src");
    const dstDir = path.join(base, "dst");
    fs.mkdirSync(srcDir);
    fs.mkdirSync(dstDir);
    await assertCrossRootMove({ srcDir, dstDir, restore: true, expectExdev: false });
  } finally {
    rmDir(base);
  }
});

it.skipIf(!SECOND)("跨卷移动到第二个卷，回滚后回到 D 盘", async () => {
  const srcDir = tempOnD("kb-exdev-src-");
  const dstDir = path.join(volumeRoot(SECOND), "kb-root");
  fs.mkdirSync(dstDir, { recursive: true });
  try {
    expectRenameExdev(srcDir, dstDir);
    await assertCrossRootMove({ srcDir, dstDir, restore: true, expectExdev: true });
  } finally {
    rmDir(dstDir);
    rmDir(srcDir);
  }
}, 120_000);

it.skipIf(!SECOND)("跨卷复制完成后、删除源文件之前失败，两边都还在", () => {
  const srcDir = tempOnD("kb-exdev-crash-src-");
  const dstDir = path.join(volumeRoot(SECOND), "kb-crash");
  fs.mkdirSync(dstDir, { recursive: true });
  const srcFile = absOf(srcDir, REL);
  const dstFile = absOf(dstDir, REL);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, bytes);
  try {
    expectRenameExdev(srcDir, dstDir);
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./exdev-crash-child.mjs", import.meta.url))], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: {
        ...process.env,
        KB_FILEOPS_CRASH_POINT: "exdev-before-unlink",
        KB_EXDEV_REL: REL,
        KB_EXDEV_SRC: srcDir,
        KB_EXDEV_DST: dstDir,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(91);
    expect(fs.existsSync(srcFile)).toBe(true);
    expect(fs.existsSync(dstFile)).toBe(true);
    expect(fs.readFileSync(srcFile)).toEqual(bytes);
    expect(fs.readFileSync(dstFile)).toEqual(bytes);
  } finally {
    rmDir(dstDir);
    rmDir(srcDir);
  }
}, 120_000);

async function assertCrossRootMove(options: {
  srcDir: string;
  dstDir: string;
  restore: boolean;
  expectExdev: boolean;
}): Promise<void> {
  const srcFile = absOf(options.srcDir, REL);
  const dstFile = absOf(options.dstDir, REL);
  fs.mkdirSync(path.dirname(srcFile), { recursive: true });
  fs.writeFileSync(srcFile, bytes);
  expect(fs.existsSync(dstFile)).toBe(false);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-fileops-xdata-"));
  const db = new Database(path.join(dataDir, "ops.db"));
  try {
    migrateIdentity(db);
    const srcRootId = createRoot(db, { name: "源根" });
    const dstRootId = createRoot(db, { name: "目标根" });
    setMount(db, srcRootId, options.srcDir);
    setMount(db, dstRootId, options.dstDir);
    const resourceId = ensureResource(db, srcRootId, REL);
    const ops = createFileOps({
      db,
      dataDir,
      resolveInsideRoot,
      ensureResource,
      onMoved(id, before, after) {
        updateLocation(db, id, before, after);
      },
    });
    ops.migrate();

    const beforeStat = fs.statSync(srcFile);
    const moved = await ops.apply(
      { type: "move", rootId: srcRootId, toRootId: dstRootId, fromRelPath: REL, toRelPath: REL },
      { actor: "ui" },
    );
    expect(moved.status, opError(db, moved.opId)).toBe("ok");
    const log = opRow(db, moved.opId);
    expect(log.actor).toBe("ui");
    expect(log.op).toBe("move");
    expect(log.status).toBe("ok");
    expect(log.phase).toBe("committed");
    expect(log.resource_id).toBe(resourceId);
    expect(log.root_id).toBe(srcRootId);
    expect(log.error).toBeNull();
    const before = JSON.parse(log.before_json ?? "null") as { rootId: string; relPath: string; hash: string };
    const after = JSON.parse(log.after_json ?? "null") as { rootId: string; relPath: string; hash: string };
    expect(before.rootId).toBe(srcRootId);
    expect(before.relPath).toBe(REL);
    expect(after.rootId).toBe(dstRootId);
    expect(after.relPath).toBe(REL);
    expect(before.hash).toBe(after.hash);
    expect(before.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(countResource(db, resourceId)).toBe(1);
    expect(getResource(db, resourceId)?.rootId).toBe(dstRootId);
    expect(getResource(db, resourceId)?.relPath).toBe(REL);
    expect(fs.existsSync(srcFile)).toBe(false);
    expect(fs.readFileSync(dstFile)).toEqual(bytes);
    const afterStat = fs.statSync(dstFile);
    if (options.expectExdev) {
      expect(afterStat.dev).not.toBe(beforeStat.dev);
      expect(afterStat.ino).not.toBe(beforeStat.ino);
    } else {
      expect(afterStat.dev).toBe(beforeStat.dev);
      expect(afterStat.ino).toBe(beforeStat.ino);
    }

    if (!options.restore) return;
    const restored = await ops.restore(moved.opId, { actor: "ui", onConflict: "cancel" });
    expect(restored.status, opError(db, restored.opId)).toBe("ok");
    expect(countResource(db, resourceId)).toBe(1);
    expect(getResource(db, resourceId)?.id).toBe(resourceId);
    expect(getResource(db, resourceId)?.rootId).toBe(srcRootId);
    expect(getResource(db, resourceId)?.relPath).toBe(REL);
    expect(fs.existsSync(dstFile)).toBe(false);
    expect(fs.readFileSync(srcFile)).toEqual(bytes);
    const restoreLog = opRow(db, restored.opId);
    expect(restoreLog.op).toBe("restore");
    expect(restoreLog.status).toBe("ok");
    expect(restoreLog.resource_id).toBe(resourceId);
  } finally {
    db.close();
    rmDir(dataDir);
  }
}

function expectRenameExdev(srcDir: string, dstDir: string): void {
  const from = path.join(srcDir, "exdev-probe.bin");
  const to = path.join(dstDir, "exdev-probe.bin");
  fs.writeFileSync(from, Buffer.from("probe"));
  try {
    fs.renameSync(from, to);
    fs.rmSync(to, { force: true });
    throw new Error(`KB_TEST_SECOND_VOLUME=${SECOND} 与源目录在同一卷，fs.renameSync 没有抛 EXDEV`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    fs.rmSync(from, { force: true });
    fs.rmSync(to, { force: true });
    if (code !== "EXDEV") throw error;
  }
}

function volumeRoot(value: string): string {
  const root = path.win32.parse(value).root;
  if (!root || !fs.existsSync(root)) {
    throw new Error(`KB_TEST_SECOND_VOLUME=${value} 不是可用的盘符`);
  }
  return root;
}

function tempOnD(prefix: string): string {
  if (!fs.existsSync("D:\\")) throw new Error("D: 不存在，不能从 D 盘移动到第二个卷");
  return fs.mkdtempSync(path.join("D:\\", prefix));
}

function absOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

function countResource(db: Database.Database, id: string): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM resources WHERE id = ?").get(id) as { n: number };
  return row.n;
}

function opRow(db: Database.Database, opId: string): {
  actor: string;
  op: string;
  root_id: string | null;
  resource_id: string | null;
  before_json: string | null;
  after_json: string | null;
  status: string;
  phase: string;
  error: string | null;
} {
  const row = db
    .prepare(
      `SELECT actor, op, root_id, resource_id, before_json, after_json, status, phase, error
       FROM op_log WHERE id = ?`,
    )
    .get(opId) as
    | {
        actor: string;
        op: string;
        root_id: string | null;
        resource_id: string | null;
        before_json: string | null;
        after_json: string | null;
        status: string;
        phase: string;
        error: string | null;
      }
    | undefined;
  expect(row).toBeTruthy();
  return row!;
}

function opError(db: Database.Database, opId: string): string {
  const row = db.prepare("SELECT status, error FROM op_log WHERE id = ?").get(opId) as
    | { status: string; error: string | null }
    | undefined;
  return `${row?.status ?? "missing"} ${row?.error ?? ""}`.trim();
}

function rmDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
