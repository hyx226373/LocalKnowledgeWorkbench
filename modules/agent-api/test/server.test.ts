import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { createWorkbench, startServer, TOKEN_FILE_NAME } from '../src/index.ts';
import { pdfWithText } from './pdf-fixture.ts';
import {
  aceGrantsRead,
  aclLines,
  boot,
  call,
  isEveryoneOrUsers,
  lanIpv4,
  makeJunction,
  openUiPlan,
  rpcResult,
  sameSnapshot,
  snapshotFiles,
  tcpConnect,
} from './helpers.ts';

test('refuses 0.0.0.0 and other non-127.0.0.1 hosts before listen', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-bind-'));
  const root = path.join(base, 'root');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(root, { recursive: true });
  const services = await createWorkbench({
    dataDir,
    roots: [{ id: 'root-a', name: 'A', localPath: root }],
  });
  try {
    const tokens = [{ name: 'writer', rootIds: ['root-a'], permission: 'readwrite' as const }];
    for (const host of ['0.0.0.0', '10.1.2.3', 'localhost', '::1', '']) {
      await expect(
        startServer({ host, dataDir, services, tokens }),
        host,
      ).rejects.toThrow(/127\.0\.0\.1/);
    }
    expect(fs.existsSync(path.join(dataDir, TOKEN_FILE_NAME))).toBe(false);
  } finally {
    await services.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('loopback listener is not reachable on a LAN address', async () => {
  const box = await boot();
  try {
    const port = box.started.port;
    expect(box.started.host).toBe('127.0.0.1');
    await expect(tcpConnect('127.0.0.1', port)).resolves.toBeUndefined();
    const lans = lanIpv4();
    expect(lans.length, 'this machine has no non-loopback IPv4 address').toBeGreaterThan(0);
    for (const host of lans.slice(0, 3)) {
      await expect(tcpConnect(host, port), host).rejects.toThrow();
    }
  } finally {
    await box.cleanup();
  }
});

test('auth, host, origin, read-only token, and unauthorized roots', async () => {
  const box = await boot();
  try {
    const port = box.started.port;
    const missing = await call(port, undefined, 'roots.list', {});
    const wrong = await call(port, 'not-the-token', 'roots.list', {});
    const badHost = await call(port, box.writerSecret, 'roots.list', {}, { hostHeader: `localhost:${port}` });
    const bareHost = await call(port, box.writerSecret, 'roots.list', {}, { hostHeader: '127.0.0.1' });
    const origin = await call(port, box.writerSecret, 'roots.list', {}, { origin: 'https://evil.test' });
    for (const response of [missing, wrong]) expect(response.status).toBe(401);
    for (const response of [badHost, bareHost, origin]) expect(response.status).toBe(403);
    expect(origin.headers['access-control-allow-origin']).toBeUndefined();
    expect(JSON.stringify(origin.headers).toLowerCase()).not.toContain('access-control-allow');
    expect(missing.raw).not.toContain(box.writerSecret);
    expect(wrong.raw).not.toContain(box.writerSecret);
    expect(origin.raw).not.toContain(box.writerSecret);

    const ok = rpcResult<{ roots: { id: string }[] }>(await call(port, box.writerSecret, 'roots.list', {}));
    expect(ok.roots.map((root) => root.id)).toEqual(['root-a']);

    const readerPreview = rpcResult<{ previewId: string }>(
      await call(port, box.readerSecret, 'ops.preview', {
        op: 'move',
        rootId: 'root-a',
        fromPath: 'docs/hello.txt',
        toPath: 'docs/moved.txt',
      }),
    );
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'hello.txt'))).toBe(true);
    expect((await call(port, box.readerSecret, 'ops.apply', { previewId: readerPreview.previewId })).status).toBe(403);
    const readerRestore = await call(port, box.readerSecret, 'ops.restore', { opId: 'missing', onConflict: 'cancel' });
    expect(readerRestore.status).toBe(403);
    expect(readerRestore.raw).toContain('plan_required');
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'hello.txt'))).toBe(true);
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'moved.txt'))).toBe(false);

    expect((await call(port, box.writerSecret, 'fs.list', { rootId: 'root-b', path: '' })).status).toBe(403);
    expect((await call(port, box.writerSecret, 'fs.read', { rootId: 'root-b', path: 'secret.txt' })).status).toBe(403);
    expect(
      (await call(port, box.writerSecret, 'search.query', { query: 'secret-b-only-zz', rootId: 'root-b' })).status,
    ).toBe(403);
    expect(
      (
        await call(port, box.writerSecret, 'ops.preview', {
          op: 'move',
          rootId: 'root-b',
          fromPath: 'secret.txt',
          toPath: 'x.txt',
        })
      ).status,
    ).toBe(403);
    const leaked = rpcResult<{ hits: unknown[] }>(
      await call(port, box.writerSecret, 'search.query', { query: 'secret-b-only-zz' }),
    );
    expect(leaked.hits).toEqual([]);

    const acl = aclLines(box.started.tokenFile);
    expect(acl.length).toBeGreaterThan(0);
    const shared = acl.filter((line) => {
      const [sid, rights, kind] = line.split('|');
      return kind === 'Allow' && sid && rights && isEveryoneOrUsers(sid) && aceGrantsRead(rights);
    });
    expect(shared, acl.join('\n')).toEqual([]);
    const stored = fs.readFileSync(box.started.tokenFile, 'utf8');
    expect(stored).toContain(box.writerSecret);
    expect(path.basename(box.started.tokenFile)).toBe(TOKEN_FILE_NAME);
  } finally {
    await box.cleanup();
  }
});

test('rejects traversal, absolute paths, and outside junctions without writing outside', async () => {
  const box = await boot();
  const outside = path.join(box.base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
  const before = snapshotFiles(outside);
  try {
    const port = box.started.port;
    const token = box.writerSecret;
    const junction = path.join(box.rootA, 'escape');
    makeJunction(junction, outside);
    let symlinkError: string | null = null;
    try {
      fs.symlinkSync(outside, path.join(box.rootA, 'symdir'), 'dir');
    } catch (error) {
      symlinkError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    const paths = [
      '../outside/secret.txt',
      'docs/../../outside/secret.txt',
      path.join(outside, 'secret.txt'),
      'C:/Windows/win.ini',
      'escape/secret.txt',
      'escape/planted.txt',
    ];
    if (!symlinkError) paths.push('symdir/secret.txt');
    for (const rel of paths) {
      const read = await call(port, token, 'fs.read', { rootId: 'root-a', path: rel });
      const preview = await call(port, token, 'ops.preview', {
        op: 'move',
        rootId: 'root-a',
        fromPath: 'docs/hello.txt',
        toPath: rel,
      });
      expect(read.status, rel).toBeGreaterThanOrEqual(400);
      expect(preview.status, rel).toBeGreaterThanOrEqual(400);
    }
    const listEscape = await call(port, token, 'fs.list', { rootId: 'root-a', path: 'escape' });
    expect(listEscape.status).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(outside, 'planted.txt'))).toBe(false);
    expect(sameSnapshot(before, snapshotFiles(outside))).toBe(true);
    expect(fs.readFileSync(path.join(box.rootA, 'docs', 'hello.txt'), 'utf8')).toBe('hello knowledge base');
    if (symlinkError) expect(symlinkError.length).toBeGreaterThan(0);
  } finally {
    await box.cleanup();
  }
});

test('reads text and pdf with a size cap, then move, log actor, and restore', async () => {
  const box = await boot();
  try {
    const port = box.started.port;
    const token = box.writerSecret;
    const text = rpcResult<{ text: string; truncated: boolean; kind: string }>(
      await call(port, token, 'fs.read', { rootId: 'root-a', path: 'docs/cn.txt' }),
    );
    expect(text.kind).toBe('text');
    expect(text.text).toBe('知识库正文');
    expect(text.truncated).toBe(false);

    const big = `${'A'.repeat(500)}ENDMARKER`;
    fs.writeFileSync(path.join(box.rootA, 'docs', 'big.txt'), big);
    const clipped = rpcResult<{ text: string; truncated: boolean; bytesRead: number }>(
      await call(port, token, 'fs.read', { rootId: 'root-a', path: 'docs/big.txt', maxBytes: 100 }),
    );
    expect(clipped.truncated).toBe(true);
    expect(clipped.bytesRead).toBeLessThanOrEqual(100);
    expect(clipped.text.includes('ENDMARKER')).toBe(false);

    fs.writeFileSync(path.join(box.rootA, 'docs', 'note.pdf'), pdfWithText('Hello PDF'));
    const pdf = rpcResult<{ text: string; kind: string; pages: { page: number; text: string }[] }>(
      await call(port, token, 'fs.read', { rootId: 'root-a', path: 'docs/note.pdf' }),
    );
    expect(pdf.kind).toBe('pdf');
    expect(pdf.pages.some((page) => page.text.includes('Hello PDF'))).toBe(true);
    expect(pdf.text).toContain('Hello PDF');

    const huge = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(4096, 0x20),
      Buffer.from('\nUNIQUE_TAIL_MARKER\n%%EOF\n'),
    ]);
    fs.writeFileSync(path.join(box.rootA, 'docs', 'huge.pdf'), huge);
    const tooBig = await call(port, token, 'fs.read', {
      rootId: 'root-a',
      path: 'docs/huge.pdf',
      maxBytes: 128,
    });
    expect(tooBig.status).toBe(413);
    expect(tooBig.raw.includes('UNIQUE_TAIL_MARKER')).toBe(false);

    const listed = rpcResult<{ entries: { relPath: string }[] }>(
      await call(port, token, 'fs.list', { rootId: 'root-a', path: 'docs' }),
    );
    expect(listed.entries.some((entry) => entry.relPath.endsWith('hello.txt'))).toBe(true);

    const original = fs.readFileSync(path.join(box.rootA, 'docs', 'hello.txt'));
    const preview = rpcResult<{ previewId: string; willWrite: boolean }>(
      await call(port, token, 'ops.preview', {
        op: 'move',
        rootId: 'root-a',
        fromPath: 'docs/hello.txt',
        toPath: 'archive/hello.txt',
        actor: 'ui',
      }),
    );
    expect(preview.willWrite).toBe(false);
    expect(fs.existsSync(path.join(box.rootA, 'docs', 'hello.txt'))).toBe(true);

    const plan = rpcResult<{ id: string; actor: string }>(
      await call(port, token, 'plans.create', {
        title: '移动 hello',
        actor: 'ui',
        ops: [
          {
            type: 'move',
            rootId: 'root-a',
            fromRelPath: 'docs/hello.txt',
            toRelPath: 'archive/hello.txt',
          },
        ],
      }),
    );
    expect(plan.actor).toBe('agent:writer');
    const ui = openUiPlan(box.dataDir);
    try {
      const cred = await ui.plans.getApprovalCredential({ planId: plan.id, actor: 'ui' });
      const deniedApprove = await call(port, token, 'plans.approve', { planId: plan.id });
      const deniedApply = await call(port, token, 'plans.apply', { planId: plan.id });
      const deniedRestore = await call(port, token, 'ops.restore', { opId: 'missing', onConflict: 'cancel' });
      expect(deniedApprove.status).toBe(403);
      expect(deniedApply.status).toBe(403);
      expect(deniedApprove.raw).toContain('user_approval_required');
      expect(deniedApply.raw).toContain('user_approval_required');
      expect(deniedRestore.status).toBe(403);
      expect(deniedRestore.raw).toContain('plan_required');
      for (const response of [deniedApprove, deniedApply, deniedRestore]) {
        expect(response.raw).not.toContain(cred.contentHash);
      }
      expect(fs.existsSync(path.join(box.rootA, 'docs', 'hello.txt'))).toBe(true);
      expect(fs.existsSync(path.join(box.rootA, 'archive', 'hello.txt'))).toBe(false);

      const applied = await ui.plans.approvePlan({
        planId: plan.id,
        contentHash: cred.contentHash,
        actor: 'ui',
      });
      const step = applied.steps[0];
      if (!step?.opId) throw new Error('missing op id');
      expect(applied.actor).toBe('agent:writer');
      expect(applied.status).toBe('applied');
      expect(step.resourceId).toEqual(expect.any(String));
      expect(step.resourceId).not.toBe('');
      expect(fs.existsSync(path.join(box.rootA, 'archive', 'hello.txt'))).toBe(true);
      expect(fs.existsSync(path.join(box.rootA, 'docs', 'hello.txt'))).toBe(false);

      const log = rpcResult<{ entries: { id: string; actor: string; op: string; resourceId: string | null }[] }>(
        await call(port, token, 'ops.log', {}),
      );
      const move = log.entries.find((entry) => entry.op === 'move');
      expect(move?.actor).toBe('ui');
      expect(move?.id).toBe(step.opId);
      expect(move?.resourceId).toBe(step.resourceId);

      const stillDenied = await call(port, token, 'ops.restore', { opId: step.opId, onConflict: 'cancel' });
      expect(stillDenied.status).toBe(403);
      expect(stillDenied.raw).toContain('plan_required');
      expect(stillDenied.raw).not.toContain(cred.contentHash);
      expect(fs.existsSync(path.join(box.rootA, 'archive', 'hello.txt'))).toBe(true);

      const restorePlan = rpcResult<{ id: string }>(
        await call(port, token, 'plans.create', {
          title: '恢复 hello',
          ops: [{ type: 'restore', opId: step.opId, onConflict: 'overwrite' }],
        }),
      );
      const restoreCred = await ui.plans.getApprovalCredential({ planId: restorePlan.id, actor: 'ui' });
      const restored = await ui.plans.approvePlan({
        planId: restorePlan.id,
        contentHash: restoreCred.contentHash,
        actor: 'ui',
      });
      expect(restored.status).toBe('applied');
      expect(fs.readFileSync(path.join(box.rootA, 'docs', 'hello.txt')).equals(original)).toBe(true);
      expect(fs.existsSync(path.join(box.rootA, 'archive', 'hello.txt'))).toBe(false);

      const after = rpcResult<{ entries: { actor: string; op: string }[] }>(
        await call(port, token, 'ops.log', {}),
      );
      expect(after.entries.some((entry) => entry.op === 'restore' && entry.actor === 'ui')).toBe(true);
    } finally {
      ui.close();
    }
  } finally {
    await box.cleanup();
  }
});
