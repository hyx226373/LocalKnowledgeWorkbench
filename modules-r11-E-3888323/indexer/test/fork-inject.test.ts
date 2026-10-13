import { describe, expect, it } from 'vitest';
import { getIndexerFork, setIndexerFork, indexerFork, type IndexerChild } from '../src/fork.ts';

describe('setIndexerFork', () => {
  it('可注入并恢复默认 fork', () => {
    const calls: string[] = [];
    const fake: IndexerChild = {
      on() { return fake; },
      off() { return fake; },
      once() { return fake; },
      unref() {},
      ref() {},
      send() { return true; },
    };
    setIndexerFork((modulePath) => {
      calls.push(modulePath);
      return fake;
    });
    const child = indexerFork('/tmp/fake-worker.js', [], {});
    expect(child).toBe(fake);
    expect(calls[0]).toBe('/tmp/fake-worker.js');
    setIndexerFork(null);
    expect(getIndexerFork()).not.toBeNull();
  });
});
