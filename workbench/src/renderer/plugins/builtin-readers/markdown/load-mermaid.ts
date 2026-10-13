import { MERMAID_INIT } from './assets';

export interface MermaidLike {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

/** 未安装 mermaid 时返回 null。图的源码留在页面上，不请求 CDN。 */
export async function loadMermaid(): Promise<MermaidLike | null> {
  try {
    const mod = await import('mermaid');
    const api = (mod.default ?? mod) as MermaidLike;
    if (typeof api.initialize !== 'function' || typeof api.render !== 'function') return null;
    api.initialize({ ...MERMAID_INIT });
    return api;
  } catch {
    return null;
  }
}
