/**
 * r12-P3b 最小调度：只处理 source.filter.set。
 * 不是完整的 P5 调度器。未批准不调用 setSourceFilter。其它 ActionId 明确未处理。
 * 不登记桥执行体，不改能力表。
 */

export interface SourceFilterDispatchHost {
  setSourceFilter(sourceId: string, extensions: readonly string[]): unknown;
}

export interface DispatchRequest {
  actionId: string;
  args?: Record<string, unknown>;
  /** 只有严格的 true 才执行。缺省和 false 都不重扫。 */
  approved?: boolean;
}

export interface DispatchOutcome {
  status: 'success' | 'awaiting_approval' | 'unhandled' | 'failed';
  error?: { code: string; message: string };
  result?: unknown;
}

function filterArgs(args: Record<string, unknown> | undefined): { sourceId: string; extensions: string[] } | DispatchOutcome {
  const sourceId = args?.sourceId;
  const extensions = args?.extensions;
  if (typeof sourceId !== 'string' || sourceId.trim() === '') {
    return { status: 'failed', error: { code: 'invalid_args', message: 'source.filter.set 需要 sourceId' } };
  }
  if (!Array.isArray(extensions) || extensions.some((item) => typeof item !== 'string')) {
    return { status: 'failed', error: { code: 'invalid_args', message: 'source.filter.set 需要 extensions 字符串数组' } };
  }
  return { sourceId, extensions };
}

export function dispatchAction(host: SourceFilterDispatchHost, request: DispatchRequest): DispatchOutcome {
  if (request.actionId !== 'source.filter.set') {
    return { status: 'unhandled', error: { code: 'unhandled', message: `没有执行体：${request.actionId}` } };
  }
  if (request.approved !== true) {
    return {
      status: 'awaiting_approval',
      error: { code: 'approval_required', message: 'source.filter.set 需要批准后才重扫' },
    };
  }
  const parsed = filterArgs(request.args);
  if ('status' in parsed) return parsed;
  try {
    const result = host.setSourceFilter(parsed.sourceId, parsed.extensions);
    return { status: 'success', result };
  } catch (err) {
    return { status: 'failed', error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } };
  }
}
