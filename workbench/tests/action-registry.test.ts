import { describe, expect, it } from 'vitest';
import type { CommandContribution } from '../src/renderer/plugin-host/types';
import { commands } from '../src/renderer/plugin-host/registry';
import { emptyStore, listBoundAccelerators } from '../src/renderer/keybindings/store';
import { bridgeCapabilityDetails } from '../src/shared/actions/capabilityDetails';
import { installActionPackages } from '../src/shared/actions/install';
import { disposeSourcesPackage, registerSourcesPackage } from '../src/shared/actions/packages/sources';
import { actionGate, bridgeInvokableIds, getInvokeExecutor, listActions, registerActions } from '../src/shared/actions/registry';

installActionPackages();

interface ZoomCatalogEntry {
  actionId: string;
  title: string;
  source: string;
  bridgeInvokable: boolean;
  approvalRequired: false;
  argsSchema?: Record<string, unknown>;
  access: 'pending';
  intended: 'bridge' | 'ui' | 'name-only';
  trigger?: 'key' | 'wheel';
}

/** 冻结草案第 5 节。bridge 为 false 的 disk.* 不进能力明细。 */
const SOURCES_DRAFT: { id: string; approval: boolean; bridge: boolean }[] = [
  { id: 'source.add.folder', approval: true, bridge: true },
  { id: 'source.add.file', approval: true, bridge: true },
  { id: 'source.add.web', approval: true, bridge: true },
  { id: 'source.remove', approval: true, bridge: true },
  { id: 'source.filter.set', approval: true, bridge: true },
  { id: 'source.remap.preview', approval: false, bridge: true },
  { id: 'source.remap.apply', approval: true, bridge: true },
  { id: 'catalog.create', approval: false, bridge: true },
  { id: 'catalog.rename', approval: false, bridge: true },
  { id: 'catalog.delete', approval: true, bridge: true },
  { id: 'catalog.switch', approval: false, bridge: true },
  { id: 'catalog.folder.create', approval: false, bridge: true },
  { id: 'catalog.folder.rename', approval: false, bridge: true },
  { id: 'catalog.folder.delete', approval: false, bridge: true },
  { id: 'catalog.folder.move', approval: false, bridge: true },
  { id: 'catalog.ref.add', approval: false, bridge: true },
  { id: 'catalog.ref.remove', approval: false, bridge: true },
  { id: 'catalog.export', approval: false, bridge: true },
  { id: 'catalog.import', approval: false, bridge: true },
  { id: 'disk.mkdir', approval: true, bridge: false },
  { id: 'disk.move', approval: true, bridge: false },
  { id: 'disk.copy', approval: true, bridge: false },
  { id: 'disk.trash', approval: true, bridge: false },
  { id: 'disk.write', approval: true, bridge: false },
];

const BUILTIN_BRIDGE_IDS = ['index.showHealth', 'workbench.pendingPlans'];
const WEB_SITE_IDS = ['web.allowAllBlocked', 'web.allowSite', 'web.neverBlock', 'web.revokeSite'];
const APP_UPDATE_IDS = ['app.checkUpdate', 'app.installUpdate', 'app.rollbackUpdate'];

function bridgeIdsWithSources(): string[] {
  return [...SOURCES_DRAFT.filter((row) => row.bridge).map((row) => row.id), ...BUILTIN_BRIDGE_IDS, ...WEB_SITE_IDS, ...APP_UPDATE_IDS].sort();
}

function bridgeIdsWithoutSources(): string[] {
  return [...BUILTIN_BRIDGE_IDS, ...WEB_SITE_IDS, ...APP_UPDATE_IDS].sort();
}

const DETAIL_FIELDS = ['name', 'description', 'params', 'availability', 'approvalRequired', 'resultSchema'] as const;

const ZOOM_CATALOG: ZoomCatalogEntry[] = [
  { actionId: 'view.contentZoomIn', title: '内容放大', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomOut', title: '内容缩小', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomReset', title: '内容缩放重置', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomFit', title: '内容适应窗口', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge' },
  { actionId: 'view.contentZoomSet', title: '设置内容比例', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'bridge', argsSchema: { type: 'object', required: ['scale'] } },
  { actionId: 'view.contentZoomWheel', title: '滚轮缩放阅读内容', source: 'zoom', bridgeInvokable: false, approvalRequired: false, access: 'pending', intended: 'ui', trigger: 'wheel' },
];

describe('操作登记表', () => {
  it('内置两条仍可调用，sources 已在运行包里', () => {
    expect(bridgeInvokableIds()).toEqual(bridgeIdsWithSources());
    expect(actionGate('workbench.pendingPlans').bridgeInvokable).toBe(true);
    expect(actionGate('workbench.pendingPlans').approvalRequired).toBe(false);
    expect(typeof getInvokeExecutor('index.showHealth')).toBe('function');
    expect(actionGate('console.openItem').bridgeInvokable).toBe(false);
    expect(actionGate('console.openGroup').bridgeInvokable).toBe(false);
    expect(listActions().some((row) => row.packageId === 'zoom' || row.packageId === 'zoom-catalog')).toBe(false);
    const details = bridgeCapabilityDetails();
    const names = details.map((row) => row.name);
    expect(names).toContain('workbench.pendingPlans');
    expect(names).toContain('index.showHealth');
    expect(names).toContain('source.add.folder');
    expect(names).toContain('catalog.ref.add');
    expect(names.some((name) => name.startsWith('view.contentZoom'))).toBe(false);
    expect(names.some((name) => name.startsWith('disk.'))).toBe(false);
    const filter = details.find((item) => item.name === 'source.filter.set');
    expect(filter?.approvalRequired).toBe(true);
    expect(filter?.availability).toBe('unavailable');
  });

  it('命令登记收下 trigger wheel，且不进加速键列表', () => {
    const wheel: CommandContribution = {
      id: 'view.contentZoomWheel',
      title: '滚轮缩放阅读内容',
      category: '视图',
      keybinding: 'Ctrl+Wheel',
      when: 'global',
      trigger: 'wheel',
      run: () => undefined,
    };
    const others: CommandContribution[] = [
      { id: 'view.contentZoomIn', title: '内容放大', category: '视图', keybinding: 'Ctrl+=', when: 'global', trigger: 'key', run: () => undefined },
      { id: 'view.contentZoomOut', title: '内容缩小', category: '视图', keybinding: 'Ctrl+-', when: 'global', trigger: 'key', run: () => undefined },
      { id: 'view.contentZoomReset', title: '内容缩放重置', category: '视图', keybinding: 'Ctrl+0', when: 'global', trigger: 'key', run: () => undefined },
      { id: 'view.contentZoomFit', title: '内容适应窗口', category: '视图', when: 'global', trigger: 'key', run: () => undefined },
      { id: 'view.contentZoomSet', title: '设置内容比例', category: '视图', when: 'global', trigger: 'key', run: () => undefined },
    ];
    const disposables = [wheel, ...others].map((command) => commands.register('zoom-fixture', command));
    const undoCatalog = registerActions('zoom-catalog', ZOOM_CATALOG);
    try {
      expect(actionGate('view.contentZoomWheel').action?.trigger).toBe('wheel');
      expect(actionGate('view.contentZoomWheel').bridgeInvokable).toBe(false);
      expect(listActions().some((row) => row.actionId === 'view.contentZoomFit' && row.source === 'zoom')).toBe(true);
      const keys = listBoundAccelerators([wheel, ...others], emptyStore());
      expect(keys.map((row) => row.commandId)).toEqual(['view.contentZoomIn', 'view.contentZoomOut', 'view.contentZoomReset']);
    } finally {
      undoCatalog();
      for (const disposable of disposables) disposable.dispose();
    }
    expect(actionGate('view.contentZoomWheel').known).toBe(false);
    expect(bridgeInvokableIds()).toEqual(bridgeIdsWithSources());
  });

  it('sources 包按草案登记，需要批准的不标 available', () => {
    expect(listActions().some((row) => row.packageId === 'sources')).toBe(true);
    try {
      const registered = listActions().filter((row) => row.packageId === 'sources').map((row) => row.actionId).sort();
      expect(registered).toEqual(SOURCES_DRAFT.map((row) => row.id).sort());
      const details = bridgeCapabilityDetails();
      for (const row of SOURCES_DRAFT) {
        const gate = actionGate(row.id);
        expect(gate.known).toBe(true);
        expect(gate.bridgeInvokable).toBe(row.bridge);
        expect(gate.approvalRequired).toBe(row.approval);
        expect(gate.action?.packageId).toBe('sources');
        expect(gate.action?.source).toBe('sources');
        expect(getInvokeExecutor(row.id)).toBeUndefined();
        const detail = details.find((item) => item.name === row.id);
        if (!row.bridge) {
          expect(detail).toBeUndefined();
          continue;
        }
        expect(detail).toBeTruthy();
        for (const field of DETAIL_FIELDS) expect(detail).toHaveProperty(field);
        expect(detail?.approvalRequired).toBe(row.approval);
        expect(detail?.availability).toBe('unavailable');
        expect(typeof detail?.description).toBe('string');
        expect((detail?.description ?? '').length).toBeGreaterThan(0);
        expect(detail?.params).toEqual(expect.any(Object));
        expect(detail?.resultSchema).toEqual({ type: 'object', required: ['actionId', 'commandId'] });
      }
      const params = (name: string) => details.find((item) => item.name === name)?.params as { required?: string[]; properties?: Record<string, unknown> };
      expect(params('source.add.folder').required).toEqual(['name', 'extensions']);
      expect(params('source.filter.set').required).toEqual(['sourceId', 'extensions']);
      expect(params('source.remap.preview').required).toEqual(['sourceId', 'newLocation']);
      expect(params('catalog.ref.add').required).toEqual(['catalogId', 'folderId', 'resourceId']);
      expect(params('catalog.ref.add').properties?.folderId).toEqual({ type: ['string', 'null'] });
      expect(bridgeInvokableIds()).toEqual(bridgeIdsWithSources());
      disposeSourcesPackage();
      expect(actionGate('source.filter.set').known).toBe(false);
      expect(actionGate('catalog.ref.add').known).toBe(false);
      expect(bridgeInvokableIds()).toEqual(bridgeIdsWithoutSources());
    } finally {
      registerSourcesPackage();
    }
    expect(listActions().some((row) => row.packageId === 'sources')).toBe(true);
    expect(bridgeInvokableIds()).toEqual(bridgeIdsWithSources());
  });

  it('任一包要求批准时，能力明细不标 available', () => {
    const undo = registerActions('r12-approval-overlay', [
      {
        actionId: 'workbench.pendingPlans',
        title: '待批准计划…',
        source: 'r12',
        bridgeInvokable: false,
        approvalRequired: true,
      },
    ]);
    try {
      const row = bridgeCapabilityDetails().find((item) => item.name === 'workbench.pendingPlans');
      expect(actionGate('workbench.pendingPlans').bridgeInvokable).toBe(true);
      expect(actionGate('workbench.pendingPlans').approvalRequired).toBe(true);
      expect(row?.approvalRequired).toBe(true);
      expect(row?.availability).toBe('unavailable');
    } finally {
      undo();
    }
    const row = bridgeCapabilityDetails().find((item) => item.name === 'workbench.pendingPlans');
    expect(row?.approvalRequired).toBe(false);
    expect(row?.availability).toBe('available');
    expect(bridgeInvokableIds()).toEqual(bridgeIdsWithSources());
  });

  it('更新三个 ActionId：检查可执行，安装和回滚只等人机批准', () => {
    expect(bridgeInvokableIds()).toEqual(expect.arrayContaining(APP_UPDATE_IDS));
    expect(actionGate('app.checkUpdate').approvalRequired).toBe(false);
    expect(actionGate('app.checkUpdate').bridgeInvokable).toBe(true);
    expect(typeof getInvokeExecutor('app.checkUpdate')).toBe('function');
    expect(actionGate('app.installUpdate').approvalRequired).toBe(true);
    expect(actionGate('app.rollbackUpdate').approvalRequired).toBe(true);
    expect(getInvokeExecutor('app.installUpdate')).toBeUndefined();
    expect(getInvokeExecutor('app.rollbackUpdate')).toBeUndefined();
    const details = bridgeCapabilityDetails();
    expect(details.find((row) => row.name === 'app.checkUpdate')?.availability).toBe('available');
    expect(details.find((row) => row.name === 'app.installUpdate')?.availability).not.toBe('available');
    expect(details.find((row) => row.name === 'app.rollbackUpdate')?.approvalRequired).toBe(true);
  });
});
