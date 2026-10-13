import { describe, expect, it } from 'vitest';
import { flushWait, ingestWatch, isOwnWatchRel, normalizeWatchRel, skipRel, WATCH_QUEUE_CAP } from '../src/main/service/watcher';
import type { FsEvent } from '../src/main/service/indexer';
import { affectsDir, dirRefreshKey } from '../src/shared/fsScope';
import { reopenAfterIoError } from '../src/main/service/openRetry';
import { resolveIdsSliced } from '../../modules-r11-E-3888323/indexer/src/resolveBatch.ts';

describe('目录刷新范围', () => {
  it('只命中同一层、父目录或整根', () => {
    const event = { rootId: 'r', relPath: '笔记/待办.txt', type: 'change' as const };
    expect(affectsDir('r', '笔记', event)).toBe(true);
    expect(affectsDir('r', '资料', event)).toBe(false);
    expect(affectsDir('other', '笔记', event)).toBe(false);
    expect(affectsDir('r', '笔记', { rootId: 'r', relPath: '' })).toBe(true);
    const idle = dirRefreshKey('r', '资料', 3, [event]);
    expect(idle.endsWith('|0')).toBe(true);
    const hit = dirRefreshKey('r', '笔记', 3, [event]);
    expect(hit).toBe('r|笔记|3');
  });
});

describe('监听过滤', () => {
  it('丢掉忽略目录、临时文件和 asar，普通文件留下', () => {
    expect(skipRel('笔记/待办.md')).toBe(false);
    expect(skipRel('node_modules/pkg/index.js')).toBe(true);
    expect(skipRel('草稿.md.kbtmp-12')).toBe(true);
    expect(skipRel('release-staging/app.asar/a.js')).toBe(true);
    expect(skipRel('')).toBe(false);
  });

  it('自己的库和缓存不进队列，普通 md 留下', () => {
    expect(isOwnWatchRel('笔记/待办.md')).toBe(false);
    expect(isOwnWatchRel('笔记/run.log')).toBe(false);
    expect(isOwnWatchRel('workbench.db')).toBe(true);
    expect(isOwnWatchRel('meta/workbench.db-wal')).toBe(true);
    expect(isOwnWatchRel('meta/workbench.db-shm')).toBe(true);
    expect(isOwnWatchRel('GPUCache/data_0')).toBe(true);
    expect(isOwnWatchRel('Cache/Cache_Data/a')).toBe(true);
    expect(isOwnWatchRel('startup-trace.json')).toBe(true);
    expect(isOwnWatchRel('instance.lock')).toBe(true);
    expect(isOwnWatchRel('child-pids.json')).toBe(true);
    expect(isOwnWatchRel('agent-bridge/requests/a.json')).toBe(true);
    expect(isOwnWatchRel('笔记/agent-bridge-notes.md')).toBe(false);
  });

  it('把 \\\\?\\ 和 ?/ 收成相对路径后，自写过滤认得出库文件，根外的路径丢掉', () => {
    const root = 'D:\\kb-r13-work';
    const wal = normalizeWatchRel('\\\\?\\D:\\kb-r13-work\\integ-0018\\userdata\\workbench.db-wal', root);
    expect(wal).toEqual({ rel: 'integ-0018/userdata/workbench.db-wal', outside: false });
    expect(wal && isOwnWatchRel(wal.rel)).toBe(true);
    const folded = normalizeWatchRel('?/D:/kb-r13-work/integ-0018/userdata/Cache/data_0', root);
    expect(folded && isOwnWatchRel(folded.rel)).toBe(true);
    const outside = normalizeWatchRel('\\\\?\\D:\\kb-r13-work', 'D:\\kb-r13-work\\integ-0018\\pdf-fixture');
    expect(outside).toEqual({ rel: '', outside: true });
    const sibling = normalizeWatchRel('?/D:/kb-r13-work/integ-0018/stall.log', 'D:\\kb-r13-work\\integ-0018\\pdf-fixture');
    expect(sibling?.outside).toBe(true);
    expect(normalizeWatchRel('笔记/待办.md', root)).toEqual({ rel: '笔记/待办.md', outside: false });
    expect(normalizeWatchRel('', root)).toBeNull();
    const nested = normalizeWatchRel('\\\\?\\D:\\kb-r13-work\\integ-0018\\pdf-fixture\\a.md', 'D:\\kb-r13-work\\integ-0018\\pdf-fixture');
    expect(nested).toEqual({ rel: 'a.md', outside: false });
    expect(nested && skipRel(nested.rel)).toBe(false);
  });
});

describe('监听队列', () => {
  it('同一路径只留最后一条', () => {
    const queue = new Map<string, FsEvent>();
    expect(ingestWatch(queue, { type: 'add', relPath: 'a.md' }).rescan).toBe(false);
    expect(ingestWatch(queue, { type: 'change', relPath: 'a.md' }).rescan).toBe(false);
    expect(queue.size).toBe(1);
    expect(queue.get('a.md')?.type).toBe('change');
  });

  it('超过上限就清空并要求重扫', () => {
    const queue = new Map<string, FsEvent>();
    for (let i = 0; i < WATCH_QUEUE_CAP; i += 1) {
      expect(ingestWatch(queue, { type: 'change', relPath: `f${i}.md` }).rescan).toBe(false);
    }
    expect(queue.size).toBe(WATCH_QUEUE_CAP);
    expect(ingestWatch(queue, { type: 'change', relPath: 'overflow.md' }).rescan).toBe(true);
    expect(queue.size).toBe(0);
  });

  it('第一件事等满去抖，窗口内缩短，过点就立刻刷', () => {
    expect(flushWait(1000, undefined, 300)).toEqual({ wait: 300, armedAt: 1000 });
    expect(flushWait(1100, 1000, 300)).toEqual({ wait: 200, armedAt: 1000 });
    expect(flushWait(1400, 1000, 300)).toEqual({ wait: 0, armedAt: 1000 });
  });
});

describe('开库重试', () => {
  it('只对截断、锁和磁盘错误重开', () => {
    expect(reopenAfterIoError('disk I/O error', 0)).toBe(true);
    expect(reopenAfterIoError('SQLITE_IOERR_TRUNCATE', 6)).toBe(true);
    expect(reopenAfterIoError('SQLITE_IOERR_TRUNCATE', 7)).toBe(false);
    expect(reopenAfterIoError('no such table: roots', 0)).toBe(false);
  });
});

describe('资料 ID 分段', () => {
  it('慢的一批会让出事件循环', async () => {
    let yielded = false;
    const timer = setImmediate(() => {
      yielded = true;
    });
    const rels = Array.from({ length: 3 }, (_, i) => `n/${i}.md`);
    const result = await resolveIdsSliced({
      rootId: 'r',
      relPaths: rels,
      resolveOne: () => 'id',
      resolveMany: () => {
        const end = performance.now() + 12;
        while (performance.now() < end) { /* 占住这一段，超过 8ms 预算 */ }
        return rels.map((_, i) => `id-${i}`);
      },
    });
    clearImmediate(timer);
    expect(result.ids).toEqual(['id-0', 'id-1', 'id-2']);
    expect(result.errors).toEqual([]);
    expect(yielded).toBe(true);
  });

  it('快的一批不因为让出把空 ID 当成成功', async () => {
    const result = await resolveIdsSliced({
      rootId: 'r',
      relPaths: ['a.md', 'b.md'],
      resolveOne: (_root, rel) => (rel === 'a.md' ? 'keep' : ''),
    });
    expect(result.ids).toEqual(['keep', '']);
    expect(result.errors.map((e) => e.relPath)).toEqual(['b.md']);
  });
});
