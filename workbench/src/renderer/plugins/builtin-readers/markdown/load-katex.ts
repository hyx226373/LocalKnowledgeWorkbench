import type { KatexLike } from './types';

/**
 * 安装 katex 之后，Vite 会把这个动态 import 和 katex.min.css 里的 woff2 打进渲染包。
 * 未安装时 import 在运行期失败，阅读器显示公式原文，不访问网络。
 * 单元测试不要 import 本文件，否则 Vite 会在转换期解析 katex。
 */
export async function loadKatex(): Promise<KatexLike | null> {
  try {
    const mod = await import('katex');
    const api = mod.default ?? mod;
    if (typeof api.renderToString !== 'function') return null;
    try {
      await import('katex/dist/katex.min.css');
    } catch {
      /* 没有样式文件时仍返回渲染器；调用方失败会退回原文 */
    }
    return api;
  } catch {
    return null;
  }
}
