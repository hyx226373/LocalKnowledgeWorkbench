/** 阅读壳和 Markdown 委托共用：打开命令、整组摘要、拖入索引后走现有保存。 */
import { useCallback, useRef } from 'react';
import { newItemId } from '../plugin-host/layoutModel';
import type { PluginApi } from '../plugin-host/types';
import { parseResourceDrag, type ConsoleIndex, type ConsoleIndexItem } from '../../shared/consoleSchema';
import { kb } from '../kb';
import { formatOpenGroupResult } from './open/summary';
import { appendDragToIndex } from './open/dropIndex';
import type { OpenGroupResult } from './commands';

function clean(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

function isGroupResult(value: unknown): value is OpenGroupResult {
  return !!value && typeof value === 'object' && Array.isArray((value as OpenGroupResult).ok) && Array.isArray((value as OpenGroupResult).failed);
}

export function useConsoleFileActions(
  api: PluginApi,
  doc: { draft: string; setDraft: (text: string) => void; save: () => Promise<void> },
  notify: (message: string) => void,
) {
  const draftRef = useRef(doc.draft);
  draftRef.current = doc.draft;

  const onOpenItem = useCallback(
    (item: ConsoleIndexItem) => {
      void api.commands.execute('console.openItem', item).then(
        () => notify('已打开'),
        (error) => notify(clean(error)),
      );
    },
    [api, notify],
  );

  const onOpenGroup = useCallback(
    (index: ConsoleIndex) => {
      void api.commands.execute('console.openGroup', index).then(
        (result) => notify(isGroupResult(result) ? formatOpenGroupResult(result) : '已打开'),
        (error) => notify(clean(error)),
      );
    },
    [api, notify],
  );

  const onIndexDrop = useCallback(
    (raw: string) => {
      void (async () => {
        const parsed = parseResourceDrag(raw);
        if (!parsed.ok) {
          notify(parsed.error);
          return;
        }
        const titles = new Map<string, string>();
        for (const drag of parsed.items) {
          const resource = await kb.getResource(drag.resourceId).catch(() => null);
          titles.set(drag.resourceId, resource?.name || drag.resourceId);
        }
        const next = appendDragToIndex(draftRef.current, parsed.items, (drag) => titles.get(drag.resourceId) || drag.resourceId, newItemId);
        if (!next.ok) {
          notify(next.error);
          return;
        }
        doc.setDraft(next.text);
        try {
          await doc.save();
        } catch (error) {
          notify(clean(error));
          return;
        }
        notify(`已加入 ${next.added} 条到控制台索引（不移动原文件）`);
      })();
    },
    [doc, notify],
  );

  const onDropRejected = useCallback(() => {
    notify('请先切换到编辑。加入控制台索引（不移动原文件）');
  }, [notify]);

  return { onOpenItem, onOpenGroup, onIndexDrop, onDropRejected };
}
