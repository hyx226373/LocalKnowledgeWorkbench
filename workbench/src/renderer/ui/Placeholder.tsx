/**
 * 统一占位（H6）：所有 SDK PlaceholderKind 都走这里，文案与动作来自 SDK placeholderFor（同一份规范）。
 * 面板布局、条目与状态原样保留；可用后自动恢复。没有处理函数的动作显示为禁用（P2/P3 才开放）。
 */
import React from 'react';
import { DISPLAY_MODE_FACTS, placeholderFor } from '../../shared/adapter-sdk/policy';
import type { PlaceholderActionId, PlaceholderKind } from '../../shared/adapter-sdk/types';
import type { WorkspaceItem } from '../plugin-host/layoutModel';

export const ACTION_LABEL: Record<PlaceholderActionId, string> = {
  'install-plugin': '安装插件…',
  'enable-plugin': '启用插件',
  'review-permission': '查看权限…',
  'open-with-default': '用内置阅读器打开（仅本次）',
  'locate-program': '定位程序…',
  retry: '重试',
  'go-home': '回到首页',
  'open-in-system-browser': '用系统浏览器打开…',
  'remove-item': '从工作区移除',
};
const LATER: Partial<Record<PlaceholderActionId, string>> = {
  'locate-program': '程序位置只来自适配器声明的候选路径；请把程序安装到默认位置后点“重试”',
  'go-home': '条目已经是适配器首页',
  'open-in-system-browser': '只有 https 地址可以用系统浏览器打开',
};
const KIND_LABEL = { file: '文件', web: '网页', app: '本机应用' } as const;
/** 显示方式：与授权框、插件管理同一份 SDK 文案（DISPLAY_MODE_FACTS，如实命名：内嵌渲染 / 内嵌网页 / 外部窗口启动） */
const modeLabel = (m: keyof typeof DISPLAY_MODE_FACTS) => `${DISPLAY_MODE_FACTS[m].short}（${DISPLAY_MODE_FACTS[m].panelShows}）`;

export interface PlaceholderProps {
  kind: PlaceholderKind;
  item: WorkspaceItem;
  adapterId: string;
  pluginName?: string;
  detail?: string;
  /** 额外一行说明（例如文件相对路径） */
  meta?: string;
  actions: Partial<Record<PlaceholderActionId, () => void>>;
}

export function Placeholder(p: PlaceholderProps) {
  const info = placeholderFor(p.kind, { itemId: p.item.itemId, adapterId: p.adapterId, plugin: p.pluginName, detail: p.detail, sourceKind: p.item.sourceKind });
  // open-with-default 只有在确有可用的内置阅读器时才显示
  const actions = info.actions.filter((a) => a !== 'open-with-default' || p.actions['open-with-default']);
  return (
    <div className="kb-notice kb-placeholder" data-testid="placeholder" data-kind={p.kind} data-source-kind={p.item.sourceKind} data-adapter-id={p.adapterId} data-item-id={p.item.itemId}>
      <h2>{info.title}</h2>
      <div data-testid="placeholder-message">{info.message}</div>
      <div className="meta">
        来源：{KIND_LABEL[p.item.sourceKind]} · <span data-testid="placeholder-display-mode">显示方式：{modeLabel(p.item.displayMode)}</span> · 适配器：<code>{p.adapterId}</code>
        {p.item.sourceKind !== 'file' && <> · 引用：{p.item.ref}</>}
        {p.meta && <> · {p.meta}</>}
      </div>
      <div className="kb-placeholder-actions">
        {actions.map((a) => {
          const fn = p.actions[a];
          return (
            <button
              key={a}
              className={'kb-button' + (a === 'remove-item' ? ' kb-button--ghost' : a === actions[0] ? '' : ' kb-button--secondary')}
              data-testid={`placeholder-action-${a}`}
              disabled={!fn}
              title={!fn ? LATER[a] ?? '当前不可用' : undefined}
              onClick={() => fn?.()}
            >
              {a === 'enable-plugin' && p.adapterId === 'web.generic' ? '重新启用内置网页适配器' /* r11-A */ : ACTION_LABEL[a]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
