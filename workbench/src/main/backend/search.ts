/**
 * 搜索适配层（第 9/10 轮 E）。磐石接口：searchGrouped(db, query, { limit, rootIds }) → GroupedSearchResult。
 * 短查询（<3 码点）走 fts_short；长查询正文走 fts_content。
 * KbSearch 包装真实 searchGrouped；LocalSearch 保留作无正文索引时的文件名兜底。
 */
import type { WorkbenchService } from '../service/WorkbenchService';

export type MatchKind = 'name' | 'path' | 'content' | 'heading';
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
}
export type SearchGroupedFn = (db: unknown, query: string, o: { limit: number; rootIds?: string[] }) => GroupedResult | Promise<GroupedResult>;

export interface SearchBackend {
  search(query: string, o?: { limit?: number; rootIds?: string[] }): Promise<GroupedResult>;
}

/** 把 @kb/indexer 的 GroupedHit 转成我方形状（matchKind body→content；anchor 对象→字符串） */
export function fromIndexerGrouped(r: {
  hits: Array<{
    resourceId: string;
    rootId: string;
    relPath: string;
    title: string;
    score: number;
    matchKind: 'name' | 'body';
    page: number;
    snippet: string;
    matches: Array<{ page: number; line: number | null; snippet: string; anchor: { page: number } | { line: number } }>;
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
      matchKind: h.matchKind === 'body' ? 'content' : 'name',
      page: h.page,
      snippet: h.snippet,
      matches: (h.matches ?? []).map((m) => {
        const anchor = 'page' in m.anchor ? `page:${m.anchor.page}` : `line:${m.anchor.line}`;
        const start = Math.max(0, (m.snippet || '').indexOf('<b>'));
        const raw = (m.snippet || '').replace(/<\/?b>/g, '');
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
  };
}

export class KbSearch implements SearchBackend {
  constructor(private fn: SearchGroupedFn, private db: unknown) {}
  async search(query: string, o: { limit?: number; rootIds?: string[] } = {}) {
    const limit = o.limit ?? 50;
    return normalizeGrouped(await this.fn(this.db, query, { limit, rootIds: o.rootIds }), { limit, rootIds: o.rootIds });
  }
}

/** 把 workbench 资源 ID 映射进去（模块栈搜索命中后按 rootId+relPath 回查主库） */
export class RemappingSearch implements SearchBackend {
  constructor(
    private inner: SearchBackend,
    private resolveId: (rootId: string, relPath: string) => string | null,
  ) {}
  async search(query: string, o?: { limit?: number; rootIds?: string[] }) {
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
  async search(query: string, o: { limit?: number; rootIds?: string[] } = {}) {
    const limit = o.limit ?? 50;
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

/** 正文优先：KbSearch 有命中用它；否则回退 LocalSearch（文件名） */
export class HybridSearch implements SearchBackend {
  constructor(private primary: SearchBackend, private fallback: SearchBackend) {}
  async search(query: string, o?: { limit?: number; rootIds?: string[] }) {
    const r = await this.primary.search(query, o);
    if (r.hits.length > 0) return r;
    return this.fallback.search(query, o);
  }
}

/** 强制标记 degraded（local-fallback 时包一层 LocalSearch） */
export class DegradedSearch implements SearchBackend {
  constructor(private inner: SearchBackend, private degraded = true) {}
  async search(query: string, o?: { limit?: number; rootIds?: string[] }) {
    const r = await this.inner.search(query, o);
    return this.degraded ? { ...r, degraded: true } : r;
  }
}
