import { FormatFail } from './types';
import { MSG } from './messages';
import { PARSE_TIMEOUT_MS } from './limits';

/** 同步解析挡不住定时器；真正的隔离在 Worker。这里卡住的是异步解析。 */
export async function withTimeout<T>(work: Promise<T>, ms = PARSE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FormatFail('timeout', MSG.timeout)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
