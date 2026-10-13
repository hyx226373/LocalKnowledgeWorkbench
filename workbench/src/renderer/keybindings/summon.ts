/**
 * 呼出规则（B7 · 长文）：对「打开/呼出某面板或资料」类命令统一：
 * 1. 已开 → 置前；
 * 2. 已收起（气泡/最小化）→ 恢复；
 * 3. 已关闭 → 重开（保留上次阅读状态若可）；
 * 4. 跨工作区 → 先切换工作区并处理未保存，再呼出。
 *
 * B 负责文档化；相关内置命令接线见 registerWorkbenchKeyCommands。
 */
export type SummonPhase = 'focus' | 'restore' | 'reopen' | 'switchWorkspace';

export interface SummonContext {
  /** 面板是否已在当前工作区打开 */
  isOpen: boolean;
  /** 是否收起为气泡 */
  isCollapsed: boolean;
  /** 目标是否在其他工作区（由调用方判断） */
  needsWorkspaceSwitch: boolean;
  /** 当前工作区是否有未保存 */
  hasUnsaved?: boolean;
}

export interface SummonPlan {
  phase: SummonPhase;
  /** 人类可读说明 */
  note: string;
}

export function planSummon(ctx: SummonContext): SummonPlan {
  if (ctx.needsWorkspaceSwitch) {
    return {
      phase: 'switchWorkspace',
      note: ctx.hasUnsaved ? '先处理未保存并切换工作区，再呼出' : '先切换工作区，再呼出',
    };
  }
  if (ctx.isCollapsed) {
    return { phase: 'restore', note: '已收起 → 恢复' };
  }
  if (ctx.isOpen) {
    return { phase: 'focus', note: '已开 → 置前' };
  }
  return { phase: 'reopen', note: '已关闭 → 重开（保留阅读状态若可）'};
}

/** 对活动面板执行置前/恢复（供 panel.* 命令使用） */
export function applySummonToPanel(pm: {
  isCollapsed(id: string): boolean;
  restoreFromBubble(id: string): void;
  focus?(id: string): void;
  bringToFront?(id: string): void;
}, panelId: string): SummonPhase {
  if (pm.isCollapsed(panelId)) {
    pm.restoreFromBubble(panelId);
    return 'restore';
  }
  if (typeof pm.bringToFront === 'function') pm.bringToFront(panelId);
  else if (typeof pm.focus === 'function') pm.focus(panelId);
  return 'focus';
}

export const SUMMON_RULES_DOC = `呼出规则（第 11 轮琴键组）：
1. 已开 → 置前（activate / bringToFront）
2. 已收起（气泡）→ restoreFromBubble
3. 已关闭 → 按原 resourceId/adapter 重开，阅读状态由 schema 4 条目状态恢复
4. 跨工作区 → switchTo(workspaceId)（未保存走现有 flush/确认），再执行 1–3
不注册 globalShortcut；系统级呼出见设置页独立子分组。`;
