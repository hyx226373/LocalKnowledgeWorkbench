/**
 * 控制台阅读壳。默认只渲染索引，不调用开整组。
 * 阅读模式是可操作列表；编辑模式改文本定义。
 */
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import {
  executableIndex,
  KB_RESOURCE_MIME,
  openAsLabel,
  orderedItems,
  parseConsoleDocument,
  type ConsoleFenceBlock,
  type ConsoleIndex,
  type ConsoleIndexItem,
} from '../../shared/consoleSchema';
import { consoleBlockRegistry } from '../plugin-host/registry';
import { safeConsoleContext, type ConsoleBlockContext } from './blockContext';
import './console.css';

export function ConsoleScreen({
  name,
  text,
  onText,
  onSave,
  onOpenItem,
  onOpenGroup,
  onIndexDrop,
  onDropRejected,
  notice,
  blockContext,
}: {
  name: string;
  text: string;
  onText?: (next: string) => void;
  onSave?: () => void;
  onOpenItem: (item: ConsoleIndexItem) => void;
  onOpenGroup: (index: ConsoleIndex) => void;
  /** 编辑态放下 application/x-kb-resource+json。调用方只改控制台文本。 */
  onIndexDrop?: (raw: string) => void;
  onDropRejected?: () => void;
  notice?: string | null;
  blockContext?: ConsoleBlockContext;
}) {
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [dropOver, setDropOver] = useState(false);
  const parsed = useMemo(() => parseConsoleDocument(text), [text]);
  const index = executableIndex(parsed);
  const title = parsed.title || name.replace(/\.kbconsole\.md$/i, '').replace(/\.md$/i, '');
  const items = index ? orderedItems(index.items) : [];
  const acceptDrop = (event: DragEvent) => {
    event.preventDefault();
    setDropOver(true);
  };
  const finishDrop = (event: DragEvent, edit: boolean) => {
    event.preventDefault();
    setDropOver(false);
    const raw = event.dataTransfer.getData(KB_RESOURCE_MIME);
    if (!raw) return;
    if (edit) onIndexDrop?.(raw);
    else onDropRejected?.();
  };
  return (
    <div className="kb-console" data-testid="console-root" data-auto-open="off" data-mode={mode}>
      <div className="kb-console-head">
        <h1 data-testid="console-title">{title}</h1>
        <div>
          <button type="button" className="kb-button kb-button--secondary" data-testid="console-mode-read" onClick={() => { setDropOver(false); setMode('read'); }}>
            阅读
          </button>
          <button type="button" className="kb-button kb-button--secondary" data-testid="console-mode-edit" onClick={() => { setDropOver(false); setMode('edit'); }}>
            编辑
          </button>
        </div>
      </div>
      {index?.titleNote ? <p className="kb-console-note" data-testid="console-title-note">{index.titleNote}</p> : null}
      {parsed.frontMatter.description && parsed.frontMatter.description !== index?.titleNote ? <p className="kb-console-note">{parsed.frontMatter.description}</p> : null}
      {notice ? <div className="kb-banner kb-editor-banner" data-testid="console-notice">{notice}</div> : null}
      {parsed.primary?.ignoredFields?.length ? <div className="kb-notice">已忽略文件内的 {parsed.primary.ignoredFields.join('、')}，不会据此批准。</div> : null}
      {mode === 'read' && index ? (
        <div
          className="kb-console-drop"
          data-testid="console-index-drop"
          data-drop="read"
          data-over={dropOver ? '1' : '0'}
          title="加入控制台索引（不移动原文件）"
          onDragEnter={acceptDrop}
          onDragOver={acceptDrop}
          onDragLeave={() => setDropOver(false)}
          onDrop={(event) => finishDrop(event, false)}
        >
          {dropOver ? <div className="kb-console-drop-hint" data-testid="console-drop-hint">加入控制台索引（不移动原文件）</div> : null}
          <ul className="kb-console-list" data-testid="console-index">
            {items.map((item) => (
              <li key={item.id} className="kb-console-item" data-testid="console-item" data-id={item.id} data-order={item.order}>
                <strong>{item.title}</strong>
                <button type="button" className="kb-button" data-testid="console-open-one" onClick={() => onOpenItem(item)}>
                  开单项
                </button>
                {item.note ? <div className="meta">{item.note}</div> : null}
                <div className="meta">{openAsLabel(item.openAs)}</div>
              </li>
            ))}
          </ul>
          <button type="button" className="kb-button" data-testid="console-open-group" onClick={() => onOpenGroup(index)}>
            开整组
          </button>
        </div>
      ) : null}
      {mode === 'edit' ? (
        <div
          className="kb-console-drop"
          data-testid="console-index-drop"
          data-drop="edit"
          data-over={dropOver ? '1' : '0'}
          title="加入控制台索引（不移动原文件）"
          onDragEnter={acceptDrop}
          onDragOver={acceptDrop}
          onDragLeave={() => setDropOver(false)}
          onDrop={(event) => finishDrop(event, true)}
        >
          {dropOver ? <div className="kb-console-drop-hint" data-testid="console-drop-hint">加入控制台索引（不移动原文件）</div> : null}
          <textarea className="kb-console-source" data-testid="console-source" value={text} spellCheck={false} onChange={(e) => onText?.(e.target.value)} />
          {onSave ? (
            <button type="button" className="kb-button" data-testid="console-save" onClick={onSave}>
              保存定义
            </button>
          ) : null}
        </div>
      ) : null}
      {parsed.blocks.map((block, i) => (
        <BlockView key={`${block.start}-${i}`} block={block} ctx={blockContext} />
      ))}
    </div>
  );
}

function BlockView({ block, ctx }: { block: ConsoleFenceBlock; ctx?: ConsoleBlockContext }) {
  if (block.kind === 'console' && block.status === 'ok') return null;
  if (block.status === 'unknown-version') {
    return (
      <div className="kb-notice" data-testid="console-unknown-version">
        未知控制台版本
        <pre>{block.rawBody}</pre>
      </div>
    );
  }
  if (block.status === 'invalid') {
    return (
      <div className="kb-notice" data-testid="console-block-error">
        {block.error}
      </div>
    );
  }
  const contrib = block.kind ? consoleBlockRegistry.get(block.kind) : undefined;
  if (!contrib || (block.version ?? 0) > contrib.version) {
    if (contrib) {
      return (
        <div className="kb-notice" data-testid="console-unknown-version">
          未知控制台版本
          <pre>{block.rawBody}</pre>
        </div>
      );
    }
    return <pre data-testid="console-unknown-kind">{JSON.stringify(block.data, null, 2)}</pre>;
  }
  return <PluginBlockHost kind={contrib.kind} version={block.version ?? contrib.version} data={block.data} ctx={ctx} />;
}

function PluginBlockHost({ kind, version, data, ctx }: { kind: string; version: number; data: unknown; ctx?: ConsoleBlockContext }) {
  const [element, setElement] = useState<unknown>(null);
  useEffect(() => {
    const contrib = consoleBlockRegistry.get(kind);
    if (!contrib) return;
    const safe = safeConsoleContext(
      ctx ?? {
        commands: { execute: async () => undefined },
        ops: { propose: async () => undefined },
        log: () => {},
      },
    );
    const rendered = contrib.render({ version, data }, safe);
    setElement(rendered.element ?? null);
    return () => rendered.dispose();
  }, [kind, version, data, ctx]);
  return <div data-testid="console-plugin-block">{element as never}</div>;
}
