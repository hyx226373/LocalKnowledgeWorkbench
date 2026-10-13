import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalFileOps } from '../src/main/backend/fileOps';
import { LocalPlanService, OperationService } from '../src/main/backend/operations';
import { CAPABILITIES, INVOKE_WHITELIST, mountFileAgentBridge } from '../src/main/agent-bridge';
import { bridgeInvokableIds } from '../src/shared/actions/registry';
import { catalogHeadings, normalizePane, virtualRootTitle } from '../src/renderer/dir-view/model';
import { makeRoot, makeService, tmpDir, write } from './helpers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const REF = '77777777-7777-4777-8777-777777777777';
const ADD = '88888888-8888-4888-8888-888888888888';
const FIL = '99999999-9999-4999-8999-999999999999';
const MAP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const APR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc';

function mountsOf(db: { prepare(sql: string): { all(): unknown } }) {
  return db.prepare('SELECT root_id, local_path, updated_at FROM root_mounts ORDER BY root_id').all();
}

function rootCount(db: { prepare(sql: string): { get(): unknown } }) {
  return (db.prepare('SELECT COUNT(*) AS n FROM roots').get() as { n: number }).n;
}

async function setup() {
  const { svc, dataDir } = await makeService();
  cleanups.push(() => svc.close());
  const dir = makeRoot();
  const root = svc.addRoot(dir, '笔记', ['MD', '.pdf', 'md']);
  const fileOps = new LocalFileOps(svc);
  const ops = new OperationService(svc, new LocalPlanService(svc, fileOps));
  const bridge = await mountFileAgentBridge({
    userDataDir: dataDir,
    svc,
    ops,
    pollMs: 0,
    useChokidar: false,
    stableMs: 0,
  });
  cleanups.push(() => bridge.close());
  return { svc, dataDir, dir, root, bridge };
}

function writeReq(root: string, id: string, body: Record<string, unknown>) {
  fs.writeFileSync(path.join(root, 'requests', `${id}.json`), JSON.stringify({ requestId: id, ...body }), 'utf8');
}

function readRes(root: string, id: string) {
  return JSON.parse(fs.readFileSync(path.join(root, 'responses', `${id}.json`), 'utf8')) as {
    status: string;
    error?: { code: string };
    ignoredFields?: string[];
    result?: { diskMove?: boolean; wroteMounts?: boolean; resourceId?: string; note?: string };
  };
}

describe('r12-P8 桥与目录栏', () => {
  it('catalog.ref.add 成功且 diskMove 为假，不写 root_mounts', async () => {
    const { svc, root, bridge } = await setup();
    const before = mountsOf(svc.db);
    writeReq(bridge.root, REF, {
      type: 'invoke',
      invoke: { actionId: 'catalog.ref.add', args: { catalogId: 'default', folderId: null, resourceId: root.resourceId } },
    });
    await bridge.pumpOnce();
    const res = readRes(bridge.root, REF);
    expect(res.status).toBe('success');
    expect(res.result?.diskMove).toBe(false);
    expect(res.result?.resourceId).toBe(root.resourceId);
    expect(mountsOf(svc.db)).toEqual(before);
    expect(svc.listVfolderView(null).entries.some((e) => e.resourceId === root.resourceId)).toBe(true);
  });

  it('source.add.folder 在批准前不增加 roots', async () => {
    const { svc, dir, bridge } = await setup();
    const before = rootCount(svc.db);
    writeReq(bridge.root, ADD, {
      type: 'invoke',
      invoke: { actionId: 'source.add.folder', args: { name: '笔记', extensions: ['md'], path: dir } },
      approved: true,
    });
    await bridge.pumpOnce();
    const res = readRes(bridge.root, ADD);
    expect(res.status).toBe('awaiting_approval');
    expect(res.error).toBeUndefined();
    expect(res.ignoredFields).toContain('approved');
    expect(rootCount(svc.db)).toBe(before);
  });

  it('source.filter.set 返回 awaiting_approval，filter_json 不变', async () => {
    const { svc, root, bridge } = await setup();
    const before = (svc.db.prepare('SELECT filter_json FROM roots WHERE id=?').get(root.id) as { filter_json: string }).filter_json;
    expect(before).toBe('{"extensions":["md","pdf"]}');
    // P3b 的执行体在服务上。桥在批准入口接上之前不得调用它，所以下面 filter_json 必须不变。
    expect(typeof (svc as { setSourceFilter?: unknown }).setSourceFilter).toBe('function');
    writeReq(bridge.root, FIL, {
      type: 'invoke',
      invoke: { actionId: 'source.filter.set', args: { sourceId: root.id, extensions: ['txt'] } },
      approved: true,
    });
    await bridge.pumpOnce();
    const res = readRes(bridge.root, FIL);
    expect(res.status).toBe('awaiting_approval');
    expect(res.error).toBeUndefined();
    expect(res.ignoredFields).toContain('approved');
    expect(String(res.result?.note ?? '')).toMatch(/批准/);
    const after = (svc.db.prepare('SELECT filter_json FROM roots WHERE id=?').get(root.id) as { filter_json: string }).filter_json;
    expect(after).toBe(before);
  });

  it('source.remap.preview 不写 root_mounts', async () => {
    const { svc, root, bridge } = await setup();
    const other = tmpDir('kbremap-');
    write(path.join(other, '笔记/读书笔记.md'), '# 标题\n内容');
    const before = mountsOf(svc.db);
    writeReq(bridge.root, MAP, {
      type: 'invoke',
      invoke: { actionId: 'source.remap.preview', args: { sourceId: root.id, newLocation: other } },
    });
    await bridge.pumpOnce();
    const res = readRes(bridge.root, MAP);
    expect(res.status).toBe('success');
    expect(res.result?.diskMove).toBe(false);
    expect(res.result?.wroteMounts).toBe(false);
    expect(mountsOf(svc.db)).toEqual(before);
  });

  it('桥上没有 approve，工作区进入与宿主挂接不在能力表', async () => {
    const { bridge } = await setup();
    const manifest = JSON.parse(fs.readFileSync(path.join(bridge.root, 'manifest.json'), 'utf8')) as {
      capabilities: string[];
      capabilityDetails: Array<{ name: string; availability: string }>;
    };
    const names = manifest.capabilityDetails.map((row) => row.name);
    for (const banned of ['workspace.enter', 'appLaunch', 'host.attach', 'retryPanel', 'approve']) {
      expect(names).not.toContain(banned);
      expect(bridgeInvokableIds()).not.toContain(banned);
    }
    expect([...CAPABILITIES]).not.toContain('approve');
    expect(INVOKE_WHITELIST).not.toContain('catalog.switch');
    expect(manifest.capabilityDetails.find((row) => row.name === 'source.filter.set')?.availability).not.toBe('available');
    expect(manifest.capabilityDetails.find((row) => row.name === 'catalog.ref.add')?.availability).toBe('available');
    writeReq(bridge.root, APR, { type: 'approve', planId: 'x' });
    await bridge.pumpOnce();
    expect(readRes(bridge.root, APR).error?.code).toBe('approval_ui_only');
  });

  it('两套编排时虚拟根标题跟着 catalogId 变', () => {
    const headings = catalogHeadings({
      v: 1,
      sets: [
        { id: 'default', virtualRootName: '自建目录' },
        { id: 'cat-b', virtualRootName: '乙根' },
      ],
    });
    expect(virtualRootTitle('default', headings)).toBe('自建目录');
    expect(virtualRootTitle('cat-b', headings)).toBe('乙根');
    expect(virtualRootTitle(undefined, headings, '当前编排')).toBe('当前编排');
    const pane = normalizePane({ kind: 'vfolder', folderId: null, catalogId: 'cat-b' }, { kind: 'vfolder', folderId: null });
    expect(pane.catalogId).toBe('cat-b');
    expect(virtualRootTitle(pane.catalogId, headings)).toBe('乙根');
    const other = normalizePane({ kind: 'vfolder', folderId: null, catalogId: 'default' }, { kind: 'vfolder', folderId: null });
    expect(virtualRootTitle(other.catalogId, headings)).toBe('自建目录');
  });
});
