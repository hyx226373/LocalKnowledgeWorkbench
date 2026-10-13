/** 控制台文件的阅读器适配器。打开文件只渲染，不自动开整组。 */
import { useEffect, useRef, useState } from 'react';
import type { AdapterProps } from '../plugin-host/types';
import { useEditableDoc } from '../plugins/builtin-readers/editor';
import { ConsoleScreen } from './ConsoleScreen';
import { useConsoleFileActions } from './useConsoleFileActions';

export function ConsolePanel({ resource, api, reportReady }: AdapterProps) {
  const [notice, setNotice] = useState<string | null>(null);
  const doc = useEditableDoc(api, resource.resourceId, setNotice);
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || !reportReady || (!doc.snap && !doc.error)) return;
    reported.current = true;
    const frame = requestAnimationFrame(() => reportReady());
    return () => cancelAnimationFrame(frame);
  }, [doc.snap, doc.error, reportReady]);
  const actions = useConsoleFileActions(api, doc, setNotice);
  if (doc.error) return <div className="kb-notice">读取失败：{doc.error}</div>;
  if (!doc.snap) return <div className="kb-notice" data-testid="console-loading">加载中…</div>;
  return (
    <ConsoleScreen
      name={resource.name}
      text={doc.draft}
      onText={doc.setDraft}
      onSave={() => void doc.save()}
      notice={notice}
      onOpenItem={actions.onOpenItem}
      onOpenGroup={actions.onOpenGroup}
      onIndexDrop={actions.onIndexDrop}
      onDropRejected={actions.onDropRejected}
      blockContext={{
        commands: { execute: (id, ...args) => api.commands.execute(id, ...args) },
        ops: {
          propose: async (title, ops) => {
            const kb = (window as unknown as { kb?: { opsPropose?: (t: string, o: unknown[]) => Promise<unknown> } }).kb;
            if (!kb?.opsPropose) throw new Error('当前环境不能提交计划');
            return kb.opsPropose(title, ops);
          },
        },
        log: (message) => console.warn(`[consoleBlocks] ${message}`),
      }}
    />
  );
}
