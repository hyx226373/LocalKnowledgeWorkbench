/**
 * 设置里的「更新」页。安装和回滚只从这里或托盘发起，不走文件桥。
 */
import React, { useEffect, useState } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { KbToggle } from '../settings/KbToggle';
import '../settings/settings-frame.css';
import { RESTART_TO_UPDATE_TITLE } from '../../shared/layout/names';
import { formatByteProgress } from '../../shared/update/progress';
import type { UpdateSnapshot } from '../../shared/update/types';

export function openUpdatePage(): Promise<void> {
  return dialogs.custom<void>({
    title: '更新',
    testid: 'update-page',
    wide: true,
    cancelValue: undefined,
    render: (done) => <UpdateBody done={() => done(undefined)} />,
  });
}

export function UpdateBody({ done, embedded = false }: { done?: () => void; embedded?: boolean }) {
  const [snap, setSnap] = useState<UpdateSnapshot | null>(null);
  const [feed, setFeed] = useState('');
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState('');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    let alive = true;
    const off = kb.onUpdate((next) => {
      if (alive) setSnap(next);
    });
    void kb.updateState().then((next) => {
      if (!alive || !next) return;
      setSnap(next);
      setFeed(next.feed);
      setLimit(next.rateLimitBytesPerSec == null ? '' : String(next.rateLimitBytesPerSec));
    }).catch((err: unknown) => {
      if (alive) setLocalError(String((err as Error)?.message ?? err));
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(label);
    setLocalError('');
    try {
      const next = await work();
      if (next && typeof next === 'object' && 'currentVersion' in (next as UpdateSnapshot)) setSnap(next as UpdateSnapshot);
    } catch (err) {
      setLocalError(String((err as Error)?.message ?? err));
    } finally {
      setBusy('');
    }
  };

  const save = () => {
    const trimmed = limit.trim();
    const rate = trimmed === '' ? null : Number(trimmed);
    if (rate !== null && (!Number.isInteger(rate) || rate <= 0)) {
      setLocalError('限速必须是正整数，单位是字节/秒');
      return;
    }
    void run('save', () => kb.updateSaveSettings({ feed: feed.trim(), rateLimitBytesPerSec: rate, autoCheck: snap?.autoCheck !== false }));
  };

  const progress = snap?.progress ? formatByteProgress(snap.progress) : '';
  const locked = busy !== '' || snap?.phase === 'installing' || snap?.phase === 'rolling-back';
  const canRollback = snap?.layout === 'dirpack' ? Boolean(snap.previousVersion) : (snap?.backups.length ?? 0) > 0;

  return (
    <>
      <div className={embedded ? 'kb-set-page kb-dialog-body' : 'kb-dialog-body'} data-testid="update-body">
        {embedded ? (
          <>
            <h1>更新</h1>
            <p className="kb-set-lead">安装与回滚只从本页或托盘发起。</p>
          </>
        ) : null}
        <p data-testid="update-unsigned">{snap?.unsignedNotice ?? '未签名'}</p>
        <p data-testid="update-current">当前版本 {snap?.currentVersion ?? '…'}</p>
        <p data-testid="update-available">可用版本 {snap?.available?.version ?? '没有'}</p>
        <p data-testid="update-notes">{snap?.available?.notes ?? ''}</p>
        <p data-testid="update-progress">{progress}</p>
        <p data-testid="update-last-check">上次检查 {snap?.lastCheckAt ?? '还没有'}</p>
        <p data-testid="update-phase">{snap?.info ?? ''}{snap?.error ? ` ${snap.error}` : ''}</p>
        {localError && <p data-testid="update-error">{localError}</p>}
        <label className="kb-field">
          源地址
          <input data-testid="update-feed" value={feed} onChange={(ev) => setFeed(ev.target.value)} />
        </label>
        <div className="kb-set-row">
          <div>
            <b>自动检查</b>
            <p>按计划检查更新源。关闭后仍可手动检查。</p>
          </div>
          <KbToggle
            testId="update-auto"
            label="自动检查"
            checked={snap?.autoCheck !== false}
            disabled={busy === 'auto'}
            busy={busy === 'auto'}
            onChange={(next) => void run('auto', () => kb.updateSaveSettings({ autoCheck: next }))}
          />
        </div>
        <label className="kb-field">
          限速（字节/秒，留空不限）
          <input data-testid="update-rate" value={limit} onChange={(ev) => setLimit(ev.target.value)} inputMode="numeric" />
        </label>
        <ul data-testid="update-backups">
          {(snap?.backups ?? []).length === 0 && <li>还没有备份</li>}
          {(snap?.backups ?? []).map((item) => (
            <li key={item.id} data-testid={`update-backup-${item.id}`}>
              {item.createdAt} · {item.version} · {item.id}
            </li>
          ))}
        </ul>
        <div className="kb-update-actions">
          <button className="kb-button" data-testid="update-check" disabled={locked} onClick={() => void run('check', () => kb.updateCheck())}>
            检查更新
          </button>
          <button className="kb-button" data-testid="update-install-now" disabled={locked || !snap?.downloaded} onClick={() => void run('now', () => kb.updateApply({ actionId: 'app.installUpdate', when: 'now' }))}>
            {snap?.layout === 'dirpack' ? RESTART_TO_UPDATE_TITLE : '立即重启并升级'}
          </button>
          <button className="kb-button" data-testid="update-install-quit" disabled={locked || !snap?.downloaded} onClick={() => void run('quit', () => kb.updateApply({ actionId: 'app.installUpdate', when: 'quit' }))}>
            下次退出时升级
          </button>
          <button className="kb-button" data-testid="update-rollback" disabled={locked || !canRollback} onClick={() => void run('rollback', () => kb.updateApply({ actionId: 'app.rollbackUpdate' }))}>
            回滚到上一版
          </button>
          <button className="kb-button kb-button--ghost" data-testid="update-save" disabled={locked} onClick={save}>
            保存设置
          </button>
        </div>
      </div>
      {!embedded && (
        <div className="kb-dialog-actions">
          <button className="kb-button" data-testid="update-close" onClick={done}>
            关闭
          </button>
        </div>
      )}
    </>
  );
}
