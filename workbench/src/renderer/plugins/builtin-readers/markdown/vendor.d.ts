/** 依赖尚未安装。这里只提供类型，避免 tsc 在集成组安装前失败。 */
declare module 'katex' {
  interface KatexOptions {
    displayMode?: boolean;
    throwOnError?: boolean;
    strict?: boolean | string;
    trust?: boolean;
    output?: 'html' | 'mathml' | 'htmlAndMathml';
  }
  export function renderToString(tex: string, options?: KatexOptions): string;
  const katex: { renderToString: typeof renderToString };
  export default katex;
}

declare module 'katex/dist/katex.min.css';

declare module 'mermaid' {
  interface MermaidApi {
    initialize(config: Record<string, unknown>): void;
    render(id: string, text: string): Promise<{ svg: string }>;
  }
  const mermaid: MermaidApi;
  export default mermaid;
}
