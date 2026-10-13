export interface WriteBatcher {
  enqueue<T>(fn: () => T | Promise<T>): Promise<T>;
  drain(): Promise<void>;
  pending(): number;
}

/**
 * 写入串行执行。同步任务在调用方返回前跑完当前这一批；
 * 满 batchSize 且后面还有任务时，用 setImmediate 让出一次，读取才能插进来。
 */
export function createWriteBatcher(batchSize = 32): WriteBatcher {
  const queue: Array<() => Promise<void> | void> = [];
  let pumping = false;
  let ran = 0;
  const idle: Array<() => void> = [];

  function notifyIdle() {
    if (pumping || queue.length) return;
    const wait = idle.splice(0);
    for (const fn of wait) fn();
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    const step = () => {
      if (!queue.length) {
        pumping = false;
        notifyIdle();
        return;
      }
      if (ran >= batchSize) {
        ran = 0;
        setImmediate(step);
        return;
      }
      const job = queue.shift();
      if (!job) {
        pumping = false;
        notifyIdle();
        return;
      }
      ran += 1;
      let result: Promise<void> | void;
      try {
        result = job();
      } catch {
        result = undefined;
      }
      if (result && typeof result.then === 'function') {
        void result.then(step, step);
        return;
      }
      step();
    };
    step();
  }

  return {
    enqueue(fn) {
      return new Promise((resolve, reject) => {
        queue.push(() => {
          try {
            const value = fn();
            if (value && typeof (value as Promise<unknown>).then === 'function') {
              return (value as Promise<unknown>).then(resolve as (value: unknown) => void, reject);
            }
            resolve(value);
          } catch (err) {
            reject(err);
          }
        });
        pump();
      });
    },
    pending() {
      return queue.length;
    },
    drain() {
      if (!pumping && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        idle.push(resolve);
      });
    },
  };
}
