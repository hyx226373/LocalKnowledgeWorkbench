import { describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: { isPackaged: true }, utilityProcess: { fork: vi.fn() } }));
vi.mock('@kb/indexer/fork', () => ({ setIndexerFork: vi.fn(), getIndexerFork: vi.fn(() => null) }));
import { bridgeIndexerHost } from '../src/main/backend/wire';

describe('r15 索引宿主桥接', () => {
  it('indexer 只认 setIndexerHost 时，把 utilityProcess fork 交给它', () => {
    const setIndexerHost = vi.fn();
    const forkFn = vi.fn(() => ({ child: 1 }));
    expect(bridgeIndexerHost({ setIndexerHost }, 'utilityProcess', () => forkFn)).toBe(true);
    const host = setIndexerHost.mock.calls[0]![0] as { fork(p: string, env?: object): unknown };
    expect(host.fork('w.js', { A: '1' })).toEqual({ child: 1 });
    expect(forkFn).toHaveBeenCalledWith('w.js', [], { env: { A: '1' } });
  });
  it('开发态 child_process 或旧 indexer 不桥接', () => {
    const setIndexerHost = vi.fn();
    expect(bridgeIndexerHost({ setIndexerHost }, 'child_process', () => vi.fn())).toBe(false);
    expect(bridgeIndexerHost({}, 'utilityProcess', () => vi.fn())).toBe(false);
    expect(setIndexerHost).not.toHaveBeenCalled();
  });
  it('拿不到 fork 时明确报错，不静默落回 child_process.fork', () => {
    expect(() => bridgeIndexerHost({ setIndexerHost: vi.fn() }, 'utilityProcess', () => null)).toThrow(/索引宿主未注入/);
  });
});
