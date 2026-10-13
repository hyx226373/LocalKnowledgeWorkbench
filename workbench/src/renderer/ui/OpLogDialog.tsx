/**
 * 操作记录（统一撤销入口）：列出最近的文件操作（编辑器保存、外部程序改动、移到暂存区、移动、撤销），逐条撤销。
 * 撤销是否可用由主进程计算（opsView）：已撤销 / 备份已过期（外部程序改动的备份保留 14 天）/ 备份缺失时按钮变灰并写明原因。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { kb } from '../kb';
import type { OpLogView } from '../../shared/types';
import { dialogs } from './dialogs';

const OP_TEXT: Record<string, string> = { write: '写入', trash: '移到暂存区', move: '移动/重命名', undo: '撤销' };

export function opSourceText(o: OpLogView): string {
  const d = o.detail;
  if (d.via === 'external-app') return `${d.afterRestart ? '工作台关闭期间的外部修改' : '外部程序修改'}（${String(d.program ?? d.programId ?? '外部程序')}）`;
  if (d.via === 'text-edit') return '编辑器保存';
  if (d.via === 'restore-backup') return `恢复撤销前的内容（第 ${String(d.restoreOf ?? '?')} 条）`;
  if (o.op === 'undo') return `撤销第 ${String(d.undoOf ?? '?')} 条${d.conflictBackup ? '（撤销前的内容已备份）' : ''}`;
  if (o.actor === 'user') return '你';
  if (o.actor.startsWith('agent:')) return `Agent（${o.actor.slice(6)}）`;
  if (o.actor.startsWith('app:')) return `插件（${o.actor.slice(4)}）`;
  return o.actor;
}

const UNDO_TEXT: Record<OpLogView['undo']['state'], string> = { available: '撤销', undone: '已撤销', expired: '撤销', missing: '撤销', unsupported: '—' };

export function OpLogDialog({ onClose }: { onClose: () => void }) {
  const [ops, setOps] = useState<OpLogView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = useCallback(() => void kb.opsView(200).then(setOps), []);
  useEffect(() => {
    reload();
    return kb.onFsChange(() => reload());
  }, [reload]);

  const undo = useCallback(
    async (o: OpLogView) => {
      if (busy) return;
      setBusy(true);
      try {
        let r = await kb.opUndo(o.id, false);
        if (r.status === 'conflict') {
          const ok = await dialogs.confirm({
            title: '撤销这条操作？',
            body: `${r.detail.join('\n')}\n\n继续撤销会用操作前的内容覆盖现在的内容；现在的内容会先存进备份库，撤销完成后可以在这里那条撤销记录上点“恢复撤销前的内容”找回。`,
            ok: '仍然撤销',
          });
          if (!ok) return;
          r = await kb.opUndo(o.id, true);
        }
        if (r.status === 'unrecoverable') await dialogs.alert({ title: '无法撤销', body: r.detail.join('；') });
      } catch (e) {
        await dialogs.alert({ title: '撤销失败', body: String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      } finally {
        setBusy(false);
        reload();
      }
    },
    [busy, reload],
  );

  const restore = useCallback(
    async (o: OpLogView) => {
      if (busy) return;
      setBusy(true);
      try {
        let r = await kb.opRestoreBackup(o.id, false);
        if (r.status === 'conflict') {
          const ok = await dialogs.confirm({ title: '恢复撤销前的内容？', body: r.detail.join('\n'), ok: '仍然恢复' });
          if (!ok) return;
          r = await kb.opRestoreBackup(o.id, true);
        }
        if (r.status === 'unrecoverable') await dialogs.alert({ title: '无法恢复', body: r.detail.join('；') });
      } catch (e) {
        await dialogs.alert({ title: '恢复失败', body: String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
      } finally {
        setBusy(false);
        reload();
      }
    },
    [busy, reload],
  );

  return (
    <div className="kb-dialog-backdrop kb-pm-backdrop" onMouseDown={onClose}>
      <div className="kb-dialog kb-dialog--wide kb-oplog" role="dialog" aria-modal="true" aria-label="操作记录" data-testid="oplog-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <div className="kb-dialog-title">操作记录</div>
        <div className="kb-dialog-body kb-oplog-body">
          <p className="meta">工作台写过、移动过的文件和外部程序的修改都记在这里，可以逐条撤销。外部程序修改的备份保留 14 天，过期后不能撤销。</p>
          {ops === null ? (
            <div className="meta">正在读取…</div>
          ) : ops.length === 0 ? (
            <div className="meta" data-testid="oplog-empty">还没有操作记录。</div>
          ) : (
            <table className="kb-oplog-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>操作</th>
                  <th>文件</th>
                  <th>来源</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ops.map((o) => (
                  <tr key={o.id} data-testid="oplog-row" data-op-id={o.id} data-op={o.op} data-via={String(o.detail.via ?? '')} data-undo-state={o.undo.state} data-restore-state={o.restore?.state ?? ''}>
                    <td className="meta">{new Date(o.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td>{OP_TEXT[o.op] ?? o.op}</td>
                    <td className="kb-oplog-path" title={o.relPath}>
                      {o.relPath}
                    </td>
                    <td data-testid="oplog-source">{opSourceText(o)}</td>
                    <td className="kb-oplog-actions">
                      {o.undo.state !== 'unsupported' && (
                        <button className="kb-button kb-button--secondary kb-button--small" data-testid="oplog-undo" disabled={busy || o.undo.state !== 'available'} onClick={() => void undo(o)}>
                          {UNDO_TEXT[o.undo.state]}
                        </button>
                      )}
                      {o.restore && (
                        <>
                          <button className="kb-button kb-button--secondary kb-button--small" data-testid="oplog-restore" disabled={busy || o.restore.state !== 'available'} title="撤销时文件已被改过：当时的内容先存进了备份库，可以在这里找回" onClick={() => void restore(o)}>
                            {o.restore.state === 'restored' ? '已恢复撤销前的内容' : '恢复撤销前的内容'}
                          </button>
                          {o.restore.reason && <span className="meta kb-oplog-reason">{o.restore.reason}</span>}
                        </>
                      )}
                      {o.undo.reason && o.undo.state !== 'unsupported' && (
                        <span className="meta kb-oplog-reason" data-testid="oplog-undo-reason">
                          {o.undo.reason}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="kb-dialog-actions">
          <button className="kb-button kb-button--secondary" data-testid="oplog-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
