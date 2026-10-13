import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { boot, call, openUiPlan, rpcResult } from './helpers.ts';

test('readwrite ops.apply is rejected and a read token can preview a plan but not run it', async () => {
  const box = await boot();
  try {
    const port = box.started.port;
    const hello = path.join(box.rootA, 'docs', 'hello.txt');
    const original = fs.readFileSync(hello);
    const preview = rpcResult<{ previewId: string }>(
      await call(port, box.writerSecret, 'ops.preview', {
        op: 'move',
        rootId: 'root-a',
        fromPath: 'docs/hello.txt',
        toPath: 'archive/hello.txt',
      }),
    );
    expect(preview.previewId.length).toBeGreaterThan(0);
    const denied = await call(port, box.writerSecret, 'ops.apply', { previewId: preview.previewId });
    expect(denied.status).toBe(403);
    expect(denied.raw).toContain('plan_required');
    expect(fs.readFileSync(hello).equals(original)).toBe(true);
    expect(fs.existsSync(path.join(box.rootA, 'archive', 'hello.txt'))).toBe(false);

    const readerDenied = await call(port, box.readerSecret, 'ops.apply', { previewId: preview.previewId });
    expect(readerDenied.status).toBe(403);
    expect(fs.readFileSync(hello).equals(original)).toBe(true);

    const created = rpcResult<{ id: string; actor: string }>(
      await call(port, box.readerSecret, 'plans.create', {
        title: '只读草稿',
        ops: [
          {
            type: 'create',
            rootId: 'root-a',
            relPath: 'docs/from-reader.txt',
            content: '不应落盘',
          },
        ],
      }),
    );
    expect(created.actor).toBe('agent:reader');
    const planned = rpcResult<{ steps: Array<{ conflicts: unknown[] }> }>(
      await call(port, box.readerSecret, 'plans.preview', { planId: created.id }),
    );
    expect(planned.steps[0]?.conflicts).toEqual([]);
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'from-reader.txt'))).toBe(false);
    const readerApprove = await call(port, box.readerSecret, 'plans.approve', { planId: created.id });
    const readerApply = await call(port, box.readerSecret, 'plans.apply', { planId: created.id });
    expect(readerApprove.status).toBe(403);
    expect(readerApply.status).toBe(403);
    expect(readerApprove.raw).toContain('user_approval_required');
    expect(readerApply.raw).toContain('user_approval_required');
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'from-reader.txt'))).toBe(false);
    expect(fs.readFileSync(hello).equals(original)).toBe(true);

    const foreign = await call(port, box.writerSecret, 'plans.create', {
      title: '越权',
      ops: [{ type: 'delete', rootId: 'root-b', relPath: 'secret.txt' }],
    });
    expect(foreign.status).toBe(403);
    expect(fs.readFileSync(path.join(box.rootB, 'secret.txt'), 'utf8')).toBe('secret-b-only-zz');
  } finally {
    await box.cleanup();
  }
});

test('readwrite create succeeds, but approve, apply, and direct restore stay forbidden', async () => {
  const box = await boot();
  const ui = openUiPlan(box.dataDir);
  try {
    const port = box.started.port;
    const hello = path.join(box.rootA, 'docs', 'hello.txt');
    const original = fs.readFileSync(hello);
    const created = rpcResult<{ id: string; status: string }>(
      await call(port, box.writerSecret, 'plans.create', {
        title: '待批准',
        ops: [
          {
            type: 'write',
            rootId: 'root-a',
            relPath: 'docs/hello.txt',
            content: '不应由令牌落盘',
          },
        ],
      }),
    );
    expect(created.status).toBe('draft');
    const cred = await ui.plans.getApprovalCredential({ planId: created.id, actor: 'ui' });
    const approve = await call(port, box.writerSecret, 'plans.approve', {
      planId: created.id,
      contentHash: cred.contentHash,
    });
    const apply = await call(port, box.writerSecret, 'plans.apply', { planId: created.id });
    expect(approve.status).toBe(403);
    expect(apply.status).toBe(403);
    expect(approve.raw).toContain('user_approval_required');
    expect(apply.raw).toContain('user_approval_required');
    const restore = await call(port, box.writerSecret, 'ops.restore', {
      opId: 'not-a-real-op',
      onConflict: 'overwrite',
    });
    expect(restore.status).toBe(403);
    expect(restore.raw).toContain('plan_required');
    expect(fs.readFileSync(hello).equals(original)).toBe(true);

    const preview = await call(port, box.writerSecret, 'plans.preview', { planId: created.id });
    const loaded = await call(port, box.readerSecret, 'plans.get', { planId: created.id });
    const again = await call(port, box.writerSecret, 'plans.create', {
      title: '另一份草稿',
      ops: [
        {
          type: 'create',
          rootId: 'root-a',
          relPath: 'docs/other.txt',
          content: '仍不落盘',
        },
      ],
    });
    expect(again.status).toBe(200);
    for (const response of [approve, apply, restore, preview, loaded, again]) {
      expect(response.raw).not.toContain(cred.contentHash);
    }
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'other.txt'))).toBe(false);
    const still = await ui.plans.getPlan(created.id);
    expect(still.status).toBe('draft');
  } finally {
    ui.close();
    await box.cleanup();
  }
});
