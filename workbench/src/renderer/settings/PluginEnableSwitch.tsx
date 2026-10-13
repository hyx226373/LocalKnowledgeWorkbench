/**
 * 插件启停胶囊开关：侧栏与插件管理页共用。
 * active/disabled → KbToggle；error/incompatible/denied → 轻量状态文案（不伪装成关）。
 * 不可禁用：锁定关开并说明原因。写入中 busy，失败由 host 真值回显。
 */
import React, { useRef, useState } from 'react';
import { pluginHost, type PluginStatus } from '../plugin-host/host';
import { KbToggle } from './KbToggle';

export const PLUGIN_STATUS_TEXT = {
  active: '已启用',
  disabled: '已禁用',
  incompatible: '不兼容',
  error: '出错',
  denied: '未授权',
} as const;

const LOCK_HINT = '内置核心插件，不可禁用';

export function PluginEnableSwitch({
  pluginId,
  name,
  status,
  canDisable,
  message,
  testId,
}: {
  pluginId: string;
  name?: string;
  status: PluginStatus;
  canDisable: boolean;
  message?: string;
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);

  if (status === 'incompatible' || status === 'error' || status === 'denied') {
    return (
      <span
        className="kb-plugin-status"
        data-status={status}
        data-testid={testId ? `${testId}-status` : undefined}
        title={message || PLUGIN_STATUS_TEXT[status]}
      >
        {PLUGIN_STATUS_TEXT[status]}
      </span>
    );
  }

  const checked = status === 'active';
  const locked = !canDisable;
  const label = name ? `${name}启用` : '启用插件';
  const title = locked ? message || LOCK_HINT : message || (checked ? '已启用，点按关闭' : '已禁用，点按开启');

  return (
    <KbToggle
      testId={testId}
      label={label}
      title={title}
      checked={checked}
      disabled={locked || busy}
      busy={busy}
      onChange={(next) => {
        if (writing.current || locked) return;
        if (next === checked) return;
        writing.current = true;
        setBusy(true);
        void pluginHost.setEnabled(pluginId, next).finally(() => {
          writing.current = false;
          setBusy(false);
        });
      }}
    />
  );
}
