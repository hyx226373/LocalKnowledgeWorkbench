/**
 * 高档收件箱改动的逐文件批准，旧 plan.json 仍走整份计划，中档冲突仍可保留或还原。不碰系统剪贴板。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { changeActions, changeSummary, legacyStageSummary, type AiWriteChangeView, type AiWriteConflictView, type AiWriteLegacyStage, type AiWritePending, type AiWritePlanView } from '../../shared/aiWriteChannel';
import { diffLines } from '../../shared/textDiff';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';

function changeKey(row: AiWriteChangeView): string {
  return `${row.sessionId}:${row.fileId}`;
}

export function AiWriteBoard({ onClose }: { onClose?: () => void }) {
  const [pending, setPending] = useState<AiWritePending>({ plans: [], conflicts: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [landings, setLandings] = useState<Record<string, string>>({});
  const load = useCallback(() => {
    void kb.aiWritePending().then(setPending).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      load();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  };
  const changes = pending.changes ?? [];
  const idle = changes.length === 0 && pending.plans.length === 0 && pending.conflicts.length === 0;
  return (
    <div data-testid="ai-write-approval">
      <p className="kb-set-copy">高档改动先停在收件箱副本。点「收取改动」后在这里逐文件批准；批准时软件才备份并写回。对不上源文件夹的新建文件要先选目标文件夹。冲突不会覆盖，除非改选「覆盖（先备份）」。旧的 plan.json 仍会列在下面。中档审查没通过的不自动还原。</p>
      <LegacyStages />
      {idle ? <p>没有待处理的改动、计划或冲突。</p> : null}
      {changes.map((row) => (
        <ChangeCard
          key={changeKey(row)}
          row={row}
          busy={busy}
          checked={picked[changeKey(row)] === true}
          landing={landings[changeKey(row)] ?? ''}
          onCheck={(value) => setPicked((prev) => ({ ...prev, [changeKey(row)]: value }))}
          onLanding={(dir) => setLandings((prev) => ({ ...prev, [changeKey(row)]: dir }))}
          onRun={run}
        />
      ))}
      {changes.length ? (
        <div className="kb-ai-actions">
          <button type="button" className="kb-button" data-testid="ai-write-approve-selected" disabled={busy} onClick={() => void run(async () => {
            for (const row of changes) {
              const key = changeKey(row);
              if (!picked[key]) continue;
              const actions = changeActions(row);
              const landing = landings[key] ?? '';
              if (actions.approve) await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision: 'approve' });
              else if (actions.pickLanding && landing) await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision: 'approve', landingDir: landing });
            }
          })}>批准所选</button>
          <button type="button" className="kb-button" data-testid="ai-write-reject-all" disabled={busy} onClick={() => void run(async () => {
            const ok = await dialogs.confirm({ title: '全部驳回', body: '驳回这份清单里还没处理的改动？原件不会被修改。', ok: '全部驳回', cancel: '取消' });
            if (!ok) return;
            for (const row of changes) await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision: 'reject' });
          })}>全部驳回</button>
        </div>
      ) : null}
      {pending.plans.map((plan) => <PlanCard key={plan.planId} plan={plan} busy={busy} onRun={run} />)}
      {pending.conflicts.map((row) => <ConflictCard key={row.id} row={row} busy={busy} onRun={run} />)}
      {error ? <p role="alert">{error}</p> : null}
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" onClick={load}>刷新</button>
        {onClose ? <button type="button" className="kb-button" onClick={onClose}>关闭</button> : null}
      </div>
    </div>
  );
}

function LegacyStages() {
  const [rows, setRows] = useState<AiWriteLegacyStage[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void kb.aiWriteLegacyStages().then(setRows).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load]);
  if (!rows.length && !error) return null;
  return (
    <section data-testid="ai-write-legacy-stages">
      <b>遗留空暂存</b>
      <p className="kb-set-copy">下面这些旧暂存是空的，或只剩已经处理过的计划。有其它文件的不会出现在这里。点确认后才移入系统回收站，不会自动删除。</p>
      <ul>
        {rows.map((row) => <li key={row.path}>{legacyStageSummary(row)}</li>)}
      </ul>
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" data-testid="ai-write-legacy-trash" disabled={busy || rows.length === 0} onClick={() => void (async () => {
          const listed = rows.map((row) => legacyStageSummary(row)).join('\n');
          const ok = await dialogs.confirm({ title: '移入回收站', body: `把下面这些空暂存移入系统回收站？\n${listed}`, ok: '移入回收站', cancel: '留下', danger: true });
          if (!ok) return;
          setBusy(true);
          setError('');
          try {
            await kb.aiWriteLegacyStageTrash({ paths: rows.map((row) => row.path) });
            load();
          } catch (err) {
            setError(String((err as Error)?.message ?? err));
          } finally {
            setBusy(false);
          }
        })()}>移入回收站</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function ChangeCard({ row, busy, checked, landing, onCheck, onLanding, onRun }: {
  row: AiWriteChangeView;
  busy: boolean;
  checked: boolean;
  landing: string;
  onCheck: (value: boolean) => void;
  onLanding: (dir: string) => void;
  onRun: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const actions = changeActions(row);
  const showDiff = !row.binary && (row.oldText.length > 0 || row.newText.length > 0);
  const diff = showDiff ? diffLines(row.oldText, row.newText) : null;
  const apply = (decision: 'approve' | 'reject' | 'delete' | 'overwrite', landingDir?: string) => onRun(async () => {
    const result = await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision, ...(landingDir ? { landingDir } : {}) });
    if (!result.ok) await dialogs.alert({ title: '没有写入', body: `${result.file}\n复制时 ${result.expectedHash || '（新文件）'}\n现在 ${result.actualHash || '（文件不存在）'}\n这次没有覆盖原件。` });
  });
  return (
    <article className="kb-ai-file" data-testid={`ai-write-change-${row.fileId}`}>
      <label>
        <input type="checkbox" checked={checked} disabled={busy || (!actions.approve && !(actions.pickLanding && landing))} onChange={(event) => onCheck(event.target.checked)} />
        {' '}{changeSummary(row)}
      </label>
      {diff ? diff.lines.map((line, index) => (
        <div key={index} className="kb-diff-line" data-kind={line.kind}>
          {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
          {line.text}
        </div>
      )) : null}
      {actions.pickLanding ? (
        <div className="kb-ai-actions">
          <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-pick-landing" onClick={() => void (async () => {
            const picked = await kb.pickFolder({ title: '选择新建文件的目标文件夹' });
            if (picked) onLanding(picked);
          })()}>选择目标文件夹…</button>
          {landing ? <span data-testid="ai-write-landing">{landing}</span> : <span>还没选目标文件夹，不能批准。</span>}
        </div>
      ) : null}
      <div className="kb-ai-actions">
        {actions.approve ? <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-change-approve" onClick={() => void apply('approve')}>批准</button> : null}
        {actions.pickLanding && landing ? <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-change-approve" onClick={() => void apply('approve', landing)}>批准</button> : null}
        {actions.confirmDelete ? <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-change-delete" onClick={() => void onRun(async () => {
          const ok = await dialogs.confirm({ title: '确认删除', body: `${row.inboxRel}\n原件会先备份，再移入系统回收站。`, ok: '确认删除', cancel: '取消', danger: true });
          if (!ok) return;
          const result = await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision: 'delete' });
          if (!result.ok) await dialogs.alert({ title: '没有删除', body: `${result.file}\n复制时 ${result.expectedHash || '（无）'}\n现在 ${result.actualHash || '（文件不存在）'}\n原件还在。` });
        })}>确认删除</button> : null}
        {actions.overwrite ? <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-change-overwrite" onClick={() => void onRun(async () => {
          const body = row.role === 'created'
            ? `${row.inboxRel}\n目标已存在。覆盖会先备份现在的内容，再写入。`
            : `${row.inboxRel}\n复制之后原件已经变过。覆盖会先备份现在的原件。`;
          const ok = await dialogs.confirm({ title: '覆盖原件', body, ok: '覆盖（先备份）', cancel: '取消', danger: true });
          if (!ok) return;
          await kb.aiWriteApply({ sessionId: row.sessionId, fileId: row.fileId, decision: 'overwrite' });
        })}>覆盖（先备份）</button> : null}
        <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-change-reject" onClick={() => void apply('reject')}>驳回</button>
      </div>
    </article>
  );
}

function PlanCard({ plan, busy, onRun }: { plan: AiWritePlanView; busy: boolean; onRun: (work: () => Promise<unknown>) => Promise<void> }) {
  return (
    <article className="kb-ai-file" data-testid={`ai-write-plan-${plan.planId}`}>
      <b>{plan.rootName}</b>
      <span> · {plan.virtualRoot}</span>
      {plan.files.map((file) => {
        const diff = diffLines(file.oldText, file.newText);
        return (
          <div key={file.virtualPath} className="kb-diff" data-testid="ai-write-diff">
            <div>{file.rel}{file.conflict ? ' · 哈希不一致' : ''}{file.note ? ` · ${file.note}` : ''}</div>
            {diff.lines.map((line, index) => (
              <div key={index} className="kb-diff-line" data-kind={line.kind}>
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                {line.text}
              </div>
            ))}
          </div>
        );
      })}
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" disabled={busy} data-testid="ai-write-approve" onClick={() => void onRun(async () => {
          const result = await kb.aiWriteApprove({ planId: plan.planId });
          if (!result.ok) {
            const force = await dialogs.confirm({ title: '哈希不一致', body: `${result.file}\n期望 ${result.expectedHash || '（新文件）'}\n实际 ${result.actualHash || '（文件不存在）'}\n仍然写入会先备份当前内容。`, ok: '仍然写入', cancel: '停下' });
            if (force) await kb.aiWriteApprove({ planId: plan.planId, force: true });
          }
        })}>批准写入</button>
        <button type="button" className="kb-button" disabled={busy} onClick={() => void onRun(() => kb.aiWriteReject({ planId: plan.planId }))}>拒绝</button>
      </div>
    </article>
  );
}

function ConflictCard({ row, busy, onRun }: { row: AiWriteConflictView; busy: boolean; onRun: (work: () => Promise<unknown>) => Promise<void> }) {
  return (
    <article className="kb-ai-file" data-testid={`ai-write-conflict-${row.id}`}>
      <b>{row.path}</b>
      {row.reasons?.length ? <p>待批准：{row.reasons.join('、')}</p> : null}
      <p>期望 {row.expectedHash || '（无）'} · 写前 {row.previousHash || '（无副本）'} · 这次 {row.actualHash}</p>
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" disabled={busy} onClick={() => void onRun(() => kb.aiWriteConflictResolve({ id: row.id, action: 'keep' }))}>保留</button>
        <button type="button" className="kb-button" disabled={busy || !row.canRestore} onClick={() => void onRun(() => kb.aiWriteConflictResolve({ id: row.id, action: 'restore' }))}>还原到备份</button>
      </div>
    </article>
  );
}

export function openAiWriteApproval(): Promise<void> {
  return dialogs.custom<void>({
    title: 'AI 写入批准',
    testid: 'ai-write-approval-dialog',
    wide: true,
    cancelValue: undefined,
    render: (done) => <AiWriteBoard onClose={() => done(undefined)} />,
  });
}
