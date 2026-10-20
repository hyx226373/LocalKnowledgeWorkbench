import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { formatViewState, type FormatViewState } from '../../../shared/formats/state';
import type { Asset, Block, DocModel } from '../../../shared/formats/types';

export const FORMAT_SCALE_MIN = 0.5;
export const FORMAT_SCALE_MAX = 3;

const FOLDER_CODES = new Set(['encrypted', 'too-large', 'timeout']);

export function persistFormatState(input: FormatViewState | Record<string, unknown>): FormatViewState {
  const next = formatViewState(input as Record<string, unknown>);
  if (next.page !== undefined) next.page = Math.max(1, Math.floor(next.page));
  if (next.sheet !== undefined) next.sheet = Math.max(1, Math.floor(next.sheet));
  if (next.slide !== undefined) next.slide = Math.max(1, Math.floor(next.slide));
  if (next.scroll !== undefined) next.scroll = Math.min(1, Math.max(0, next.scroll));
  if (next.scale !== undefined) next.scale = Math.min(FORMAT_SCALE_MAX, Math.max(FORMAT_SCALE_MIN, next.scale));
  return next;
}

export function restoreFormatState(raw: unknown): FormatViewState | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return persistFormatState(raw as Record<string, unknown>);
}

export function scrollRatio(scrollTop: number, scrollHeight: number, clientHeight: number): number | undefined {
  const max = scrollHeight - clientHeight;
  if (!(clientHeight > 0) || !(max > 0)) return undefined;
  return Math.min(1, Math.max(0, scrollTop / max));
}

function clampIndex(value: number | undefined, count: number): number {
  if (count < 1) return 1;
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return Math.min(count, Math.max(1, n));
}

function assetSrc(asset: Asset | undefined): string | undefined {
  if (!asset?.bytes?.byteLength) return undefined;
  let binary = '';
  const bytes = asset.bytes;
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${asset.mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function RunText({ text, runs }: { text: string; runs?: { text: string; bold?: boolean; italic?: boolean }[] }) {
  if (!runs || runs.length === 0) return text;
  return runs.map((run, index) => {
    let body: React.ReactNode = run.text;
    if (run.italic) body = <em>{body}</em>;
    if (run.bold) body = <strong>{body}</strong>;
    return <span key={index}>{body}</span>;
  });
}

function Blocks({ blocks, assets }: { blocks: Block[]; assets: Asset[] }) {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (blocks.length === 0) return <p data-testid="format-empty">没有可显示的内容</p>;
  return (
    <article className="kb-md">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          const level = Math.min(6, Math.max(1, Math.floor(block.level) || 1));
          return React.createElement(`h${level}`, { key: index }, <RunText text={block.text} runs={block.runs} />);
        }
        if (block.type === 'paragraph') return (
          <p key={index}>
            <RunText text={block.text} runs={block.runs} />
          </p>
        );
        if (block.type === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{item}</li>
              ))}
            </Tag>
          );
        }
        if (block.type === 'table') {
          return (
            <table key={index} className="kb-table">
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === 'image') {
          const src = assetSrc(byId.get(block.assetId));
          return <img key={index} data-testid="format-image" data-asset-id={block.assetId} alt={block.alt ?? ''} {...(src ? { src } : {})} />;
        }
        return (
          <p key={index} data-testid="format-unsupported-block">
            {block.text}
          </p>
        );
      })}
    </article>
  );
}

function Grid({ rows }: { rows: string[][] }) {
  if (rows.length === 0) return <p data-testid="format-empty">这一张是空的</p>;
  return (
    <table className="kb-table" data-testid="format-grid">
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function FormatStage({
  doc,
  failure,
  state,
  onState,
  onShowInFolder,
}: {
  doc?: DocModel;
  failure?: { code: string; message: string };
  state: FormatViewState;
  onState: (next: FormatViewState) => void;
  onShowInFolder?: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (!restored.current) {
      restored.current = true;
      const ratio = stateRef.current.scroll;
      if (typeof ratio !== 'number' || !(ratio > 0)) return;
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
      return;
    }
    if ((stateRef.current.scroll ?? 0) === 0) el.scrollTop = 0;
  }, [doc, state.page, state.sheet, state.slide]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const ratio = scrollRatio(el.scrollTop, el.scrollHeight, el.clientHeight);
        if (ratio === undefined) return;
        onStateRef.current(persistFormatState({ ...stateRef.current, scroll: +ratio.toFixed(4) }));
      }, 250);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      el.removeEventListener('scroll', onScroll);
    };
  }, [doc]);

  const warnings = [...(doc?.warnings ?? [])];
  if (failure && doc && !warnings.includes(failure.message)) warnings.push(failure.message);
  const folder = !!failure && (FOLDER_CODES.has(failure.code) || !doc);
  const folderButton = folder ? (
    <button type="button" className="kb-button kb-button--secondary" data-testid="format-show-folder" onClick={() => onShowInFolder?.()}>
      在资源管理器中显示
    </button>
  ) : null;

  if (!doc) {
    return (
      <div className="kb-notice" data-testid="format-error" data-code={failure?.code ?? 'corrupt'}>
        <p>{failure?.message ?? '文件已损坏，无法阅读。'}</p>
        {folderButton}
      </div>
    );
  }

  const scale = state.scale ?? 1;
  const patch = (partial: FormatViewState) => onState(persistFormatState({ ...state, ...partial }));

  let index = 1;
  let count = 1;
  let body: React.ReactNode = null;
  if (doc.kind === 'flow') {
    count = doc.blocks.length;
    body = (
      <div data-testid="format-flow" data-count={count}>
        <Blocks blocks={doc.blocks} assets={doc.assets} />
      </div>
    );
  } else if (doc.kind === 'sheets') {
    count = doc.sheets.length;
    index = clampIndex(state.sheet, count);
    const sheet = doc.sheets[index - 1];
    body = (
      <div data-testid="format-sheets" data-count={count} data-index={index}>
        {count === 0 ? <p data-testid="format-empty">没有工作表</p> : <Grid rows={sheet?.rows ?? []} />}
      </div>
    );
  } else if (doc.kind === 'slides') {
    count = doc.slides.length;
    index = clampIndex(state.slide, count);
    const slide = doc.slides[index - 1];
    body = (
      <div data-testid="format-slides" data-count={count} data-index={index}>
        <Blocks blocks={slide?.blocks ?? []} assets={doc.assets} />
        {slide?.notes ? <p data-testid="format-notes">{slide.notes}</p> : null}
      </div>
    );
  } else {
    count = doc.pages.length;
    index = clampIndex(state.page, count);
    const page = doc.pages[index - 1];
    body = (
      <div data-testid="format-paged" data-count={count} data-index={index}>
        <Blocks blocks={page?.blocks ?? []} assets={doc.assets} />
      </div>
    );
  }

  const pagerLabel = doc.kind === 'slides' ? '张' : '页';
  const step = (delta: number) => {
    const next = index + delta;
    if (doc.kind === 'slides') patch({ slide: next, scroll: 0 });
    else patch({ page: next, scroll: 0 });
  };
  const zoom = (next: number) => patch({ scale: Math.round(next * 100) / 100 });

  return (
    <div
      className="kb-reading reader format"
      data-testid="format-stage"
      data-kind={doc.kind}
      data-page={doc.kind === 'paged' ? index : undefined}
      data-sheet={doc.kind === 'sheets' ? index : undefined}
      data-slide={doc.kind === 'slides' ? index : undefined}
      data-scale={scale}
      data-scroll={state.scroll ?? 0}
      ref={scroller}
      style={{ '--content-zoom': String(scale) } as React.CSSProperties}
    >
      {warnings.length > 0 && (
        <div className="kb-banner" data-tone="warning" data-testid="format-warnings" role="status">
          {warnings.map((warning, warningIndex) => (
            <span key={`${warning}:${warningIndex}`}>{warning}</span>
          ))}
        </div>
      )}
      <div className="kb-view-toolbar" data-testid="format-toolbar">
        {doc.kind === 'sheets'
          ? doc.sheets.map((sheet, sheetIndex) => (
              <button
                key={`${sheet.name}:${sheetIndex}`}
                type="button"
                className="kb-button kb-button--secondary"
                data-testid="format-sheet-tab"
                data-index={sheetIndex + 1}
                aria-pressed={sheetIndex + 1 === index}
                onClick={() => patch({ sheet: sheetIndex + 1, scroll: 0 })}
              >
                {sheet.name}
              </button>
            ))
          : doc.kind !== 'flow' && (
              <>
                <button type="button" className="kb-button kb-button--secondary" data-testid="format-prev" disabled={index <= 1} onClick={() => step(-1)}>
                  上一{pagerLabel}
                </button>
                <span data-testid="format-position">
                  第 {index} / {count} {pagerLabel}
                </span>
                <button type="button" className="kb-button kb-button--secondary" data-testid="format-next" disabled={index >= count} onClick={() => step(1)}>
                  下一{pagerLabel}
                </button>
              </>
            )}
        {doc.kind === 'sheets' && (
          <span data-testid="format-position">
            第 {index} / {count} 个工作表
          </span>
        )}
        <button type="button" className="kb-button kb-button--secondary" data-testid="format-zoom-out" onClick={() => zoom(scale - 0.1)}>
          缩小
        </button>
        <button type="button" className="kb-button kb-button--secondary" data-testid="format-zoom-reset" onClick={() => zoom(1)}>
          重置
        </button>
        <button type="button" className="kb-button kb-button--secondary" data-testid="format-zoom-in" onClick={() => zoom(scale + 0.1)}>
          放大
        </button>
        {folderButton}
      </div>
      {body}
    </div>
  );
}
