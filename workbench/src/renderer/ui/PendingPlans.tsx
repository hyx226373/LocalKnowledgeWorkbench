/**
 * 待批准计划列表：提出 → 看差异 → 批准（绑定 contentHash）→ 自动执行。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { kb } from '../kb';
import { dialogs } from './dialogs';
import type { PendingPlanDto } from '../../shared/types';
import type { TextDiff } from '../../shared/textDiff';

function DiffBlock({ diff, note }: { diff: TextDiff | null; note?: string }) {
  if (!diff) return <div className="meta">{note ?? '无法逐行对比'}</div>;
  return (
    <div className="kb-diff" data-testid="plan-diff">
      {diff.lines.map((l, i) => (
        <div key={i} className="kb-diff-line" data-kind={l.kind}>
          {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function PendingPlansButton() {
  const [n, setN] = useState(0);
  const refresh = useCallback(() => {
    void kb.opsPending().then((list) => setN(list.length)).catch(() => setN(0));
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  return (
    <button type="button" className="kb-pending kb-no-drag" data-testid="pending-plans-btn" onClick={() => void openPendingPlans().then(refresh)}>
      <span className="kb-pending-label">待批准</span>
      <b>{n}</b>
    </button>
  );
}

export async function openPendingPlans(): Promise<void> {
  const list = await kb.opsPending();
  await dialogs.custom<void>({
    title: '待批准计划',
    testid: 'pending-plans-dialog',
    wide: true,
    cancelValue: undefined,
    render: (done) => <PendingList initial={list} onClose={() => done(undefined)} />,
  });
}

function PendingList({ initial, onClose }: { initial: PendingPlanDto[]; onClose: () => void }) {
  const [plans, setPlans] = useState(initial);
  const [sel, setSel] = useState<string | null>(initial[0]?.planId ?? null);
  const [review, setReview] = useState<{
    plan: PendingPlanDto;
    preview: { contentHash: string; items: { opId: string; summary: string; conflicts: string[] }[] };
    diffs: Record<string, { relPath: string; diff: TextDiff | null; note?: string }>;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async () => {
    const list = await kb.opsPending();
    setPlans(list);
    if (sel && !list.find((p) => p.planId === sel)) {
      setSel(list[0]?.planId ?? null);
      setReview(null);
    }
  };

  const doReview = async (planId: string) => {
    setErr('');
    setBusy(true);
    try {
      const rv = (await kb.opsReview(planId)) as typeof review;
      setReview(rv);
      setSel(planId);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const doReject = async () => {
    if (!review) return;
    setErr('');
    setBusy(true);
    try {
      await kb.opsReject(review.plan.planId, '用户拒绝');
      setReview(null);
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const doApprove = async () => {
    if (!review) return;
    setErr('');
    setBusy(true);
    try {
      const opIds = review.plan.ops.map((o) => o.opId);
      await kb.opsApprove(review.plan.planId, opIds, review.preview.contentHash || review.plan.contentHash);
      setReview(null);
      await load();
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="kb-dialog-body" data-testid="pending-plans-body">
        {plans.length === 0 && <div className="meta kb-pending-empty">当前没有待批准的计划。</div>}
        <div style={{ display: 'flex', gap: 12, minHeight: 240 }}>
          <ul className="kb-plan-steps" style={{ flex: '0 0 220px', margin: 0, padding: 0, listStyle: 'none' }} data-testid="pending-plan-list">
            {plans.map((p) => (
              <li key={p.planId} style={{ marginBottom: 8 }}>
                <button
                  type="button"
                  className="kb-button kb-button--secondary"
                  data-testid={`pending-plan-${p.planId}`}
                  aria-selected={sel === p.planId}
                  onClick={() => void doReview(p.planId)}
                  style={{ width: '100%', textAlign: 'left' }}
                >
                  <div>{p.title}</div>
                  <div className="meta">{p.actor}</div>
                </button>
              </li>
            ))}
          </ul>
          <div style={{ flex: 1 }} data-testid="pending-plan-review">
            {!review && plans.length > 0 && <div className="meta">选择左侧计划以查看差异。</div>}
            {review && (
              <>
                <div>
                  <b>{review.plan.title}</b> · {review.plan.actor} · hash {review.plan.contentHash.slice(0, 12)}…
                </div>
                {review.preview.items.map((it) => (
                  <div key={it.opId} style={{ marginTop: 8 }} data-testid={`plan-op-${it.opId}`}>
                    <div>
                      {it.summary}
                      {it.conflicts.length > 0 && (
                        <span className="kb-plan-conflict" role="alert">
                          {' '}
                          冲突：{it.conflicts.join('；')}
                        </span>
                      )}
                    </div>
                    <DiffBlock diff={review.diffs[it.opId]?.diff ?? null} note={review.diffs[it.opId]?.note} />
                  </div>
                ))}
              </>
            )}
            {err && (
              <div className="kb-plan-conflict" role="alert" data-testid="pending-plan-error">
                {err}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="kb-dialog-actions">
        <button type="button" className="kb-button kb-button--secondary" data-testid="pending-plans-close" onClick={onClose}>
          关闭
        </button>
        <button type="button" className="kb-button kb-button--secondary" data-testid="pending-plan-reject" disabled={!review || busy} onClick={() => void doReject()}>
          拒绝
        </button>
        <button type="button" className="kb-button" data-testid="pending-plan-approve" disabled={!review || busy} onClick={() => void doApprove()}>
          批准并执行
        </button>
      </div>
    </>
  );
}
