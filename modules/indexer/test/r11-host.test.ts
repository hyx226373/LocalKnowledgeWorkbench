import { describe, expect, it, afterEach } from 'vitest';
import { childFromUtility, useUtilityProcessHost, type UtilityChildLike } from '../src/electronHost.ts';
import { forkIndexerScript, indexerUsesInjectedHost, setIndexerHost } from '../src/host.ts';
import { classifyIndexTarget, shouldIndexFileBody } from '../src/indexBoundary.ts';
import { FALLBACK_INDEX_LABEL, indexStatusLabel } from '../src/indexHealthText.ts';
import { debugDualDbCheck } from '../src/dualDb.ts';

afterEach(() => {
  setIndexerHost(null);
});

describe('r11 indexer host', () => {
  it('打包态注入的宿主不会走 child_process.fork', () => {
    const forked: string[] = [];
    useUtilityProcessHost({
      fork(modulePath) {
        forked.push(modulePath);
        return {
          postMessage() {},
          on() {},
        };
      },
    });
    expect(indexerUsesInjectedHost()).toBe(true);
    const child = forkIndexerScript('C:/app/worker.js', { PATH: 'x' }, []);
    expect(forked).toEqual(['C:/app/worker.js']);
    const seen: unknown[] = [];
    child.on('message', (msg) => seen.push(msg));
    child.send({ type: 'warm-ping' });
    expect(seen).toEqual([]);
  });

  it('utilityProcess 的 postMessage 收成 send，message 事件能转回', () => {
    let posted: unknown;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const proc: UtilityChildLike = {
      postMessage(message) {
        posted = message;
      },
      on(event, listener) {
        handlers.set(event, listener);
      },
    };
    const child = childFromUtility(proc);
    const got: unknown[] = [];
    child.on('message', (msg) => got.push(msg));
    handlers.get('message')?.({ type: 'warm' });
    child.send({ type: 'shutdown' });
    expect(got).toEqual([{ type: 'warm' }]);
    expect(posted).toEqual({ type: 'shutdown' });
  });
});

describe('r11 索引边界和降级文案', () => {
  it('网页正文不索引，本地路径可以', () => {
    expect(classifyIndexTarget('https://example.com/a')).toBe('web');
    expect(classifyIndexTarget('http://example.com/a.pdf')).toBe('web');
    expect(shouldIndexFileBody('https://example.com/a')).toBe(false);
    expect(shouldIndexFileBody('D:/cache/direct.pdf')).toBe(true);
    expect(classifyIndexTarget('ftp://example.com/a')).toBe('reject');
  });

  it('fallback 不把扫描量说成已索引', () => {
    const text = indexStatusLabel({
      engine: 'local-fallback',
      contentSearch: false,
      scanned: 8,
      indexed: 0,
      state: 'idle',
    });
    expect(text.startsWith(FALLBACK_INDEX_LABEL)).toBe(true);
    expect(text).toContain('已扫描 8 个文件');
    expect(text).toContain('正文索引 0 个');
    expect(text).not.toContain('已索引 8');
    expect(
      indexStatusLabel({
        engine: 'kb-indexer',
        contentSearch: true,
        scanned: 8,
        indexed: 8,
        state: 'idle',
      }),
    ).toBe('已扫描 8 个文件 · 正文索引 8 个');
  });
});

describe('r11 双库', () => {
  it('同一 id 路径不一致就算 mismatched', () => {
    const main = fakeDb([{ id: 'a', rel_path: 'note.txt' }, { id: 'b', rel_path: 'b.txt' }]);
    const modules = fakeDb([{ id: 'a', rel_path: 'moved/note.txt' }, { id: 'b', rel_path: 'b.txt' }]);
    expect(debugDualDbCheck(main, modules).mismatched).toEqual([
      { resourceId: 'a', mainPath: 'note.txt', modulesPath: 'moved/note.txt' },
    ]);
  });
});

function fakeDb(rows: Array<{ id: string; rel_path: string }>) {
  return {
    prepare() {
      return { all: () => rows };
    },
  };
}
