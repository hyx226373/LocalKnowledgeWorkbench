import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  createRoot,
  ensureResource,
  migrate as migrateIdentity,
  resolveInsideRoot,
  setMount,
  updateLocation,
} from "@kb/identity-watch";
import { createFileOps } from "../dist/index.js";

const rel = process.env.KB_EXDEV_REL;
const srcDir = process.env.KB_EXDEV_SRC;
const dstDir = process.env.KB_EXDEV_DST;
if (!rel || !srcDir || !dstDir) {
  console.error("missing KB_EXDEV_REL, KB_EXDEV_SRC, or KB_EXDEV_DST");
  process.exit(2);
}
if (process.env.KB_FILEOPS_CRASH_POINT !== "exdev-before-unlink") {
  console.error("KB_FILEOPS_CRASH_POINT must be exdev-before-unlink");
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-exdev-child-"));
const db = new Database(path.join(dataDir, "ops.db"));
migrateIdentity(db);
const srcRootId = createRoot(db, { name: "源根" });
const dstRootId = createRoot(db, { name: "目标根" });
setMount(db, srcRootId, srcDir);
setMount(db, dstRootId, dstDir);
ensureResource(db, srcRootId, rel);
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
await ops.apply(
  { type: "move", rootId: srcRootId, toRootId: dstRootId, fromRelPath: rel, toRelPath: rel },
  { actor: "ui" },
);
console.error("crash point was not reached");
process.exit(2);
