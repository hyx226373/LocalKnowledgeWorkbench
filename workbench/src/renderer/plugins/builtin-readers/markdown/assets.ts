/**
 * 离线包约定。渲染器不写任何 CDN 地址。
 * katex 未安装时 Vite 还不能静态打包字体；安装后 load-katex.ts 的
 * `import('katex/dist/katex.min.css')` 会把 css 和其中的 fonts/*.woff2 打进 out/renderer。
 */
export const KATEX_PACKAGE = 'katex';
export const KATEX_VERSION = '0.19.0';
export const KATEX_CSS_SPEC = 'katex/dist/katex.min.css';
export const KATEX_FONT_SPEC = 'katex/dist/fonts';

export const MERMAID_PACKAGE = 'mermaid';
export const MERMAID_VERSION = '12.1.0';

/** mermaid 官方初始化。禁止 startOnLoad，禁止任何外部字体或主题 URL。 */
export const MERMAID_INIT = {
  startOnLoad: false,
  securityLevel: 'strict',
  fontFamily: 'inherit',
  // 净化只留 SVG text。htmlLabels 的 foreignObject 会被丢掉，节点就只剩空框。
  htmlLabels: false,
} as const;

export function configUsesNetwork(config: unknown): boolean {
  return /https?:\/\//i.test(JSON.stringify(config));
}

export const READER_PURIFY = {
  ALLOWED_URI_REGEXP: /^(?:(?:https?|kbfile|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  ADD_TAGS: [
    'math', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'msqrt', 'mtext', 'annotation',
    'svg', 'path', 'line', 'g', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text', 'tspan', 'defs', 'marker', 'title',
  ],
  ADD_ATTR: [
    'aria-hidden', 'aria-checked', 'aria-disabled', 'aria-label', 'role', 'encoding', 'style', 'data-kb-backtoc',
    'd', 'viewBox', 'xmlns', 'fill', 'stroke', 'stroke-width', 'transform',
    'cx', 'cy', 'r', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'offset', 'stop-color',
    'dominant-baseline', 'text-anchor',
  ],
};
