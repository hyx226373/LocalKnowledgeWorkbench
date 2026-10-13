/** 主进程事件循环、渲染进程长任务、数据库锁等待。启动轨迹和性能门禁都读这里。 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

const hist: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
hist.enable();

const longTasks: number[] = [];
const dbWaits: number[] = [];
let contentBodyReads = 0;
let contentIndexDone = false;

function dist(values: number[]) {
  if (values.length === 0) return { n: 0, max: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((q / 100) * sorted.length) - 1))] ?? 0;
  return { n: sorted.length, max: sorted[sorted.length - 1] ?? 0, p95: at(95), p99: at(99) };
}

export function noteLongTask(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return;
  longTasks.push(ms);
  if (longTasks.length > 400) longTasks.shift();
}

export function noteDbWait(ms: number) {
  if (!Number.isFinite(ms) || ms < 20) return;
  dbWaits.push(Math.round(ms));
  if (dbWaits.length > 400) dbWaits.shift();
}

export function noteContentBodyReads(n: number) {
  if (Number.isFinite(n) && n >= 0) contentBodyReads += n;
}

export function markContentIndexDone() {
  contentIndexDone = true;
}

export function runtimeSnapshot() {
  const ms = (ns: number) => (Number.isFinite(ns) ? Math.round((ns / 1e6) * 1000) / 1000 : 0);
  return {
    eventLoopDelayMs: {
      min: ms(hist.min),
      max: ms(hist.max),
      mean: ms(hist.mean),
      p50: ms(hist.percentile(50)),
      p99: ms(hist.percentile(99)),
    },
    rendererLongTaskMs: dist(longTasks),
    dbWaitMs: dist(dbWaits),
    contentBodyReads,
    contentIndexDone,
  };
}
