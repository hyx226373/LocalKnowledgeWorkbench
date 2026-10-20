/**
 * 辅助搜索的宿主侧注册表与调度（r21 §3）。
 * 没有 provider 时，搜索框插槽和结果分段都返回 null，不占宽度。
 * 片段只保留纯文本，宿主用文本节点渲染，不接收 HTML。
 */
import { createElement, type MouseEvent, type ReactNode } from 'react';
import type { Disposable } from '../../shared/adapter-sdk/types';
import type { SearchProviderContext, SearchProviderHit, SearchProviderTarget } from '../../shared/searchProvider';

export const SEARCH_PROVIDER_DEBOUNCE_MS = 200;
export const SEARCH_PROVIDER_TIMEOUT_MS = 1500;
export const SEARCH_PROVIDER_VISIBLE_LIMIT = 5;
export const SEARCH_PROVIDER_ERROR_TEXT = '出错';

export interface HostSearchProvider {
  id: string;
  label: string;
  icon?: string;
  search(query: string, ctx: SearchProviderContext, signal: AbortSignal): Promise<SearchProviderHit[]>;
  onAction?(action: string, payload: unknown): void;
}

export interface ProviderSection {
  id: string;
  label: string;
  /** aborted：这一轮已被取消，宿主不渲染。timeout 与 error 只在该段显示「出错」。 */
  status: 'ok' | 'error' | 'timeout' | 'aborted';
  hits: SearchProviderHit[];
  visible: SearchProviderHit[];
  more: number;
}

const providers = new Map<string, HostSearchProvider>();
const listeners = new Set<() => void>();
const EMPTY: HostSearchProvider[] = [];
let snapshot: HostSearchProvider[] = EMPTY;

function emit(): void {
  snapshot = providers.size ? [...providers.values()] : EMPTY;
  for (const listener of [...listeners]) listener();
}

export function listSearchProviders(): HostSearchProvider[] {
  return snapshot;
}

export function subscribeSearchProviders(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function registerHostSearchProvider(p: HostSearchProvider): Disposable {
  providers.set(p.id, p);
  emit();
  return {
    dispose() {
      if (providers.get(p.id) === p) {
        providers.delete(p.id);
        emit();
      }
    },
  };
}

export function resetSearchProvidersForTests(): void {
  providers.clear();
  emit();
}

export function plainText(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/<[^>]*>/g, '').replace(/[<>]/g, '');
}

function validTarget(target: SearchProviderHit['target'] | undefined): target is SearchProviderHit['target'] {
  if (!target || typeof target !== 'object') return false;
  if (typeof (target as { resourceId?: unknown }).resourceId === 'string') return true;
  if (typeof (target as { rootId?: unknown }).rootId === 'string' && typeof (target as { relPath?: unknown }).relPath === 'string') return true;
  if (typeof (target as { action?: unknown }).action === 'string') return true;
  return false;
}

function sanitizeHit(hit: SearchProviderHit): SearchProviderHit | null {
  if (!validTarget(hit.target)) return null;
  const title = plainText(hit.title);
  if (!title) return null;
  const subtitle = hit.subtitle ? plainText(hit.subtitle) : '';
  const snippet = hit.snippet ? plainText(hit.snippet) : '';
  return {
    title,
    ...(subtitle ? { subtitle } : {}),
    ...(snippet ? { snippet } : {}),
    target: hit.target,
  };
}

export function applyExpanded(sections: readonly ProviderSection[], expanded: ReadonlySet<string>): ProviderSection[] {
  return sections.map((section) => {
    if (section.status !== 'ok') return { ...section, visible: [], more: 0 };
    if (expanded.has(section.id) || section.hits.length <= SEARCH_PROVIDER_VISIBLE_LIMIT) {
      return { ...section, visible: section.hits, more: 0 };
    }
    return {
      ...section,
      visible: section.hits.slice(0, SEARCH_PROVIDER_VISIBLE_LIMIT),
      more: section.hits.length - SEARCH_PROVIDER_VISIBLE_LIMIT,
    };
  });
}

function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function emptySection(provider: HostSearchProvider, status: ProviderSection['status']): ProviderSection {
  return { id: provider.id, label: provider.label, status, hits: [], visible: [], more: 0 };
}

export async function queryOneProvider(
  provider: HostSearchProvider,
  query: string,
  ctx: SearchProviderContext,
  signal: AbortSignal,
  timeoutMs = SEARCH_PROVIDER_TIMEOUT_MS,
): Promise<ProviderSection> {
  if (signal.aborted) return emptySection(provider, 'aborted');
  const child = new AbortController();
  const onAbort = () => child.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const raw = await withTimeout(provider.search(query, ctx, child.signal), timeoutMs, child.signal);
    const hits = (Array.isArray(raw) ? raw : [])
      .filter((hit) => hit && typeof hit.title === 'string')
      .map(sanitizeHit)
      .filter((hit): hit is SearchProviderHit => hit !== null);
    const more = Math.max(0, hits.length - SEARCH_PROVIDER_VISIBLE_LIMIT);
    return {
      id: provider.id,
      label: provider.label,
      status: 'ok',
      hits,
      visible: hits.slice(0, SEARCH_PROVIDER_VISIBLE_LIMIT),
      more,
    };
  } catch (err) {
    const code = (err as { code?: string; name?: string })?.code;
    const name = (err as { name?: string })?.name;
    if (code === 'timeout') {
      child.abort();
      return emptySection(provider, 'timeout');
    }
    if (name === 'AbortError' || signal.aborted || child.signal.aborted) return emptySection(provider, 'aborted');
    return emptySection(provider, 'error');
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** 输入防抖 200ms。新一轮开始时 abort 上一轮。单个 provider 的失败留在自己的段里。 */
export class AuxiliarySearchRunner {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private round: AbortController | undefined;
  private generation = 0;

  schedule(
    query: string,
    ctx: SearchProviderContext,
    list: readonly HostSearchProvider[],
    onResult: (sections: ProviderSection[]) => void,
  ): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.round?.abort();
    this.round = undefined;
    const gen = ++this.generation;
    const q = query.trim();
    if (!q || list.length === 0) {
      onResult([]);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const ac = new AbortController();
      this.round = ac;
      void Promise.all(list.map((provider) => queryOneProvider(provider, q, ctx, ac.signal))).then((sections) => {
        if (gen !== this.generation || ac.signal.aborted) return;
        onResult(sections.filter((section) => section.status !== 'aborted'));
      });
    }, SEARCH_PROVIDER_DEBOUNCE_MS);
  }

  dispose(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.round?.abort();
    this.round = undefined;
  }
}

/** 有插件时结果区先标「文件名」。没有插件时返回 null，调用方不渲染这一段。 */
export function filenameSectionLabel(list: readonly unknown[]): string | null {
  return list.length > 0 ? '文件名' : null;
}

export function dispatchSearchAction(providerId: string, action: string, payload: unknown): void {
  providers.get(providerId)?.onAction?.(action, payload);
}

export function isResourceTarget(target: SearchProviderTarget): target is { resourceId: string } {
  return typeof (target as { resourceId?: unknown }).resourceId === 'string';
}

export function isPathTarget(target: SearchProviderTarget): target is { rootId: string; relPath: string } {
  const t = target as { rootId?: unknown; relPath?: unknown };
  return typeof t.rootId === 'string' && typeof t.relPath === 'string' && !('resourceId' in target);
}

export function isActionTarget(target: SearchProviderTarget): target is { action: string; payload?: unknown } {
  return typeof (target as { action?: unknown }).action === 'string' && !('resourceId' in target) && !('relPath' in target);
}

function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text;
  return createElement(
    'span',
    null,
    text.slice(0, at),
    createElement('mark', { className: 'kb-search-mark' }, text.slice(at, at + q.length)),
    text.slice(at + q.length),
  );
}

/** 无插件时返回 null，不占宽度。 */
export function SearchBoxAddon({ providers: list }: { providers: readonly HostSearchProvider[] }): ReactNode {
  if (!list.length) return null;
  return createElement(
    'span',
    { className: 'search-box-addon', 'data-testid': 'search-box-addon' },
    list.map((provider) =>
      createElement(
        'span',
        {
          key: provider.id,
          className: 'search-box-addon-item',
          title: provider.label,
          'data-provider': provider.id,
        },
        provider.icon ? plainText(provider.icon) : plainText(provider.label).slice(0, 1),
      ),
    ),
  );
}

export function SearchProviderSections({
  sections,
  query,
  selectedKey,
  onOpen,
  onMore,
}: {
  sections: readonly ProviderSection[];
  query: string;
  selectedKey?: string;
  onOpen: (sectionId: string, hit: SearchProviderHit) => void;
  onMore: (sectionId: string) => void;
}): ReactNode {
  const shown = sections.filter((section) => section.status !== 'aborted');
  if (!shown.length) return null;
  return createElement(
    'div',
    { className: 'kb-search-provider-sections', 'data-testid': 'search-provider-sections' },
    shown.map((section) =>
      createElement(
        'section',
        { key: section.id, 'data-testid': 'search-provider-section', 'data-provider': section.id },
        createElement('div', { className: 'kb-search-section-title', 'data-testid': 'search-provider-label' }, section.label),
        section.status !== 'ok'
          ? createElement(
              'div',
              { className: 'kb-search-hit', 'data-testid': 'search-provider-error', role: 'status' },
              SEARCH_PROVIDER_ERROR_TEXT,
            )
          : section.visible.map((hit, index) => {
              const key = `${section.id}:${index}:${hit.title}`;
              return createElement(
                'div',
                {
                  key,
                  className: 'kb-search-hit',
                  'data-testid': 'search-provider-hit',
                  'aria-selected': selectedKey === key ? 'true' : undefined,
                  onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
                    event.preventDefault();
                    onOpen(section.id, hit);
                  },
                },
                createElement('div', null, highlight(hit.title, query)),
                hit.subtitle ? createElement('div', { className: 'p' }, hit.subtitle) : null,
                hit.snippet
                  ? createElement('div', { className: 'p', 'data-testid': 'search-provider-snippet' }, highlight(hit.snippet, query))
                  : null,
              );
            }),
        section.more > 0
          ? createElement(
              'button',
              {
                type: 'button',
                className: 'kb-search-more',
                'data-testid': 'search-provider-more',
                onMouseDown: (event: MouseEvent<HTMLButtonElement>) => {
                  event.preventDefault();
                  onMore(section.id);
                },
              },
              '更多',
            )
          : null,
      ),
    ),
  );
}
