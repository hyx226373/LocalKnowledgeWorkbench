import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileOps } from '@kb/fileops';
import { ensureResource, resolveInsideRoot, updateLocation } from '@kb/identity-watch';
import { createPlanService } from '@kb/plan';
import { createWorkbench, rpcCall, startServer } from '../src/index.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const tokenName = 'demo';
const rootId = 'demo-root';
const original = Buffer.from('知识库演示原文\n第二行 unchanged\n', 'utf8');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-demo-'));
const root = path.join(base, 'root');
const dataDir = path.join(base, 'data');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const note = path.join(root, 'note.txt');
fs.writeFileSync(note, original);

let services;
let started;
let uiDb;
try {
  services = await createWorkbench({
    dataDir,
    roots: [{ id: rootId, name: '演示', localPath: root }],
  });
  started = await startServer({
    dataDir,
    services,
    tokens: [{ name: tokenName, rootIds: [rootId], permission: 'readwrite' }],
  });
  const token = started.tokens[0];
  if (!token) throw new Error('no token');
  const call = async (method, params) => {
    const response = await rpcCall({
      port: started.port,
      token: token.secret,
      method,
      params,
      timeoutMs: 120_000,
    });
    const body = response.body;
    if (response.status !== 200 || !body || typeof body !== 'object' || !('result' in body)) {
      throw new Error(`${method} failed: HTTP ${response.status} ${response.raw}`);
    }
    return body.result;
  };

  const roots = await call('roots.list', {});
  if (!roots.roots.some((item) => item.id === rootId)) throw new Error('connect: root missing');

  const found = await call('search.query', { query: '知识库演示原文' });
  if (!found.hits.some((hit) => hit.relPath.replaceAll('\\', '/') === 'note.txt')) {
    throw new Error(`search missed note.txt: ${JSON.stringify(found)}`);
  }

  const moved = path.join(root, 'archive', 'note.txt');
  const created = await call('plans.create', {
    title: '移动笔记',
    ops: [
      {
        type: 'move',
        rootId,
        fromRelPath: 'note.txt',
        toRelPath: 'archive/note.txt',
      },
    ],
  });
  if (!created.id) throw new Error('plan id missing');
  if (created.actor !== `agent:${tokenName}`) throw new Error(`plan actor ${created.actor}`);
  if (!fs.existsSync(note)) throw new Error('create changed the source');
  const previewed = await call('plans.preview', { planId: created.id });
  const conflicts = (previewed.steps ?? []).flatMap((step) => step.conflicts ?? []);
  if (conflicts.length) throw new Error(`preview conflicts ${JSON.stringify(conflicts)}`);
  if (fs.existsSync(moved)) throw new Error('preview wrote the destination');

  const deniedApprove = await rpcCall({
    port: started.port,
    token: token.secret,
    method: 'plans.approve',
    params: { planId: created.id },
    timeoutMs: 120_000,
  });
  if (deniedApprove.status !== 403 || !deniedApprove.raw.includes('user_approval_required')) {
    throw new Error(`HTTP approve should be refused: ${deniedApprove.status} ${deniedApprove.raw}`);
  }
  if (fs.existsSync(moved)) throw new Error('HTTP approve wrote the destination');

  const ui = openUi(dataDir);
  uiDb = ui.db;
  const cred = await ui.plans.getApprovalCredential({ planId: created.id, actor: 'ui' });
  const applied = await ui.plans.approvePlan({
    planId: created.id,
    contentHash: cred.contentHash,
    actor: 'ui',
  });
  if (applied.status !== 'applied') throw new Error(`plan status ${applied.status} ${JSON.stringify(applied)}`);
  if (applied.actor !== `agent:${tokenName}`) throw new Error(`plan actor ${applied.actor}`);
  if (!fs.existsSync(moved) || fs.existsSync(note)) throw new Error('move did not hit disk');
  if (!fs.readFileSync(moved).equals(original)) throw new Error('moved bytes changed');

  const log = await call('ops.log', {});
  const entry = log.entries.find((item) => item.op === 'move' && item.status === 'ok');
  if (!entry) throw new Error('move missing from ops.log');
  if (entry.actor !== 'ui') throw new Error(`log actor ${entry.actor}`);
  if (typeof entry.resourceId !== 'string' || entry.resourceId.length === 0) {
    throw new Error(`move resourceId is empty: ${JSON.stringify(entry.resourceId)}`);
  }

  const movedRow = readResource(dataDir, entry.resourceId);
  const movedRel = normRel(movedRow?.rel_path);
  if (movedRel !== 'archive/note.txt') {
    throw new Error(`W2 location after move: ${JSON.stringify(movedRow)}`);
  }

  const deniedRestore = await rpcCall({
    port: started.port,
    token: token.secret,
    method: 'ops.restore',
    params: { opId: entry.id, onConflict: 'overwrite' },
    timeoutMs: 120_000,
  });
  if (deniedRestore.status !== 403 || !deniedRestore.raw.includes('plan_required')) {
    throw new Error(`HTTP restore should be refused: ${deniedRestore.status} ${deniedRestore.raw}`);
  }
  if (!fs.existsSync(moved) || fs.existsSync(note)) throw new Error('HTTP restore changed the move');
  if (deniedApprove.raw.includes(cred.contentHash) || deniedRestore.raw.includes(cred.contentHash)) {
    throw new Error('HTTP response leaked the approval credential');
  }

  const restorePlan = await call('plans.create', {
    title: '恢复笔记',
    ops: [{ type: 'restore', opId: entry.id, onConflict: 'overwrite' }],
  });
  const restoreCred = await ui.plans.getApprovalCredential({ planId: restorePlan.id, actor: 'ui' });
  const restoredPlan = await ui.plans.approvePlan({
    planId: restorePlan.id,
    contentHash: restoreCred.contentHash,
    actor: 'ui',
  });
  if (restoredPlan.status !== 'applied') {
    throw new Error(`restore plan ${restoredPlan.status} ${JSON.stringify(restoredPlan)}`);
  }
  if (!fs.existsSync(note)) throw new Error('restore did not return the file');
  if (fs.existsSync(moved)) throw new Error('restore left the moved file');
  const restored = fs.readFileSync(note);
  if (!restored.equals(original)) throw new Error('restored bytes differ');

  const restoredRow = readResource(dataDir, entry.resourceId);
  const restoredRel = normRel(restoredRow?.rel_path);
  if (restoredRow?.id !== entry.resourceId) throw new Error('resource id changed');
  if (restoredRel !== 'note.txt') {
    throw new Error(`W2 location after restore: ${JSON.stringify(restoredRow)}`);
  }

  console.log(`resourceId ${entry.resourceId}`);
  console.log(`movedRel ${movedRel}`);
  console.log(`restoredRel ${restoredRel}`);
  console.log('demo ok');
} finally {
  if (uiDb) uiDb.close();
  if (started) await started.close();
  if (services) await services.close();
  await removeTree(base);
}

function openUi(dir) {
  const db = new Database(path.join(dir, 'workbench.db'));
  db.pragma('busy_timeout = 5000');
  const fileOps = createFileOps({
    db,
    dataDir: dir,
    resolveInsideRoot,
    ensureResource,
    onMoved(resourceId, before, after) {
      return updateLocation(db, resourceId, before, after);
    },
  });
  const plans = createPlanService({ db, fileOps });
  plans.migrate();
  return { db, plans };
}

function readResource(dir, id) {
  const db = new Database(path.join(dir, 'workbench.db'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT id, rel_path, missing FROM resources WHERE id = ?').get(id);
  } finally {
    db.close();
  }
}

function normRel(value) {
  return typeof value === 'string' ? value.replaceAll('\\', '/') : '';
}

async function removeTree(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && error.code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
