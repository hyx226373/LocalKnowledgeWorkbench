/**
 * 内置插件：阅读器。与第三方插件完全相同的方式（PluginApi.views.register）注册视图。
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import DOMPurify from 'dompurify';
import { READER_PURIFY } from './markdown/assets';
import { LARGE_MD_CHARS, SLICE_BUDGET_MS } from './markdown/blocks';
import { loadKatex } from './markdown/load-katex';
import { loadMermaid } from './markdown/load-mermaid';
import { renderMarkdown, startMarkdownStream } from './markdown/render';
import { locateBackToc, prefersReducedMotion, resolveDocHash, runFocusedBackToc, setFocusedBackToc, shouldShowBackToc, BACK_TOC_COMMAND } from './markdown/backToc';
import { loadReaderBackToToc, readReaderBackToToc, subscribeReaderBackToToc } from '../../settings/readerBackToc';
import type { KatexLike } from './markdown/types';
import { renderTex } from './tex/render';
import * as pdfjs from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { HOST_API_VERSION, type AdapterTarget, type PluginApi, type PluginModule, type AdapterProps as ViewProps } from '../../plugin-host/types';
import type { ResourceInfo } from '../../../shared/types';
import { APPEARANCE_CHANGED_EVENT } from '../../theme/contract';
import { useFocusMode } from '../../theme/focus';
import { EditorBar, EditorTextarea, showPendingChanges, useEditableDoc } from './editor';
import { isConsoleDocument } from '../../../shared/consoleSchema';
import { ConsoleScreen } from '../../console/ConsoleScreen';
import { useConsoleFileActions } from '../../console/useConsoleFileActions';
import { registerConsoleAdapter } from '../../console/registerAdapter';
import { ZoomBadge, ZoomControls } from '../../zoom/ZoomBadge';
import { ZOOM_COMMIT_IDLE_MS } from '../../zoom/coalesce';
import {
  PDF_PAGE_BORDER_TOP,
  PDF_SCALE_MAX,
  PDF_SCALE_MIN,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  anchorOffset,
  clampOffset,
  clampScale,
  imageFitScale,
  imageScaleBounds,
  normalizeDelta,
  pdfFitScale,
  pdfHit,
  pdfLayout,
  pdfOpenScale,
  pdfScrollForAnchor,
  type Point,
} from '../../zoom/math';
import { runContentZoom, useContentZoom } from '../../zoom/registry';
import {
  MD_MODES,
  TEXT_MODES,
  TEX_MODES,
  mergeScrollReport,
  restoreImageState,
  restorePdfState,
  restoreScrollState,
  withMode,
  withZoom,
  type ImageState,
  type PdfState,
  type ScrollState,
} from '../../zoom/state';
import { ensureWheelTrigger } from '../../zoom/wheelTrigger';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const TEXT_EXT = new Set(['txt', 'log', 'json', 'csv', 'tsv', 'xml', 'yaml', 'yml', 'ini', 'toml', 'js', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'sh', 'ps1', 'bat', 'css', 'html', 'htm', 'sql']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const isFile = (r: ResourceInfo) => r.kind === 'file';
/** file 适配器的匹配：只看 sourceKind=file 的目标 */
const fileMatch = (fn: (r: ResourceInfo) => number) => (t: AdapterTarget) => (t.sourceKind === 'file' ? fn(t.resource) : 0);

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 文档工具栏弱化路径：父目录段，用「 / 」连接；仅文件名时为空。 */
export function docCrumb(relPath: string): string {
  const parts = relPath.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join(' / ');
}

// ---------------- shared helpers ----------------

export function useText(api: PluginApi, resourceId: string) {
  const [s, set] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    api.workspace.readText(resourceId).then(
      (t) => alive && set(t),
      (e) => alive && set({ error: String(e?.message ?? e) }),
    );
    return () => {
      alive = false;
    };
  }, [api, resourceId]);
  return s;
}

/** 视图模式 + 滚动 + 内容比例共用一个面板状态。滚动上报不能把 zoom 丢掉。 */
function useModeState(state: ScrollState | undefined, setState: (s: ScrollState) => void, allowed: readonly string[], def: string) {
  const [mode, setModeS] = useState(state?.mode && allowed.includes(state.mode) ? state.mode : def);
  const cur = useRef<ScrollState>(withZoom({ scroll: state?.scroll ?? 0, ...(mode !== def ? { mode } : {}) }, state?.zoom ?? 1));
  const setScroll = useCallback(
    (s: ScrollState) => {
      cur.current = mergeScrollReport(cur.current, s.scroll);
      setState(cur.current);
    },
    [setState],
  );
  const setMode = useCallback(
    (m: string) => {
      setModeS(m);
      cur.current = withMode(cur.current, m, def);
      setState(cur.current);
    },
    [setState, def],
  );
  const setZoom = useCallback(
    (z: number) => {
      cur.current = withZoom(cur.current, z);
      setState(cur.current);
    },
    [setState],
  );
  return { mode, setMode, setScroll, setZoom };
}

/** 第 9 轮 D：内容画好后报告一次就绪（“可见内容加载完成”指标） */
function useReportReady(ready: boolean, reportReady?: () => void) {
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current || !reportReady) return;
    done.current = true;
    const r = requestAnimationFrame(() => reportReady());
    return () => cancelAnimationFrame(r);
  }, [ready, reportReady]);
}

function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = useCallback((s: string) => {
    setMsg(s);
    clearTimeout(t.current);
    t.current = setTimeout(() => setMsg(null), 3500);
  }, []);
  return { msg, notify };
}

const SETTLE_MS = 3000;

/** 恢复/记录滚动位置（比例），内容就绪后执行一次恢复 */
function useScrollState(ref: React.RefObject<HTMLDivElement | null>, ready: boolean, state: ScrollState | undefined, setState: (s: ScrollState) => void, hold?: { current: boolean }) {
  const restored = useRef(false);
  /**
   * 恢复后的“稳定期”：面板尺寸、字体、分级加载在恢复后的几帧到几秒内还会变化（机器繁忙时更久）。
   * 稳定期内尺寸每变一次就按保存的比例重新定位（而不是按锚点保持恢复瞬间的错误位置），也不把中间状态写回；
   * 用户（或程序）主动滚动、或 SETTLE_MS 到期后结束，之后照常按锚点保持阅读位置。
   */
  const settle = useRef<{ ratio: number; until: number; lastSet: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ready || restored.current) return;
    restored.current = true;
    if (state) {
      el.scrollTop = state.scroll * Math.max(0, el.scrollHeight - el.clientHeight);
      settle.current = state.scroll > 0 ? { ratio: state.scroll, until: performance.now() + SETTLE_MS, lastSet: el.scrollTop } : null;
    }
  }, [ready, ref, state]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !ready) return;
    // 阅读锚点：视口顶部所在的块元素及块内偏移。排版变化（切换阅读区样式/字号、图片加载、栏宽变化）后
    // 按锚点把同一段内容放回视口顶部，而不是保持像素值或比例。
    let anchor: { node: Element; frac: number } | null = null;
    const blocks = () => {
      const art = el.firstElementChild;
      return art && art.children.length ? [...art.children] : [];
    };
    const takeAnchor = () => {
      const top = el.getBoundingClientRect().top;
      const b = blocks().find((n) => n.getBoundingClientRect().bottom > top + 1);
      if (!b) return (anchor = null);
      const r = b.getBoundingClientRect();
      anchor = { node: b, frac: r.height > 0 ? (top - r.top) / r.height : 0 };
    };
    const settling = () => {
      const st = settle.current;
      if (st && performance.now() > st.until) settle.current = null;
      return settle.current;
    };
    const endSettle = () => (settle.current = null);
    /** 稳定期内：按保存的比例重新定位 */
    const reapply = () => {
      const st = settling();
      if (!st) return false;
      const want = Math.round(st.ratio * Math.max(0, el.scrollHeight - el.clientHeight));
      if (Math.abs(el.scrollTop - want) >= 1) el.scrollTop = want;
      st.lastSet = el.scrollTop;
      return true;
    };
    // 每帧最多上报一次（不再用 200ms 防抖：防抖期间关闭/切换工作区会丢失最后的滚动位置）
    let raf = 0;
    const report = () => {
      raf = 0;
      const st = settling();
      if (st) {
        // 不是我们写的位置（用户/程序主动滚动；内容变短被浏览器夹住的除外）→ 结束稳定期，照常上报
        const max = el.scrollHeight - el.clientHeight;
        if (Math.abs(el.scrollTop - st.lastSet) > 2 && el.scrollTop < max - 1) endSettle();
        else return void takeAnchor();
      }
      takeAnchor();
      const max = el.scrollHeight - el.clientHeight;
      setState({ scroll: max > 0 ? +(el.scrollTop / max).toFixed(4) : 0 });
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    /** 把锚点块放回视口顶部（按块与块内比例，而不是 scrollTop 像素值） */
    const applyAnchor = () => {
      if (!anchor || !anchor.node.isConnected) return;
      const r = anchor.node.getBoundingClientRect();
      const delta = r.top + anchor.frac * r.height - el.getBoundingClientRect().top;
      if (Math.abs(delta) >= 1) el.scrollTop += delta; // 触发 scroll → 上报等价的新比例
    };
    takeAnchor();
    let lastW = -1;
    let lastH = -1;
    let lastCH = -1;
    const ro = new ResizeObserver(() => {
      const art = el.firstElementChild as HTMLElement | null;
      const w = el.clientWidth;
      const h = art?.offsetHeight ?? el.scrollHeight;
      // 可视高度也要比较：恢复瞬间若临时出现横向滚动条（10px），可视高度小 10px，按比例算出的位置会偏大（0.8 处偏 8px），
      // 滚动条消失后只有可视高度变化，稳定期内要据此重新定位
      const ch = el.clientHeight;
      if (w === lastW && h === lastH && ch === lastCH) return;
      const first = lastH < 0;
      lastW = w;
      lastH = h;
      lastCH = ch;
      // 内容缩放改字号时，只更新顶部锚点，不用它把视口拉回去盖住鼠标锚点。
      if (hold?.current) return takeAnchor();
      if (reapply()) return takeAnchor();
      if (!first) applyAnchor();
    });
    // 字体加载完成会改变排版：稳定期内再按比例定位一次
    void document.fonts?.ready.then(() => ref.current === el && reapply() && takeAnchor());
    const onUserInput = () => endSettle();
    const inputs = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;
    for (const t of inputs) el.addEventListener(t, onUserInput, { passive: true });
    // 外观切换（外框/阅读区令牌、字号、行高、内边距）：样式生效后的下一帧按锚点校正一次。
    // 正文高度不变的变化（只改内边距等）不会触发上面的尺寸判断，所以单独处理。
    let themeRaf = 0;
    const onAppearance = () => {
      endSettle(); // 用户切换外观：按锚点保持当前内容
      if (themeRaf) cancelAnimationFrame(themeRaf);
      themeRaf = requestAnimationFrame(() => ((themeRaf = 0), applyAnchor()));
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onAppearance);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener('scroll', on);
    return () => {
      window.removeEventListener(APPEARANCE_CHANGED_EVENT, onAppearance);
      if (themeRaf) cancelAnimationFrame(themeRaf);
      el.removeEventListener('scroll', on);
      for (const t of inputs) el.removeEventListener(t, onUserInput);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ready, ref, setState]);
}

function caretAt(x: number, y: number): Range | null {
  if (typeof document === 'undefined') return null;
  const doc = document as Document & { caretRangeFromPoint?: (cx: number, cy: number) => Range | null };
  if (typeof doc.caretRangeFromPoint === 'function') return doc.caretRangeFromPoint(x, y);
  const pos = document.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const range = document.createRange();
  range.setStart(pos.offsetNode, pos.offset);
  range.collapse(true);
  return range;
}

/** Markdown / 文本：--content-zoom，缩放前记下鼠标处字符，重排后放回原来的 y。 */
function useReflowZoom(itemId: string, ref: React.RefObject<HTMLDivElement | null>, saved: number | undefined, persistZoom: (z: number) => void, hold: React.RefObject<boolean>) {
  const [zoom, setZoomLive] = useState(typeof saved === 'number' && Number.isFinite(saved) ? saved : 1);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const pending = useRef<{ node: Node; offset: number; top: number } | null>(null);
  const pendingRatio = useRef<number | null>(null);
  const persistRef = useRef(persistZoom);
  persistRef.current = persistZoom;

  const zoomTo = useCallback((next: number, anchor: Point | null) => {
    const el = ref.current;
    if (!el) return;
    const clamped = clampScale(next, TEXT_SCALE_MIN, TEXT_SCALE_MAX);
    (hold as React.MutableRefObject<boolean>).current = true;
    const rect = el.getBoundingClientRect();
    const pt = anchor ?? { x: rect.left + rect.width / 2, y: rect.top + el.clientHeight / 2 };
    const range = caretAt(pt.x, pt.y);
    pending.current = null;
    pendingRatio.current = null;
    if (range && el.contains(range.startContainer)) pending.current = { node: range.startContainer, offset: range.startOffset, top: range.getBoundingClientRect().top };
    else {
      const max = el.scrollHeight - el.clientHeight;
      pendingRatio.current = max > 0 ? el.scrollTop / max : 0;
    }
    zoomRef.current = clamped;
    setZoomLive(clamped);
  }, [hold, ref]);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const article = el.querySelector('.kb-md, .kb-tex');
    if (!article) {
      zoomTo(1, null);
      return;
    }
    const maxPx = parseFloat(getComputedStyle(article).maxWidth);
    const base = maxPx / (zoomRef.current || 1);
    if (Number.isFinite(base) && base > 0) zoomTo(el.clientWidth / base, null);
    else zoomTo(1, null);
  }, [ref, zoomTo]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const mark = pending.current;
    pending.current = null;
    if (mark?.node.isConnected) {
      const range = document.createRange();
      const len = mark.node.textContent?.length ?? 0;
      try {
        range.setStart(mark.node, Math.min(mark.offset, len));
        range.collapse(true);
        const dy = range.getBoundingClientRect().top - mark.top;
        if (Math.abs(dy) >= 0.5) el.scrollTop += dy;
      } catch {
        /* 节点已换 */
      }
      return;
    }
    if (pendingRatio.current != null) {
      const ratio = pendingRatio.current;
      pendingRatio.current = null;
      el.scrollTop = ratio * Math.max(0, el.scrollHeight - el.clientHeight);
    }
  }, [zoom, ref]);

  useContentZoom(itemId, {
    actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'],
    anchor: () => 'reflow',
    getScale: () => zoomRef.current,
    getBounds: () => ({ min: TEXT_SCALE_MIN, max: TEXT_SCALE_MAX }),
    applyFactor: (factor, anchor) => zoomTo(zoomRef.current * factor, anchor),
    setScale: (scale, anchor) => zoomTo(scale, anchor),
    reset: (anchor) => zoomTo(1, anchor),
    fit: () => fit(),
    commit: () => {
      persistRef.current(zoomRef.current);
      requestAnimationFrame(() => {
        (hold as React.MutableRefObject<boolean>).current = false;
      });
    },
    acceptWheel: (_point, target) => {
      if (!ref.current) return false;
      if (target && typeof (target as Element).closest === 'function' && (target as Element).closest('textarea, .kb-editor-text')) return false;
      return true;
    },
  });
  return zoom;
}

function readingZoomStyle(zoom: number): React.CSSProperties {
  return { '--content-zoom': String(zoom) } as React.CSSProperties;
}

// ---------------- text ----------------

function TextView({ item, resource, api, state, setState, reportReady }: ViewProps<ScrollState>) {
  const focus = useFocusMode();
  const { mode, setMode, setScroll, setZoom } = useModeState(state, setState, TEXT_MODES, 'read');
  const { msg, notify } = useFlash();
  const doc = useEditableDoc(api, resource.resourceId, notify);
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef(false);
  const loaded = !!doc.snap;
  const zoom = useReflowZoom(item.itemId, ref, state?.zoom, setZoom, hold);
  useScrollState(ref, loaded && mode === 'read', state, setScroll, hold);
  useReportReady(loaded || !!doc.error, reportReady);
  if (doc.error) return <div className="kb-notice">读取失败：{doc.error}</div>;
  if (!doc.snap) return <div className="kb-notice">加载中…</div>;
  return (
    <div className="kb-editor" data-testid="text-editor" data-mode={mode} data-dirty={doc.dirty ? 'true' : undefined} data-conflict={doc.external ? 'true' : undefined} data-saves={doc.saveCount}>
      <EditorBar doc={doc} modes={[{ id: 'read', label: '阅读' }, { id: 'edit', label: '编辑' }]} mode={mode} setMode={setMode} onPreviewChanges={() => void showPendingChanges(doc)} crumb={docCrumb(resource.relPath)} />
      {msg && <div className="kb-banner kb-editor-banner" data-testid="editor-flash" data-tone="info">{msg}</div>}
      <div className="kb-editor-body">
        {mode === 'edit' ? (
          <EditorTextarea doc={doc} />
        ) : (
          <div className="kb-zoom-host">
            <div className="kb-reading reader text" data-testid="reader-text" data-focus={focus ? 'on' : undefined} ref={ref} style={readingZoomStyle(zoom)}>
              <pre>{doc.draft}</pre>
            </div>
            <ZoomControls itemId={item.itemId} scale={zoom} />
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- markdown / tex ----------------

function purify(html: string): string {
  return String(DOMPurify.sanitize(html, READER_PURIFY));
}

/** mermaid 不在时保留源码块。画出的 SVG 再过一遍净化，不从 CDN 取字体。 */
async function paintMermaid(root: ParentNode): Promise<void> {
  const nodes = [...root.querySelectorAll('pre.kb-mermaid')];
  if (!nodes.length) return;
  const api = await loadMermaid();
  if (!api) return;
  let n = 0;
  for (const node of nodes) {
    if (!node.isConnected) continue;
    const src = node.querySelector('code')?.textContent ?? '';
    try {
      const drawn = await api.render(`kb-mmd-${n++}-${Math.random().toString(36).slice(2, 8)}`, src);
      const wrap = node.ownerDocument.createElement('div');
      wrap.className = 'kb-mermaid-drawn';
      wrap.innerHTML = purify(drawn.svg);
      node.replaceWith(wrap);
    } catch {
      node.classList.add('kb-mermaid-error');
    }
  }
}

function MarkdownView({ item, resource, api, state, setState, reportReady }: ViewProps<ScrollState>) {
  const focus = useFocusMode();
  const { mode, setMode, setScroll, setZoom } = useModeState(state, setState, MD_MODES, 'preview');
  const { msg, notify } = useFlash();
  const doc = useEditableDoc(api, resource.resourceId, notify);
  const ref = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const hold = useRef(false);
  const streamGen = useRef(0);
  const source = doc.snap ? doc.draft : null;
  const [katex, setKatex] = useState<KatexLike | null>(null);
  const [chunkReady, setChunkReady] = useState(false);
  const [streamCount, setStreamCount] = useState(0);
  const articleRef = useRef<HTMLElement | null>(null);
  const planRef = useRef<{ kind: 'heading' | 'list' | 'top'; target: Element | null }>({ kind: 'top', target: null });
  const returnRef = useRef<{ ratio: number; landed: number | null; active: boolean } | null>(null);
  const [showReturn, setShowReturn] = useState(false);
  const backOn = useSyncExternalStore(subscribeReaderBackToToc, readReaderBackToToc);
  useEffect(() => {
    let alive = true;
    void loadKatex().then((k) => {
      if (alive && k) setKatex(k);
    });
    return () => {
      alive = false;
    };
  }, []);
  const relDir = resource.relPath.includes('/') ? resource.relPath.slice(0, resource.relPath.lastIndexOf('/')) : '';
  const deps = useMemo(
    () => ({
      katex,
      relDir,
      fileUrl: (rel: string) => api.workspace.rootFileUrl(resource.rootId, rel),
    }),
    [katex, relDir, resource.rootId, api],
  );
  const large = (source?.length ?? 0) >= LARGE_MD_CHARS;
  const consoleDoc = source != null && isConsoleDocument({ name: resource.name, text: source });
  const syncDoc = useMemo(() => {
    if (source == null || large || consoleDoc) return null;
    const rendered = renderMarkdown(source, deps);
    return { html: purify(rendered.html), count: rendered.headings.length };
  }, [source, large, consoleDoc, deps]);
  const syncHtml = syncDoc?.html ?? '';
  useEffect(() => {
    const token = ++streamGen.current;
    setChunkReady(false);
    setStreamCount(0);
    if (!large || source == null || mode === 'edit' || consoleDoc) return;
    const body = bodyRef.current;
    const toc = tocRef.current;
    if (!body || !toc) return;
    body.replaceChildren();
    toc.innerHTML = '';
    const stream = startMarkdownStream(source, deps);
    let painted = false;
    const pump = () => {
      if (streamGen.current !== token) return;
      const slice = stream.step(SLICE_BUDGET_MS);
      if (slice.html) {
        const holder = document.createElement('div');
        holder.className = 'kb-md-slice';
        holder.innerHTML = purify(slice.html);
        body.appendChild(holder);
      }
      if (!painted && body.childElementCount > 0) {
        painted = true;
        setChunkReady(true);
      }
      if (!stream.done()) {
        setTimeout(pump, 0);
        return;
      }
      if (streamGen.current !== token) return;
      toc.innerHTML = purify(stream.toc());
      setStreamCount(stream.headings().length);
      if (!painted) setChunkReady(true);
      void paintMermaid(body);
    };
    pump();
    return () => {
      streamGen.current += 1;
    };
  }, [large, source, mode, deps, consoleDoc]);
  useEffect(() => {
    if (large || mode === 'edit' || !syncHtml) return;
    const root = ref.current;
    if (!root) return;
    void paintMermaid(root);
  }, [syncHtml, large, mode]);
  const zoom = useReflowZoom(item.itemId, ref, state?.zoom, setZoom, hold);
  const previewReady = source != null && mode !== 'edit' && (!large || chunkReady);
  useScrollState(ref, previewReady, state, setScroll, hold);
  useReportReady(!!doc.error || previewReady, reportReady);
  const headingCount = large ? streamCount : (syncDoc?.count ?? 0);
  const showBack = shouldShowBackToc(headingCount, backOn);
  const jumpToToc = useCallback(() => {
    const scroller = ref.current;
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const ratio = max > 0 ? scroller.scrollTop / max : 0;
    const plan = planRef.current;
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    const target = plan.target;
    if (plan.kind === 'top' || !target || !target.isConnected) scroller.scrollTo({ top: 0, behavior });
    else {
      const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: Math.max(0, top), behavior });
    }
    returnRef.current = { ratio, landed: null, active: true };
    setShowReturn(true);
  }, []);
  useEffect(() => {
    void loadReaderBackToToc();
  }, []);
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    if (large && streamCount === 0) return;
    planRef.current = locateBackToc(article);
  }, [large, streamCount, syncDoc, mode]);
  useEffect(() => {
    const el = ref.current;
    if (!el || mode === 'edit') return;
    const focusJump = () => setFocusedBackToc(jumpToToc);
    el.addEventListener('pointerdown', focusJump);
    setFocusedBackToc(jumpToToc);
    return () => {
      el.removeEventListener('pointerdown', focusJump);
    };
  }, [jumpToToc, mode]);
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller || !showReturn) return;
    let user = false;
    const markUser = () => {
      user = true;
    };
    const land = () => {
      const bag = returnRef.current;
      if (bag && bag.landed == null) bag.landed = scroller.scrollTop;
    };
    const onScroll = () => {
      const bag = returnRef.current;
      if (!bag?.active || !user || bag.landed == null) return;
      if (Math.abs(scroller.scrollTop - bag.landed) > scroller.clientHeight) {
        bag.active = false;
        setShowReturn(false);
      }
    };
    scroller.addEventListener('wheel', markUser, { passive: true });
    scroller.addEventListener('pointerdown', markUser);
    scroller.addEventListener('keydown', markUser);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    scroller.addEventListener('scrollend', land);
    const timer = window.setTimeout(land, 700);
    return () => {
      window.clearTimeout(timer);
      scroller.removeEventListener('wheel', markUser);
      scroller.removeEventListener('pointerdown', markUser);
      scroller.removeEventListener('keydown', markUser);
      scroller.removeEventListener('scroll', onScroll);
      scroller.removeEventListener('scrollend', land);
    };
  }, [showReturn]);
  const onMarkdownClick = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    if (el.closest('.kb-md-backtoc')) {
      e.preventDefault();
      jumpToToc();
      return;
    }
    const a = el.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const scroller = e.currentTarget;
    const raw = (a.getAttribute('href') ?? '').slice(1);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    if (!decoded) return;
    const ids = new Set<string>();
    scroller.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
      if (heading.id) ids.add(heading.id);
    });
    const id = resolveDocHash('#' + decoded, ids);
    if (!id) return;
    const target = scroller.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!(target instanceof HTMLElement)) return;
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  };
  const restoreHere = () => {
    const scroller = ref.current;
    const saved = returnRef.current;
    if (!scroller || !saved) return;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    scroller.scrollTo({ top: saved.ratio * max, behavior });
    saved.active = false;
    setShowReturn(false);
  };
  const consoleActions = useConsoleFileActions(api, doc, notify);
  if (source != null && isConsoleDocument({ name: resource.name, text: source })) {
    return (
      <ConsoleScreen
        name={resource.name}
        text={doc.draft}
        onText={doc.setDraft}
        onSave={() => void doc.save()}
        notice={msg}
        onOpenItem={consoleActions.onOpenItem}
        onOpenGroup={consoleActions.onOpenGroup}
        onIndexDrop={consoleActions.onIndexDrop}
        onDropRejected={consoleActions.onDropRejected}
      />
    );
  }
  if (doc.error) return <div className="kb-notice">读取失败：{doc.error}</div>;
  if (!doc.snap) return <div className="kb-notice">加载中…</div>;
  return (
    <div className="kb-editor" data-testid="md-editor" data-mode={mode} data-dirty={doc.dirty ? 'true' : undefined} data-conflict={doc.external ? 'true' : undefined} data-saves={doc.saveCount}>
      <EditorBar
        doc={doc}
        modes={[
          { id: 'preview', label: '预览' },
          { id: 'edit', label: '编辑' },
          { id: 'split', label: '分栏' },
        ]}
        mode={mode}
        setMode={setMode}
        onPreviewChanges={() => void showPendingChanges(doc)}
        crumb={docCrumb(resource.relPath)}
      />
      {msg && <div className="kb-banner kb-editor-banner" data-testid="editor-flash" data-tone="info">{msg}</div>}
      <div className="kb-editor-body">
        {mode !== 'preview' && <EditorTextarea doc={doc} />}
        {mode !== 'edit' && (
          <div className="kb-zoom-host">
            <div className="kb-reading reader kb-editor-preview" data-testid="reader-markdown" data-focus={focus ? 'on' : undefined} ref={ref} style={readingZoomStyle(zoom)} onClick={onMarkdownClick}>
              {large ? (
                <article ref={articleRef} className="kb-md md" data-backtoc={showBack ? 'on' : undefined}>
                  <nav className="kb-md-toc" data-testid="md-toc" aria-label="目录" ref={tocRef} />
                  <div className="kb-md-stream" ref={bodyRef} />
                </article>
              ) : (
                <article ref={articleRef} className="kb-md md" data-backtoc={showBack ? 'on' : undefined} dangerouslySetInnerHTML={{ __html: syncHtml }} />
              )}
            </div>
            <div className="kb-md-zoom-row">
              {showReturn && (
                <button type="button" className="kb-button kb-button--secondary kb-md-back-here" data-testid="md-back-here" onClick={restoreHere}>
                  ↩ 回到刚才
                </button>
              )}
              <ZoomControls itemId={item.itemId} scale={zoom} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------- image ----------------

function ImageView({ item, resource, api, state, setState, reportReady }: ViewProps<ImageState>) {
  const [err, setErr] = useState(false);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [scale, setScale] = useState(1);
  const [off, setOff] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLDivElement>(null);
  const naturalRef = useRef(natural);
  naturalRef.current = natural;
  const scaleRef = useRef(1);
  const oxRef = useRef(0);
  const oyRef = useRef(0);
  const cxRef = useRef(state?.cx ?? 0.5);
  const cyRef = useRef(state?.cy ?? 0.5);
  const modeRef = useRef<ImageState['mode']>(state?.mode === 'free' ? 'free' : 'fit');
  const placed = useRef(false);
  const initial = useRef(state);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useReportReady(natural.w > 0 || err, reportReady);

  const rememberCenter = useCallback(() => {
    const el = ref.current;
    const nat = naturalRef.current;
    const s = scaleRef.current;
    if (!el || !nat.w || !nat.h || !s) return;
    cxRef.current = (el.clientWidth / 2 - oxRef.current) / (nat.w * s);
    cyRef.current = (el.clientHeight / 2 - oyRef.current) / (nat.h * s);
  }, []);

  const publish = useCallback((s: number, ox: number, oy: number) => {
    scaleRef.current = s;
    oxRef.current = ox;
    oyRef.current = oy;
    setScale(s);
    setOff({ x: ox, y: oy });
  }, []);

  const persist = useCallback(() => {
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w) return;
    rememberCenter();
    setState({ mode: modeRef.current, scale: scaleRef.current, cx: cxRef.current, cy: cyRef.current });
  }, [rememberCenter, setState]);

  const schedulePersist = useCallback(() => {
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => persist(), ZOOM_COMMIT_IDLE_MS);
  }, [persist]);

  const applyFit = useCallback((write: boolean) => {
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w || el.clientWidth <= 0 || el.clientHeight <= 0) return;
    const s = imageFitScale(el.clientWidth, el.clientHeight, nat.w, nat.h);
    modeRef.current = 'fit';
    const ox = (el.clientWidth - nat.w * s) / 2;
    const oy = (el.clientHeight - nat.h * s) / 2;
    publish(s, ox, oy);
    cxRef.current = 0.5;
    cyRef.current = 0.5;
    if (write) persist();
  }, [persist, publish]);

  const placeOnce = useCallback(() => {
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w || placed.current || el.clientWidth <= 0 || el.clientHeight <= 0) return;
    placed.current = true;
    const saved = initial.current;
    if (saved?.mode === 'free') {
      const bounds = imageScaleBounds(imageFitScale(el.clientWidth, el.clientHeight, nat.w, nat.h));
      const s = clampScale(saved.scale, bounds.min, bounds.max);
      modeRef.current = 'free';
      cxRef.current = saved.cx;
      cyRef.current = saved.cy;
      publish(
        s,
        clampOffset(el.clientWidth / 2 - saved.cx * nat.w * s, el.clientWidth, nat.w * s),
        clampOffset(el.clientHeight / 2 - saved.cy * nat.h * s, el.clientHeight, nat.h * s),
      );
      return;
    }
    applyFit(false);
  }, [applyFit, publish]);

  const zoomTo = useCallback((next: number, anchor: Point | null) => {
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w) return;
    const bounds = imageScaleBounds(imageFitScale(el.clientWidth, el.clientHeight, nat.w, nat.h));
    const s0 = scaleRef.current || 1;
    const s1 = clampScale(next, bounds.min, bounds.max);
    const rect = el.getBoundingClientRect();
    const localX = anchor ? anchor.x - rect.left : rect.width / 2;
    const localY = anchor ? anchor.y - rect.top : rect.height / 2;
    const ox = clampOffset(anchorOffset(localX, oxRef.current, s0, s1), rect.width, nat.w * s1);
    const oy = clampOffset(anchorOffset(localY, oyRef.current, s0, s1), rect.height, nat.h * s1);
    modeRef.current = 'free';
    publish(s1, ox, oy);
    rememberCenter();
  }, [publish, rememberCenter]);

  const resetImage = useCallback(() => {
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w) return;
    modeRef.current = 'free';
    publish(1, clampOffset((el.clientWidth - nat.w) / 2, el.clientWidth, nat.w), clampOffset((el.clientHeight - nat.h) / 2, el.clientHeight, nat.h));
    rememberCenter();
  }, [publish, rememberCenter]);

  const panPixels = useCallback((dx: number, dy: number) => {
    if (modeRef.current !== 'free') return;
    const el = ref.current;
    const nat = naturalRef.current;
    if (!el || !nat.w) return;
    const s = scaleRef.current;
    publish(s, clampOffset(oxRef.current + dx, el.clientWidth, nat.w * s), clampOffset(oyRef.current + dy, el.clientHeight, nat.h * s));
    rememberCenter();
    schedulePersist();
  }, [publish, rememberCenter, schedulePersist]);

  useLayoutEffect(() => {
    placeOnce();
  }, [natural, placeOnce]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!placed.current) {
        placeOnce();
        return;
      }
      const nat = naturalRef.current;
      if (!nat.w) return;
      if (modeRef.current === 'fit') applyFit(false);
      else {
        const s = scaleRef.current;
        publish(
          s,
          clampOffset(el.clientWidth / 2 - cxRef.current * nat.w * s, el.clientWidth, nat.w * s),
          clampOffset(el.clientHeight / 2 - cyRef.current * nat.h * s, el.clientHeight, nat.h * s),
        );
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [applyFit, placeOnce, publish]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      if (modeRef.current !== 'free') return;
      const t = e.target as Element | null;
      if (t && typeof t.closest === 'function' && t.closest('.kb-zoom-hud')) return;
      e.preventDefault();
      const dy = normalizeDelta(e.deltaY || 0, e.deltaMode || 0, el.clientHeight);
      const dx = normalizeDelta(e.deltaX || 0, e.deltaMode || 0, el.clientWidth);
      if (e.shiftKey) panPixels(-dy, 0);
      else panPixels(-dx, -dy);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [panPixels]);

  useEffect(() => () => clearTimeout(persistTimer.current), []);

  useContentZoom(item.itemId, {
    actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'],
    anchor: () => 'exact',
    getScale: () => scaleRef.current,
    getBounds: () => {
      const el = ref.current;
      const nat = naturalRef.current;
      if (!el || !nat.w) return { min: 0.1, max: 8 };
      return imageScaleBounds(imageFitScale(el.clientWidth, el.clientHeight, nat.w, nat.h));
    },
    applyFactor: (factor, anchor) => zoomTo(scaleRef.current * factor, anchor),
    setScale: (next, anchor) => zoomTo(next, anchor),
    reset: () => resetImage(),
    fit: () => applyFit(false),
    commit: () => persist(),
    acceptWheel: () => naturalRef.current.w > 0,
  });

  if (err) return <div className="kb-notice">图片无法解码</div>;
  return (
    <div
      className="kb-reading reader image kb-zoom-image"
      data-testid="reader-image"
      ref={ref}
      onPointerDown={(e) => {
        if (e.button !== 0 || modeRef.current !== 'free') return;
        const t = e.target as Element;
        if (typeof t.closest === 'function' && t.closest('.kb-zoom-hud')) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        panPixels(e.clientX - drag.current.x, e.clientY - drag.current.y);
        drag.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        drag.current = null;
        clearTimeout(persistTimer.current);
        persist();
      }}
    >
      <img
        src={api.workspace.fileUrl(resource)}
        alt={resource.name}
        draggable={false}
        width={natural.w || undefined}
        height={natural.h || undefined}
        style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${scale})` }}
        onLoad={(e) => {
          const img = e.currentTarget;
          setNatural({ w: img.naturalWidth, h: img.naturalHeight });
        }}
        onError={() => setErr(true)}
        onDragStart={(e) => e.preventDefault()}
      />
      <ZoomControls itemId={item.itemId} scale={scale} />
    </div>
  );
}

// ---------------- pdf ----------------

function PdfPage({ doc, n, scale, size, onRendered }: { doc: pdfjs.PDFDocumentProxy; n: number; scale: number; size: { w: number; h: number }; onRendered?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)), { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !ref.current) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    const host = ref.current;
    // 文档可能已被销毁（视图重挂载时旧 doc 先 destroy）：同步异常转成 rejection 并忽略
    Promise.resolve().then(() => doc.getPage(n)).then((p) => {
      if (cancelled) return;
      const dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: scale * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      const t = p.render({ canvas, viewport: vp } as any);
      task = t;
      t.promise.then(
        () => {
          if (cancelled) return;
          host.replaceChildren(canvas);
          host.dataset.rendered = '1';
          onRendered?.();
        },
        () => undefined,
      );
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      task?.cancel();
      // renderScale 变化时先留着被拉伸的旧画布，新画布画完再替换。离开文档再释放。
      queueMicrotask(() => {
        if (!host.isConnected) {
          host.replaceChildren();
          delete host.dataset.rendered;
        }
      });
    };
  }, [visible, doc, n, scale]);
  useEffect(() => {
    if (visible || !ref.current) return;
    ref.current.replaceChildren();
    delete ref.current.dataset.rendered;
  }, [visible]);
  return <div ref={ref} className="kb-pdf-page pdf-page" data-page={n} style={{ width: size.w, height: size.h }} />;
}

function PdfView({ item, resource, api, state, setState, reportReady }: ViewProps<PdfState>) {
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [firstPage, setFirstPage] = useState(false);
  const onRendered = useCallback(() => setFirstPage(true), []);
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useReportReady(firstPage || !!err, reportReady);
  const [viewScale, setViewScale] = useState(state?.scale ?? 1.2);
  const [renderScale, setRenderScale] = useState(state?.scale ?? 1.2);
  const [page, setPage] = useState(state?.page ?? 1);
  const [off, setOff] = useState(state?.off ?? 0);
  const [x, setX] = useState(state?.x ?? 0);
  const [dark, setDark] = useState(!!state?.dark);
  const viewScaleRef = useRef(viewScale);
  viewScaleRef.current = viewScale;
  const pageRef = useRef(page);
  const offRef = useRef(off);
  const xRef = useRef(x);
  const baseRef = useRef(base);
  baseRef.current = base;
  const docRef = useRef(doc);
  docRef.current = doc;
  const zoomingRef = useRef(false);
  const opened = useRef(false);
  const pendingAnchor = useRef<{ page: number; fx: number; fy: number; localX: number; localY: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const pdfKey = `${resource.resourceId}|${resource.size}|${resource.mtimeMs}`;
  useEffect(() => {
    let task: ReturnType<typeof pdfjs.getDocument> | null = null;
    let alive = true;
    const counter = window as Window & { __kbPdfLoads?: number };
    counter.__kbPdfLoads = (counter.__kbPdfLoads ?? 0) + 1;
    try { performance.mark('kb-pdf-load'); } catch { /* 标记失败不影响打开 */ }
    (async () => {
      try {
        const buf = await (await fetch(api.workspace.fileUrl(resource))).arrayBuffer();
        task = pdfjs.getDocument({ data: new Uint8Array(buf) });
        const d = await task.promise;
        const p1 = await d.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        if (!alive) return;
        // 没有保存的状态时按“适合宽度”打开（上限 150%）
        if (!state) {
          const cw = scroller.current?.clientWidth ?? 0;
          if (cw > 0) {
            const s = pdfOpenScale(cw, vp.width);
            viewScaleRef.current = s;
            setViewScale(s);
            setRenderScale(s);
          }
        }
        setBase({ w: vp.width, h: vp.height });
        setDoc(d);
      } catch (e) {
        if (alive) setErr(String((e as Error).message ?? e));
      }
    })();
    return () => {
      alive = false;
      void task?.destroy(); // 关闭标签即释放 PDF 内存
    };
    // 只在文件身份变化时重载。扫描通知换了 resource 对象，但大小和修改时间没变，就不重新取文件。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, pdfKey]);

  const size = base ? { w: Math.round(base.w * viewScale), h: Math.round(base.h * viewScale) } : null;
  const pageEl = (n: number) => scroller.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${n}"]`);
  const toolbarH = () => scroller.current?.querySelector<HTMLElement>('.pdf-toolbar')?.offsetHeight ?? 0;

  const zoomTo = useCallback((next: number, anchor: Point | null) => {
    const el = scroller.current;
    const b = baseRef.current;
    const d = docRef.current;
    if (!el || !b || !d) return;
    const rect = el.getBoundingClientRect();
    const local = anchor ? { x: anchor.x - rect.left, y: anchor.y - rect.top } : { x: rect.width / 2, y: rect.height / 2 };
    const current = pdfLayout({
      toolbarH: toolbarH(),
      viewportW: el.clientWidth,
      viewportH: el.clientHeight,
      baseW: b.w,
      baseH: b.h,
      scale: viewScaleRef.current,
      pageCount: d.numPages,
      borderTop: PDF_PAGE_BORDER_TOP,
    });
    const hit = pdfHit(current, el.scrollLeft, el.scrollTop, local.x, local.y) ?? pdfHit(current, el.scrollLeft, el.scrollTop, rect.width / 2, rect.height / 2);
    const clamped = clampScale(next, PDF_SCALE_MIN, PDF_SCALE_MAX);
    if (hit) pendingAnchor.current = { page: hit.page, fx: hit.fx, fy: hit.fy, localX: local.x, localY: local.y };
    zoomingRef.current = true;
    viewScaleRef.current = clamped;
    setViewScale(clamped);
  }, []);

  // 页顶重定位只在首开做一次。之后的缩放按鼠标（或视口中心）锚点，不再拉回页顶。
  useLayoutEffect(() => {
    if (opened.current) return;
    const el = scroller.current;
    const target = pageEl(page);
    if (!el || !base || !doc || !target) return;
    opened.current = true;
    el.scrollTop = Math.max(0, Math.round(target.offsetTop - toolbarH() + offRef.current * target.offsetHeight));
    if (target.clientWidth > 0) el.scrollLeft = Math.max(0, Math.round(target.offsetLeft + xRef.current * target.clientWidth));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, !!base]);

  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    const el = scroller.current;
    const b = baseRef.current;
    const d = docRef.current;
    if (!pending || !el || !b || !d) return;
    pendingAnchor.current = null;
    const layout = pdfLayout({
      toolbarH: toolbarH(),
      viewportW: el.clientWidth,
      viewportH: el.clientHeight,
      baseW: b.w,
      baseH: b.h,
      scale: viewScaleRef.current,
      pageCount: d.numPages,
      borderTop: PDF_PAGE_BORDER_TOP,
    });
    const scr = pdfScrollForAnchor(layout, pending.page, pending.fx, pending.fy, pending.localX, pending.localY);
    el.scrollLeft = scr.scrollLeft;
    el.scrollTop = scr.scrollTop;
  }, [viewScale, base, doc]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !doc) return;
    let raf = 0;
    const report = () => {
      raf = 0;
      const bar = toolbarH();
      const y = el.scrollTop + bar + el.clientHeight / 3;
      let n = 1;
      for (let k = 1; k <= doc.numPages; k++) {
        const pe = pageEl(k);
        if (pe && pe.offsetTop <= y) n = k;
        else break;
      }
      const pe = pageEl(n);
      const offV = pe && pe.offsetHeight > 0 ? +((el.scrollTop + bar - pe.offsetTop) / pe.offsetHeight).toFixed(4) : offRef.current;
      const xV = pe && pe.clientWidth > 0 ? +((el.scrollLeft - pe.offsetLeft) / pe.clientWidth).toFixed(4) : xRef.current;
      pageRef.current = n;
      offRef.current = offV;
      xRef.current = xV;
      if (zoomingRef.current) return;
      setPage(n);
      setOff(offV);
      setX(xV);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    el.addEventListener('scroll', on);
    return () => {
      el.removeEventListener('scroll', on);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);

  useEffect(() => {
    if (!doc) return;
    const next: PdfState = { page, scale: renderScale, off, x };
    if (dark) next.dark = true;
    setState(next);
  }, [page, renderScale, off, x, dark, doc, setState]);

  const commitZoom = useCallback(() => {
    zoomingRef.current = false;
    setRenderScale(viewScaleRef.current);
    setPage(pageRef.current);
    setOff(offRef.current);
    setX(xRef.current);
  }, []);

  useContentZoom(item.itemId, {
    actions: () => ['in', 'out', 'reset', 'fit', 'set', 'wheel'],
    anchor: () => 'page',
    getScale: () => viewScaleRef.current,
    getBounds: () => ({ min: PDF_SCALE_MIN, max: PDF_SCALE_MAX }),
    applyFactor: (factor, anchor) => zoomTo(viewScaleRef.current * factor, anchor),
    setScale: (next, anchor) => zoomTo(next, anchor),
    reset: (anchor) => zoomTo(1, anchor),
    fit: () => {
      const el = scroller.current;
      const b = baseRef.current;
      if (!el || !b) return;
      zoomTo(pdfFitScale(el.clientWidth, b.w), null);
    },
    commit: () => commitZoom(),
    acceptWheel: () => !!docRef.current,
  });

  if (err) return <div className="kb-notice">PDF 打开失败：{err}</div>;
  if (!doc || !size)
    return (
      <div className="kb-reading reader pdf" ref={scroller}>
        <div className="kb-notice">正在加载 PDF…</div>
      </div>
    );
  return (
    <div className="kb-reading reader pdf" data-testid="reader-pdf" data-page={page} data-scale={viewScale} data-dark-filter={dark ? 'on' : undefined} ref={scroller}>
      <div className="kb-view-toolbar pdf-toolbar">
        <span className="pdf-pageno">
          第 {page} / {doc.numPages} 页
        </span>
        <button className="kb-button kb-button--secondary" data-testid="pdf-zoom-out" onClick={() => runContentZoom(item.itemId, 'out')}>
          −
        </button>
        <ZoomBadge scale={viewScale} />
        <button className="kb-button kb-button--secondary" data-testid="pdf-zoom-in" onClick={() => runContentZoom(item.itemId, 'in')}>
          ＋
        </button>
        <button className="kb-button kb-button--secondary" data-testid="content-zoom-reset" title="重置为 100%" onClick={() => runContentZoom(item.itemId, 'reset')}>
          重置
        </button>
        <button className="kb-button kb-button--secondary" data-testid="content-zoom-fit" title="适合宽度" onClick={() => runContentZoom(item.itemId, 'fit')}>
          适应
        </button>
        <button
          className="kb-button kb-button--secondary"
          data-testid="pdf-dark-filter"
          aria-pressed={dark ? 'true' : 'false'}
          title="深色滤镜：只影响这个 PDF 面板，保存在面板阅读状态里；滤镜参数由阅读区主题提供"
          onClick={() => setDark((d) => !d)}
        >
          深色滤镜
        </button>
      </div>
      {Array.from({ length: doc.numPages }, (_, i) => (
        <PdfPage key={i} doc={doc} n={i + 1} scale={renderScale} size={size} onRendered={firstPage ? undefined : onRendered} />
      ))}
    </div>
  );
}

function TexView({ item, resource, api, state, setState, reportReady }: ViewProps<ScrollState>) {
  const focus = useFocusMode();
  const { mode, setMode, setScroll, setZoom } = useModeState(state, setState, TEX_MODES, 'split');
  const [s, set] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  const [katex, setKatex] = useState<KatexLike | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef(false);
  useEffect(() => {
    let alive = true;
    const load = () => {
      api.workspace.readText(resource.resourceId).then(
        (t) => alive && set(t),
        (e) => alive && set({ error: String((e as { message?: string })?.message ?? e) }),
      );
    };
    load();
    const sub = api.workspace.onDidChangeFile(resource.resourceId, load);
    return () => {
      alive = false;
      sub.dispose();
    };
  }, [api, resource.resourceId]);
  useEffect(() => {
    let alive = true;
    void loadKatex().then((k) => {
      if (alive && k) setKatex(k);
    });
    return () => {
      alive = false;
    };
  }, []);
  const text = s && 'text' in s ? s.text : null;
  const rendered = useMemo(() => (text == null ? null : renderTex(text, katex)), [text, katex]);
  const zoom = useReflowZoom(item.itemId, ref, state?.zoom, setZoom, hold);
  useScrollState(ref, text != null, state, setScroll, hold);
  useReportReady(text != null || !!(s && 'error' in s), reportReady);
  if (s && 'error' in s) return <div className="kb-notice">读取失败：{s.error}</div>;
  if (!s || !rendered) return <div className="kb-notice">加载中…</div>;
  return (
    <div className="kb-editor" data-testid="tex-reader" data-mode={mode}>
      <div className="kb-view-toolbar" data-testid="tex-toolbar">
        <span className="kb-mode">
          {([
            ['source', '源码'],
            ['math', '公式'],
            ['split', '分栏'],
          ] as const).map(([id, label]) => (
            <button key={id} className="kb-button kb-button--secondary" data-testid={`tex-mode-${id}`} aria-pressed={mode === id ? 'true' : 'false'} onClick={() => setMode(id)}>
              {label}
            </button>
          ))}
        </span>
        <span className="state">只读</span>
      </div>
      {s.truncated && <div className="kb-banner kb-editor-banner" data-tone="info">文件超过读取上限，只显示前面一部分。</div>}
      <div className="kb-editor-body">
        <div className="kb-zoom-host">
          <div className="kb-reading reader" data-testid="reader-tex" data-focus={focus ? 'on' : undefined} ref={ref} style={readingZoomStyle(zoom)}>
            <article className="kb-tex">
              {mode !== 'math' && <div className="kb-tex-code" dangerouslySetInnerHTML={{ __html: purify(rendered.sourceHtml) }} />}
              {mode !== 'source' && <div className="kb-tex-preview" dangerouslySetInnerHTML={{ __html: purify(rendered.mathHtml) }} />}
            </article>
          </div>
          <ZoomControls itemId={item.itemId} scale={zoom} />
        </div>
      </div>
    </div>
  );
}

// ---------------- unsupported（回退） ----------------

function UnsupportedView({ resource, api }: ViewProps) {
  return (
    <div className="kb-notice" data-testid="reader-unsupported">
      <h2>暂不支持在应用内阅读此格式</h2>
      <div>
        「{resource.name}」{resource.ext ? `（.${resource.ext}）` : ''} · {fmtSize(resource.size)}
      </div>
      <div className="meta">内置支持：文本/代码、Markdown、TeX、图片、PDF。其他格式可由插件提供阅读器。</div>
      <button className="kb-button kb-button--secondary" onClick={() => api.workspace.showInFolder(resource.resourceId)}>
        在资源管理器中显示
      </button>
    </div>
  );
}

const READ_ALL = { id: 'read', kind: 'fs.read', scope: 'all-registered-roots', reason: '内置阅读器读取你打开的文件' } as const;

const plugin: PluginModule = {
  manifest: {
    id: 'builtin.readers',
    name: '内置阅读器',
    version: '1.0.0',
    engines: { workbench: `^${HOST_API_VERSION}` },
    activationEvents: ['onStartup'],
    contributes: {
      adapters: [
        { id: 'builtin.markdown', title: 'Markdown', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: ['md', 'markdown'] }, permissions: [READ_ALL], stateSchemaVersion: 1 },
        { id: 'builtin.tex', title: 'TeX', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: ['tex'] }, permissions: [READ_ALL], stateSchemaVersion: 1 },
        { id: 'builtin.pdf', title: 'PDF', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: ['pdf'], mimeTypes: ['application/pdf'] }, permissions: [READ_ALL], stateSchemaVersion: 1 },
        { id: 'builtin.text', title: '文本', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: [...TEXT_EXT] }, permissions: [READ_ALL], stateSchemaVersion: 1 },
        { id: 'builtin.image', title: '图片', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: [...IMAGE_EXT] }, permissions: [READ_ALL], stateSchemaVersion: 1 },
        { id: 'builtin.unsupported', title: '文件信息', sourceKinds: ['file'], displayMode: 'in-app-reader', permissions: [READ_ALL] },
      ],
    },
  },
  activate(api) {
    ensureWheelTrigger();
    registerConsoleAdapter(api);
    api.commands.register({ ...BACK_TOC_COMMAND, run: () => runFocusedBackToc() });
    const F = { sourceKinds: ['file'] as const, displayMode: 'in-app-reader' as const };
    api.adapters.register<ScrollState>({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.markdown',
      reportsReady: true,
      title: 'Markdown',
      match: fileMatch((r) => (isFile(r) && (r.ext === 'md' || r.ext === 'markdown') ? 100 : 0)),
      component: MarkdownView,
      stateSchemaVersion: 1,
      restoreState: restoreScrollState,
      handlesFileChanges: true,
      contentZoom: { actions: ['in', 'out', 'reset', 'fit', 'set', 'wheel'], anchor: 'reflow', min: 0.5, max: 3, note: '根上 --content-zoom；textarea 不缩放' },
    });
    api.adapters.register<ScrollState>({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.tex',
      reportsReady: true,
      title: 'TeX',
      match: fileMatch((r) => (isFile(r) && r.ext === 'tex' ? 100 : 0)),
      component: TexView,
      stateSchemaVersion: 1,
      restoreState: restoreScrollState,
      handlesFileChanges: true,
      contentZoom: { actions: ['in', 'out', 'reset', 'fit', 'set', 'wheel'], anchor: 'reflow', min: 0.5, max: 3, note: '根上 --content-zoom；只读，不写回 .tex' },
    });
    api.adapters.register<PdfState>({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.pdf',
      reportsReady: true,
      title: 'PDF',
      match: fileMatch((r) => (isFile(r) && r.ext === 'pdf' ? 100 : 0)),
      component: PdfView,
      stateSchemaVersion: 1,
      restoreState: restorePdfState,
      contentZoom: { actions: ['in', 'out', 'reset', 'fit', 'set', 'wheel'], anchor: 'page', min: 0.4, max: 4, note: 'viewScale 每帧改尺寸，renderScale 在 commit 时重画' },
    });
    api.adapters.register<ScrollState>({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.text',
      reportsReady: true,
      title: '文本',
      // md 也能以纯文本查看（优先级低于 Markdown 视图）
      match: fileMatch((r) => (isFile(r) && TEXT_EXT.has(r.ext) ? 100 : isFile(r) && (r.ext === 'md' || r.ext === 'markdown') ? 50 : 0)),
      component: TextView,
      stateSchemaVersion: 1,
      restoreState: restoreScrollState,
      handlesFileChanges: true,
      contentZoom: { actions: ['in', 'out', 'reset', 'fit', 'set', 'wheel'], anchor: 'reflow', min: 0.5, max: 3, note: '根上 --content-zoom；textarea 不缩放' },
    });
    api.adapters.register<ImageState>({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.image',
      reportsReady: true,
      title: '图片',
      match: fileMatch((r) => (isFile(r) && IMAGE_EXT.has(r.ext) ? 100 : 0)),
      component: ImageView,
      stateSchemaVersion: 1,
      restoreState: restoreImageState,
      contentZoom: { actions: ['in', 'out', 'reset', 'fit', 'set', 'wheel'], anchor: 'exact', min: 0.1, max: 8, note: '适应比例更小时下限取适应值' },
    });
    api.adapters.register({
      ...F,
      sourceKinds: ['file'],
      id: 'builtin.unsupported',
      title: '文件信息',
      match: fileMatch((r) => (isFile(r) ? 1 : 0)),
      component: UnsupportedView,
    });
  },
};
export default plugin;
