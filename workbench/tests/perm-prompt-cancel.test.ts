/**
 * 插件权限框：取消（Esc、点背景、关闭）不写 granted_json；只有点「拒绝」才记 denied。
 * 停用插件时关掉挂着的权限框，不写入任何决定。
 * setPermissionGrant 是唯一会改 plugins.granted_json 的渲染进程入口。
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdapterPluginDto } from '../src/shared/pluginIpc';
import type { AdapterContribution, FsReadPermission, PermissionGrant } from '../src/shared/adapter-sdk/types';
import { permissionDeclHash } from '../src/shared/adapter-sdk/policy';

const kbState = vi.hoisted(() => {
  const box: {
    plugins: AdapterPluginDto[];
    written: { pluginId: string; adapterId: string; permissionId: string; decision: 'granted' | 'denied'; rootIds?: string[] | 'all' }[];
  } = { plugins: [], written: [] };
  return {
    box,
    listRoots: async () => [
      { id: 'root-a', workspaceRootId: 'root-a', sourceId: 'root-a', name: 'A', path: '/tmp/a', resourceId: 'res-a', status: 'ok' as const, createdAt: 0, kind: 'folder' as const },
    ],
    listAdapterPlugins: async () => box.plugins,
    setAdapterPluginEnabled: async (id: string, on: boolean) => {
      box.plugins = box.plugins.map((p) => (p.id === id ? { ...p, enabled: on } : p));
    },
    setPermissionGrant: async (g: (typeof box.written)[number]) => {
      box.written.push(g);
      return { ...g, declHash: g.decision === 'denied' ? 'denied-hash' : 'from-main', decidedAt: 2 };
    },
  };
});

vi.mock('../src/renderer/kb', () => ({
  kb: {
    listRoots: () => kbState.listRoots(),
    listAdapterPlugins: () => kbState.listAdapterPlugins(),
    setAdapterPluginEnabled: (id: string, on: boolean) => kbState.setAdapterPluginEnabled(id, on),
    setPermissionGrant: (g: (typeof kbState.box.written)[number]) => kbState.setPermissionGrant(g),
  },
}));

import { pluginHost } from '../src/renderer/plugin-host/host';
import { askPermissionDialog } from '../src/renderer/ui/adapterDialogs';
import { DialogHost, dialogs } from '../src/renderer/ui/dialogs';

const PID = 'test.notes';
const AID = 'test.notes.reader';
const perm: FsReadPermission = { id: 'read', kind: 'fs.read', scope: 'ask-per-root', extensions: ['note'], reason: '读取 .note 笔记' };
const adapter: AdapterContribution = {
  id: AID,
  title: '笔记',
  sourceKinds: ['file'],
  displayMode: 'in-app-reader',
  match: { file: { extensions: ['note'] }, priority: 100 },
  permissions: [perm],
  stateSchemaVersion: 1,
};

function grant(decision: 'granted' | 'denied', extra: Partial<PermissionGrant> = {}): PermissionGrant {
  return {
    pluginId: PID,
    adapterId: AID,
    permissionId: perm.id,
    decision,
    declHash: decision === 'denied' ? '*' : permissionDeclHash(perm),
    decidedAt: 1,
    ...(decision === 'granted' ? { rootIds: ['root-a'] } : {}),
    ...extra,
  };
}

function dto(grants: PermissionGrant[], enabled = true): AdapterPluginDto {
  return {
    id: PID,
    name: '笔记',
    version: '0.1.0',
    source: 'dev',
    manifest: {
      id: PID,
      name: '笔记',
      version: '0.1.0',
      engines: { workbench: '^0.2.0', adapterApi: '^0.1.0' },
      main: 'dist/index.js',
      sandbox: 'iframe',
      contributes: { adapters: [adapter] },
    },
    errors: [],
    enabled,
    installedAt: 1,
    grants,
    storageBytes: 0,
    storageKeys: 0,
    mainUrl: 'kbplugin://test.notes/dist/index.js',
  };
}

function load(grants: PermissionGrant[], enabled = true) {
  const plugin = dto(grants, enabled);
  kbState.box.plugins = [plugin];
  pluginHost.loadSandboxed(kbState.box.plugins);
  return plugin;
}

const originalAsk = pluginHost.askAdapterPermission;

beforeEach(() => {
  kbState.box.written.length = 0;
  kbState.box.plugins = [];
});

afterEach(async () => {
  pluginHost.loadSandboxed([]);
  dialogs.dismissCustom();
  pluginHost.askAdapterPermission = originalAsk;
  kbState.box.plugins = [];
  await new Promise((r) => setTimeout(r, 0));
  kbState.box.written.length = 0;
});

describe('插件权限询问：取消不写库，拒绝才写 denied', () => {
  it('重新询问时取消（Esc、点背景、关闭的 cancel 值），已允许的授权保持不变', async () => {
    const kept = grant('granted');
    load([kept]);
    pluginHost.askAdapterPermission = askPermissionDialog;
    const pending = pluginHost.ensurePermission(PID, adapter, perm, true);
    await vi.waitFor(() => expect(dialogs.customTestIds()).toContain('perm-dialog'));
    const html = renderToStaticMarkup(createElement(DialogHost));
    expect(html).toContain('data-testid="perm-dialog"');
    expect(html).toContain('data-testid="perm-deny"');
    // DialogHost 点背景和 Esc 都用 cancelValue 结束；这里走同一条 closeCustom。
    expect(dialogs.customTestIds()).toEqual(['perm-dialog']);
    dialogs.dismissCustom('perm-dialog');
    await expect(pending).resolves.toBe('granted');
    expect(kbState.box.written).toEqual([]);
    expect(pluginHost.grantsOf(PID)).toEqual([kept]);
    expect(pluginHost.decision(PID, AID, perm)).toBe('granted');
    expect(renderToStaticMarkup(createElement(DialogHost))).not.toContain('perm-dialog');
  });

  it('重新询问已拒绝的记录时取消，拒绝记录保持不变', async () => {
    const kept = grant('denied');
    load([kept]);
    pluginHost.askAdapterPermission = async () => 'cancel';
    await expect(pluginHost.ensurePermission(PID, adapter, perm, true)).resolves.toBe('denied');
    expect(kbState.box.written).toEqual([]);
    expect(pluginHost.grantsOf(PID)).toEqual([kept]);
    expect(pluginHost.decision(PID, AID, perm)).toBe('denied');
  });

  it('第一次询问时取消，不写 denied，下次还会再问', async () => {
    load([]);
    let asks = 0;
    pluginHost.askAdapterPermission = async () => {
      asks += 1;
      return 'cancel';
    };
    await expect(pluginHost.ensurePermission(PID, adapter, perm, false)).resolves.toBe('prompt');
    expect(kbState.box.written).toEqual([]);
    expect(pluginHost.grantsOf(PID)).toEqual([]);
    expect(pluginHost.decision(PID, AID, perm)).toBe('prompt');
    await expect(pluginHost.ensurePermission(PID, adapter, perm, false)).resolves.toBe('prompt');
    expect(asks).toBe(2);
    expect(kbState.box.written).toEqual([]);
  });

  it('明确点拒绝才写入 denied', async () => {
    const kept = grant('granted');
    load([kept]);
    pluginHost.askAdapterPermission = async () => 'deny';
    await expect(pluginHost.ensurePermission(PID, adapter, perm, true)).resolves.toBe('denied');
    expect(kbState.box.written).toEqual([{ pluginId: PID, adapterId: AID, permissionId: perm.id, decision: 'denied' }]);
    expect(pluginHost.decision(PID, AID, perm)).toBe('denied');
  });

  it('点允许仍写入 granted', async () => {
    load([]);
    pluginHost.askAdapterPermission = async () => ({ grant: true, rootIds: ['root-a'] });
    await expect(pluginHost.ensurePermission(PID, adapter, perm, false)).resolves.toBe('granted');
    expect(kbState.box.written).toEqual([{ pluginId: PID, adapterId: AID, permissionId: perm.id, decision: 'granted', rootIds: ['root-a'] }]);
  });

  it('权限框开着时停用插件：关掉该框，不写入任何决定，别的对话框还在', async () => {
    const kept = grant('granted');
    load([kept]);
    pluginHost.askAdapterPermission = askPermissionDialog;
    const other = dialogs.custom({ title: '别的', testid: 'other-dialog', cancelValue: 'leave', render: () => null });
    const pending = pluginHost.ensurePermission(PID, adapter, perm, true);
    await vi.waitFor(() => expect(dialogs.customTestIds()).toEqual(['other-dialog', 'perm-dialog']));
    expect(renderToStaticMarkup(createElement(DialogHost))).toContain('data-testid="other-dialog"');
    await pluginHost.setEnabled(PID, false);
    await expect(pending).resolves.toBe('granted');
    expect(kbState.box.written).toEqual([]);
    expect(pluginHost.grantsOf(PID)).toEqual([kept]);
    expect(pluginHost.get(PID)?.status).toBe('disabled');
    expect(dialogs.customTestIds()).toEqual(['other-dialog']);
    expect(renderToStaticMarkup(createElement(DialogHost))).not.toContain('perm-dialog');
    dialogs.dismissCustom('other-dialog');
    await expect(other).resolves.toBe('leave');
  });

  it('停用之后权限框即使回报允许，也不写入', async () => {
    const kept = grant('granted');
    load([kept]);
    let opened = false;
    pluginHost.askAdapterPermission = (_req, opts) =>
      new Promise((resolve) => {
        opened = true;
        const finish = () => resolve('grant');
        if (opts?.signal?.aborted) finish();
        else opts?.signal?.addEventListener('abort', finish);
      });
    const pending = pluginHost.ensurePermission(PID, adapter, perm, true);
    await vi.waitFor(() => expect(opened).toBe(true));
    await pluginHost.setEnabled(PID, false);
    await expect(pending).resolves.toBe('granted');
    expect(kbState.box.written).toEqual([]);
    expect(pluginHost.grantsOf(PID)).toEqual([kept]);
  });
});
