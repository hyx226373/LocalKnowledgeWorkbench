// OLE 解析会加载 ppt.js。Vite 插件 ppt-cfb-binding 给它补上 CFB / cptable 的 var，
// 否则严格模式的 Worker 包在加载时抛 ReferenceError，docx 也打不开。
import './bufferPrelude';
import { MSG } from '../../../shared/formats/messages';
import { parseFormat } from '../../../shared/formats/parse';
import type { FormatInput, FormatResult } from '../../../shared/formats/types';
import type { ParseRequest, ParseResponse } from './protocol';

const MESSAGE_LIMIT = 400;

/** Worker 里跑的同一份解析。失败只回中文说明，不回正文。 */
export async function parseRequest(input: FormatInput): Promise<FormatResult> {
  try {
    const result = await parseFormat(input);
    if (!result.ok && result.message.length > MESSAGE_LIMIT) {
      return { ok: false, code: result.code, message: MSG.corrupt, ...(result.doc ? { doc: result.doc } : {}) };
    }
    return result;
  } catch {
    return { ok: false, code: 'corrupt', message: MSG.corrupt };
  }
}

const scope = globalThis as typeof globalThis & {
  document?: Document;
  postMessage?: (message: ParseResponse) => void;
  onmessage: ((event: MessageEvent<ParseRequest>) => void) | null;
};

// 浏览器窗口里 document 存在，不在这里听消息。Node 测试导入时没有 postMessage。
if (typeof scope.postMessage === 'function' && typeof scope.document === 'undefined') {
  scope.onmessage = (event: MessageEvent<ParseRequest>) => {
    const request = event.data;
    const id = request && typeof request.id === 'number' ? request.id : 0;
    if (!request?.input?.bytes) {
      scope.postMessage?.({ id, result: { ok: false, code: 'corrupt', message: MSG.corrupt } });
      return;
    }
    void parseRequest(request.input).then((result) => scope.postMessage?.({ id, result }));
  };
}
