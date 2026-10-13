/**
 * 外贴 25 隔离验收。空库落在 D:\kb-r13-work\agent-live-0025\userdata。
 * 不打开窗口，不写 Amy 的用户目录。双 agent 只用组 5 的模拟监听。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildManifest, initBridgeTree } from '../src/main/agent-bridge/initBridge';
import { startAgentLive, type AgentLiveWire } from '../src/main/agentLive/wire';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { RootWatchers } from '../src/main/service/watcher';
import { actionGate, getInvokeExecutor, hasInvokeExecutor, type ActionExecutorHost } from '../src/shared/actions/registry';
import { AGENT_LIVE_ACTIONS, type AgentMaterial } from '../src/shared/agentLive/types';
import { describeAdd } from '../src/renderer/agent-live/actions';
import { duplicateMessage, MSG_CLEAR_BODY, MSG_CLEAR_TITLE, MSG_COPIED } from '../src/renderer/agent-live/messages';
import type { AgentLiveClient } from '../src/renderer/agent-live/client';
import type { AgentLiveHost } from '../src/renderer/agent-live/host';

const LOG = 'D:\\kb-r13-work\\agent-live-0025';
const USER_ROOT = path.join(LOG, 'userdata');
const REPO = path.resolve(process.cwd());
const BLOCKS = ['## 1. 工作区', '## 2. 已打开的资料', '## 3. 工作资料', '## 4. 导航', '## 5. 版本', '## 6. 接入约定'];

const hostStub: ActionExecutorHost = { listPendingPlans: () => [] };

let live: AgentLiveWire | null = null;
let watchers: RootWatchers | null = null;
let svc: WorkbenchService | null = null;

function assertIsolated(dir: string): void {
  const norm = path.resolve(dir).toLowerCase();
  const local = path.join(process.env.LOCALAPPDATA || '', 'LocalKnowledgeWorkbench').toLowerCase();
  if (local && (norm === local || norm.startsWith(local + path.sep))) {
    throw new Error('拒绝写入真实用户目录');
  }
  if (norm.startsWith('d:\\study_dev')) throw new Error('拒绝写入 D:\\study_dev');
  if (!norm.startsWith(path.resolve(USER_ROOT).toLowerCase() + path.sep) && norm !== path.resolve(USER_ROOT).toLowerCase()) {
    throw new Error('用户数据必须留在隔离目录');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label: string, fn: () => boolean, ms = 15000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(50);
  }
  throw new Error(`等待超时: ${label}`);
}

function rowsOf(api: AgentLiveWire, workspaceId: string): AgentMaterial[] {
  return api.methods.agentLiveList(workspaceId) as AgentMaterial[];
}

function runWatch(bridge: string, agent: string, logName: string): string {
  const log = path.join(LOG, logName);
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.KB_AGENT_BRIDGE_ROOT;
  delete env.KB_USER_DATA;
  const res = spawnSync(process.execPath, [
    path.join(REPO, 'tools', 'kb-agent-watch', 'watch.mjs'),
    '--bridge', bridge,
    '--agent', agent,
    '--once',
    '--poll-only',
  ], { cwd: REPO, env, encoding: 'utf8', timeout: 20000 });
  fs.writeFileSync(log, `exit:${res.status}\n${res.stdout || ''}\n${res.stderr || ''}`, 'utf8');
  if (res.status !== 0) throw new Error(`${logName} 退出 ${res.status}`);
  return log;
}

function readCursor(bridge: string, agent: string): { currentRevision: number; workspaces: Record<string, number> } {
  return JSON.parse(fs.readFileSync(path.join(bridge, 'cursors', `${agent}.json`), 'utf8')) as {
    currentRevision: number;
    workspaces: Record<string, number>;
  };
}

function workspaceRevision(bridge: string, agent: string, workspaceId: string): number {
  return readCursor(bridge, agent).workspaces[workspaceId] ?? -1;
}

function walkFiles(dir: string, hit: (file: string) => void): void {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (fs.statSync(abs).isDirectory()) walkFiles(abs, hit);
    else hit(abs);
  }
}

afterEach(async () => {
  if (live) await live.close();
  live = null;
  if (watchers) await watchers.closeAll();
  watchers = null;
  if (svc) await svc.close();
  svc = null;
});

describe('agent live 公共接线', () => {
  it('隔离入口、两区、双模拟 agent', async () => {
    const started = Date.now();
    const savedBridge = process.env.KB_AGENT_BRIDGE_ROOT;
    delete process.env.KB_AGENT_BRIDGE_ROOT;
    fs.mkdirSync(USER_ROOT, { recursive: true });
    const dataDir = fs.mkdtempSync(path.join(USER_ROOT, 'run-'));
    assertIsolated(dataDir);
    const evidence: Record<string, unknown> = {
      label: '仅模拟 / 仅文件入口',
      realAgent: '未跑。不声称自动唤醒已实现。',
      dataDir,
      clipboard: '未开窗口。copyBridgeLink 把入口绝对路径交给 writeClipboard。',
    };
    const library = path.join(LOG, 'files', path.basename(dataDir));
    const note = path.join(library, '笔记.md');
    fs.mkdirSync(library, { recursive: true });
    fs.writeFileSync(note, 'alpha line\n', 'utf8');
    evidence.library = library;

    try {
      svc = new WorkbenchService({ dataDir });
      const ws = svc.getCurrentWorkspaceId();
      svc.addRoot(library, '库');
      watchers = new RootWatchers(svc, 40);
      watchers.sync();
      await waitFor('资料入库', () => svc!.resolveMaterialIdentity(note) !== null);
      watchers.sync();
      const identity = svc.resolveMaterialIdentity(note);

      const bridge = path.join(dataDir, 'agent-bridge');
      initBridgeTree(bridge, buildManifest());
      const here = fs.readFileSync(path.join(bridge, 'AGENT_START_HERE.md'), 'utf8');
      expect(here.split(/\r?\n/, 1)[0]).toBe('现场入口：live/current/ENTRY.md');
      expect(here).toContain('不要读 `agent-token.json`');

      live = startAgentLive({
        svc,
        watchers,
        dataDir,
        version: '0.2.3',
        notify: () => undefined,
      });
      const entryPath = path.join(bridge, 'live', 'current', 'ENTRY.md');
      await waitFor('启动入口', () => fs.existsSync(entryPath) && fs.existsSync(path.join(bridge, 'live', 'current', 'marker.json')));
      const linked = String(await live.methods.agentLiveEntryPath('current'));
      expect(path.resolve(linked)).toBe(path.resolve(entryPath));

      const bootText = fs.readFileSync(entryPath, 'utf8');
      let at = -1;
      for (const heading of BLOCKS) {
        const next = bootText.indexOf(heading);
        expect(next).toBeGreaterThan(at);
        at = next;
      }
      expect(bootText).toContain('### 本轮资料');
      expect(bootText).toContain('### 固定资料');
      const marker = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'current', 'marker.json'), 'utf8')) as { appVersion?: string };
      expect(marker.appVersion).toBe('0.2.3');

      const copied: string[] = [];
      await (await import('../src/renderer/agent-live/actions')).copyBridgeLink({
        client: { list: async () => rowsOf(live!, ws) } as unknown as AgentLiveClient,
        host: {
          workspaceId: () => ws,
          bridgeEntryPath: () => live!.methods.agentLiveEntryPath('current') as Promise<string>,
          writeClipboard: async (text: string) => { copied.push(text); },
          notify: (message: string) => { evidence.notify = message; },
        } as AgentLiveHost,
      });
      expect(copied[0] && path.resolve(copied[0])).toBe(path.resolve(entryPath));
      expect(evidence.notify).toBe(MSG_COPIED);
      evidence.clipboardPath = copied[0];
      evidence.clipboardReadback = '未采样系统剪贴板。没有开窗口，也不改当前剪贴板。';

      const currentDir = path.join(bridge, 'live', 'current');
      const seen: string[] = [];
      const orderWatch = fs.watch(currentDir, (_event, name) => {
        if (name) seen.push(String(name));
      });
      expect(live.methods.agentLiveAdd(ws, { absPath: note })).toBe('added');
      const markerFile = path.join(currentDir, 'marker.json');
      await waitFor('入口写上资料名', () => fs.readFileSync(entryPath, 'utf8').includes('笔记.md'));
      let stableMarker = '';
      let stableFor = 0;
      await waitFor('发布收尾', () => {
        const text = fs.readFileSync(markerFile, 'utf8');
        if (text === stableMarker && fs.statSync(markerFile).mtimeMs >= fs.statSync(entryPath).mtimeMs) {
          stableFor += 50;
          return stableFor >= 500;
        }
        stableMarker = text;
        stableFor = 0;
        return false;
      });
      orderWatch.close();
      const entryAt = seen.map((name) => name.replace(/\\/g, '/')).reduce((acc, name, index) => (name.endsWith('ENTRY.md') ? index : acc), -1);
      const markerAt = seen.map((name) => name.replace(/\\/g, '/')).reduce((acc, name, index) => (name.endsWith('marker.json') ? index : acc), -1);
      const entryMtime = fs.statSync(entryPath).mtimeMs;
      const markerMtime = fs.statSync(path.join(currentDir, 'marker.json')).mtimeMs;
      evidence.publishOrder = { seen, entryAt, markerAt, entryMtime, markerMtime };
      expect(markerMtime).toBeGreaterThanOrEqual(entryMtime);
      if (markerAt >= 0 && entryAt >= 0) expect(markerAt).toBeGreaterThan(entryAt);

      const addedText = fs.readFileSync(entryPath, 'utf8');
      expect(addedText).toContain('### 本轮资料');
      expect(addedText).toContain('### 固定资料');
      expect(addedText).toContain('笔记.md');

      const row = rowsOf(live, ws)[0]!;
      expect(row.resourceId).toBe(identity?.resourceId ?? null);
      const ref = { absPath: note, resourceId: row.resourceId };
      const dup = live.methods.agentLiveAdd(ws, ref) as 'added' | 'duplicate';
      expect(dup).toBe('duplicate');
      const sessionDetail = await describeAdd(
        { list: async () => rowsOf(live!, ws) } as unknown as AgentLiveClient,
        ws,
        ref,
        dup,
      );
      expect(sessionDetail).toMatchObject({ result: 'duplicate', tier: 'session', materialId: row.materialId });
      expect(duplicateMessage(sessionDetail.tier)).toBe('已在本轮资料中');

      await waitFor('首版正文', () => {
        const item = rowsOf(live!, ws)[0];
        return !!item?.contentHash;
      });
      const beforeHash = rowsOf(live, ws)[0]!.contentHash;
      const bootA = runWatch(bridge, 'smoke-a', 'watch-smoke-a-boot.log');
      const bootB = runWatch(bridge, 'smoke-b', 'watch-smoke-b-boot.log');
      const revA = workspaceRevision(bridge, 'smoke-a', ws);
      const revB = workspaceRevision(bridge, 'smoke-b', ws);
      expect(revA).toBe(revB);
      expect(revA).toBeGreaterThanOrEqual(0);

      fs.writeFileSync(note, 'alpha line\nbeta line\n', 'utf8');
      const markerPath = path.join(bridge, 'live', 'ws', ws, 'marker.json');
      await waitFor('增量差异', () => {
        const item = rowsOf(live!, ws)[0];
        if (!item?.contentHash || item.contentHash === beforeHash) return false;
        let found = false;
        walkFiles(path.join(bridge, 'live', 'ws', ws, 'diff'), (file) => {
          if (file.endsWith('.diff')) found = true;
        });
        if (!found) return false;
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { revision?: number };
        return Number(marker.revision) > revA;
      });
      let changelog = '';
      walkFiles(path.join(bridge, 'live', 'ws', ws, 'changes'), (file) => {
        if (path.basename(file) !== 'index.json') changelog += fs.readFileSync(file, 'utf8');
      });
      expect(changelog).toContain('content.changed');
      const afterA = runWatch(bridge, 'smoke-a', 'watch-smoke-a-after.log');
      const midA = workspaceRevision(bridge, 'smoke-a', ws);
      const midB = workspaceRevision(bridge, 'smoke-b', ws);
      expect(midA).toBeGreaterThan(revA);
      expect(midB).toBe(revB);
      const afterB = runWatch(bridge, 'smoke-b', 'watch-smoke-b-after.log');
      expect(workspaceRevision(bridge, 'smoke-b', ws)).toBe(midA);
      expect(workspaceRevision(bridge, 'smoke-a', ws)).toBe(midA);

      const contentExec = getInvokeExecutor(AGENT_LIVE_ACTIONS.getContent);
      expect(contentExec).toBeTypeOf('function');
      const content = await contentExec!({
        actionId: AGENT_LIVE_ACTIONS.getContent,
        args: { materialId: row.materialId, workspaceId: ws },
        host: hostStub,
      });
      expect(content.status).toBe('success');
      expect(JSON.stringify(content.result)).toContain('beta line');

      let diffText = '';
      walkFiles(path.join(bridge, 'live', 'ws', ws, 'diff'), (file) => {
        if (file.endsWith('.diff')) diffText = fs.readFileSync(file, 'utf8');
      });
      expect(diffText).toContain('beta line');
      let diffName = '';
      walkFiles(path.join(bridge, 'live', 'ws', ws, 'diff'), (file) => {
        if (file.endsWith('.diff')) diffName = path.basename(file, '.diff');
      });
      const [fromHex, toHex] = diffName.split('__');
      const diffExec = getInvokeExecutor(AGENT_LIVE_ACTIONS.getDiff);
      const diff = await diffExec!({
        actionId: AGENT_LIVE_ACTIONS.getDiff,
        args: { materialId: row.materialId, workspaceId: ws, fromHash: `sha256:${fromHex}`, toHash: `sha256:${toHex}` },
        host: hostStub,
      });
      expect(diff.status).toBe('success');

      const materialId = rowsOf(live, ws)[0]!.materialId;
      live.methods.agentLivePin(ws, materialId);
      expect(rowsOf(live, ws).find((item) => item.materialId === materialId)?.tier).toBe('pinned');
      const pinnedDup = live.methods.agentLiveAdd(ws, ref) as 'duplicate';
      const pinnedDetail = await describeAdd(
        { list: async () => rowsOf(live!, ws) } as unknown as AgentLiveClient,
        ws,
        ref,
        pinnedDup,
      );
      expect(pinnedDetail).toMatchObject({ result: 'duplicate', tier: 'pinned', materialId });
      expect(duplicateMessage('pinned')).toBe('已在固定资料中');
      live.methods.agentLiveUnpin(ws, materialId);
      expect(rowsOf(live, ws).find((item) => item.materialId === materialId)?.tier).toBe('session');
      expect(MSG_CLEAR_TITLE).toBe('清空本轮资料？');
      expect(MSG_CLEAR_BODY).toContain('不会删除原文件');
      live.methods.agentLiveClearSession(ws);
      expect(rowsOf(live, ws)).toEqual([]);
      expect(fs.existsSync(note)).toBe(true);

      const other = svc.createWorkspace('另一区').id;
      svc.setCurrentWorkspace(other);
      await live.activate(other);
      const switched = String(await live.methods.agentLiveEntryPath('current'));
      expect(path.resolve(switched)).toBe(path.resolve(entryPath));
      const switchedText = fs.readFileSync(entryPath, 'utf8');
      expect(switchedText).toContain(other);
      expect(switchedText).not.toContain('笔记.md');

      for (const id of [
        AGENT_LIVE_ACTIONS.materialsAdd,
        AGENT_LIVE_ACTIONS.materialsRemove,
        AGENT_LIVE_ACTIONS.materialsPin,
        AGENT_LIVE_ACTIONS.materialsClearSession,
      ]) {
        expect(actionGate(id).approvalRequired).toBe(true);
        expect(hasInvokeExecutor(id)).toBe(false);
      }
      for (const id of [
        AGENT_LIVE_ACTIONS.copyBridgeLink,
        AGENT_LIVE_ACTIONS.copyWorkspaceLink,
        AGENT_LIVE_ACTIONS.getContent,
        AGENT_LIVE_ACTIONS.getDiff,
      ]) {
        expect(actionGate(id).approvalRequired).toBe(false);
        expect(hasInvokeExecutor(id)).toBe(true);
      }

      evidence.identity = identity;
      evidence.entryPath = entryPath;
      evidence.watchLogs = { bootA, bootB, afterA, afterB };
      evidence.cursors = {
        boot: revA,
        afterEditA: midA,
        heldB: midB,
        caughtUp: workspaceRevision(bridge, 'smoke-b', ws),
      };
      evidence.ms = Date.now() - started;
      evidence.result = 'PASS';
    } finally {
      if (savedBridge === undefined) delete process.env.KB_AGENT_BRIDGE_ROOT;
      else process.env.KB_AGENT_BRIDGE_ROOT = savedBridge;
      fs.writeFileSync(path.join(LOG, 'v1-v3.json'), JSON.stringify(evidence, null, 2), 'utf8');
    }
  }, 90000);
});
