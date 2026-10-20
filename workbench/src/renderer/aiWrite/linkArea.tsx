/**
 * 链接区。复制给 AI 的链接只带这里的文件夹和文件。
 * 高档项的真实路径只在这里显示，不进粘贴。
 */
import { useCallback, useEffect, useState } from 'react';
import { discardManifestBody, linkRowSummary, sessionSummary, type AiWriteLinkStatus } from '../../shared/aiWriteChannel';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import '../settings/ai-write.css';
import { linkTargetsFromTransfer, type LinkTarget } from './drops';

const EMPTY: AiWriteLinkStatus = { needsInbox: false, rows: [], session: null };

export function AiWriteLinkArea() {
  const [status, setStatus] = useState<AiWriteLinkStatus>(EMPTY);
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void kb.aiWriteLinkStatus().then(setStatus).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  const add = async (targets: LinkTarget[]) => {
    if (!targets.length) return;
    setError('');
    try {
      await kb.aiWriteLinksAdd({ items: targets });
      refresh();
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    }
  };
  const fail = (err: unknown) => setError(String((err as Error)?.message ?? err));
  return (
    <div
      className="kb-ai-link"
      data-testid="ai-write-link-area"
      data-drag-over={over ? 'true' : 'false'}
      onDragEnter={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setOver(false);
        void add(linkTargetsFromTransfer(event.dataTransfer));
      }}
    >
      <b>链接区</b>
      <p>拖进或放入文件夹、文件。复制的链接只带这些，不带整个根目录，也不列出文件夹里的文件。</p>
      {status.needsInbox ? <p role="status" data-testid="ai-write-needs-inbox">有高档内容。请先在设置里选择收件箱根目录，再复制链接。</p> : null}
      {status.rows.length === 0 ? <p>还没有放入内容。</p> : (
        <ul>
          {status.rows.map((item) => (
            <li key={item.id} data-testid={`ai-write-link-${item.id}`}>
              {linkRowSummary(item)}
              <button type="button" className="kb-linkish" onClick={() => void kb.aiWriteLinksRemove({ id: item.id }).then(() => refresh()).catch(fail)}>移除</button>
            </li>
          ))}
        </ul>
      )}
      {status.session ? <p data-testid="ai-write-session">{sessionSummary(status.session)}</p> : null}
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" data-testid="ai-write-link-add-folder" onClick={() => void (async () => {
          const picked = await kb.pickFolder({ title: '放入链接区的文件夹' });
          if (picked) await add([{ path: picked, name: picked.split(/[\\/]/).pop() || picked, kind: 'dir' }]);
        })()}>放入文件夹…</button>
        <button type="button" className="kb-button" data-testid="ai-write-link-add-file" onClick={() => void (async () => {
          const picked = await kb.pickFile({ title: '放入链接区的文件' });
          if (picked) await add([{ path: picked, name: picked.split(/[\\/]/).pop() || picked, kind: 'file' }]);
        })()}>放入文件…</button>
        <button type="button" className="kb-button" disabled={status.rows.length === 0} onClick={() => void kb.aiWriteLinksClear().then(() => refresh()).catch(fail)}>清空</button>
        <button type="button" className="kb-button" data-testid="ai-write-collect" disabled={busy || !status.session} onClick={() => void (async () => {
          setBusy(true);
          setError('');
          try {
            await kb.aiWriteCollect({ sessionId: status.session?.sessionId });
            refresh();
          } catch (err) {
            fail(err);
          } finally {
            setBusy(false);
          }
        })()}>收取改动</button>
        <button type="button" className="kb-button" data-testid="ai-write-discard" disabled={busy || !status.session} onClick={() => void (async () => {
          const sessionId = status.session?.sessionId;
          if (!sessionId) return;
          setBusy(true);
          setError('');
          try {
            const manifest = await kb.aiWriteSessionDiscard({ sessionId });
            if (!manifest.removed && manifest.needsConfirm) {
              const again = await dialogs.confirm({
                title: manifest.warning ? '结束会话 · 有未批准的变更' : '结束会话',
                body: discardManifestBody(manifest),
                ok: '移入回收站',
                cancel: '留下',
                danger: manifest.pendingCount > 0,
              });
              if (!again) return;
              await kb.aiWriteSessionDiscard({ sessionId, confirm: true });
            }
            refresh();
          } catch (err) {
            fail(err);
          } finally {
            setBusy(false);
          }
        })()}>结束会话</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
