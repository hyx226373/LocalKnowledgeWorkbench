import type { OpenGroupResult } from '../commands';

export function formatOpenGroupResult(result: OpenGroupResult): string {
  const head = `已打开 ${result.ok.length} 项`;
  if (!result.failed.length) return head;
  const detail = result.failed.map((item) => `${item.id}：${item.reason}`).join('；');
  return `${head}，失败 ${result.failed.length} 项：${detail}`;
}
