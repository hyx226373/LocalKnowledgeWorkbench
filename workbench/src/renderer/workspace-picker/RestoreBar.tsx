/**
 * 进入后的恢复条。只放失败、找不到、等待手动打开的面板。
 * 关掉一条只藏提示，不关面板，不删条目。
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { readRestoreBarVisible, subscribeRestoreBarVisible } from '../settings/restoreBarVisible';
import {
  createRestoreFeed,
  restorePanelKey,
  type RestoreBarRow,
  type RestoreFeedInput,
  type RestoreFeedPorts,
  type RestorePanelRef,
} from './restoreFeed';
import { hiddenByDismiss, restoreBarFacts, restoreRetryTarget, type RestoreDismissed } from './restoreBarModel';

export interface RestoreBarProps {
  workspaceId: string;
  panels: readonly RestorePanelRef[];
  ports?: RestoreFeedPorts;
  retryPanel?: RestoreFeedInput['retryPanel'];
  /** 点整条（不是重试按钮）时打开已收起的面板。 */
  onActivate?: (panelId: string) => void;
  dismissed?: RestoreDismissed;
  onDismiss?: (panelId: string, problemKey: string) => void;
  onClear?: (entries: readonly { panelId: string; problemKey: string }[]) => void;
}

const KIND_LABEL: Record<string, string> = {
  file: '文件',
  web: '网页',
  app: '应用',
  'native-host': '本机',
  unknown: '面板',
};

function visibleLabel(row: RestoreBarRow): string {
  const title = row.title?.trim();
  if (title && title !== 'unknown') return title;
  return row.event.panelId;
}

export function RestoreBar({ workspaceId, panels, ports, retryPanel, onActivate, dismissed, onDismiss, onClear }: RestoreBarProps) {
  const barOn = useSyncExternalStore(subscribeRestoreBarVisible, readRestoreBarVisible, readRestoreBarVisible);
  const retryRef = useRef(retryPanel);
  retryRef.current = retryPanel;
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const panelKey = restorePanelKey(panels);
  const feed = useMemo(
    () =>
      createRestoreFeed({
        workspaceId,
        panels,
        ports,
        retryPanel: (id, panelId) => retryRef.current?.(id, panelId),
      }),
    [workspaceId, panelKey, ports],
  );
  const snapshot = useSyncExternalStore(feed.subscribe, feed.getSnapshot, feed.getSnapshot);
  useEffect(() => () => feed.dispose(), [feed]);
  if (!workspaceId || !barOn) return null;
  const kept = snapshot.rows.flatMap((row) => {
    const facts = restoreBarFacts({
      kind: row.kind,
      phase: row.event.phase,
      reason: row.event.reason,
      retryable: row.event.retryable,
      file: row.file,
    });
    if (!facts.show) return [];
    if (hiddenByDismiss(dismissed ?? {}, row.event.panelId, facts.problemKey)) return [];
    return [{ row, facts }];
  });
  if (kept.length === 0) return null;
  return (
    <div className="kb-ws-restore" data-testid="ws-restore" data-workspace-id={snapshot.workspaceId}>
      <button
        type="button"
        className="kb-ws-restore-clear"
        data-testid="ws-restore-clear"
        onClick={() => onClear?.(kept.map((item) => ({ panelId: item.row.event.panelId, problemKey: item.facts.problemKey })))}
      >
        全部清除
      </button>
      {kept.map(({ row, facts }) => (
        <RestoreSlot
          key={row.event.panelId}
          row={row}
          reasonText={facts.reasonText}
          retryTitle={facts.retryTitle}
          retryable={facts.retryable}
          locate={facts.locate}
          remap={facts.remap}
          switchWorkspaceId={facts.switchWorkspaceId}
          onRetry={() => {
            const target = restoreRetryTarget(facts);
            if (target === 'open') portsRef.current?.openPanel?.(row.event.panelId);
            else if (target === 'retry') feed.retryPanel(row.event.panelId);
          }}
          onOpen={() => feed.openApp(row.event.panelId)}
          onActivate={() => onActivate?.(row.event.panelId)}
          onDismiss={() => onDismiss?.(row.event.panelId, facts.problemKey)}
          onLocate={() => portsRef.current?.locateFile?.(row.event.panelId)}
          onRemap={() => portsRef.current?.remapFile?.(row.event.panelId)}
          onSwitch={() => {
            if (facts.switchWorkspaceId) portsRef.current?.switchWorkspace?.(facts.switchWorkspaceId);
          }}
        />
      ))}
    </div>
  );
}

function RestoreSlot({
  row,
  reasonText,
  retryTitle,
  retryable,
  locate,
  remap,
  switchWorkspaceId,
  onRetry,
  onOpen,
  onActivate,
  onDismiss,
  onLocate,
  onRemap,
  onSwitch,
}: {
  row: RestoreBarRow;
  reasonText: string;
  retryTitle: string;
  retryable: boolean;
  locate: boolean;
  remap: boolean;
  switchWorkspaceId: string;
  onRetry: () => void;
  onOpen: () => void;
  onActivate: () => void;
  onDismiss: () => void;
  onLocate: () => void;
  onRemap: () => void;
  onSwitch: () => void;
}) {
  const native = row.event.host;
  return (
    <div
      className="kb-ws-restore-panel"
      data-panel-id={row.event.panelId}
      data-kind={row.kind}
      data-phase={row.event.phase}
      data-reason={reasonText || row.event.reason || ''}
      onClick={onActivate}
    >
      <span className="kb-ws-restore-label">{visibleLabel(row)}</span>
      <span className="kb-ws-restore-kind">{KIND_LABEL[row.kind] ?? '面板'}</span>
      {reasonText ? <span className="kb-ws-restore-reason">{reasonText}</span> : null}
      {native ? (
        <span className="kb-ws-restore-host" data-layout={native.layout} data-attach={native.attach} data-document={native.document}>
          {`layout ${native.layout} attach ${native.attach} document ${native.document}`}
        </span>
      ) : null}
      {locate ? (
        <button type="button" className="kb-ws-restore-open" data-testid="ws-restore-locate" onClick={(e) => { e.stopPropagation(); onLocate(); }}>
          在磁盘中定位
        </button>
      ) : null}
      {remap ? (
        <button type="button" className="kb-ws-restore-open" data-testid="ws-restore-remap" onClick={(e) => { e.stopPropagation(); onRemap(); }}>
          重新映射
        </button>
      ) : null}
      {switchWorkspaceId ? (
        <button type="button" className="kb-ws-restore-open" data-testid="ws-restore-switch" onClick={(e) => { e.stopPropagation(); onSwitch(); }}>
          切到包含这个根的工作区
        </button>
      ) : null}
      {row.showOpen ? (
        <button type="button" className="kb-ws-restore-open" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
          打开
        </button>
      ) : null}
      <button
        type="button"
        className="kb-ws-restore-retry"
        data-retryable={retryable ? 'true' : 'false'}
        disabled={!retryable}
        title={retryTitle || undefined}
        onClick={(e) => { e.stopPropagation(); if (retryable) onRetry(); }}
      >
        重试
      </button>
      <button type="button" className="kb-ws-restore-dismiss" data-testid="ws-restore-dismiss" aria-label="关闭这条提示" onClick={(e) => { e.stopPropagation(); onDismiss(); }}>
        ×
      </button>
    </div>
  );
}
