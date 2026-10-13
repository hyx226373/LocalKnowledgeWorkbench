/**
 * 布局缩略图卡片。只画 LayoutThumbModel。
 * 不截图，不读文件正文，不启动应用。
 * generate 只在卡片根进入视口后调用一次；视口外与缺省都不调用。
 */
import { useEffect, useRef } from 'react';
import { clipCodePoints } from '../../shared/workspacePicker/normalize';
import { WORKSPACE_CARD_CLASS, type LayoutThumbModel, type LayoutThumbNode } from '../../shared/workspacePicker/types';
import './layoutThumb.css';

const SHORT_NAME_MAX = 8;

export interface LayoutThumbProps {
  model: LayoutThumbModel;
  selected?: boolean;
  favorite?: boolean;
  /** 进入视口才调用，参数为 model.cacheKey。不传则不生成。 */
  generate?: (cacheKey: string) => void;
  /** 嵌在总览卡片里时只画缩略图，不再套一层卡片 class。缺省仍是独立卡片。 */
  embedded?: boolean;
}

interface ThumbObserver {
  observe(target: Element): void;
  disconnect(): void;
}

type ThumbObserverCtor = new (callback: IntersectionObserverCallback) => ThumbObserver;

/** 假观察器或真实 IntersectionObserver 都走这里。未相交不调用 generate。 */
export function observeThumbEnter(
  target: Element,
  cacheKey: string,
  generate: (cacheKey: string) => void,
  ObserverCtor: ThumbObserverCtor | undefined = globalThis.IntersectionObserver,
): () => void {
  if (typeof ObserverCtor !== 'function') return () => {};
  let stopped = false;
  const obs = new ObserverCtor((entries) => {
    if (stopped) return;
    const entered = entries.some((entry) => entry.isIntersecting && (entry.target == null || entry.target === target));
    if (!entered) return;
    stopped = true;
    obs.disconnect();
    generate(cacheKey);
  });
  obs.observe(target);
  return () => {
    stopped = true;
    obs.disconnect();
  };
}

function safeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** 百分比保留到 0.01，去掉二进制小数尾巴。 */
function percent(n: number): string {
  const scaled = Math.round(clamp01(n) * 10000) / 100;
  return `${Number(scaled.toFixed(2))}%`;
}

function nodeRect(node: LayoutThumbNode): { x: number; y: number; w: number; h: number } {
  // 最大化铺满内容区。收起/隐藏沿用模型矩形（气泡或原格）。
  if (node.flags.maximized) return { x: 0, y: 0, w: 1, h: 1 };
  const rect = node.rect;
  return {
    x: clamp01(rect?.x),
    y: clamp01(rect?.y),
    w: clamp01(rect?.w),
    h: clamp01(rect?.h),
  };
}

export function LayoutThumb({ model, selected = false, favorite = false, generate, embedded = false }: LayoutThumbProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const cacheKey = model.cacheKey;
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !generate) return;
    return observeThumbEnter(el, cacheKey, generate);
  }, [cacheKey, generate]);

  const aspect = safeAspect(model.aspect);
  const className = embedded
    ? 'kb-ws-thumb-frame'
    : [WORKSPACE_CARD_CLASS.root, selected ? WORKSPACE_CARD_CLASS.selected : '', favorite ? WORKSPACE_CARD_CLASS.favorite : '']
        .filter(Boolean)
        .join(' ');
  const nodes = Array.isArray(model.nodes) ? model.nodes : [];

  return (
    <div ref={rootRef} className={className} data-cache-key={cacheKey}>
      <div className="kb-ws-thumb" data-node-count={nodes.length} style={{ aspectRatio: String(aspect) }}>
        {nodes.map((node) => {
          const rect = nodeRect(node);
          const raw = typeof node.shortName === 'string' ? node.shortName : '';
          const shown = clipCodePoints(raw, SHORT_NAME_MAX);
          const iconKey = typeof node.iconKey === 'string' ? node.iconKey : 'unknown';
          const flags = node.flags ?? {};
          const unknown = node.unknown === true;
          const nodeClass = [
            'kb-ws-thumb-node',
            flags.collapsed ? 'is-collapsed' : '',
            flags.hidden ? 'is-hidden' : '',
            flags.maximized ? 'is-maximized' : '',
            unknown ? 'is-unknown' : '',
          ]
            .filter(Boolean)
            .join(' ');
          return (
            <div
              key={node.id}
              className={nodeClass}
              data-node-id={node.id}
              data-kind={node.kind}
              data-icon-key={iconKey}
              data-collapsed={flags.collapsed ? 'true' : 'false'}
              data-hidden={flags.hidden ? 'true' : 'false'}
              data-maximized={flags.maximized ? 'true' : 'false'}
              data-unknown={unknown ? 'true' : 'false'}
              style={{ left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h) }}
            >
              <span className="kb-ws-thumb-icon" data-icon-key={iconKey}>
                {iconKey}
              </span>
              <span className="kb-ws-thumb-name">{shown}</span>
              {unknown ? <span className="kb-ws-thumb-placeholder">未知</span> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
