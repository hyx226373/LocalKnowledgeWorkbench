import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMaterialsStore, ResourceChange, ResourceChangeFeed, Unsubscribe } from '../src/shared/agentLive/types';
import {
  createAgentMaterialsStore,
  estimateTokens,
  MaterialStoreError,
  onMaterialsChange,
  pathKey,
  statPath,
  type AgentMaterialsApi,
  type MaterialsChange,
  type StatResult,
} from '../src/main/agentLive/materials';

const ROOT = 'D:\\kb-r13-work\\al-1\\unit';
const WS = 'ws1';
const WS2 = 'ws2';

class Feed implements ResourceChangeFeed {
  private readonly cbs = new Set<(batch: ResourceChange[]) => void>();
  onBatch(cb: (batch: ResourceChange[]) => void): Unsubscribe {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(batch: ResourceChange[]): void {
    for (const cb of [...this.cbs]) cb(batch);
  }
}

interface Env {
  dir: string;
  user: string;
  root: string;
  loose: string;
  state: string;
  feed: Feed;
}

let openStores: AgentMaterialsApi[] = [];

function writeFile(file: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fresh(): Env {
  fs.mkdirSync(ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(ROOT, 't-'));
  const user = path.join(dir, 'user');
  const root = path.join(dir, 'root');
  const loose = path.join(dir, 'loose');
  fs.mkdirSync(user);
  fs.mkdirSync(root);
  fs.mkdirSync(loose);
  return { dir, user, root, loose, state: path.join(user, 'agent-live-state.json'), feed: new Feed() };
}

function open(env: Env, extra: Record<string, unknown> = {}): AgentMaterialsApi {
  const store = createAgentMaterialsStore({
    userDataDir: env.user,
    stateFile: env.state,
    feed: env.feed,
    repairMs: 0,
    looseDebounceMs: 0,
    now: () => new Date('2026-10-08T00:00:00.000Z'),
    identity: {
      resolve(absPath: string) {
        const key = pathKey(absPath);
        const rootKey = pathKey(env.root);
        if (key !== rootKey && !key.startsWith(`${rootKey}\\`)) return null;
        const rel = path.relative(env.root, absPath).replace(/\\/g, '/');
        return { resourceId: `r-${rel.toLowerCase()}`, sourceId: 'src1', relPath: rel };
      },
    },
    ...extra,
  });
  openStores.push(store);
  return store;
}

function record(store: AgentMaterialsApi): MaterialsChange[] {
  const events: MaterialsChange[] = [];
  onMaterialsChange(store, (event) => events.push(event));
  return events;
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))] ?? 0;
}

afterEach(async () => {
  const pending = openStores;
  openStores = [];
  for (const store of pending) await store.close();
});

describe('agent live 资料清单', () => {
  it('粗估按中日韩字符和其余字符的比例', () => {
    expect(estimateTokens('你好world')).toBe(4);
    expect(estimateTokens('你好 world')).toBe(4);
    expect(estimateTokens('')).toBe(0);
  });

  it('加入、重复加入、排序、改用途，并保持接口形状', async () => {
    const env = fresh();
    const file = path.join(env.root, '实验.md');
    writeFile(file, 'SENTINEL_BODY_zz\n你好world');
    const store = open(env);
    const typed: AgentMaterialsStore = store;
    const events = record(store);
    expect(store.add(WS, { absPath: file }, { purpose: '对照', index: 0 })).toBe('added');
    expect(store.add(WS, { absPath: `${file}\\` })).toBe('duplicate');
    expect(store.add(WS, { absPath: file.toUpperCase() })).toBe('duplicate');
    const first = store.list(WS)[0]!;
    expect(store.find(WS, { absPath: file })?.materialId).toBe(first.materialId);
    expect(first.tier).toBe('session');
    expect(first.resourceId).toBe('r-实验.md');
    expect(first.sourceId).toBe('src1');
    expect(first.purpose).toBe('对照');
    expect(first.status).toBe('ok');
    expect(first.bytes).toBe(fs.statSync(file).size);
    expect(first.contentHash).toBeNull();
    expect(first.estTokens).toBeNull();
    expect(events[0]).toMatchObject({ type: 'material.added', tier: 'session', materialId: first.materialId });

    const second = path.join(env.root, '笔记.md');
    const third = path.join(env.root, '附录.md');
    writeFile(second, 'b');
    writeFile(third, 'c');
    store.add(WS, { absPath: second });
    store.add(WS, { absPath: third }, { index: 0 });
    expect(store.list(WS).map((item) => item.name)).toEqual(['附录.md', '实验.md', '笔记.md']);
    store.reorder(WS, [first.materialId, store.list(WS)[0]!.materialId]);
    expect(store.list(WS).map((item) => item.name)).toEqual(['实验.md', '附录.md', '笔记.md']);
    expect(events.some((event) => event.type === 'material.reordered' && Array.isArray(event.order))).toBe(true);

    const before = events.length;
    store.setPurpose(WS, first.materialId, '  新用途  ');
    store.setPurpose(WS, first.materialId, '新用途');
    store.setPurpose(WS, first.materialId, '  ');
    expect(events.slice(before).map((event) => event.type)).toEqual(['material.purposeChanged', 'material.purposeChanged']);
    expect(store.list(WS)[0]?.purpose).toBeNull();
    expect(typed.list(WS)).toHaveLength(3);

    await store.whenIdle();
    const ready = store.list(WS).find((item) => item.materialId === first.materialId)!;
    expect(ready.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(ready.estTokens).toBe(estimateTokens('SENTINEL_BODY_zz\n你好world'));
    expect(ready.hasText).toBe(true);
    expect(ready.pages).toBeNull();
    expect(ready.readable).toBe(`content/${ready.materialId}/${ready.contentHash!.slice('sha256:'.length)}.txt`);
    expect(ready.contentVersion).toBe(1);
    const dumped = fs.readFileSync(env.state, 'utf8') + fs.readFileSync(path.join(env.user, 'agent-materials', 'pinned.json'), 'utf8');
    expect(dumped.includes('SENTINEL_BODY_zz')).toBe(false);
    expect(fs.readdirSync(env.user).join(',')).not.toContain('content');
  });

  it('固定、取消固定、清空本轮；重启后两区都在，原文件不变', async () => {
    const env = fresh();
    const pinnedFile = path.join(env.root, '固定.md');
    const sessionFile = path.join(env.root, '本轮.md');
    writeFile(pinnedFile, 'pinned-body');
    writeFile(sessionFile, 'session-body');
    const pinnedHash = sha256(pinnedFile);
    const sessionHash = sha256(sessionFile);
    const store = open(env);
    const events = record(store);
    store.add(WS, { absPath: pinnedFile }, { purpose: '长期' });
    store.add(WS, { absPath: sessionFile }, { purpose: '临时' });
    const pinned = store.find(WS, { absPath: pinnedFile })!;
    const session = store.find(WS, { absPath: sessionFile })!;
    store.pin(WS, pinned.materialId);
    expect(store.add(WS, { absPath: pinnedFile })).toBe('duplicate');
    expect(store.find(WS, { absPath: pinnedFile })?.tier).toBe('pinned');
    expect(store.find(WS, { absPath: pinnedFile })?.materialId).toBe(pinned.materialId);
    expect(store.list(WS)).toHaveLength(2);
    expect(events.some((event) => event.type === 'material.pinned' && event.materialId === pinned.materialId)).toBe(true);

    const cleared = store.clearSession(WS);
    expect(cleared).toEqual([session.materialId]);
    expect(store.list(WS).map((item) => item.materialId)).toEqual([pinned.materialId]);
    expect(events.some((event) => event.type === 'session.cleared' && event.materialIds?.join() === session.materialId)).toBe(true);
    expect(sha256(pinnedFile)).toBe(pinnedHash);
    expect(sha256(sessionFile)).toBe(sessionHash);
    expect(store.clearSession(WS)).toEqual([]);

    store.unpin(WS, pinned.materialId);
    store.pin(WS, pinned.materialId);
    await store.whenIdle();
    await store.close();
    openStores = [];

    const again = open(env);
    const restored = again.list(WS);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      materialId: pinned.materialId,
      tier: 'pinned',
      purpose: '长期',
      status: 'ok',
    });
    expect(restored[0]?.contentHash).toMatch(/^sha256:/);
    const state = JSON.parse(fs.readFileSync(env.state, 'utf8')) as { sessionMaterials?: { byWorkspace?: Record<string, unknown[]> } };
    expect(state.sessionMaterials?.byWorkspace?.[WS] ?? []).toHaveLength(0);
    const pinnedJson = fs.readFileSync(path.join(env.user, 'agent-materials', 'pinned.json'), 'utf8');
    expect(pinnedJson).toContain(pinned.materialId);
    expect(pinnedJson).not.toContain(session.materialId);
    expect(pinnedJson).not.toContain('session-body');
  });

  it('移除不删文件；删除源文件后条目仍在并标为失效，恢复后还是同一个 id', async () => {
    const env = fresh();
    const file = path.join(env.root, '会动.md');
    writeFile(file, 'keep');
    const before = sha256(file);
    const store = open(env);
    const events = record(store);
    store.add(WS, { absPath: file });
    await store.whenIdle();
    const item = store.list(WS)[0]!;
    store.remove(WS, item.materialId);
    expect(store.list(WS)).toHaveLength(0);
    expect(sha256(file)).toBe(before);
    expect(fs.existsSync(file)).toBe(true);

    store.add(WS, { absPath: file });
    await store.whenIdle();
    const live = store.list(WS)[0]!;
    const version = live.contentVersion;
    events.length = 0;
    fs.rmSync(file);
    env.feed.emit([{ type: 'unlink', resourceId: live.resourceId ?? undefined, absPath: file, relPath: '会动.md', rootId: 'src1' }]);
    expect(store.list(WS)).toHaveLength(1);
    expect(store.list(WS)[0]).toMatchObject({ materialId: live.materialId, status: 'missing' });
    expect(events.map((event) => event.type)).toEqual(['material.missing']);

    writeFile(file, 'keep');
    env.feed.emit([{ type: 'add', resourceId: live.resourceId ?? undefined, absPath: file, relPath: '会动.md', rootId: 'src1' }]);
    expect(store.list(WS)[0]).toMatchObject({ materialId: live.materialId, status: 'ok' });
    expect(events.some((event) => event.type === 'material.restored')).toBe(true);
    expect(events.some((event) => event.type === 'material.removed')).toBe(false);
    await store.whenIdle();
    expect(store.list(WS)[0]?.contentVersion).toBe(version);
  });

  it('重命名和移动只发 path.changed，临时文件不算变化', async () => {
    const env = fresh();
    const file = path.join(env.root, '旧.md');
    const moved = path.join(env.root, '目录', '新.md');
    writeFile(file, 'same');
    const store = open(env);
    const events = record(store);
    store.add(WS, { absPath: file });
    await store.whenIdle();
    const item = store.list(WS)[0]!;
    events.length = 0;
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(file, moved);
    env.feed.emit([
      { type: 'unlink', resourceId: item.resourceId ?? undefined, absPath: file, relPath: '旧.md', rootId: 'src1' },
      { type: 'add', resourceId: item.resourceId ?? undefined, absPath: moved, relPath: '目录/新.md', rootId: 'src1' },
    ]);
    expect(store.list(WS)).toHaveLength(1);
    expect(store.list(WS)[0]).toMatchObject({ materialId: item.materialId, status: 'ok', relPath: '目录/新.md', name: '新.md' });
    expect(pathKey(store.list(WS)[0]!.absPath)).toBe(pathKey(moved));
    expect(events.map((event) => event.type)).toEqual(['path.changed']);
    expect(events[0]).toMatchObject({ prevAbsPath: item.absPath, prevRelPath: '旧.md' });

    events.length = 0;
    env.feed.emit([{ type: 'change', absPath: `${moved}.tmp`, relPath: '目录/新.md.tmp', rootId: 'src1' }]);
    expect(events).toHaveLength(0);

    const dir = path.join(env.root, '目录');
    env.feed.emit([{ type: 'unlinkDir', absPath: dir, rootId: 'src1' }]);
    expect(store.list(WS)[0]?.status).toBe('missing');
    expect(store.list(WS)[0]?.materialId).toBe(item.materialId);
  });

  it('内容没变不升版本；只改修改时间会通知；正文变化才增加 contentVersion', async () => {
    const env = fresh();
    const file = path.join(env.root, '稿.md');
    writeFile(file, 'v1');
    const store = open(env);
    const events = record(store);
    store.add(WS, { absPath: file });
    await store.whenIdle();
    const item = store.list(WS)[0]!;
    events.length = 0;
    env.feed.emit([{ type: 'change', absPath: file, resourceId: item.resourceId ?? undefined, relPath: '稿.md', rootId: 'src1' }]);
    await store.whenIdle();
    expect(events.filter((event) => event.type === 'content.changed')).toHaveLength(0);

    const st = fs.statSync(file);
    fs.utimesSync(file, st.atime, new Date(Math.trunc(st.mtimeMs) + 5000));
    env.feed.emit([{ type: 'change', absPath: file, resourceId: item.resourceId ?? undefined, relPath: '稿.md', rootId: 'src1' }]);
    await store.whenIdle();
    const mtimeEvents = events.filter((event) => event.type === 'content.changed');
    expect(mtimeEvents).toHaveLength(1);
    const mtimeHit = mtimeEvents[0];
    expect(mtimeHit?.type).toBe('content.changed');
    if (mtimeHit?.type === 'content.changed') {
      expect(mtimeHit.contentHash).toBe(item.contentHash);
      expect(mtimeHit.prevContentHash).toBe(item.contentHash);
    }
    expect(store.list(WS)[0]?.contentVersion).toBe(1);

    writeFile(file, 'v2 你好');
    env.feed.emit([{ type: 'change', absPath: file, resourceId: item.resourceId ?? undefined, relPath: '稿.md', rootId: 'src1' }]);
    await store.whenIdle();
    const changed = store.list(WS)[0]!;
    expect(changed.contentVersion).toBe(2);
    expect(changed.contentHash).not.toBe(item.contentHash);
    expect(changed.estTokens).toBe(estimateTokens('v2 你好'));
  });

  it('根外单文件用单文件监视，根内文件不监视；PDF 只记页数', async () => {
    const env = fresh();
    const outside = path.join(env.loose, '外面.txt');
    const inside = path.join(env.root, '里面.txt');
    writeFile(outside, 'out');
    writeFile(inside, 'in');
    const pdf = path.join(env.loose, '文.pdf');
    writeFile(
      pdf,
      '%PDF-1.4\n1 0 obj << /Type /Pages /Count 2 >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Page >> endobj\n',
    );
    const store = open(env);
    const events = record(store);
    store.add(WS, { absPath: outside });
    store.add(WS, { absPath: inside });
    store.add(WS, { absPath: pdf });
    expect(store.find(WS, { absPath: outside })?.resourceId).toBeNull();
    expect(store.find(WS, { absPath: inside })?.resourceId).toBe('r-里面.txt');
    expect(store.watchCount()).toBe(2);
    await store.whenIdle();
    const pdfItem = store.find(WS, { absPath: pdf })!;
    expect(pdfItem.pages).toBe(2);
    expect(pdfItem.estTokens).toBeNull();
    expect(pdfItem.hasText).toBe(true);
    const pdfEvent = events.find((event) => event.type === 'content.changed' && event.materialId === pdfItem.materialId);
    expect(pdfEvent?.type === 'content.changed' ? pdfEvent.diffSupported : undefined).toBe(false);

    events.length = 0;
    writeFile(outside, 'out\nmore');
    const started = Date.now();
    while (!events.some((event) => event.type === 'content.changed' && event.absPath && pathKey(event.absPath) === pathKey(outside))) {
      if (Date.now() - started > 2000) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await store.whenIdle();
    expect(events.some((event) => event.type === 'content.changed' && event.materialId === store.find(WS, { absPath: outside })?.materialId)).toBe(true);
    expect(store.watchCount()).toBe(2);
  });

  it('根外文件不靠监视时，reconcile 也能补上变化', async () => {
    const env = fresh();
    const outside = path.join(env.loose, '慢.txt');
    writeFile(outside, 'a');
    const store = open(env, { watchLoose: false });
    store.add(WS, { absPath: outside });
    await store.whenIdle();
    expect(store.watchCount()).toBe(0);
    writeFile(outside, 'a\nb');
    const events = record(store);
    store.reconcile();
    await store.whenIdle();
    expect(events.some((event) => event.type === 'content.changed')).toBe(true);
    expect(store.list(WS)[0]?.status).toBe('ok');
  });

  it('不可读变为可读后恢复；目录、网址和令牌文件不收', async () => {
    const env = fresh();
    const file = path.join(env.loose, '锁.txt');
    writeFile(file, 'abc');
    let mode: StatResult = { kind: 'unreadable' };
    const store = open(env, {
      watchLoose: false,
      stat: (absPath: string) => (pathKey(absPath) === pathKey(file) ? mode : statPath(absPath)),
      readFile: async () => Buffer.from('abc'),
    });
    store.add(WS, { absPath: file });
    expect(store.list(WS)[0]?.status).toBe('unreadable');
    mode = { kind: 'file', size: 3, mtimeMs: 10 };
    const events = record(store);
    store.reconcile();
    await store.whenIdle();
    expect(store.list(WS)[0]?.status).toBe('ok');
    expect(store.list(WS)[0]?.contentHash).toMatch(/^sha256:/);
    expect(events.some((event) => event.type === 'material.restored')).toBe(true);

    expect(() => store.add(WS, { absPath: env.root })).toThrow(MaterialStoreError);
    expect(() => store.add(WS, { absPath: 'https://example.com/a.png' })).toThrow(MaterialStoreError);
    const secret = path.join(env.loose, 'agent-token.json');
    writeFile(secret, '{"token":"no"}');
    expect(() => store.add(WS, { absPath: secret })).toThrow(MaterialStoreError);
    expect(store.list(WS)).toHaveLength(1);
    expect(fs.existsSync(secret)).toBe(true);
  });

  it('两个工作区互不影响，第 201 项被拒绝', () => {
    const env = fresh();
    const store = open(env, {
      watchLoose: false,
      stat: () => ({ kind: 'missing' }) as StatResult,
    });
    store.add(WS, { absPath: path.join(env.root, 'a.md') });
    store.add(WS2, { absPath: path.join(env.root, 'a.md') });
    expect(store.list(WS)).toHaveLength(1);
    expect(store.list(WS2)).toHaveLength(1);
    expect(store.list(WS)[0]?.materialId).not.toBe(store.list(WS2)[0]?.materialId);
    for (let i = 0; i < 199; i++) store.add(WS, { absPath: path.join(env.root, 'more', `${i}.md`) });
    expect(store.list(WS)).toHaveLength(200);
    expect(() => store.add(WS, { absPath: path.join(env.root, 'more', 'overflow.md') })).toThrow(MaterialStoreError);
    try {
      store.add(WS, { absPath: path.join(env.root, 'more', 'overflow.md') });
    } catch (err) {
      expect((err as MaterialStoreError).code).toBe('limit');
    }
    expect(store.list(WS)).toHaveLength(200);
    expect(store.list(WS2)).toHaveLength(1);
  });

  it('沿用组 4 的修订字段，并迁移没有版本号的固定资料', async () => {
    const env = fresh();
    const file = path.join(env.root, '旧档.md');
    writeFile(file, 'old');
    const seeded = {
      schemaVersion: 1,
      note: 'keep-me',
      current: {
        workspaceId: WS,
        currentRevision: 4,
        revision: 4,
        oldestRevision: 1,
        segments: [{ from: 1, to: 4, file: '000001-000004.jsonl' }],
        revisionTimes: { '4': '2026-10-08T00:00:00.000Z' },
        pendingUnlinks: [],
      },
      workspaces: { [WS]: { revision: 9, workspaceName: '论文', custom: 1 } },
    };
    writeFile(env.state, JSON.stringify(seeded));
    const pinnedFile = path.join(env.user, 'agent-materials', 'pinned.json');
    writeFile(pinnedFile, JSON.stringify({
      schemaVersion: 1,
      workspaces: {
        [WS]: [{ materialId: 'm-legacy', absPath: file, name: '旧档.md', purpose: '旧', order: 0 }],
      },
    }));
    const before = fs.readFileSync(env.state);
    const store = open(env, { watchLoose: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.readFileSync(env.state).equals(before)).toBe(false);
    await store.whenIdle();
    const disk = JSON.parse(fs.readFileSync(env.state, 'utf8')) as {
      note: string;
      current: { currentRevision: number; segments: unknown[] };
      workspaces: Record<string, { revision: number; custom: number; workspaceName: string }>;
    };
    expect(disk.note).toBe('keep-me');
    expect(disk.current.currentRevision).toBe(4);
    expect(disk.current.segments).toHaveLength(1);
    expect(disk.workspaces[WS]).toMatchObject({ revision: 9, custom: 1, workspaceName: '论文' });
    expect(store.list(WS)).toHaveLength(1);
    expect(store.list(WS)[0]).toMatchObject({ materialId: 'm-legacy', tier: 'pinned', purpose: '旧' });
    const saved = JSON.parse(fs.readFileSync(pinnedFile, 'utf8')) as { workspaces: Record<string, { schemaVersion: number; items: unknown[] }> };
    expect(saved.workspaces[WS]?.schemaVersion).toBe(1);
    expect(Array.isArray(saved.workspaces[WS]?.items)).toBe(true);

    const bad = path.join(env.dir, 'bad.json');
    writeFile(bad, JSON.stringify({ schemaVersion: 2, current: {}, workspaces: {} }));
    const badBefore = fs.readFileSync(bad);
    expect(() => createAgentMaterialsStore({ userDataDir: env.user, stateFile: bad, repairMs: 0, watchLoose: false })).toThrow(/schemaVersion/);
    expect(fs.readFileSync(bad).equals(badBefore)).toBe(true);

    const clean = path.join(env.dir, 'clean.json');
    writeFile(clean, JSON.stringify(seeded));
    const cleanBefore = fs.readFileSync(clean);
    const cleanStore = createAgentMaterialsStore({
      userDataDir: path.join(env.dir, 'clean-user'),
      stateFile: clean,
      repairMs: 0,
      watchLoose: false,
    });
    openStores.push(cleanStore);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.readFileSync(clean).equals(cleanBefore)).toBe(true);
  });

  it('同一条路径后来补上 resourceId 时复用原条目', () => {
    const env = fresh();
    const file = path.join(env.loose, '后补.txt');
    writeFile(file, 'x');
    const store = open(env, { watchLoose: false });
    store.add(WS, { absPath: file });
    const id = store.list(WS)[0]!.materialId;
    expect(store.list(WS)[0]?.resourceId).toBeNull();
    expect(store.watchCount()).toBe(0);
    expect(store.add(WS, { absPath: file, resourceId: 'r-later', sourceId: 'src9', relPath: '后补.txt' })).toBe('duplicate');
    expect(store.list(WS)).toHaveLength(1);
    expect(store.list(WS)[0]).toMatchObject({ materialId: id, resourceId: 'r-later', sourceId: 'src9', tier: 'session' });
  });

  it('加入、批量加入和清空落在 0.10 的耗时门槛内', async () => {
    const env = fresh();
    const store = open(env, { watchLoose: false });
    const samples: number[] = [];
    for (let i = 0; i < 20; i++) {
      const file = path.join(env.root, 'perf', `${i}.md`);
      writeFile(file, `n${i}`);
      const started = process.hrtime.bigint();
      store.add(WS, { absPath: file });
      store.flushSync();
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      store.remove(WS, store.list(WS)[0]!.materialId);
      store.flushSync();
    }
    const singleP95 = p95(samples);

    const batchDir = path.join(env.root, 'batch');
    for (let i = 0; i < 50; i++) writeFile(path.join(batchDir, `${i}.md`), 'b');
    const lagStart = process.hrtime.bigint();
    let lagMs = 0;
    const lag = new Promise<void>((resolve) => {
      setImmediate(() => {
        lagMs = Number(process.hrtime.bigint() - lagStart) / 1e6;
        resolve();
      });
    });
    const batchStart = process.hrtime.bigint();
    for (let i = 0; i < 50; i++) store.add(WS2, { absPath: path.join(batchDir, `${i}.md`) });
    const batchSyncMs = Number(process.hrtime.bigint() - batchStart) / 1e6;
    await lag;
    store.flushSync();
    const batchTotalMs = Number(process.hrtime.bigint() - batchStart) / 1e6;

    const clearEnv = fresh();
    const clearStore = open(clearEnv, {
      watchLoose: false,
      stat: () => ({ kind: 'missing' }) as StatResult,
    });
    for (let i = 0; i < 200; i++) clearStore.add('ws-clear', { absPath: path.join(clearEnv.root, 'clear', `${i}.md`) });
    clearStore.flushSync();
    const clearLagStart = process.hrtime.bigint();
    let clearLagMs = 0;
    const clearLag = new Promise<void>((resolve) => {
      setImmediate(() => {
        clearLagMs = Number(process.hrtime.bigint() - clearLagStart) / 1e6;
        resolve();
      });
    });
    const clearStart = process.hrtime.bigint();
    expect(clearStore.clearSession('ws-clear')).toHaveLength(200);
    const clearSyncMs = Number(process.hrtime.bigint() - clearStart) / 1e6;
    await clearLag;
    clearStore.flushSync();
    const clearTotalMs = Number(process.hrtime.bigint() - clearStart) / 1e6;

    const perf = { singleP95, batchSyncMs, batchTotalMs, lagMs, clearSyncMs, clearTotalMs, clearLagMs };
    fs.mkdirSync('D:\\kb-r13-work\\al-1', { recursive: true });
    fs.writeFileSync('D:\\kb-r13-work\\al-1\\perf.json', JSON.stringify(perf, null, 2));
    console.log(JSON.stringify(perf));
    expect(singleP95).toBeLessThan(100);
    expect(batchTotalMs).toBeLessThan(300);
    expect(lagMs).toBeLessThan(100);
    expect(clearTotalMs).toBeLessThan(200);
    expect(clearLagMs).toBeLessThan(100);
  });
});
