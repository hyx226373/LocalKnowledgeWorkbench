import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryHost } from '../e2e/memoryHost';
import { CAPABILITIES, startAgentBridge } from '../src/main/agent-bridge/index';
import type { BridgeResponse } from '../src/main/agent-bridge/types';


const Q = '11111111-1111-4111-8111-111111111111';
const P = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const RID = '22222222-2222-4222-8222-222222222222';

async function boot() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-bridge-'));
  const mem = createMemoryHost();
  const bridge = await startAgentBridge({
    userDataDir: userData,
    host: mem.host,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
    appCommit: '30f956d',
    modulesCommit: 'c391925',
  });
  return { bridge, ...mem, root: bridge.root };
}

function writeReq(root: string, id: string, body: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ requestId: id, ...body }), 'utf8');
}

function readRes(root: string, id: string): BridgeResponse {
  return JSON.parse(fs.readFileSync(path.join(root, 'responses', `${id}.json`), 'utf8')) as BridgeResponse;
}

describe('文件桥登记表', () => {
  it('manifest 能力明细与说明使用同一组字段名', async () => {
    const ctx = await boot();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'manifest.json'), 'utf8'));
      expect(manifest.capabilities).toEqual([...CAPABILITIES]);
      const details = manifest.capabilityDetails as Array<Record<string, unknown>>;
      for (const row of details) {
        for (const field of ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema']) {
          expect(row).toHaveProperty(field);
        }
      }
      const byName = new Map(details.map((row) => [String(row.name), row]));
      expect(byName.get('state-export')?.availability).toBe('degraded');
      expect(byName.get('workbench.pendingPlans')?.availability).toBe('available');
      expect(byName.get('index.showHealth')?.availability).toBe('available');
      expect(byName.get('plan-submit')?.approvalRequired).toBe(true);
      expect(details.some((row) => String(row.name).startsWith('view.contentZoom'))).toBe(false);
      for (const name of ['source.add.folder', 'source.filter.set']) {
        const row = byName.get(name);
        expect(row).toBeTruthy();
        for (const field of ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema']) {
          expect(row).toHaveProperty(field);
        }
        expect(row?.availability).not.toBe('available');
      }
      for (const name of ['source.remap.preview', 'catalog.ref.add']) {
        const row = byName.get(name);
        expect(row).toBeTruthy();
        expect(row?.availability).toBe('available');
      }
      expect(byName.get('source.add.folder')?.approvalRequired).toBe(true);
      expect(byName.get('source.filter.set')?.approvalRequired).toBe(true);
      expect(byName.get('source.remap.preview')?.approvalRequired).toBe(false);
      expect(byName.get('catalog.ref.add')?.approvalRequired).toBe(false);
      expect(byName.has('disk.write')).toBe(false);
      const guide = fs.readFileSync(path.join(ctx.root, 'AGENT_START_HERE.md'), 'utf8');
      expect(guide).toContain('capabilityDetails');
      expect(guide).toContain('approvalRequired');
      expect(guide).toContain('name');
      expect(guide).toContain('description');
      expect(guide).toContain('params');
      expect(guide).toContain('availability');
      expect(guide).toContain('resultSchema');
      expect(guide).toContain('state-export');
      expect(fs.existsSync(path.join(ctx.root, 'schemas', 'capability.schema.json'))).toBe(true);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('actionId 与旧 commandId 都打开待批准计划', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待批准',
        approved: true,
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      const planId = readRes(ctx.root, P).planId;
      expect(readRes(ctx.root, P).status).toBe('awaiting_approval');
      expect(readRes(ctx.root, P).ignoredFields).toContain('approved');
      writeReq(ctx.root, Q, { type: 'invoke', actionId: 'workbench.pendingPlans' });
      const healthId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      writeReq(ctx.root, healthId, { type: 'invoke', invoke: { commandId: 'index.showHealth' } });
      await ctx.bridge.pumpOnce();
      const listed = readRes(ctx.root, Q);
      expect(listed.status).toBe('success');
      const result = listed.result as { plans: Array<{ planId: string }>; actionId: string; commandId: string };
      expect(result.plans[0]?.planId).toBe(planId);
      expect(result.actionId).toBe('workbench.pendingPlans');
      expect(result.commandId).toBe('workbench.pendingPlans');
      const health = readRes(ctx.root, healthId);
      expect(health.status).toBe('success');
      expect((health.result as { actionId: string }).actionId).toBe('index.showHealth');
      expect((health.result as { commandId: string }).commandId).toBe('index.showHealth');
      expect(ctx.stats.proposeCount).toBe(1);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('actionId 与 commandId 不一致、以及白名单外命令都不执行', async () => {
    const ctx = await boot();
    try {
      writeReq(ctx.root, Q, {
        type: 'invoke',
        invoke: { actionId: 'workbench.pendingPlans', commandId: 'index.showHealth' },
      });
      writeReq(ctx.root, S, { type: 'invoke', invoke: { commandId: 'powershell' } });
      await ctx.bridge.pumpOnce();
      expect(readRes(ctx.root, Q).error?.code).toBe('incomplete_request');
      expect(readRes(ctx.root, S).error?.code).toBe('command_not_allowed');
      expect(ctx.stats.proposeCount).toBe(0);
    } finally {
      await ctx.bridge.close();
    }
  });

  it('未批准的资料动作返回 awaiting_approval，内存宿主上的编排仍不可用', async () => {
    const ctx = await boot();
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(ctx.root, 'manifest.json'), 'utf8')) as { capabilityDetails: Array<Record<string, unknown>> };
        const byName = new Map(manifest.capabilityDetails.map((row) => [String(row.name), row]));
        for (const name of ['source.add.folder', 'source.filter.set']) {
          const row = byName.get(name);
          expect(row).toBeTruthy();
          for (const field of ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema']) {
            expect(row).toHaveProperty(field);
          }
          expect(row?.availability).not.toBe('available');
        }
        for (const name of ['source.remap.preview', 'catalog.ref.add']) {
          expect(byName.get(name)?.availability).toBe('available');
        }
        expect(byName.get('source.add.folder')?.approvalRequired).toBe(true);
        expect(byName.get('source.filter.set')?.approvalRequired).toBe(true);
        expect(byName.get('source.remap.preview')?.approvalRequired).toBe(false);
        expect(byName.get('catalog.ref.add')?.approvalRequired).toBe(false);
        expect(byName.has('disk.write')).toBe(false);
        writeReq(ctx.root, Q, {
          type: 'invoke',
          invoke: { actionId: 'source.filter.set', args: { sourceId: 's1', extensions: ['md'] } },
          approved: true,
        });
        const addId = '55555555-5555-4555-8555-555555555555';
        writeReq(ctx.root, addId, {
          type: 'invoke',
          invoke: { actionId: 'source.add.folder', args: { name: '笔记', extensions: ['md'] } },
          approved: true,
        });
        writeReq(ctx.root, S, { type: 'invoke', invoke: { actionId: 'source.remap.preview' } });
        const refId = '66666666-6666-4666-8666-666666666666';
        writeReq(ctx.root, refId, {
          type: 'invoke',
          invoke: { actionId: 'catalog.ref.add', args: { catalogId: 'default', folderId: null, resourceId: RID } },
        });
        const zoomId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
        writeReq(ctx.root, zoomId, { type: 'invoke', invoke: { commandId: 'view.contentZoomWheel' } });
        await ctx.bridge.pumpOnce();
        const filtered = readRes(ctx.root, Q);
        expect(filtered.status).toBe('awaiting_approval');
        expect(filtered.error).toBeUndefined();
        expect(filtered.ignoredFields).toContain('approved');
        expect(String((filtered.result as { note?: string } | undefined)?.note ?? '')).toMatch(/批准/);
        const added = readRes(ctx.root, addId);
        expect(added.status).toBe('awaiting_approval');
        expect(added.error).toBeUndefined();
        expect(added.ignoredFields).toContain('approved');
        expect(readRes(ctx.root, S).error?.code).toBe('incomplete_request');
        expect(readRes(ctx.root, refId).error?.code).toBe('not_available');
        expect(readRes(ctx.root, zoomId).error?.code).toBe('command_not_allowed');
        expect(ctx.stats.proposeCount).toBe(0);
      } finally {
        await ctx.bridge.close();
      }
  });

  it('state-export 六键用稳定 id，不写绝对路径', async () => {
    const ctx = await boot();
    try {
      ctx.host.readState = () => ({
        workspace: { workspaceId: 'ws-1', title: '默认' },
        resources: [{ resourceId: RID, title: 'a.md', sourceKind: 'file' }],
        panels: [{ itemId: 'item-1', resourceId: RID, adapterId: 'builtin.md' }],
        unsaved: [],
      });
      writeReq(ctx.root, P, {
        type: 'plan-submit',
        title: '待导出',
        ops: [{ kind: 'trash', resourceId: RID }],
      });
      await ctx.bridge.pumpOnce();
      const planId = readRes(ctx.root, P).planId;
      writeReq(ctx.root, Q, { type: 'state-export', snapshot: true });
      await ctx.bridge.pumpOnce();
      const res = readRes(ctx.root, Q);
      expect(res.status).toBe('success');
      const body = res.result as {
        workspace: { workspaceId: string };
        resources: { resourceId: string }[];
        panels: { itemId: string }[];
        unsaved: unknown[];
        pendingPlans: { planId: string }[];
        results: { requestId: string }[];
      };
      expect(body.workspace.workspaceId).toBe('ws-1');
      expect(body.resources[0]?.resourceId).toBe(RID);
      expect(body.panels[0]?.itemId).toBe('item-1');
      expect(body.unsaved).toEqual([]);
      expect(body.pendingPlans[0]?.planId).toBe(planId);
      expect(body.results.some((row) => row.requestId === P)).toBe(true);
      const snaps = fs.readdirSync(path.join(ctx.root, 'snapshots')).filter((name) => name.startsWith('state-'));
      expect(snaps).toHaveLength(1);
      const text = fs.readFileSync(path.join(ctx.root, 'snapshots', snaps[0]!), 'utf8');
      expect(text).not.toContain('should-not-leak');
      expect(text).not.toMatch(/[A-Za-z]:\\/);
    } finally {
      await ctx.bridge.close();
    }
  });
});
