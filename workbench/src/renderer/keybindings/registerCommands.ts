/**
 * 琴键组登记/接线的工作台命令（B5 覆盖清单）。
 * 稳定 id = <领域>.<动作>；缩放 ≠ 面板尺寸。
 */
import type { Disposable } from '../plugin-host/types';
import type { PanelManager } from '../panel-manager/PanelManager';
import { applySummonToPanel, planSummon } from './summon';
import { openKeybindingsPage, resetAllUserKeybindings } from './runtime';

export interface KeyCommandHost {
  panelManager: PanelManager;
  /** 当前活动面板 id（非侧栏） */
  activePanelId(): string | null;
  /** 打开资料：已开置前 / 收起恢复 / 关闭重开 */
  openResource?(resourceId: string, title?: string): void | Promise<void>;
  /** 切换下一/上一标签 */
  cycleTab?(dir: 1 | -1): void;
  /** 内容缩放（阅读区/PDF），与面板尺寸分开 */
  contentZoom?(delta: number): void;
  /** 面板尺寸（浮动窗口宽高） */
  panelResize?(delta: number): void;
  /** 读写模式切换 */
  toggleEditMode?(): void;
  /** 关闭活动面板 */
  closeActive?(): void;
  getFocusMode?(): boolean;
}

function activeId(host: KeyCommandHost): string | null {
  return host.activePanelId();
}

export function registerKeybindingCommands(
  register: (c: {
    id: string;
    title: string;
    category?: string;
    keybinding?: string;
    when?: 'global' | 'editorFocus' | 'treeFocus' | 'webFocus';
    run(...args: unknown[]): unknown;
  }) => Disposable,
  host: KeyCommandHost,
): Disposable[] {
  const ds: Disposable[] = [];
  const reg = (c: Parameters<typeof register>[0]) => ds.push(register(c));

  reg({
    id: 'keybindings.open',
    title: '自定义快捷键…',
    category: '快捷键',
    // chord「Ctrl+K Ctrl+S」本轮不做；从命令面板 / 菜单 / 右键进入
    run: () => openKeybindingsPage(),
  });
  reg({
    id: 'keybindings.resetAll',
    title: '恢复全部快捷键默认',
    category: '快捷键',
    run: () => void resetAllUserKeybindings(),
  });

  // ---- 面板操作（呼出规则：收起则恢复）----
  reg({
    id: 'panel.float',
    title: '面板：浮动',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (!id) return;
      const pm = host.panelManager;
      if (pm.isCollapsed(id)) pm.restoreFromBubble(id);
      pm.float(id);
    },
  });
  reg({
    id: 'panel.dock',
    title: '面板：停靠',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (!id) return;
      const pm = host.panelManager;
      if (pm.isCollapsed(id)) pm.restoreFromBubble(id);
      pm.dock(id);
    },
  });
  reg({
    id: 'panel.maximize',
    title: '面板：最大化',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (!id) return;
      applySummonToPanel(host.panelManager, id);
      host.panelManager.maximize(id);
    },
  });
  reg({
    id: 'panel.restore',
    title: '面板：恢复（取消最大化）',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (!id) return;
      host.panelManager.restore(id);
    },
  });
  reg({
    id: 'panel.bubble.collapse',
    title: '面板：收起成气泡',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (id) host.panelManager.collapseToBubble(id);
    },
  });
  reg({
    id: 'panel.bubble.expand',
    title: '面板：从气泡恢复',
    category: '面板',
    run: () => {
      const id = activeId(host);
      if (id && host.panelManager.isCollapsed(id)) host.panelManager.restoreFromBubble(id);
      else {
        // 恢复托盘中第一个
        const b = host.panelManager.bubbles()[0];
        if (b) host.panelManager.restoreFromBubble(b.id);
      }
    },
  });
  reg({
    id: 'panel.close',
    title: '关闭面板',
    category: '面板',
    keybinding: 'Ctrl+W',
    run: () => host.closeActive?.(),
  });

  // ---- 标签 ----
  reg({
    id: 'tabs.next',
    title: '激活下一标签',
    category: '标签',
    keybinding: 'Ctrl+Tab',
    run: () => host.cycleTab?.(1),
  });
  reg({
    id: 'tabs.prev',
    title: '激活上一标签',
    category: '标签',
    keybinding: 'Ctrl+Shift+Tab',
    run: () => host.cycleTab?.(-1),
  });

  // 内容缩放在 zoom/actions.ts（when: global）。这里只留面板尺寸。
  reg({
    id: 'panel.size.increase',
    title: '面板尺寸增大',
    category: '面板',
    run: () => host.panelResize?.(1),
  });
  reg({
    id: 'panel.size.decrease',
    title: '面板尺寸减小',
    category: '面板',
    run: () => host.panelResize?.(-1),
  });

  // ---- 读写模式 ----
  reg({
    id: 'editor.toggleEditMode',
    title: '读写模式切换',
    category: '编辑',
    when: 'editorFocus',
    run: () => host.toggleEditMode?.(),
  });

  // ---- 打开资料（呼出规则接线）----
  reg({
    id: 'workbench.openResource',
    title: '打开资料',
    category: '工作台',
    run: () => {
      // 无参：由树焦点/选择决定；占位提示走命令面板参数后续
      const plan = planSummon({ isOpen: false, isCollapsed: false, needsWorkspaceSwitch: false });
      void plan;
      // 实际打开由调用方传入 resourceId；此处作为可绑定命令存在
    },
  });

  return ds;
}
