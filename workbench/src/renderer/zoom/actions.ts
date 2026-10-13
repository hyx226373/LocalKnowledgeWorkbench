/**
 * 内容缩放命令。id 与 B 已登记的 view.contentZoomIn/Out/Reset 相同，when 改为 global。
 * 滚轮命令不走 keydown，由 wheelTrigger 读它的有效绑定。
 */
import type { CommandContribution, Disposable } from '../plugin-host/types';
import { commands } from '../plugin-host/registry';
import { runContentZoom } from './registry';

export function registerContentZoomCommands(
  register: (c: CommandContribution) => Disposable = (c) => commands.register('builtin.workbench', c),
): Disposable[] {
  const ds: Disposable[] = [];
  const reg = (c: CommandContribution) => ds.push(register(c));
  reg({
    id: 'view.contentZoomIn',
    title: '内容放大',
    category: '视图',
    keybinding: 'Ctrl+=',
    when: 'global',
    trigger: 'key',
    run: () => runContentZoom(null, 'in'),
  });
  reg({
    id: 'view.contentZoomOut',
    title: '内容缩小',
    category: '视图',
    keybinding: 'Ctrl+-',
    when: 'global',
    trigger: 'key',
    run: () => runContentZoom(null, 'out'),
  });
  reg({
    id: 'view.contentZoomReset',
    title: '内容缩放重置',
    category: '视图',
    keybinding: 'Ctrl+0',
    when: 'global',
    trigger: 'key',
    run: () => runContentZoom(null, 'reset'),
  });
  reg({
    id: 'view.contentZoomFit',
    title: '内容适应窗口',
    category: '视图',
    when: 'global',
    trigger: 'key',
    run: () => runContentZoom(null, 'fit'),
  });
  reg({
    id: 'view.contentZoomSet',
    title: '设置内容比例',
    category: '视图',
    when: 'global',
    trigger: 'key',
    run: (...args: unknown[]) => {
      const a = (args[0] ?? {}) as { itemId?: string; scale?: number };
      return runContentZoom(a.itemId ?? null, 'set', { itemId: a.itemId, scale: a.scale });
    },
  });
  reg({
    id: 'view.contentZoomWheel',
    title: '滚轮缩放阅读内容',
    category: '视图',
    keybinding: 'Ctrl+Wheel',
    when: 'global',
    trigger: 'wheel',
    run: () => undefined,
  });
  return ds;
}
