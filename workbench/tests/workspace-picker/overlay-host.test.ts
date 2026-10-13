import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  closeOverlayHost,
  openOverlayHost,
  overlayHostStatus,
  type OverlayHostPanel,
  type OverlayHostSession,
} from '../../src/renderer/workspace-picker/overlayHost';

type Call =
  | { type: 'listPanels'; workspaceId: string }
  | { type: 'setVisible'; id: string; args: { visible: boolean; forModal: true } }
  | { type: 'activate'; id: string; args: { focusHost: boolean } }
  | { type: 'detach'; id: string }
  | { type: 'kill'; id: string }
  | { type: 'attach'; id: string };

function fake(panels: readonly OverlayHostPanel[]) {
  const calls: Call[] = [];
  const port = {
    listPanels(workspaceId: string) {
      calls.push({ type: 'listPanels', workspaceId });
      return panels;
    },
    setVisible(id: string, args: { visible: boolean; forModal: true }) {
      calls.push({ type: 'setVisible', id, args });
    },
    activate(id: string, args: { focusHost: false }) {
      calls.push({ type: 'activate', id, args });
    },
    detach(id: string) {
      calls.push({ type: 'detach', id });
    },
    kill(id: string) {
      calls.push({ type: 'kill', id });
    },
    attach(id: string) {
      calls.push({ type: 'attach', id });
    },
  };
  return { calls, port };
}

const PANELS: OverlayHostPanel[] = [
  { id: 'vis', attached: true, visible: true, collapsed: false },
  { id: 'hid', attached: true, visible: false, collapsed: false },
  { id: 'col', attached: true, visible: true, collapsed: true },
  { id: 'off', attached: false, visible: true, collapsed: false },
];

function forbidden(calls: readonly Call[]) {
  expect(calls.some((call) => call.type === 'detach' || call.type === 'kill' || call.type === 'attach')).toBe(false);
}

describe('覆盖层托管端口', () => {
  it('只恢复原本可见的面板，隐藏或收起保持，恢复后不抢焦点', () => {
    const { calls, port } = fake(PANELS);
    const session = openOverlayHost(port, 'ws-1');
    expect(session).toEqual({ workspaceId: 'ws-1', panelIds: ['vis'] });
    expect(calls).toEqual([
      { type: 'listPanels', workspaceId: 'ws-1' },
      { type: 'setVisible', id: 'vis', args: { visible: false, forModal: true } },
    ]);
    calls.length = 0;
    closeOverlayHost(port, session, 'ws-1');
    expect(calls).toEqual([
      { type: 'setVisible', id: 'vis', args: { visible: true, forModal: true } },
      { type: 'activate', id: 'vis', args: { focusHost: false } },
    ]);
    expect(JSON.stringify(calls)).not.toContain('hid');
    expect(JSON.stringify(calls)).not.toContain('col');
    expect(JSON.stringify(calls)).not.toContain('off');
    forbidden(calls);
  });

  it('覆盖层里切换工作区后关闭，旧窗口零调用', () => {
    const { calls, port } = fake(PANELS);
    const session = openOverlayHost(port, 'ws-old');
    calls.length = 0;
    closeOverlayHost(port, session, 'ws-new');
    expect(calls).toEqual([]);
    forbidden(calls);
  });

  it('没有 detach、kill、attach，端口缺省时零调用', () => {
    const { calls, port } = fake(PANELS);
    expect(overlayHostStatus(undefined)).toBe('not-in-integ');
    expect(overlayHostStatus(null)).toBe('not-in-integ');
    expect(overlayHostStatus(port)).toBe('linked');
    expect(openOverlayHost(undefined, 'ws-1')).toBeNull();
    expect(openOverlayHost(null, 'ws-1')).toBeNull();
    const session: OverlayHostSession = { workspaceId: 'ws-1', panelIds: ['vis'] };
    closeOverlayHost(undefined, session, 'ws-1');
    closeOverlayHost(null, session, 'ws-1');
    closeOverlayHost(port, null, 'ws-1');
    expect(calls).toEqual([]);
    openOverlayHost(port, 'ws-1');
    forbidden(calls);
    const src = readFileSync(path.join(process.cwd(), 'src/renderer/workspace-picker/overlayHost.ts'), 'utf8');
    expect(src).not.toMatch(/\.detach\b/);
    expect(src).not.toMatch(/\.kill\b/);
    expect(src).not.toMatch(/\.attach\b/);
    expect(src).not.toContain('createWin32Helper');
    expect(src).not.toContain('kb-wt-host');
  });
});
