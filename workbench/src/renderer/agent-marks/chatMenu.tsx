import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  conversationContextMenu,
  marksForPath,
  type AttentionMark,
  type MenuItemState,
} from '../../shared/agentMarks';
import { kb } from '../kb';
import { addAgentMark, ensureAgentMarks, readAgentMarks, subscribeAgentMarks, unmarkAgentRange } from './client';
import { selectionInPreview } from './menu';

function marksUnderSelection(root: HTMLElement, marks: readonly AttentionMark[]): AttentionMark[] {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const ids = new Set<string>();
  for (const node of root.querySelectorAll('.kb-agent-mark')) {
    if (!range.intersectsNode(node)) continue;
    const id = node.getAttribute('data-agent-mark');
    if (id) ids.add(id);
  }
  return marks.filter((mark) => ids.has(mark.id));
}

/** 一块气泡里要画上的标红。按文件偏移排序，同一段原文的第 n 次对上渲染结果里的第 n 次。 */
export function chatMarkExcerpts(marks: readonly AttentionMark[], blockId: string): { id: string; text: string; occurrence: number }[] {
  const mine = marks.filter((mark) => mark.conversation?.blockId === blockId);
  const ordered = [...mine].sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
  const seen = new Map<string, number>();
  return ordered.map((mark) => {
    const text = mark.text.replace(/\r\n/g, '\n').replace(/\r/g, '');
    const n = seen.get(text) ?? 0;
    seen.set(text, n + 1);
    return { id: mark.id, text, occurrence: n };
  });
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 剪贴板权限不够时退回选区复制 */
  }
  document.execCommand('copy');
}

type BubbleTarget = {
  id: string;
  source: string;
  displayed: 'text' | 'summary';
};

type OpenMenu = {
  x: number;
  y: number;
  items: MenuItemState[];
  range: { start: number; end: number; text: string } | null;
  copyText: string;
  block: BubbleTarget | null;
  unmark: AttentionMark[];
};

/** 对话气泡的标红菜单。资格由主进程判断，对话文件不必先放进本轮资料。 */
export function useConversationMarkMenu(args: { path: string; agent: string; title: string }): {
  count: number;
  marks: AttentionMark[];
  menu: React.ReactNode;
  onContextMenu: (event: React.MouseEvent, block: BubbleTarget) => void;
} {
  const marks = React.useSyncExternalStore(subscribeAgentMarks, readAgentMarks);
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const path = args.path;

  useEffect(() => {
    ensureAgentMarks();
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.kb-preview-ctx')) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const ranges = useMemo(() => marksForPath(marks, path), [marks, path]);

  const onContextMenu = (event: React.MouseEvent, block: BubbleTarget) => {
    event.preventDefault();
    event.stopPropagation();
    const root = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    const classified = root ? selectionInPreview(root, block.source) : { kind: 'none' as const };
    const range = classified.kind === 'range' ? classified : null;
    const target = event.target;
    const hit = target instanceof Element ? target.closest('.kb-agent-mark') : null;
    const hitId = hit?.getAttribute('data-agent-mark') ?? '';
    const hitMark = ranges.find((row) => row.id === hitId);
    const fromSelection = root ? marksUnderSelection(root, ranges) : [];
    const unmark = fromSelection.length ? fromSelection : hitMark ? [hitMark] : [];
    const overlaps = unmark.length > 0;
    const raw = window.getSelection()?.toString() ?? '';
    const x = Math.max(8, Math.min(event.clientX, window.innerWidth - 220));
    const y = Math.max(8, Math.min(event.clientY, window.innerHeight - 140));
    const input = {
      hasSelection: classified.kind === 'range' || classified.kind === 'too-long' || classified.kind === 'unmapped',
      selectionOrClickOnMark: !!hitId || overlaps,
      unmapped: classified.kind === 'unmapped',
      tooLong: classified.kind === 'too-long',
    };
    const copyValue = range?.text || (input.hasSelection ? raw : '');
    const open = (fileInRound: boolean) => {
      setMenu({
        x,
        y,
        range,
        copyText: copyValue,
        block,
        unmark,
        items: conversationContextMenu({ ...input, fileInRound }),
      });
    };
    if (!path || typeof kb?.agentMarksEligible !== 'function') {
      open(!!path);
      return;
    }
    void kb.agentMarksEligible(path).then(
      (gate) => open(!!gate?.ok),
      () => open(true),
    );
  };

  const run = (item: MenuItemState) => {
    if (!item.enabled || !menu) return;
    const range = menu.range;
    const block = menu.block;
    const unmarkTargets = menu.unmark;
    setMenu(null);
    if (item.id === 'copy') {
      if (menu.copyText) void copyText(menu.copyText);
      return;
    }
    if (item.id === 'mark' && range && path && block) {
      void addAgentMark({
        absPath: path,
        startLine: 1,
        endLine: 1,
        startOffset: range.start,
        endOffset: range.end,
        text: range.text,
        conversationDisplay: block.displayed,
        conversation: {
          path,
          agent: args.agent || 'unknown',
          title: args.title || '未命名',
          blockId: block.id,
        },
      }).catch(() => undefined);
      return;
    }
    if (item.id === 'unmark' && path) {
      for (const mark of unmarkTargets) void unmarkAgentRange(path, mark.startOffset, mark.endOffset).catch(() => undefined);
    }
  };

  const menuNode = menu
    ? createPortal(
        <div className="kb-popover menu kb-preview-ctx" role="menu" data-testid="chat-ctx" style={{ left: menu.x, top: menu.y }}>
          {menu.items.map((item) => (
            <div
              key={item.id}
              className="kb-menu-item"
              role="menuitem"
              tabIndex={item.enabled ? 0 : -1}
              data-testid={item.testId}
              aria-disabled={item.enabled ? undefined : true}
              title={item.title}
              onClick={() => run(item)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                run(item);
              }}
            >
              <span className="name">{item.label}</span>
            </div>
          ))}
        </div>,
        document.body,
      )
    : null;

  return { count: ranges.length, marks: ranges, menu: menuNode, onContextMenu };
}
