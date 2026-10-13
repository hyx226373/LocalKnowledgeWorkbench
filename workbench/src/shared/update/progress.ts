import type { ByteProgress } from './types';

/** 只把已经发生的字节数写成句子。不生成百分比，也不补假进度。 */
export function formatByteProgress(p: ByteProgress | null): string {
  if (!p) return '';
  if (!Number.isInteger(p.transferred) || !Number.isInteger(p.total)) throw new Error('进度必须是整数字节');
  if (p.transferred < 0 || p.total < 0 || p.transferred > p.total) throw new Error('进度字节数不合法');
  return `已下载 ${p.transferred} 字节 / 共 ${p.total} 字节`;
}

export function assertRealProgress(samples: ByteProgress[], total: number): void {
  if (samples.length === 0) throw new Error('没有进度样本');
  let prev = 0;
  for (const sample of samples) {
    if (sample.total !== total) throw new Error('进度总字节被改写');
    if (sample.transferred < prev) throw new Error('进度回退');
    prev = sample.transferred;
  }
  if (samples[samples.length - 1]?.transferred !== total) throw new Error('进度没有停在真实文件大小');
}
