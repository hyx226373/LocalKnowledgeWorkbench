/** 阅读器注入的公式渲染器。仓库里还没有 katex 时为 null，调用方显示原文。 */
export interface KatexLike {
  renderToString(
    tex: string,
    options?: {
      displayMode?: boolean;
      throwOnError?: boolean;
      strict?: boolean | string;
      trust?: boolean;
      output?: 'html' | 'mathml' | 'htmlAndMathml';
    },
  ): string;
}

export interface MarkdownDeps {
  katex: KatexLike | null;
  /** 当前文件所在目录，相对资料根，用 /。文件就在根上时为空字符串。 */
  relDir: string;
  fileUrl: (relPath: string) => string;
}

export interface Heading {
  level: number;
  id: string;
  text: string;
}

export interface FormulaSrc {
  tex: string;
  display: boolean;
}
