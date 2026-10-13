/**
 * Markdown「回到目录」。目标只根据已经渲染的标题和前部列表算一次。
 * slugify 与标题 id 用同一套规则。
 */

export function slugify(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

const TOC_LABELS = new Set(['目录', '目次', 'contents', 'table of contents', 'toc']);

export function isTocHeadingText(text: string): boolean {
  return TOC_LABELS.has(text.trim().toLowerCase().replace(/\s+/g, ' '));
}

/** 先按 href 原样找 id，找不到再用 kb-h- + slugify。找不到返回 null。 */
export function resolveDocHash(href: string, ids: ReadonlySet<string>): string | null {
  const raw = href.startsWith('#') ? href.slice(1) : href;
  if (!raw) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (ids.has(decoded)) return decoded;
  const slug = `kb-h-${slugify(decoded)}`;
  if (ids.has(slug)) return slug;
  return null;
}

export interface TocScan {
  kind: 'heading' | 'list' | 'block';
  level?: number;
  text?: string;
  id?: string;
  links?: string[];
}

export type BackTocKind = 'heading' | 'list' | 'top';

export interface BackTocPlan {
  kind: BackTocKind;
  id?: string;
  listIndex?: number;
}

/** 纯函数。nodes 按文章顺序，只含顶层块。 */
export function planBackToc(nodes: readonly TocScan[], ids: ReadonlySet<string>): BackTocPlan {
  for (const node of nodes) {
    if (node.kind === 'heading' && isTocHeadingText(node.text ?? '')) return { kind: 'heading', id: node.id };
  }
  const firstH2 = nodes.findIndex((node) => node.kind === 'heading' && node.level === 2);
  const end = firstH2 === -1 ? Math.min(nodes.length, 30) : firstH2;
  for (let i = 0; i < end; i++) {
    const node = nodes[i];
    if (node?.kind !== 'list') continue;
    let hits = 0;
    for (const href of node.links ?? []) {
      if (resolveDocHash(href, ids)) hits += 1;
    }
    if (hits >= 3) return { kind: 'list', listIndex: i };
  }
  return { kind: 'top' };
}

export function shouldShowBackToc(headingCount: number, enabled: boolean): boolean {
  return enabled && headingCount >= 3;
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const BACK_TOC_BUTTON = '<button type="button" class="kb-md-backtoc" data-kb-backtoc aria-label="回到目录"></button>';

export const BACK_TOC_COMMAND = {
  id: 'reader.backToToc',
  title: '回到目录',
  category: '阅读',
} as const;

let focusedJump: (() => void) | null = null;

export function setFocusedBackToc(fn: (() => void) | null): void {
  focusedJump = fn;
}

export function runFocusedBackToc(): void {
  focusedJump?.();
}

function headingLabel(el: Element): string {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.textContent ?? '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

function linkHrefs(list: Element): string[] {
  const hrefs: string[] = [];
  const walk = (node: Element) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href');
      if (href?.startsWith('#')) hrefs.push(href);
    }
    for (const child of node.children) walk(child);
  };
  walk(list);
  return hrefs;
}

function blockRoots(article: Element): Element[] {
  const out: Element[] = [];
  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (child.classList.contains('kb-md-stream') || child.classList.contains('kb-md-slice')) {
        walk(child);
        continue;
      }
      if (child.tagName === 'NAV' && child.classList.contains('kb-md-toc')) continue;
      out.push(child);
    }
  };
  walk(article);
  return out;
}

/** 渲染完成后调用。标题只查一次。 */
export function locateBackToc(article: ParentNode): { kind: BackTocKind; target: Element | null } {
  if (!(article instanceof Element)) return { kind: 'top', target: null };
  const headings = article.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const ids = new Set<string>();
  for (const heading of headings) {
    if (heading.id) ids.add(heading.id);
  }
  const blocks = blockRoots(article);
  const nodes: TocScan[] = blocks.map((el) => {
    const tag = el.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) return { kind: 'heading', level: Number(tag.slice(1)), text: headingLabel(el), id: el.id };
    if (tag === 'ul' || tag === 'ol') return { kind: 'list', links: linkHrefs(el) };
    return { kind: 'block' };
  });
  const plan = planBackToc(nodes, ids);
  if (plan.kind === 'heading') {
    const target = blocks.find((block) => block.id === plan.id) ?? null;
    return { kind: 'heading', target };
  }
  if (plan.kind === 'list' && plan.listIndex != null) return { kind: 'list', target: blocks[plan.listIndex] ?? null };
  return { kind: 'top', target: null };
}
