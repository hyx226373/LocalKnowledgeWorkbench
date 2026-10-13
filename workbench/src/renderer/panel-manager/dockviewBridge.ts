/**
 * dockview 内部对象的唯一入口。DockviewApi 没有公开浮动窗口的 overlay（位置/显隐/层级），
 * 但 DockviewComponent 上有公开 getter：floatingGroups / getFloatingWindowForGroup / getFloatingContainer。
 * DockviewApi 把 component 存为私有字段，这里在运行时取出并逐项校验；dockview 升级后若这些接口变化，
 * attach 时立即抛出明确错误（单元测试与 e2e 会失败），而不是静默错位。已核对版本：dockview-core 8.4.0。
 */
import type { DockviewApi, DockviewGroupPanel } from 'dockview-react';

export interface OverlayLike {
  readonly element: HTMLElement;
  readonly isVisible: boolean;
  setBounds(b: Partial<{ left: number; top: number; width: number; height: number }>): void;
  setVisible(v: boolean): void;
  bringToFront(): void;
}
export interface FloatingWindowLike {
  readonly group: DockviewGroupPanel;
  readonly overlay: OverlayLike;
}
export interface DockviewBridge {
  floats(): readonly FloatingWindowLike[];
  windowOf(group: DockviewGroupPanel): FloatingWindowLike | undefined;
  container(): HTMLElement;
}

export const VERIFIED_DOCKVIEW = '8.4.0';

export function bridge(api: DockviewApi): DockviewBridge {
  const comp = (api as unknown as { component?: Record<string, unknown> }).component as
    | { floatingGroups: readonly FloatingWindowLike[]; getFloatingWindowForGroup(g: DockviewGroupPanel): FloatingWindowLike | undefined; getFloatingContainer(): HTMLElement }
    | undefined;
  const ok = !!comp && 'floatingGroups' in comp && typeof comp.getFloatingWindowForGroup === 'function' && typeof comp.getFloatingContainer === 'function';
  if (!ok) throw new Error(`dockview 内部接口变化：floatingGroups / getFloatingWindowForGroup / getFloatingContainer 不可用（已核对 ${VERIFIED_DOCKVIEW}；升级 dockview 后请更新 src/renderer/panel-manager/dockviewBridge.ts）`);
  return {
    floats: () => comp!.floatingGroups,
    windowOf: (g) => comp!.getFloatingWindowForGroup(g),
    container: () => comp!.getFloatingContainer(),
  };
}
