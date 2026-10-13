/**
 * 冷启动分级加载（第 9 轮 D）——只在“面板内容加载”这一层做，不改 dockview 布局序列化、不改布局数据格式。
 *
 * - 工作区布局（标签、分栏、尺寸、每个条目的阅读状态）照常完整恢复；
 * - 只有可见的面板立即挂载内容（适配器视图：读文件、渲染 PDF 等）；
 * - 后台标签先显示一个很轻的占位，切到它时立即加载；可见内容加载完成并空闲一段时间后，后台标签逐个加载；
 * - 可见内容全部就绪时记启动标记 renderer:visible-content-loaded（startup-trace.json 的第三个指标）。
 * - 超时只记 renderer:visible-content-timeout，不当成可交互。可交互由界面壳画出时单独标记。
 * 不调整进程优先级。
 */
import { kb } from './kb';

type Release = () => void;

const DEFAULT_IDLE_DELAY_MS = 4000;

class BackgroundLoader {
  /** 后台标签空闲加载的延迟；<0 表示不做空闲加载（只在切到标签时加载） */
  delayMs = DEFAULT_IDLE_DELAY_MS;
  private pending = new Map<string, Release>();
  readonly loaded = new Set<string>();
  /** 启动以来被延后过的条目（测试与诊断用） */
  readonly deferredEver = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleHandle: number | undefined;
  private gateOpen = false;

  request(itemId: string, release: Release) {
    this.pending.set(itemId, release);
    this.deferredEver.add(itemId);
    if (this.gateOpen) this.schedule();
  }
  cancel(itemId: string) {
    this.pending.delete(itemId);
  }
  markLoaded(itemId: string) {
    this.pending.delete(itemId);
    this.loaded.add(itemId);
  }
  isPending(itemId: string) {
    return this.pending.has(itemId);
  }
  pendingIds() {
    return [...this.pending.keys()];
  }
  /** 可见内容加载完成（或超时）后打开闸门：延迟 delayMs 后在空闲时逐个加载 */
  openGate() {
    if (this.gateOpen) return;
    this.gateOpen = true;
    this.schedule();
  }
  private schedule() {
    if (this.delayMs < 0 || this.timer || this.idleHandle !== undefined || !this.pending.size) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.next();
    }, this.delayMs);
  }
  private next() {
    const step = () => {
      this.idleHandle = undefined;
      const first = this.pending.entries().next();
      if (first.done) return;
      const [id, release] = first.value;
      this.markLoaded(id);
      release();
      if (this.pending.size) this.idleHandle = requestIdleCallback(step, { timeout: 2000 });
    };
    this.idleHandle = requestIdleCallback(step, { timeout: 2000 });
  }
}
export const backgroundLoader = new BackgroundLoader();

/** 已挂载内容视图（适配器视图/沙箱/占位）的条目——隐藏标签的 DOM 被 dockview 摘下时也能准确判断（测试与诊断用） */
export const mountedViews = new Set<string>();

/** “可见内容加载完成”：冷启动时可见的面板全部报告就绪 */
class VisibleContentTracker {
  private expected: Set<string> | null = null;
  private ready = new Set<string>();
  private done = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  readonly startedAt = performance.now();
  doneAt: number | null = null;

  /** 冷启动布局恢复后调用一次：此刻可见的面板 */
  begin(visibleItemIds: string[]) {
    if (this.expected || this.done) return;
    this.expected = new Set(visibleItemIds);
    // 没有可见面板（空工作区）或适配器一直不报告：最迟 15 秒后也打开后台加载闸门
    this.timeout = setTimeout(() => this.finish(true), 15000);
    this.check();
  }
  reportReady(itemId: string) {
    this.ready.add(itemId);
    this.check();
  }
  /** 面板在就绪前被关闭/移走：不再等它 */
  drop(itemId: string) {
    this.expected?.delete(itemId);
    this.check();
  }
  private check() {
    if (!this.expected || this.done) return;
    for (const id of this.expected) if (!this.ready.has(id)) return;
    this.finish(false);
  }
  private finish(timedOut: boolean) {
    if (this.done) return;
    this.done = true;
    clearTimeout(this.timeout);
    this.doneAt = performance.now();
    // 两帧之后：内容已经画到屏幕上
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        kb.startupMark(timedOut ? 'visible-content-timeout' : 'visible-content-loaded');
        backgroundLoader.openGate();
      }),
    );
  }
  state() {
    return { expected: this.expected ? [...this.expected] : null, ready: [...this.ready], done: this.done };
  }
}
export const visibleContent = new VisibleContentTracker();
