import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LiveEvent } from '../src/shared/agentLive/types';
import {
  AgentLiveError,
  bindPlanSubmission,
  checkBoundExecution,
  createLiveRevisionLog,
  createRevisionHandlers,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_RECONCILE_MS,
  hashBuffer,
  revisionActions,
  runBoundPlan,
  unifiedDiff,
  type AgentLiveRevision,
  type LiveRevisionOptions,
} from '../src/main/agentLive/revision';

const ROOT = 'D:\\kb-r13-work\\al-4\\unit';

interface Env {
  dir: string;
  bridge: string;
  files: string;
  state: string;
}

let current: AgentLiveRevision | null = null;
let env: Env | null = null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fresh(): Env {
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  const next: Env = {
    dir,
    bridge: path.join(dir, 'agent-bridge'),
    files: path.join(dir, 'files'),
    state: path.join(dir, 'agent-live-state.json'),
  };
  fs.mkdirSync(next.files, { recursive: true });
  env = next;
  return next;
}

function writerFor(bridge: string) {
  return {
    async render(workspaceId: string, rev: number): Promise<void> {
      const dir = path.join(bridge, 'live', 'ws', workspaceId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'snapshot.json'),
        JSON.stringify({ schemaVersion: 1, workspaceId, revision: rev, workspaceName: workspaceId, panels: [], reading: null, materials: [], nav: {} }),
      );
      fs.writeFileSync(path.join(dir, 'ENTRY.md'), `revision ${rev}\n`);
    },
  };
}

function openLog(extra: Partial<LiveRevisionOptions> = {}): AgentLiveRevision {
  const box = env ?? fresh();
  const log = createLiveRevisionLog({
    bridgeRoot: box.bridge,
    debounceMs: 0,
    reconcileMs: 0,
    now: () => new Date('2026-10-08T00:00:00.000Z'),
    entryWriter: writerFor(box.bridge),
    ...extra,
  });
  current = log;
  return log;
}

function fileOf(rel: string): string {
  return path.join((env ?? fresh()).files, rel);
}

function changed(rel: string, materialId = 'mat1', workspaceId = 'ws-a'): LiveEvent {
  return { type: 'content.changed', workspaceId, materialId, relPath: rel, absPath: fileOf(rel) };
}

function wsDir(id = 'ws-a'): string {
  return path.join((env as Env).bridge, 'live', 'ws', id);
}

function readJsonl(dir: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(dir)) return [];
  const rows: Array<Record<string, unknown>> = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl') || name.endsWith('.tmp')) continue;
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\n/)) {
      if (line) rows.push(JSON.parse(line) as Record<string, unknown>);
    }
  }
  return rows.sort((a, b) => Number(a.rev) - Number(b.rev));
}

function markerOf(id = 'ws-a'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(wsDir(id), 'marker.json'), 'utf8')) as Record<string, unknown>;
}

function absLive(rel: string): string {
  return path.join(wsDir(), ...String(rel).split('/'));
}

function segName(rev: number): string {
  const n = String(rev).padStart(6, '0');
  return `${n}-${n}.jsonl`;
}

afterEach(async () => {
  if (current) {
    await current.close();
    current = null;
  }
  if (env) {
    fs.rmSync(env.dir, { recursive: true, force: true });
    env = null;
  }
});

describe('agent live 修订日志', () => {
  it('默认防抖 300ms、对账 30s', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300);
    expect(DEFAULT_RECONCILE_MS).toBe(30_000);
  });

  it('快速连续保存把临时文件并进最后一次正文', async () => {
    const box = fresh();
    const log = openLog();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'v1');
    const base = await log.append('ws-a', [changed('note.txt')]);
    expect(base).toBe(1);
    fs.writeFileSync(note, 'v2a');
    const p1 = log.append('ws-a', [changed('note.txt')]);
    fs.writeFileSync(note, 'v2b');
    const p2 = log.append('ws-a', [changed('note.txt')]);
    const p3 = log.append('ws-a', [{ ...changed('note.md.tmp', 'tmp1'), relPath: 'note.md.tmp', absPath: fileOf('note.md.tmp') }]);
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a).toBe(base + 1);
    expect(b).toBe(a);
    expect(c).toBe(a);
    const lines = readJsonl(path.join(wsDir(), 'changes'));
    const last = lines[lines.length - 1]!;
    expect(last.type).toBe('content.changed');
    expect(JSON.stringify(lines)).not.toContain('.tmp');
    const hex = String(last.contentHash).replace(/^sha256:/, '');
    const text = fs.readFileSync(path.join(wsDir(), 'content', 'mat1', `${hex}.txt`), 'utf8');
    expect(text).toBe('v2b');
    expect(String(last.content)).toBe(`content/mat1/${hex}.txt`);
    const diff = fs.readFileSync(absLive(String(last.diff)), 'utf8');
    expect(diff).toContain(`--- fromHash ${hashBuffer(Buffer.from('v1'))}`);
    expect(diff).toContain(`+++ toHash ${hashBuffer(Buffer.from('v2b'))}`);
  });

  it('丢掉的通知由对账补回', async () => {
    fresh();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'v1');
    const log = openLog({
      reconcileMs: 40,
      reconcileSource: { list: () => [{ materialId: 'mat1', relPath: 'note.txt', absPath: note }] },
    });
    const base = await log.append('ws-a', [changed('note.txt')]);
    fs.writeFileSync(note, 'v2-lost');
    const deadline = Date.now() + 2000;
    let rev = base;
    while (Date.now() < deadline && rev === base) {
      await delay(20);
      rev = log.current('ws-a');
    }
    expect(rev).toBe(base + 1);
    const last = readJsonl(path.join(wsDir(), 'changes')).at(-1)!;
    expect(last.type).toBe('content.changed');
    expect(last.contentHash).toBe(hashBuffer(fs.readFileSync(note)));
  });

  it('相同大小、修改时间和哈希不升版；只改修改时间会升版', async () => {
    fresh();
    const log = openLog();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'same');
    const first = await log.append('ws-a', [changed('note.txt')]);
    const second = await log.append('ws-a', [changed('note.txt')]);
    expect(second).toBe(first);
    const next = new Date(Date.now() + 5000);
    fs.utimesSync(note, next, next);
    const touched = await log.append('ws-a', [changed('note.txt')]);
    expect(touched).toBe(first + 1);
  });

  it('重启后续号；删掉状态文件后仍从 marker 续号', async () => {
    const box = fresh();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'v1');
    const first = openLog();
    const rev = await first.append('ws-a', [changed('note.txt')]);
    await first.close();
    current = null;
    const second = openLog();
    await second.whenReady();
    expect(second.current('ws-a')).toBe(rev);
    fs.writeFileSync(note, 'v2');
    expect(await second.append('ws-a', [changed('note.txt')])).toBe(rev + 1);
    await second.close();
    current = null;
    fs.rmSync(box.state, { force: true });
    const third = openLog();
    await third.whenReady();
    expect(third.current('ws-a')).toBe(rev + 1);
    fs.writeFileSync(note, 'v3');
    expect(await third.append('ws-a', [changed('note.txt')])).toBe(rev + 2);
  });

  it('超过 14 天且不在保留窗口内的版本才删除，两个游标互不影响', async () => {
    const box = fresh();
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const changes = path.join(box.bridge, 'live', 'ws', 'ws-a', 'changes');
    let watch = false;
    const log = openLog({
      now: () => clock,
      retainRevisions: 3,
      retainMs: 14 * 24 * 60 * 60 * 1000,
      segmentMaxRevisions: 1,
      trace: (step, info) => {
        if (!watch || step !== 'unlink') return;
        const index = JSON.parse(fs.readFileSync(path.join(changes, 'index.json'), 'utf8')) as {
          oldestRevision: number;
          segments: Array<{ file: string }>;
        };
        expect(index.oldestRevision).toBeGreaterThanOrEqual(5);
        expect(index.segments.some((seg) => seg.file === info?.file)).toBe(false);
        const marker = markerOf();
        expect(Number(marker.oldestRevision)).toBeGreaterThanOrEqual(5);
      },
    });
    for (let n = 1; n <= 5; n++) {
      fs.writeFileSync(fileOf('note.txt'), `v${n}`);
      expect(await log.append('ws-a', [changed('note.txt')])).toBe(n);
    }
    expect(log.oldest('ws-a')).toBe(1);
    for (let n = 1; n <= 5; n++) expect(fs.existsSync(path.join(changes, segName(n)))).toBe(true);
    clock = new Date('2026-08-01T00:00:00.000Z');
    fs.writeFileSync(fileOf('note.txt'), 'v6');
    expect(await log.append('ws-a', [changed('note.txt')])).toBe(6);
    expect(log.oldest('ws-a')).toBe(4);
    for (const n of [1, 2, 3]) expect(fs.existsSync(path.join(changes, segName(n)))).toBe(false);
    for (const n of [4, 5, 6]) expect(fs.existsSync(path.join(changes, segName(n)))).toBe(true);
    const cursorDir = path.join(box.bridge, 'cursors');
    fs.mkdirSync(cursorDir, { recursive: true });
    const bodyA = JSON.stringify({ schemaVersion: 1, agentId: 'agent-a', workspaceId: 'ws-a', revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' });
    const bodyB = JSON.stringify({ schemaVersion: 1, agentId: 'agent-b', workspaceId: 'ws-a', revision: 6, updatedAt: '2026-08-01T00:00:00.000Z' });
    const cursorA = path.join(cursorDir, 'agent-a.json');
    const cursorB = path.join(cursorDir, 'agent-b.json');
    fs.writeFileSync(cursorA, bodyA);
    fs.writeFileSync(cursorB, bodyB);
    const beforeA = fs.readFileSync(cursorA);
    const beforeB = fs.readFileSync(cursorB);
    watch = true;
    fs.writeFileSync(fileOf('note.txt'), 'v7');
    expect(await log.append('ws-a', [changed('note.txt')])).toBe(7);
    expect(log.oldest('ws-a')).toBe(5);
    expect(fs.existsSync(path.join(changes, segName(4)))).toBe(false);
    for (const n of [5, 6, 7]) expect(fs.existsSync(path.join(changes, segName(n)))).toBe(true);
    expect(fs.readFileSync(cursorA).equals(beforeA)).toBe(true);
    expect(fs.readFileSync(cursorB).equals(beforeB)).toBe(true);
    expect(log.cursorState('agent-a')).toBe('expired');
    expect(log.cursorState('agent-b')).toBe('ok');
    expect(log.readCursor('agent-a')?.revision).toBe(1);
    expect(log.readCursor('agent-b')?.revision).toBe(6);
  });

  it('发布中途留下的 tmp 能在下次打开时补上或丢掉', async () => {
    const box = fresh();
    const dir = path.join(box.bridge, 'live', 'ws', 'ws-a');
    fs.mkdirSync(dir, { recursive: true });
    const marker = (revision: number) =>
      JSON.stringify({
        schemaVersion: 1,
        kind: 'workspace',
        workspaceId: 'ws-a',
        workspaceName: '甲',
        revision,
        oldestRevision: 1,
        snapshotRevision: revision,
        generatedAt: '2026-10-08T00:00:00.000Z',
        appVersion: '0.2.0',
      });
    fs.writeFileSync(path.join(dir, 'marker.json.tmp'), marker(4));
    const recovered = openLog({ entryWriter: undefined });
    await recovered.whenReady();
    expect(recovered.current('ws-a')).toBe(4);
    expect(fs.existsSync(path.join(dir, 'marker.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'marker.json.tmp'))).toBe(false);
    await recovered.close();
    current = null;

    fs.rmSync(box.state, { force: true });
    fs.writeFileSync(path.join(dir, 'marker.json'), marker(2));
    fs.writeFileSync(path.join(dir, 'marker.json.tmp'), 'oops');
    const kept = openLog({ entryWriter: undefined });
    await kept.whenReady();
    expect(kept.current('ws-a')).toBe(2);
    expect(fs.existsSync(path.join(dir, 'marker.json.tmp'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8')).revision).toBe(2);
    await kept.close();
    current = null;
    fs.rmSync(box.state, { force: true });

    fs.writeFileSync(path.join(dir, 'marker.json'), marker(2));
    fs.writeFileSync(path.join(dir, 'marker.json.tmp'), marker(5));
    const replaced = openLog({ entryWriter: undefined });
    await replaced.whenReady();
    expect(replaced.current('ws-a')).toBe(5);
    expect(fs.existsSync(path.join(dir, 'marker.json.tmp'))).toBe(false);
    await replaced.close();
    current = null;
    fs.rmSync(path.join(box.bridge, 'live'), { recursive: true, force: true });
    fs.rmSync(box.state, { force: true });

    const broken = openLog({
      entryWriter: {
        async render(): Promise<void> {
          throw new Error('render failed');
        },
      },
    });
    fs.writeFileSync(fileOf('note.txt'), 'v1');
    await expect(broken.append('ws-a', [changed('note.txt')])).rejects.toThrow('render failed');
    const changes = path.join(box.bridge, 'live', 'ws', 'ws-a', 'changes');
    expect(readJsonl(changes)).toHaveLength(1);
    expect(fs.existsSync(path.join(box.bridge, 'live', 'ws', 'ws-a', 'marker.json'))).toBe(false);
    await broken.close();
    current = null;
    const healed = openLog();
    await healed.whenReady();
    expect(markerOf().revision).toBe(1);
    expect(readJsonl(changes)).toHaveLength(1);
  });

  it('发布顺序在 marker 之前写完内容、差异、分段和索引', async () => {
    const box = fresh();
    const steps: string[] = [];
    const log = openLog({
      trace: (step) => steps.push(step),
      entryWriter: {
        async render(workspaceId: string, rev: number): Promise<void> {
          await writerFor(box.bridge).render(workspaceId, rev);
          if (rev < 2) return;
          const marker = markerOf();
          expect(marker.revision).toBe(1);
          const index = JSON.parse(fs.readFileSync(path.join(wsDir(), 'changes', 'index.json'), 'utf8')) as {
            segments: Array<{ to: number }>;
          };
          expect(index.segments.some((seg) => seg.to >= 2)).toBe(true);
          const line = readJsonl(path.join(wsDir(), 'changes')).find((row) => row.rev === 2)!;
          expect(fs.existsSync(absLive(String(line.content)))).toBe(true);
          expect(fs.existsSync(absLive(String(line.diff)))).toBe(true);
        },
      },
    });
    await log.setActiveWorkspace('ws-a', '甲');
    fs.writeFileSync(fileOf('note.txt'), 'v1');
    await log.append('ws-a', [changed('note.txt')]);
    steps.length = 0;
    fs.writeFileSync(fileOf('note.txt'), 'v2');
    await log.append('ws-a', [changed('note.txt')]);
    const order = ['content', 'diff', 'segment', 'index', 'render', 'marker'];
    let at = 0;
    for (const step of steps) if (step === order[at]) at += 1;
    expect(at).toBe(order.length);
    expect(Buffer.byteLength(fs.readFileSync(path.join(wsDir(), 'marker.json')))).toBeLessThan(512);
    const currentMarker = fs.readFileSync(path.join(box.bridge, 'live', 'current', 'marker.json'));
    expect(currentMarker.byteLength).toBeLessThan(512);
    expect(JSON.parse(currentMarker.toString()).appVersion).toBe('0.2.0');
  });

  it('分段按版本数和字节数封口', async () => {
    fresh();
    const byCount = openLog({ segmentMaxRevisions: 2 });
    for (let n = 1; n <= 3; n++) {
      fs.writeFileSync(fileOf('note.txt'), `v${n}`);
      await byCount.append('ws-a', [changed('note.txt')]);
    }
    const names = fs.readdirSync(path.join(wsDir(), 'changes')).filter((name) => name.endsWith('.jsonl')).sort();
    expect(names).toEqual(['000001-000002.jsonl', '000003-000003.jsonl']);
    await byCount.close();
    current = null;
    fs.rmSync(env!.dir, { recursive: true, force: true });
    env = null;

    fresh();
    const byBytes = openLog({ segmentMaxBytes: 50 });
    fs.writeFileSync(fileOf('note.txt'), 'one');
    await byBytes.append('ws-a', [changed('note.txt')]);
    fs.writeFileSync(fileOf('note.txt'), 'two');
    await byBytes.append('ws-a', [changed('note.txt')]);
    const split = fs.readdirSync(path.join(wsDir(), 'changes')).filter((name) => name.endsWith('.jsonl')).sort();
    expect(split).toEqual(['000001-000001.jsonl', '000002-000002.jsonl']);
  });

  it('snapshot.reset 写入 jsonl，并带动 snapshotRevision', async () => {
    fresh();
    const log = openLog();
    await log.append('ws-a', [{ type: 'snapshot.reset', workspaceId: 'ws-a', snapshotRevision: 9 }]);
    expect(readJsonl(path.join(wsDir(), 'changes')).some((row) => row.type === 'snapshot.reset' && row.snapshotRevision === 9)).toBe(true);
    expect(markerOf().snapshotRevision).toBe(9);
    await log.append('ws-a', [{ type: 'snapshot.reset', workspaceId: 'ws-a' }]);
    expect(markerOf().snapshotRevision).toBe(log.current('ws-a'));
  });

  it('切换工作区只记在 current，两个工作区的修订号分开', async () => {
    const box = fresh();
    const log = openLog();
    expect(await log.setActiveWorkspace('ws-a', '甲')).toBe(1);
    fs.writeFileSync(fileOf('a.txt'), 'a');
    await log.append('ws-a', [changed('a.txt', 'mat-a', 'ws-a')]);
    expect(await log.setActiveWorkspace('ws-b', '乙')).toBe(2);
    const currentMarker = JSON.parse(fs.readFileSync(path.join(box.bridge, 'live', 'current', 'marker.json'), 'utf8')) as Record<string, unknown>;
    expect(currentMarker.kind).toBe('current');
    expect(currentMarker.workspaceId).toBe('ws-b');
    expect(currentMarker.wsDir).toBe('../ws/ws-b');
    expect(currentMarker.currentRevision).toBe(2);
    expect(readJsonl(path.join(wsDir('ws-a'), 'changes')).some((row) => row.type === 'workspace.switched')).toBe(false);
    const switched = readJsonl(path.join(box.bridge, 'live', 'current', 'changes'));
    expect(switched.length).toBeGreaterThan(0);
    expect(switched.every((row) => row.type === 'workspace.switched')).toBe(true);
    fs.writeFileSync(fileOf('b.txt'), 'b');
    await log.append('ws-b', [changed('b.txt', 'mat-b', 'ws-b')]);
    const after = JSON.parse(fs.readFileSync(path.join(box.bridge, 'live', 'current', 'marker.json'), 'utf8')) as Record<string, unknown>;
    expect(after.revision).toBe(1);
    expect(after.currentRevision).toBe(2);
    expect(log.current('ws-a')).toBe(1);
    expect(log.current('ws-b')).toBe(1);
    fs.writeFileSync(fileOf('a.txt'), 'a2');
    await log.append('ws-a', [changed('a.txt', 'mat-a', 'ws-a')]);
    expect(log.current('ws-a')).toBe(2);
    expect(log.current('ws-b')).toBe(1);
    expect(await log.setActiveWorkspace('ws-b', '乙二')).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(box.bridge, 'live', 'current', 'marker.json'), 'utf8')).workspaceName).toBe('乙二');
  });

  it('批量加入合成一个版本，并带上 0.10 的事件字段', async () => {
    fresh();
    const log = openLog();
    const added: LiveEvent = {
      type: 'material.added',
      workspaceId: 'ws-a',
      materialId: 'mat1',
      relPath: 'note.txt',
      absPath: fileOf('note.txt'),
      order: 1,
      tier: 'session',
      size: 4,
      mtimeMs: 1,
      workspaceName: '不应进 jsonl',
    };
    const pinned: LiveEvent = { type: 'material.pinned', workspaceId: 'ws-a', materialId: 'mat1', tier: 'pinned' };
    const cleared: LiveEvent = { type: 'session.cleared', workspaceId: 'ws-a', materialIds: ['mat1', 'mat2'] };
    const unpinned: LiveEvent = { type: 'material.unpinned', workspaceId: 'ws-a', materialId: 'mat1', tier: 'session' };
    const p1 = log.append('ws-a', [added]);
    const p2 = log.append('ws-a', [pinned, cleared]);
    const p3 = log.append('ws-a', [unpinned]);
    const [a, b, c] = await Promise.all([p1, p2, p3]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(1);
    const lines = readJsonl(path.join(wsDir(), 'changes'));
    expect(lines.map((row) => row.type)).toEqual(['material.added', 'material.pinned', 'session.cleared', 'material.unpinned']);
    expect(lines[0]!.tier).toBe('session');
    expect(lines[2]!.materialIds).toEqual(['mat1', 'mat2']);
    expect(lines[0]).not.toHaveProperty('size');
    expect(lines[0]).not.toHaveProperty('mtimeMs');
    expect(lines[0]).not.toHaveProperty('workspaceName');
  });

  it('发布进行中的下一次变化立刻补发，不再等一轮防抖', async () => {
    fresh();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const log = openLog({
      debounceMs: 2000,
      entryWriter: {
        async render(_workspaceId: string, rev: number): Promise<void> {
          if (rev !== 1) return;
          started();
          await gate;
        },
      },
    });
    fs.writeFileSync(fileOf('note.txt'), 'v1');
    const p1 = log.append('ws-a', [changed('note.txt')]);
    await entered;
    fs.writeFileSync(fileOf('note.txt'), 'v2');
    const p2 = log.append('ws-a', [changed('note.txt')]);
    const t0 = Date.now();
    release();
    const r1 = await p1;
    const r2 = await p2;
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('读取正文和差异，大差异延后，PDF 标成不能做差异', async () => {
    fresh();
    const log = openLog();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'hello');
    await log.append('ws-a', [changed('note.txt')]);
    fs.writeFileSync(note, `one\ftwo`);
    await log.append('ws-a', [changed('note.txt')]);
    const page = await log.getContent({ materialId: 'mat1', page: 2, offset: 100 });
    expect(page.text).toBe('two');
    expect(page.page).toBe(2);
    const slice = await log.getContent({ materialId: 'mat1', offset: 4, length: 3 });
    expect(slice.text).toBe('two');
    await expect(log.getContent({ materialId: 'mat1', offset: -1 })).rejects.toMatchObject({ code: 'bad_args' });
    const handlers = createRevisionHandlers(log);
    const failed = await handlers.getContent({ materialId: 'mat1', offset: -1 });
    expect(failed.status).toBe('failed');
    expect(failed.error?.code).toBe('bad_args');
    const lines = readJsonl(path.join(wsDir(), 'changes'));
    const prev = String(lines[0]!.contentHash);
    const next = String(lines[1]!.contentHash);
    const stored = await log.getDiff({ materialId: 'mat1', fromHash: prev, toHash: next });
    expect(stored.diff).toContain('--- fromHash ');
    expect(stored.diffSupported).toBe(true);
    const big = fileOf('big.txt');
    fs.writeFileSync(big, 's');
    await log.append('ws-a', [changed('big.txt', 'mat-big')]);
    fs.writeFileSync(big, 'B'.repeat(70 * 1024));
    await log.append('ws-a', [changed('big.txt', 'mat-big')]);
    const bigLine = readJsonl(path.join(wsDir(), 'changes')).filter((row) => row.materialId === 'mat-big').at(-1)!;
    expect(bigLine).not.toHaveProperty('diff');
    expect(bigLine).not.toHaveProperty('diffSupported');
    const made = await log.getDiff({
      materialId: 'mat-big',
      fromHash: String(readJsonl(path.join(wsDir(), 'changes')).find((row) => row.materialId === 'mat-big')!.contentHash),
      toHash: String(bigLine.contentHash),
    });
    expect(made.deferred).toBe(true);
    expect(made.diff && made.diff.length).toBeGreaterThan(64 * 1024);
    const pdf = fileOf('a.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4');
    await log.append('ws-a', [changed('a.pdf', 'mat-pdf')]);
    const pdfLine = readJsonl(path.join(wsDir(), 'changes')).find((row) => row.materialId === 'mat-pdf')!;
    expect(pdfLine.diffSupported).toBe(false);
    expect(pdfLine).not.toHaveProperty('diff');
    expect(fs.existsSync(path.join(wsDir(), 'diff', 'mat-pdf'))).toBe(false);
    const metaPath = path.join(wsDir(), 'content', 'mat1', 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { status?: string; custom?: string };
    meta.status = 'generating';
    meta.custom = 'keep-me';
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    await expect(log.getContent({ materialId: 'mat1', contentHash: `sha256:${'ab'.repeat(32)}` })).rejects.toMatchObject({ code: 'generating' });
    fs.writeFileSync(note, 'third');
    await log.append('ws-a', [changed('note.txt')]);
    fs.writeFileSync(note, 'fourth');
    await log.append('ws-a', [changed('note.txt')]);
    const kept = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as { status?: string; custom?: string; versions?: unknown[] };
    expect(kept.custom).toBe('keep-me');
    expect(kept.status).toBe('ready');
    expect(kept.versions).toHaveLength(3);
    expect(fs.readdirSync(path.join(wsDir(), 'content', 'mat1')).filter((name) => name.endsWith('.txt'))).toHaveLength(3);
  });

  it('差异可以超时和取消', () => {
    const hash = `sha256:${'ab'.repeat(32)}`;
    const other = `sha256:${'cd'.repeat(32)}`;
    expect(() => unifiedDiff('a', 'b', { fromHash: hash, toHash: other, deadline: Date.now() - 5 })).toThrow(/超过 5 秒/);
    const ac = new AbortController();
    ac.abort();
    try {
      unifiedDiff('a', 'b', { fromHash: hash, toHash: other, deadline: Date.now() + 5000, signal: ac.signal });
      throw new Error('应该取消');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentLiveError);
      expect((err as AgentLiveError).code).toBe('cancelled');
    }
  });

  it('agent.getContent 与 agent.getDiff 不需要批准', () => {
    expect(revisionActions.map((action) => action.actionId)).toEqual(['agent.getContent', 'agent.getDiff']);
    expect(revisionActions.every((action) => action.approvalRequired === false && action.bridgeInvokable)).toBe(true);
  });

  it('expectedFileHash 按提交时的路径核对，冲突时不执行', () => {
    const box = fresh();
    const note = fileOf('note.txt');
    fs.writeFileSync(note, 'v1');
    const expected = hashBuffer(fs.readFileSync(note));
    const binding = bindPlanSubmission({
      requestId: 'req-1',
      planId: 'plan-1',
      workspaceId: 'ws-a',
      contentHash: 'forged-plan-level-hash',
      ops: [{ kind: 'write', materialId: 'mat1', resourceId: 'res-1', absPath: note, expectedFileHash: expected }],
    });
    let seen = '';
    const done = runBoundPlan(binding, { activeWorkspaceId: 'ws-b', readFile: (abs) => fs.readFileSync(abs) }, (bound) => {
      seen = bound.workspaceId;
      expect(bound.ops[0]?.absPath).toBe(note);
      return 'done';
    });
    expect(done).toBe('done');
    expect(seen).toBe('ws-a');
    const raw = bindPlanSubmission({
      requestId: 'req-raw',
      workspaceId: 'ws-a',
      ops: [{ kind: 'write', absPath: note, expectedFileHash: expected.slice('sha256:'.length) }],
      resolvePath: () => null,
    });
    expect(checkBoundExecution(raw, { activeWorkspaceId: 'ws-b', readFile: (abs) => fs.readFileSync(abs) }).ok).toBe(true);
    fs.writeFileSync(note, 'v2');
    let ran = false;
    const conflict = runBoundPlan(binding, { activeWorkspaceId: 'ws-b', readFile: (abs) => fs.readFileSync(abs) }, () => {
      ran = true;
      return 'no';
    });
    expect(ran).toBe(false);
    expect(conflict).toMatchObject({ ok: false, status: 'conflict', suggestedAction: 're-read' });
    const loose = bindPlanSubmission({
      requestId: 'req-2',
      workspaceId: 'ws-a',
      ops: [{ kind: 'write', absPath: note }],
    });
    expect(runBoundPlan(loose, { activeWorkspaceId: 'ws-b', readFile: (abs) => fs.readFileSync(abs) }, () => 'yes')).toBe('yes');
    let reads = 0;
    const secret = bindPlanSubmission({
      requestId: 'req-secret',
      workspaceId: 'ws-a',
      ops: [{ kind: 'write', absPath: path.join(box.files, 'agent-token.json'), expectedFileHash: expected }],
    });
    const blocked = checkBoundExecution(secret, {
      readFile: () => {
        reads += 1;
        return Buffer.from('no');
      },
    });
    expect(reads).toBe(0);
    expect(blocked.ok).toBe(false);
  });

  it('不把 agent-token.json 写进修订记录', async () => {
    const box = fresh();
    const log = openLog();
    const rev = await log.append('ws-a', [
      { type: 'content.changed', workspaceId: 'ws-a', materialId: 'secret', absPath: path.join(box.files, 'agent-token.json'), relPath: 'agent-token.json' },
    ]);
    expect(rev).toBe(0);
    fs.writeFileSync(fileOf('note.txt'), 'safe');
    await log.append('ws-a', [
      changed('note.txt'),
      { type: 'content.changed', workspaceId: 'ws-a', materialId: 'secret', absPath: path.join(box.files, 'agent-token.json'), relPath: 'agent-token.json' },
    ]);
    const live = path.join(box.bridge, 'live');
    const dump: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (name.endsWith('.json') || name.endsWith('.jsonl') || name.endsWith('.md')) dump.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(live);
    expect(dump.join('\n')).not.toContain('agent-token');
  });

  it('状态文件保留组 1 的字段；更高的 schemaVersion 直接拒绝', async () => {
    const box = fresh();
    const log = openLog();
    fs.writeFileSync(fileOf('note.txt'), 'v1');
    await log.append('ws-a', [changed('note.txt')]);
    const saved = JSON.parse(fs.readFileSync(box.state, 'utf8')) as {
      sessionMaterials?: unknown;
      current: { customCurrent?: number };
      workspaces: { 'ws-a': { pinnedIds?: string[] } };
    };
    saved.sessionMaterials = { 'ws-a': ['mat1'] };
    saved.current.customCurrent = 1;
    saved.workspaces['ws-a'].pinnedIds = ['m9'];
    fs.writeFileSync(box.state, JSON.stringify(saved));
    fs.writeFileSync(fileOf('note.txt'), 'v2');
    await log.append('ws-a', [changed('note.txt')]);
    const again = JSON.parse(fs.readFileSync(box.state, 'utf8')) as typeof saved;
    expect(again.sessionMaterials).toEqual({ 'ws-a': ['mat1'] });
    expect(again.current.customCurrent).toBe(1);
    expect(again.workspaces['ws-a'].pinnedIds).toEqual(['m9']);
    await log.close();
    current = null;
    fs.writeFileSync(box.state, '{');
    const healed = openLog();
    await healed.whenReady();
    expect(fs.existsSync(`${box.state}.bad`)).toBe(true);
    expect(healed.current('ws-a')).toBe(2);
    await healed.close();
    current = null;
    fs.writeFileSync(
      box.state,
      JSON.stringify({
        schemaVersion: 2,
        current: { workspaceId: null, currentRevision: 0, revision: 0, oldestRevision: 0, segments: [], revisionTimes: {}, pendingUnlinks: [] },
        workspaces: {},
      }),
    );
    expect(() => openLog()).toThrow(/schemaVersion 2/);
    expect(fs.existsSync(box.state)).toBe(true);
    expect(fs.readFileSync(box.state, 'utf8')).toContain('"schemaVersion":2');
  });

  it('事先写入的 sessionMaterials 在发布后仍在，修订字段也在', async () => {
    const box = fresh();
    const sessionMaterials = { v: 1, byWorkspace: { 'ws-a': [{ materialId: 'm-keep', tier: 'session' }] } };
    fs.writeFileSync(
      box.state,
      JSON.stringify({
        schemaVersion: 1,
        sessionMaterials,
        current: {
          workspaceId: null,
          currentRevision: 0,
          revision: 0,
          oldestRevision: 0,
          segments: [],
          revisionTimes: {},
          pendingUnlinks: [],
        },
        workspaces: {},
      }),
    );
    const log = openLog();
    fs.writeFileSync(fileOf('note.txt'), 'kept');
    const rev = await log.append('ws-a', [changed('note.txt')]);
    expect(rev).toBe(1);
    const again = JSON.parse(fs.readFileSync(box.state, 'utf8')) as {
      sessionMaterials?: unknown;
      schemaVersion: number;
      current: { revision: number; sessionMaterials?: unknown };
      workspaces: { 'ws-a': { revision: number; oldestRevision: number; sessionMaterials?: unknown } };
    };
    expect(again.sessionMaterials).toEqual(sessionMaterials);
    expect(again.schemaVersion).toBe(1);
    expect(again.workspaces['ws-a'].revision).toBe(1);
    expect(again.workspaces['ws-a'].oldestRevision).toBe(1);
    expect(again.current.sessionMaterials).toBeUndefined();
    expect(again.workspaces['ws-a'].sessionMaterials).toBeUndefined();
    expect(fs.existsSync(`${box.state}.lock`)).toBe(false);
  });
});
