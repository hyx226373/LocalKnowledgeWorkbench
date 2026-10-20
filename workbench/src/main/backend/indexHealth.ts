/**
 * r11-E：索引健康状态（§2.10）。engine=local-fallback 时 UI 不得暗示正文可搜。
 */
export type IndexEngine = 'kb-indexer' | 'local-fallback' | 'starting';

export interface IndexHealth {
  engine: IndexEngine;
  contentSearch: boolean;
  reason?: string;
  since: number;
  /** 扫描（对账）到的文件数合计——与正文索引量分开 */
  scannedFiles: number;
  /** 正文已写入 FTS 的文件数合计；仅 engine==='kb-indexer' 且 contentSearch 时有意义 */
  contentIndexedFiles: number;
  /** 全文空间满且压实后仍失败。不因此把 contentSearch 改成 false。 */
  contentIndexNotice?: string;
  /** 后端启动失败时的调用栈前几行，诊断用，界面不直接显示。 */
  reasonStack?: string;
  /** locked/busy 重试用完的路径。失败记录还在，压实或手动重建时再补。 */
  contentIndexFailed?: Array<{ rootId: string; relPath: string; kind: 'locked' | 'busy' }>;
}

export const CONTENT_INDEX_FULL_NOTICE = '全文索引空间已满，已尝试压实';

type Listener = (h: IndexHealth) => void;

let current: IndexHealth = {
  engine: 'starting',
  contentSearch: false,
  since: Date.now(),
  scannedFiles: 0,
  contentIndexedFiles: 0,
};
const listeners = new Set<Listener>();

export function getIndexHealth(): IndexHealth {
  return { ...current };
}

export function setIndexHealth(patch: Partial<IndexHealth>): IndexHealth {
  current = {
    ...current,
    ...patch,
    since: patch.since ?? current.since,
  };
  if (patch.engine && patch.engine !== 'starting' && !patch.since) {
    // 引擎切换时刷新 since
    current.since = Date.now();
  }
  for (const l of listeners) {
    try {
      l(getIndexHealth());
    } catch (e) {
      console.error('[indexHealth] listener', e);
    }
  }
  return getIndexHealth();
}

export function onIndexHealth(cb: Listener): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}

/** 状态栏文案：扫描量与正文量分开；fallback 不说「已索引」 */
export function formatIndexStatusLabel(opts: {
  rootName: string;
  state: 'idle' | 'scanning' | 'error';
  progress: number;
  scannedFiles: number;
  contentIndexedFiles: number;
  health: IndexHealth;
  lastError: string | null;
  watching: boolean;
}): string {
  const { rootName, state, progress, scannedFiles, contentIndexedFiles, health, lastError } = opts;
  if (state === 'scanning') return `${rootName}：扫描中… ${progress}`;
  if (state === 'error') return `${rootName}：错误：${lastError ?? '未知'}`;
  if (health.engine === 'local-fallback' || !health.contentSearch) {
    return `${rootName}：全文索引不可用 · 仅文件名/路径搜索 · 已扫描 ${scannedFiles} 个文件`;
  }
  if (health.engine === 'starting') {
    return `${rootName}：索引启动中… · 已扫描 ${scannedFiles} 个文件`;
  }
  const failedN = health.contentIndexFailed?.length ?? 0;
  const failedNote = failedN ? ` · 索引失败 ${failedN} 条` : '';
  return `${rootName}：已扫描 ${scannedFiles} 个文件 · 正文索引 ${contentIndexedFiles} 个${failedNote}`;
}

export const FALLBACK_BANNER = '全文索引不可用 · 仅文件名/路径搜索';
