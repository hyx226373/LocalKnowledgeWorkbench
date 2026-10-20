/**
 * 搜索适配层（第 9/10 轮 E）。磐石接口：searchGrouped(db, query, { limit, rootIds }) → GroupedSearchResult。
 * 短查询（<3 码点）走 fts_short；长查询正文走 fts_content。
 * KbSearch 包装真实 searchGrouped；LocalSearch 保留作无正文索引时的文件名兜底。
 * scope=content 时在截断前只留正文命中，并且不把仅文件名的结果当成正文。
 */
import type { WorkbenchService } from '../service/WorkbenchService';
import { CONTENT_SEARCH_UNAVAILABLE_NOTICE, isContentBodyIndexEnabled } from '../../shared/contentIndexScope';

export type MatchKind = 'name' | 'path' | 'content' | 'heading';
export type SearchScope = 'name' | 'content' | 'all';

export interface SearchOpts {
  limit?: number;
  rootIds?: string[];
  scope?: SearchScope;
}

export interface MatchAnchor {
  /** 片段内的高亮区间 */
  start: number;
  end: number;
  /** 文档内锚点（Markdown 行号、PDF 页等），用于打开后定位 */
  anchor?: string;
}
export interface GroupedHit {
  resourceId: string;
  rootId: string;
  relPath: string;
  title: string;
  score: number;
  matchKind: MatchKind;
  page?: number;
  snippet?: string;
  /** 最多 3 个 */
  matches: MatchAnchor[];
  matchesTruncated: boolean;
}
export interface GroupedResult {
  hits: GroupedHit[];
  truncated: boolean;
  reindexRequired?: boolean;
  reindexReason?: string;
  /** r11-E：全文索引不可用时为 true（仅文件名/路径搜索） */
  degraded?: boolean;
  /** 正文索引不可用等原因。空结果仍可能只是没有命中。 */
  notice?: string;
}
export type SearchGroupedFn = (
  db: unknown,
  query: string,
  o: { limit: number; rootIds?: string[]; scope?: SearchScope },
) => GroupedResult | Promise<GroupedResult>;

export interface SearchBackend {
  search(query: string, o?: SearchOpts): Promise<GroupedResult>;
}

/** content 模式下向 indexer 多取一些，避免文件名命中占满 limit 后把正文挤掉。 */
export function contentFetchLimit(limit: number): number {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return Math.min(1000, Math.max(n, n * 20));
}

export function isContentHit(h: { matchKind?: string }): boolean {
  return h.matchKind === 'content' || h.matchKind === 'heading';
}

type RawMatch = {
  matchKind?: string;
  page?: number;
  line?: number | null;
  snippet?: string;
  anchor?: { page: number } | { line: number };
};

/** indexer 常只给命中一个 matchKind。matches 里若有 body，整条按正文算。 */
export function rawIndexerHitIsContent(h: { matchKind?: string; matches?: RawMatch[] | null }): boolean {
  if (h.matchKind === 'body' || h.matchKind === 'content' || h.matchKind === 'heading') return true;
  return Array.isArray(h.matches) && h.matches.some((m) => m?.matchKind === 'body' || m?.matchKind === 'content' || m?.matchKind === 'heading');
}

function mappedMatchKind(h: { matchKind?: string; matches?: RawMatch[] | null }): MatchKind {
  if (h.matchKind === 'heading') return 'heading';
  if (rawIndexerHitIsContent(h)) return 'content';
  return 'name';
}

function pickSnippet(h: { matchKind?: string; snippet?: string; matches?: RawMatch[] | null }): string {
  if (h.matchKind === 'body' || h.matchKind === 'content' || h.matchKind === 'heading') return h.snippet ?? '';
  const body = (h.matches ?? []).find((m) => m && (m.matchKind === 'body' || m.matchKind === 'content' || m.matchKind === 'heading'));
  return body?.snippet || h.snippet || '';
}

/** 把 @kb/indexer 的 GroupedHit 转成我方形状（matchKind body→content；anchor 对象→字符串） */
export function fromIndexerGrouped(r: {
  hits: Array<{
    resourceId: string;
    rootId: string;
    relPath: string;
    title: string;
    score: number;
    matchKind: 'name' | 'body' | string;
    page: number;
    snippet: string;
    matches: RawMatch[];
    matchesTruncated: boolean;
  }>;
  truncated: boolean;
  reindexRequired?: boolean;
  reindexReason?: string;
}): GroupedResult {
  return {
    hits: (r.hits ?? []).map((h) => ({
      resourceId: h.resourceId,
      rootId: h.rootId,
      relPath: h.relPath,
      title: h.title,
      score: h.score,
      matchKind: mappedMatchKind(h),
      page: h.page,
      snippet: pickSnippet(h),
      matches: (h.matches ?? []).map((m) => {
        const anchorObj = m.anchor;
        const anchor = anchorObj && typeof anchorObj === 'object'
          ? ('page' in anchorObj ? `page:${anchorObj.page}` : `line:${'line' in anchorObj ? anchorObj.line : ''}`)
          : '';
        const start = Math.max(0, (m.snippet || '').indexOf('<b>'));
        const hi = (m.snippet || '').match(/<b>(.*?)<\/b>/);
        const len = hi ? [...hi[1]].length : 0;
        return { start: start >= 0 ? start : 0, end: start >= 0 ? start + len : 0, anchor };
      }),
      matchesTruncated: !!h.matchesTruncated,
    })),
    truncated: !!r.truncated,
    ...(r.reindexRequired ? { reindexRequired: true, reindexReason: r.reindexReason } : {}),
  };
}

function filterHits(hits: GroupedHit[], scope: SearchScope): GroupedHit[] {
  if (scope === 'content') return hits.filter((h) => isContentHit(h));
  if (scope === 'name') return hits.filter((h) => !h.matchKind || h.matchKind === 'name' || h.matchKind === 'path');
  return hits;
}

/** 校验并规范化对方返回（matches ≤ 3、rootIds 过滤、limit） */
export function normalizeGrouped(r: GroupedResult, o: { limit: number; rootIds?: string[] }): GroupedResult {
  let hits = Array.isArray(r?.hits) ? r.hits : [];
  if (o.rootIds) hits = hits.filter((h) => o.rootIds!.includes(h.rootId));
  const truncated = !!r?.truncated || hits.length > o.limit;
  hits = hits.slice(0, o.limit).map((h) => {
    const m = Array.isArray(h.matches) ? h.matches : [];
    return { ...h, matches: m.slice(0, 3), matchesTruncated: !!h.matchesTruncated || m.length > 3 };
  });
  return {
    hits,
    truncated,
    ...(r.reindexRequired ? { reindexRequired: r.reindexRequired, reindexReason: r.reindexReason } : {}),
    ...(r.degraded ? { degraded: true } : {}),
    ...(r.notice ? { notice: r.notice } : {}),
  };
}

function normalizeScope(scope: SearchScope | undefined): SearchScope {
  return scope === 'name' || scope === 'content' || scope === 'all' ? scope : 'all';
}

export class KbSearch implements SearchBackend {
  constructor(private fn: SearchGroupedFn, private db: unknown) {}
  async search(query: string, o: SearchOpts = {}) {
    const limit = o.limit ?? 50;
    const scope = normalizeScope(o.scope);
    const fetchLimit = scope === 'content' ? contentFetchLimit(limit) : limit;
    const forward: { limit: number; rootIds?: string[]; scope?: SearchScope } = { limit: fetchLimit };
    if (o.rootIds) forward.rootIds = o.rootIds;
    if (o.scope === 'name' || o.scope === 'content' || o.scope === 'all') forward.scope = o.scope;
    const raw = await this.fn(this.db, query, forward);
    return normalizeGrouped({ ...raw, hits: filterHits(raw?.hits ?? [], scope) }, { limit, rootIds: o.rootIds });
  }
}

/** 把 workbench 资源 ID 映射进去（模块栈搜索命中后按 rootId+relPath 回查主库） */
export class RemappingSearch implements SearchBackend {
  constructor(
    private inner: SearchBackend,
    private resolveId: (rootId: string, relPath: string) => string | null,
  ) {}
  async search(query: string, o?: SearchOpts) {
    const r = await this.inner.search(query, o);
    return {
      ...r,
      hits: r.hits.map((h) => {
        const id = this.resolveId(h.rootId, h.relPath);
        return id ? { ...h, resourceId: id } : h;
      }),
    };
  }
}

export class LocalSearch implements SearchBackend {
  constructor(private svc: WorkbenchService) {}
  async search(query: string, o: SearchOpts = {}) {
    const limit = o.limit ?? 50;
    if (normalizeScope(o.scope) === 'content') {
      return { hits: [], truncated: false, degraded: true, notice: CONTENT_SEARCH_UNAVAILABLE_NOTICE };
    }
    const q = query.trim().toLowerCase();
    const raw = this.svc.search(query, limit + 1).filter((h) => o.rootIds == null || o.rootIds.includes(h.rootId));
    const hits: GroupedHit[] = raw.map((h, i) => {
      const at = h.name.toLowerCase().indexOf(q);
      return {
        resourceId: h.resourceId,
        rootId: h.rootId,
        relPath: h.relPath,
        title: h.name,
        score: 1 / (i + 1),
        matchKind: at >= 0 ? 'name' : 'path',
        snippet: at >= 0 ? h.name : h.relPath,
        matches: at >= 0 && q ? [{ start: at, end: at + q.length }] : [],
        matchesTruncated: false,
      };
    });
    return normalizeGrouped({ hits, truncated: raw.length > limit }, { limit, rootIds: o.rootIds });
  }
}

function contentMiss(r: GroupedResult): GroupedResult {
  if (!r.degraded) return { ...r, hits: [] };
  return { ...r, hits: [], degraded: true, notice: r.notice || CONTENT_SEARCH_UNAVAILABLE_NOTICE };
}

/** 正文优先：KbSearch 有命中用它；否则回退。content 范围下没有正文命中不算命中。 */
export class HybridSearch implements SearchBackend {
  constructor(
    private primary: SearchBackend,
    private fallback: SearchBackend,
    /** content 范围下，主结果没有正文时是否继续问 fallback。仅文件名的那一级传 false。 */
    private fallbackInContent = true,
  ) {}
  async search(query: string, o?: SearchOpts) {
    // 总闸关闭时不要再读 indexer 正文列。主结果里只要有一条命中就会把 png 等文件名短路掉。
    if (!isContentBodyIndexEnabled()) return this.fallback.search(query, o);
    const scope = normalizeScope(o?.scope);
    const primaryResult = await this.primary.search(query, o);
    if (scope !== 'content') {
      if (primaryResult.hits.length > 0) return primaryResult;
      return this.fallback.search(query, o);
    }
    if (primaryResult.hits.some((h) => isContentHit(h))) {
      return { ...primaryResult, hits: primaryResult.hits.filter((h) => isContentHit(h)) };
    }
    if (!this.fallbackInContent) return contentMiss(primaryResult);
    const next = await this.fallback.search(query, o);
    if (next.hits.some((h) => isContentHit(h))) {
      return { ...next, hits: next.hits.filter((h) => isContentHit(h)) };
    }
    const degraded = !!(primaryResult.degraded || next.degraded);
    return contentMiss({
      ...next,
      hits: [],
      ...(degraded ? { degraded: true } : {}),
      notice: next.notice || primaryResult.notice,
    });
  }
}

/** 强制标记 degraded（local-fallback 时包一层 LocalSearch） */
export class DegradedSearch implements SearchBackend {
  constructor(private inner: SearchBackend, private degraded = true) {}
  async search(query: string, o?: SearchOpts) {
    const r = await this.inner.search(query, o);
    return this.degraded ? { ...r, degraded: true } : r;
  }
}
