/**
 * 冷启动计时（docs/07 §4）。所有时间都是“距进程启动的毫秒数”（墙钟换算：进程启动时刻 = 模块加载时 Date.now() - process.uptime()）。
 * 渲染进程通过 kb:startup-mark 发送自己的 Date.now()，在这里换算到同一时间轴。
 * - 开发运行（未打包）或 KB_STARTUP_TRACE=1：完成后在主进程日志打印一张表。
 * - 总是写 <userData>/startup-trace.json（最近一次启动），便于真机反馈时直接附上。
 */
import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { isMainThread } from 'node:worker_threads';

export interface StartupMark {
  name: string;
  ms: number;
  side: 'main' | 'renderer';
}

const processStartWall = Date.now() - process.uptime() * 1000;
const marks: StartupMark[] = [];
let finished = false;
/** 0 未写，1 扫描与可见内容已写，2 正文索引结束后的最终稿 */
let traceStage = 0;
const stallFile = process.env.KB_STALL_LOG || '';
let lastMark = 'boot';

let stallTail: Promise<void> = Promise.resolve();

function stall(line: string) {
  if (!stallFile) return;
  const text = `${new Date().toISOString()} ${line}\n`;
  // 同步 append 会在扫描线程占着同一个文件时把主进程事件循环卡住。
  stallTail = stallTail.then(() => fs.promises.appendFile(stallFile, text)).catch(() => undefined);
}

/** 性能脚本打开后，把超过 50ms 的主进程调用记到 KB_STALL_LOG。 */
export function stallOp(name: string, ms: number, extra = '') {
  if (ms >= 50) stall(`slow ${ms}ms ${name}${extra ? ' ' + extra : ''}`);
}

export function stallNote(line: string) {
  stall(line);
}

const inDataProcess = !!(process as { parentPort?: unknown }).parentPort;

/** 心跳日志按进程分开。门禁只拿主进程的间隔。 */
export function stallProcessLabel(): '主进程' | '数据进程' | '扫描线程' {
  if (!isMainThread) return '扫描线程';
  if (inDataProcess) return '数据进程';
  return '主进程';
}

if (stallFile) {
  let lastBeat = Date.now();
  const beat = setInterval(() => {
    const now = Date.now();
    const gap = now - lastBeat;
    lastBeat = now;
    stall(`beat gap=${gap} last=${lastMark} proc=${stallProcessLabel()}`);
  }, 1000);
  beat.unref?.();
}

type MarkSink = (name: string, side: 'main' | 'renderer', wall: number) => void;
let markSink: MarkSink | null = null;

/** 数据进程把标记转发到主进程。主进程不设。同名标记只转发一次。 */
export function setMarkSink(fn: MarkSink | null) {
  markSink = fn;
}

let cpuSession: inspector.Session | null = null;
const cpuProf = process.env.KB_CPU_PROF || '';
if (cpuProf && isMainThread && !inDataProcess) {
  try {
    cpuSession = new inspector.Session();
    cpuSession.connect();
    cpuSession.post('Profiler.enable');
    cpuSession.post('Profiler.start');
  } catch {
    cpuSession = null;
  }
}

/** 采样结束再写。调用方要等文件出现，不能在回调之前结束进程。 */
export function dumpCpuProfile() {
  const session = cpuSession;
  cpuSession = null;
  if (!cpuProf) return;
  const file = `${cpuProf}.${process.pid}`;
  if (!session) {
    try { fs.writeFileSync(`${file}.err`, 'profiler not started'); } catch { /* 诊断文件写失败不影响退出 */ }
    return;
  }
  session.post('Profiler.stop', (err, params) => {
    try {
      if (err || !params?.profile) fs.writeFileSync(`${file}.err`, String(err ?? 'no profile'));
      else fs.writeFileSync(file, JSON.stringify(params.profile));
    } catch {
      /* 诊断文件写失败不影响退出 */
    }
    try { session.disconnect(); } catch { /* 已经断开 */ }
  });
}

mark('main:module-start');

export function mark(name: string, side: 'main' | 'renderer' = 'main', wall = Date.now()) {
  if (marks.some((m) => m.name === name)) return;
  const ms = Math.round(wall - processStartWall);
  marks.push({ name, ms, side });
  lastMark = name;
  stall(`mark ${ms} ${side} ${name}`);
  markSink?.(name, side, wall);
}

export function startupMarks(): StartupMark[] {
  return [...marks].sort((a, b) => a.ms - b.ms);
}

export function msOf(name: string): number | null {
  return marks.find((m) => m.name === name)?.ms ?? null;
}

/**
 * 启动完成（可交互且延后任务已开始）后写出。
 * final 再写一次，把正文索引结束和主进程/渲染进程/数据库等待分布带上。
 */
export function finishTrace(dataDir: string, print: boolean, extra?: { runtime?: unknown; final?: boolean }) {
  const next = extra?.final ? 2 : 1;
  if (traceStage >= next) return;
  traceStage = next;
  finished = true;
  const list = startupMarks();
  const out = { at: new Date().toISOString(), marks: list, summary: {
      /** 1. 窗口出现 */
      windowShownMs: msOf('window:shown'),
      firstPaintMs: msOf('renderer:first-contentful-paint'),
      /** 2. 可交互：界面壳已经画出来，点击有响应。不等可见内容，也不用 visible-content-timeout。 */
      interactiveMs: msOf('renderer:interactive'),
      /** 侧栏拿到第一份目录数据。只记录，不设门槛。 */
      sidebarReadyMs: msOf('renderer:sidebar-ready'),
      /** 3. 可见内容加载完成（可见面板的内容都已画好；后台标签不计，稍后加载）。超时时为 null，并有 visibleContentTimedOut */
      visibleContentLoadedMs: msOf('renderer:visible-content-loaded'),
      ...(msOf('renderer:visible-content-timeout') != null ? { visibleContentTimedOut: true } : {}),
      contentIndexDoneMs: msOf('deferred:content-index-done'),
    },
    ...(extra?.runtime !== undefined ? { runtime: extra.runtime } : {}),
  };
  try {
    fs.writeFileSync(path.join(dataDir, 'startup-trace.json'), JSON.stringify(out, null, 2));
  } catch {
    /* 数据目录不可写时忽略 */
  }
  if (print) {
    console.log('[startup] 冷启动各阶段（距进程启动 ms）：');
    let prev = 0;
    for (const m of list) {
      console.log(`[startup] ${String(m.ms).padStart(6)}  +${String(m.ms - prev).padStart(5)}  ${m.side === 'main' ? '主进程  ' : '渲染进程'}  ${m.name}`);
      prev = m.ms;
    }
  }
}
