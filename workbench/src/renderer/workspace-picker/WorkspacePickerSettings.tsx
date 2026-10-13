/**
 * 工作区启动设置。只通过 onChange 交出下一份设置，自己不写库。
 */
import { useState } from 'react';
import type { WorkspacePickerSettings as Settings } from '../../shared/workspacePicker/types';
import { withWorkspacePickerSettings } from '../../shared/workspacePicker/settings';
import { planSnapshotCacheDelete } from '../../shared/workspacePicker/snapshotCache';
import { QuickSwitchConflictNotice } from './QuickSwitch';
import type { QuickSwitchConflictReport } from './quickSwitchKey';
import { KbToggle } from '../settings/KbToggle';
import '../settings/settings-frame.css';

export function WorkspacePickerSettings({
  settings,
  workspaces,
  conflict,
  onChange,
  onClose,
  onReconfigure,
  onClearSnapshotCache,
  embedded = false,
}: {
  settings: Settings;
  workspaces: readonly { id: string; name: string }[];
  conflict?: QuickSwitchConflictReport | null;
  onChange(next: Settings): void;
  onClose(): void;
  onReconfigure(): void;
  /** 壳层若要删文件，只用这份相对文件名。本组件不扫描磁盘。 */
  onClearSnapshotCache?: (relativeNames: readonly string[]) => void;
  embedded?: boolean;
}) {
  const [clearPlan, setClearPlan] = useState<readonly string[] | null>(null);
  const selectedMissing =
    settings.startup === 'workspace' &&
    !!settings.startupWorkspaceId &&
    !workspaces.some((row) => row.id === settings.startupWorkspaceId);
  return (
    <div className={embedded ? 'kb-settings-embed' : 'kb-ws-quick-settings'} data-testid="ws-picker-settings" data-kb-overlay={embedded ? undefined : ''} data-startup={settings.startup} role={embedded ? 'region' : 'dialog'} aria-label="工作区启动设置" onMouseDown={embedded ? undefined : onClose}>
      <div className="kb-ws-quick-panel" onMouseDown={(event) => event.stopPropagation()}>
        <h2 className="kb-ws-quick-heading">工作区启动设置</h2>
        {conflict && conflict.parties.length > 0 ? <QuickSwitchConflictNotice conflict={conflict} onReconfigure={onReconfigure} /> : null}
        <fieldset className="kb-ws-quick-startup">
          <legend>启动时</legend>
          <label>
            <input type="radio" name="ws-picker-startup" value="last" checked={settings.startup === 'last'} onChange={() => onChange(withWorkspacePickerSettings(settings, { startup: 'last' }))} />
            继续上次
          </label>
          <label>
            <input
              type="radio"
              name="ws-picker-startup"
              value="overview"
              checked={settings.startup === 'overview'}
              onChange={() => onChange(withWorkspacePickerSettings(settings, { startup: 'overview' }))}
            />
            打开总览
          </label>
          <label>
            <input
              type="radio"
              name="ws-picker-startup"
              value="workspace"
              checked={settings.startup === 'workspace'}
              onChange={() => onChange(withWorkspacePickerSettings(settings, { startup: 'workspace' }))}
            />
            指定工作区
          </label>
        </fieldset>
        <label className="kb-ws-quick-field">
          指定工作区
          <select
            data-field="startup-workspace"
            value={settings.startupWorkspaceId ?? ''}
            onChange={(event) =>
              onChange(withWorkspacePickerSettings(settings, { startup: 'workspace', startupWorkspaceId: event.target.value || null }))
            }
          >
            <option value="">未选择，将继续上次</option>
            {workspaces.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        {selectedMissing ? <p className="kb-ws-quick-hint">指定的工作区不在列表中，启动时改为继续上次。</p> : null}
        <div className="kb-set-row" data-field="overview-hidden">
          <div>
            <b>总览保持关闭</b>
            <p>启动方式为打开总览时，改为继续上次。</p>
          </div>
          <KbToggle
            testId="ws-overview-hidden"
            label="总览保持关闭"
            checked={settings.overviewHidden}
            onChange={(next) => onChange(withWorkspacePickerSettings(settings, { overviewHidden: next }))}
          />
        </div>
        <div className="kb-set-row" data-field="snapshot-enabled">
          <div>
            <b>本地快照</b>
            <p>只是总览缓存，不作为布局恢复依据。关闭后不采集。</p>
          </div>
          <KbToggle
            testId="ws-snapshot-enabled"
            label="本地快照"
            checked={settings.snapshotEnabled !== false}
            onChange={(next) => onChange(withWorkspacePickerSettings(settings, { snapshotEnabled: next }))}
          />
        </div>
        <div className="kb-ws-quick-actions">
          <button
            type="button"
            data-action="clear-snapshot-cache"
            data-scans-disk="false"
            onClick={() => {
              const relativeNames = planSnapshotCacheDelete(workspaces.map((row) => row.id));
              onClearSnapshotCache?.(relativeNames);
              setClearPlan(relativeNames);
            }}
          >
            清除快照缓存
          </button>
        </div>
        {clearPlan ? (
          <p className="kb-ws-quick-hint" data-field="snapshot-clear-plan">
            {clearPlan.length === 0 ? '没有可清除的快照文件名。未扫描磁盘。' : `计划清除 ${clearPlan.length} 个相对文件名，未扫描磁盘。`}
          </p>
        ) : null}
        <p className="kb-ws-quick-hint">没有已保存工作区时仍显示欢迎页，不会创建默认工作区。</p>
        <div className="kb-ws-quick-actions">
          <button type="button" data-action="reconfigure" onClick={onReconfigure}>
            重新配置快捷键
          </button>
          {!embedded && (
            <button type="button" data-action="close-settings" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}