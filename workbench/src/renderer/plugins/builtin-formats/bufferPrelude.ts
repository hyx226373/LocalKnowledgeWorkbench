/**
 * 渲染进程的 Worker 没有 Node 的 Buffer。exceljs / cfb 在调用时才用到它，
 * 所以这个模块必须先于解析器执行。Node 里已经有 Buffer，不覆盖。
 */
import { Buffer as BrowserBuffer } from 'buffer';

const root = globalThis as unknown as {
  Buffer?: typeof BrowserBuffer;
  global?: typeof globalThis;
  process?: { env: Record<string, string | undefined>; versions: Record<string, string>; browser?: boolean };
};

if (typeof root.Buffer === 'undefined') root.Buffer = BrowserBuffer;
if (typeof root.global === 'undefined') root.global = globalThis;
if (typeof root.process === 'undefined') root.process = { env: {}, versions: {}, browser: true };
