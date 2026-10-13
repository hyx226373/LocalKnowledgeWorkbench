import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { createFileOps } from "../src/index.js";
import { lexicalResolve } from "./helpers.js";

const dbPath = must("KB_FILEOPS_DB");
const dataDir = must("KB_FILEOPS_DATA_DIR");
const root = must("KB_FILEOPS_ROOT");
const rootId = must("KB_FILEOPS_ROOT_ID");
const relPath = must("KB_FILEOPS_REL");

const db = new Database(dbPath);
const ops = createFileOps({
  db,
  dataDir,
  resolveInsideRoot: lexicalResolve(new Map([[rootId, root]])),
  ensureResource: () => "crash-child-unused",
  onMoved: () => {
    throw new Error("crash child 不应移动");
  },
});
ops.migrate();

const target = path.join(root, relPath);
if (!fs.existsSync(target)) {
  console.error(`missing target ${target}`);
  process.exit(2);
}

await ops.apply(
  {
    type: "write",
    rootId,
    relPath,
    content: "NEW-CONTENT-SHOULD-NOT-LAND",
  },
  { actor: "ui" },
);

console.error("child finished without hitting the crash point");
process.exit(0);

function must(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`missing env ${name}`);
    process.exit(2);
  }
  return value;
}
