import path from 'node:path';

/**
 * 压实在索引进程里跑，不进应用主进程。
 * 搜索走另一条连接，不进这条队列。压实没结束时，写入在这里等。
 */
interface Gate {
  tail: Promise<void>;
}

const gates = new Map<string, Gate>();

function gateFor(dbPath: string): Gate {
  const key = path.resolve(dbPath);
  let gate = gates.get(key);
  if (!gate) {
    gate = { tail: Promise.resolve() };
    gates.set(key, gate);
  }
  return gate;
}

function enqueue<T>(dbPath: string, fn: () => T | Promise<T>): Promise<T> {
  const gate = gateFor(dbPath);
  const run = gate.tail.then(fn, fn);
  gate.tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 扫描写入。压实进行时先排队，不和合并叠在同一条连接上。 */
export function runWrite<T>(dbPath: string, fn: () => T): Promise<T> {
  return enqueue(dbPath, fn);
}

/** 后台压实或增量合并。调用方不要在 fn 里再进同一条库的 runWrite。 */
export function runCompact<T>(dbPath: string, fn: () => T | Promise<T>): Promise<T> {
  return enqueue(dbPath, fn);
}
