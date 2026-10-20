import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  MAX_MARK_CHARS,
  highlightSlices,
  mapSelectionToSource,
  markFromSelection,
  marksForPath,
  occurrenceOf,
  previewContextMenu,
  sameMarkPath,
  selectionOverlapsMark,
  type AttentionMark,
  type MenuItemState,
} from '../../shared/agentMarks';
import { locateByHeadingText, locateOpenTarget, mapPreviewPoint, type OpenTarget } from '../../shared/obsidianBridge/target';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { addAgentMark, ensureAgentMarks, readAgentMarks, subscribeAgentMarks, unmarkAgentRange } from './client';
import { previewPlainText } from './domApply';

const SKIP_PREVIEW = '.kb-md-toc, .kb-md-backtoc, .kb-mermaid-drawn';

function walkText(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text)) continue;
    if (node.parentElement?.closest(SKIP_PREVIEW)) continue;
    nodes.push(node);
  }
  return nodes;
}

function textOffset(root: HTMLElement, container: Node, offset: number): number | null {
  const nodes = walkText(root);
  if (container.nodeType === Node.TEXT_NODE) {
    let cursor = 0;
    for (const node of nodes) {
      if (node === container) return cursor + Math.max(0, Math.min(offset, node.data.length));
      cursor += node.data.length;
    }
    return null;
  }
  if (!(container instanceof Element) || !root.contains(container)) return null;
  const child = offset <= 0 ? container : container.childNodes[Math.min(offset, container.childNodes.length) - 1];
  if (!child) return 0;
  let cursor = 0;
  for (const node of nodes) {
    if (node === child || (child instanceof Element && child.contains(node))) return cursor;
    cursor += node.data.length;
  }
  return cursor;
}

type Classified =
  | { kind: 'range'; start: number; end: number; text: string }
  | { kind: 'none' }
  | { kind: 'unmapped' }
  | { kind: 'too-long' };

export function selectionInPreview(root: HTMLElement, source: string): Classified {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { kind: 'none' };
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return { kind: 'none' };
  const raw = sel.toString();
  if (raw.length > MAX_MARK_CHARS) return { kind: 'too-long' };
  const previewText = previewPlainText(root);
  const start = textOffset(root, range.startContainer, range.startOffset);
  const end = textOffset(root, range.endContainer, range.endOffset);
  if (start != null && end != null && end > start) {
    const mapped = mapSelectionToSource(source, previewText, Math.min(start, end), Math.max(start, end));
    if (mapped) return { kind: 'range', ...mapped };
    return raw.trim() ? { kind: 'unmapped' } : { kind: 'none' };
  }
  if (!raw.trim()) return { kind: 'none' };
  const mapped = mapSelectionToSource(source, raw, 0, raw.length);
  if (mapped) return { kind: 'range', ...mapped };
  return { kind: 'unmapped' };
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

export function MarkedText({ text, ranges }: { text: string; ranges: readonly AttentionMark[] }) {
  const slices = useMemo(
    () => highlightSlices(text, ranges.map((mark) => ({
      id: mark.id,
      start: mark.startOffset,
      end: mark.endOffset,
      text: mark.text,
    }))),
    [text, ranges],
  );
  return (
    <pre>
      {slices.map((slice, index) =>
        slice.markId ? (
          <mark key={`${slice.markId}:${index}`} className="kb-agent-mark" data-agent-mark={slice.markId} data-testid="agent-mark">
            {slice.text}
          </mark>
        ) : (
          <span key={index}>{slice.text}</span>
        ),
      )}
    </pre>
  );
}

type OpenMenu = {
  x: number;
  y: number;
  items: MenuItemState[];
  range: { start: number; end: number; text: string } | null;
  copyText: string;
  hitId: string;
  target: OpenTarget;
};

function previewOffsetAt(root: HTMLElement, x: number, y: number): number | null {
  const doc = root.ownerDocument as Document & { caretRangeFromPoint?: (cx: number, cy: number) => Range | null };
  const caret = doc.caretRangeFromPoint?.(x, y);
  if (!caret || !root.contains(caret.startContainer)) return null;
  return textOffset(root, caret.startContainer, caret.startOffset);
}

function openTargetForClick(source: string, root: HTMLElement | null, event: React.MouseEvent, rangeStart: number | null): OpenTarget {
  if (rangeStart != null) return locateOpenTarget(source, rangeStart);
  if (!root) return {};
  const point = previewOffsetAt(root, event.clientX, event.clientY);
  if (point != null) {
    const mapped = mapPreviewPoint(source, previewPlainText(root), point);
    if (mapped != null) return locateOpenTarget(source, mapped);
  }
  const el = event.target instanceof Element ? event.target : null;
  const heading = el?.closest('h1, h2, h3, h4, h5, h6');
  const text = heading?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  if (text) return locateByHeadingText(source, text);
  return {};
}

export function usePreviewContextMenu(args: {
  active: boolean;
  source: string;
  resourceId: string;
  rootRef: React.RefObject<HTMLElement | null>;
  /** 只有 Markdown 预览才出现「在 Obsidian 打开」。 */
  markdownFile?: boolean;
}): {
  onContextMenu: (event: React.MouseEvent) => void;
  menu: React.ReactNode;
  ranges: AttentionMark[];
  absPath: string;
} {
  const marks = React.useSyncExternalStore(subscribeAgentMarks, readAgentMarks);
  const [absPath, setAbsPath] = useState('');
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  useEffect(() => {
    ensureAgentMarks();
  }, []);

  useEffect(() => {
    let alive = true;
    if (!args.resourceId) {
      setAbsPath('');
      return;
    }
    void kb.resourceAbsPath(args.resourceId).then(
      (next) => {
        if (alive) setAbsPath(next || '');
      },
      () => {
        if (alive) setAbsPath('');
      },
    );
    return () => {
      alive = false;
    };
  }, [args.resourceId]);

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

  const ranges = useMemo(() => marksForPath(marks, absPath), [marks, absPath]);

  const onContextMenu = (event: React.MouseEvent) => {
    if (!args.active) return;
    event.preventDefault();
    event.stopPropagation();
    const root = args.rootRef.current;
    const classified = root ? selectionInPreview(root, args.source) : { kind: 'none' as const };
    const range = classified.kind === 'range' ? classified : null;
    const target = event.target;
    const hit = target instanceof Element ? target.closest('.kb-agent-mark') : null;
    const hitId = hit?.getAttribute('data-agent-mark') ?? '';
    const overlaps = !!range && selectionOverlapsMark(marks, absPath, range.start, range.end);
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
    const openTarget = args.markdownFile ? openTargetForClick(args.source, root, event, range?.start ?? null) : {};
    const showMenu = (fileInRound: boolean) => {
      // 点不了的项照旧置灰显示，不隐藏（用户定）。
      const items = previewContextMenu({
        ...input,
        fileInRound,
        markdownFile: args.markdownFile === true && !!absPath,
      });
      setMenu({ x, y, range, copyText: copyValue, hitId, items, target: openTarget });
    };
    void kb.agentMarksEligible(absPath).then(
      (gate) => showMenu(gate.ok),
      () => showMenu(false),
    );
  };

  const run = (item: MenuItemState) => {
    if (!item.enabled || !menu) return;
    const range = menu.range;
    const hitId = menu.hitId;
    setMenu(null);
    if (item.id === 'copy') {
      if (menu.copyText) void copyText(menu.copyText);
      return;
    }
    if (item.id === 'mark' && range && absPath) {
      const built = markFromSelection(args.source, absPath, range.start, range.end, '', 'draft');
      if (!built) return;
      void addAgentMark({
        absPath: built.absPath,
        startLine: built.startLine,
        endLine: built.endLine,
        startOffset: built.startOffset,
        endOffset: built.endOffset,
        text: built.text,
      }).catch(() => undefined);
      return;
    }
    if (item.id === 'obsidian' && absPath) {
      const target = menu.target;
      void kb.obsidianOpen({ absPath, block: target.block, heading: target.heading }).then(
        (result) => {
          if (result && result.ok === false) {
            void dialogs.alert({ title: '在 Obsidian 打开', body: result.message || '没有打开' });
          }
        },
        (error: unknown) => {
          void dialogs.alert({ title: '在 Obsidian 打开', body: String((error as { message?: string })?.message ?? error) });
        },
      );
      return;
    }
    if (item.id === 'unmark' && absPath) {
      if (range && selectionOverlapsMark(marks, absPath, range.start, range.end)) {
        void unmarkAgentRange(absPath, range.start, range.end).catch(() => undefined);
        return;
      }
      const hitMark = marks.find((row) => row.id === hitId && sameMarkPath(row.absPath, absPath));
      if (hitMark) {
        void unmarkAgentRange(absPath, hitMark.startOffset, hitMark.endOffset).catch(() => undefined);
        return;
      }
      if (range) void unmarkAgentRange(absPath, range.start, range.end).catch(() => undefined);
    }
  };

  const menuNode = menu
    ? createPortal(
        <div
          className="kb-popover menu kb-preview-ctx"
          role="menu"
          data-testid="preview-ctx"
          style={{ left: menu.x, top: menu.y }}
        >
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

  return { onContextMenu, menu: menuNode, ranges, absPath };
}

export function domExcerpts(source: string, ranges: readonly AttentionMark[]): { id: string; text: string; occurrence: number }[] {
  return ranges.map((mark) => ({
    id: mark.id,
    text: mark.text,
    occurrence: occurrenceOf(source, mark.startOffset, mark.text),
  }));
}
