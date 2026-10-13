import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createWorkbench, startServer, TOKEN_FILE_NAME } from '../src/index.ts';
import { boot, call, openUiPlan, rpcResult } from './helpers.ts';

test('reuses the token file across restart, then tokens.rotate invalidates the old secret', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-token-'));
  const root = path.join(base, 'root');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root, { recursive: true });
  const spec = [{ name: 'writer', rootIds: ['root-a'], permission: 'readwrite' as const }];
  const firstServices = await createWorkbench({
    dataDir,
    roots: [{ id: 'root-a', name: 'A', localPath: root }],
  });
  const first = await startServer({ dataDir, services: firstServices, tokens: spec });
  const secret = first.tokens[0]?.secret;
  if (!secret) throw new Error('missing token');
  const tokenFile = path.join(dataDir, TOKEN_FILE_NAME);
  const bytes = fs.readFileSync(tokenFile);
  try {
    expect(first.tokens[0]?.secret).toBe(secret);
    await first.close();
    await firstServices.close();

    const secondServices = await createWorkbench({
      dataDir,
      roots: [{ id: 'root-a', name: 'A', localPath: root }],
    });
    const second = await startServer({ dataDir, services: secondServices, tokens: spec });
    try {
      expect(fs.readFileSync(tokenFile).equals(bytes)).toBe(true);
      expect(second.tokens[0]?.secret).toBe(secret);
      const listed = rpcResult<{ roots: { id: string }[] }>(
        await call(second.port, secret, 'roots.list', {}),
      );
      expect(listed.roots.map((item) => item.id)).toEqual(['root-a']);

      const rotated = rpcResult<{ token: string; name: string }>(
        await call(second.port, secret, 'tokens.rotate', {}),
      );
      expect(rotated.name).toBe('writer');
      expect(rotated.token).not.toBe(secret);
      expect((await call(second.port, secret, 'roots.list', {})).status).toBe(401);
      const again = rpcResult<{ roots: { id: string }[] }>(
        await call(second.port, rotated.token, 'roots.list', {}),
      );
      expect(again.roots.map((item) => item.id)).toEqual(['root-a']);
      expect(fs.readFileSync(tokenFile, 'utf8')).toContain(rotated.token);
      expect(fs.readFileSync(tokenFile, 'utf8')).not.toContain(secret);
    } finally {
      await second.close();
      await secondServices.close();
    }
  } finally {
    await removeTree(base);
  }
});

test('ui restore forwards cancel, rename, and overwrite; HTTP ops.restore is refused', async () => {
  const box = await boot();
  const ui = openUiPlan(box.dataDir);
  try {
    const port = box.started.port;
    const token = box.writerSecret;
    await checkConflict(ui, box.rootA, port, token, 'cancel');
    await checkConflict(ui, box.rootA, port, token, 'rename');
    await checkConflict(ui, box.rootA, port, token, 'overwrite');
  } finally {
    ui.close();
    await box.cleanup();
  }
});

async function checkConflict(
  ui: ReturnType<typeof openUiPlan>,
  root: string,
  port: number,
  token: string,
  mode: 'cancel' | 'rename' | 'overwrite',
): Promise<void> {
  const name = `conflict-${mode}.txt`;
  const oldText = `old-${mode}`;
  const newText = `new-${mode}`;
  const source = path.join(root, name);
  const moved = path.join(root, 'away', name);
  fs.writeFileSync(source, oldText);
  const created = rpcResult<{ id: string }>(
    await call(port, token, 'plans.create', {
      title: `move ${name}`,
      ops: [
        {
          type: 'move',
          rootId: 'root-a',
          fromRelPath: name,
          toRelPath: `away/${name}`,
        },
      ],
    }),
  );
  const cred = await ui.plans.getApprovalCredential({ planId: created.id, actor: 'ui' });
  const applied = await ui.plans.approvePlan({
    planId: created.id,
    contentHash: cred.contentHash,
    actor: 'ui',
  });
  expect(applied.status).toBe('applied');
  const opId = applied.steps[0]?.opId;
  if (!opId) throw new Error('missing op id');
  fs.writeFileSync(source, newText);
  const response = await call(port, token, 'ops.restore', { opId, onConflict: mode });
  expect(response.status).toBe(403);
  expect(response.raw).toContain('plan_required');
  expect(response.raw).not.toContain(cred.contentHash);
  expect(fs.readFileSync(source, 'utf8')).toBe(newText);
  expect(fs.readFileSync(moved, 'utf8')).toBe(oldText);
  const direct = await ui.fileOps.restore(opId, { actor: 'ui', onConflict: mode });
  if (mode === 'cancel') {
    expect(direct.status).toBe('rejected');
    expect(fs.readFileSync(source, 'utf8')).toBe(newText);
    expect(fs.readFileSync(moved, 'utf8')).toBe(oldText);
    return;
  }
  expect(direct.status).toBe('ok');
  if (mode === 'rename') {
    expect(fs.readFileSync(source, 'utf8')).toBe(newText);
    expect(fs.readFileSync(path.join(root, `conflict-${mode}.restored.txt`), 'utf8')).toBe(oldText);
    return;
  }
  expect(fs.readFileSync(source, 'utf8')).toBe(oldText);
  expect(fs.existsSync(moved)).toBe(false);
}

async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
