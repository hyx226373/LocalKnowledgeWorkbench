import { PARSE_TIMEOUT_MS } from '../../../shared/formats/limits';
import { MSG } from '../../../shared/formats/messages';
import type { FormatInput, FormatResult } from '../../../shared/formats/types';
import type { ParseRequest, ParseResponse } from './protocol';

export interface FormatWorkerPort {
  postMessage(message: ParseRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: { data: ParseResponse }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

export interface ParseHandle {
  promise: Promise<FormatResult>;
  cancel(): void;
}

/** 与 pdf.js worker 相同：Vite 把这个模块打成单独的 Worker 资源。 */
export function createBrowserFormatWorker(): FormatWorkerPort {
  return new Worker(new URL('./format.worker.ts', import.meta.url), { type: 'module' }) as unknown as FormatWorkerPort;
}

function isFormatResult(value: unknown): value is FormatResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<FormatResult> & { message?: unknown; code?: unknown; doc?: unknown };
  if (record.ok === true) return !!record.doc && typeof record.doc === 'object';
  if (record.ok !== false) return false;
  return typeof record.code === 'string' && typeof record.message === 'string';
}

/**
 * 在 Worker 里解析。到点就 terminate，同步死循环也会停。
 * 取消只停 Worker，不再把结果交给界面。
 */
export function startFormatParse(
  input: FormatInput,
  options?: { timeoutMs?: number; createWorker?: () => FormatWorkerPort },
): ParseHandle {
  const timeoutMs = options?.timeoutMs ?? PARSE_TIMEOUT_MS;
  let worker: FormatWorkerPort;
  try {
    worker = (options?.createWorker ?? createBrowserFormatWorker)();
  } catch {
    return { promise: Promise.resolve({ ok: false, code: 'corrupt', message: MSG.corrupt }), cancel() {} };
  }
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolvePromise: (result: FormatResult) => void = () => {};
  const promise = new Promise<FormatResult>((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (result: FormatResult) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    try {
      worker.terminate();
    } catch {
      /* 已经停了 */
    }
    resolvePromise(result);
  };
  timer = setTimeout(() => finish({ ok: false, code: 'timeout', message: MSG.timeout }), timeoutMs);
  worker.onmessage = (event) => {
    // 格式 Worker 静态带着 pdf.js 的 WorkerMessageHandler，它一加载就往 self 发 {sourceName,targetName,action:'ready'}。
    // 那是 pdf.js 自己的握手，不是解析结果，跳过；否则第一条就被当成损坏，docx/xlsx/pptx 全打不开。
    const data = event.data as unknown;
    if (data && typeof data === 'object' && 'sourceName' in data && !('result' in data)) return;
    const result = event.data?.result;
    if (!isFormatResult(result)) {
      finish({ ok: false, code: 'corrupt', message: MSG.corrupt });
      return;
    }
    if (!result.ok && result.message.length > 400) {
      finish({ ok: false, code: result.code, message: MSG.corrupt, ...(result.doc ? { doc: result.doc } : {}) });
      return;
    }
    finish(result);
  };
  worker.onerror = () => finish({ ok: false, code: 'corrupt', message: MSG.corrupt });
  try {
    const bytes = new Uint8Array(input.bytes);
    const request: ParseRequest = { id: 1, input: { ...input, bytes } };
    try {
      worker.postMessage(request, [bytes.buffer]);
    } catch {
      worker.postMessage(request);
    }
  } catch {
    finish({ ok: false, code: 'corrupt', message: MSG.corrupt });
  }
  return {
    promise,
    cancel() {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* 已经停了 */
      }
    },
  };
}
