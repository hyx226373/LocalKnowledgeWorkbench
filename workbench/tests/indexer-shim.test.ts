import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installChildIpcShim } from '../src/main/indexerShim';

describe('r15 indexerShim', () => {
  it('把 process.send / message 接到 parentPort', () => {
    const pp = new EventEmitter() as any;
    pp.postMessage = vi.fn();
    const proc = Object.assign(new EventEmitter(), { parentPort: pp, exit: vi.fn() }) as any;
    expect(installChildIpcShim(proc)).toBe(true);
    proc.send({ type: 'x' });
    expect(pp.postMessage).toHaveBeenCalledWith({ type: 'x' });
    const got: unknown[] = [];
    proc.on('message', (m: unknown) => got.push(m));
    pp.emit('message', { data: { type: 'run' } });
    expect(got).toEqual([{ type: 'run' }]);
  });
  it('已有 process.send（child_process）时不动', () => {
    const proc = Object.assign(new EventEmitter(), { parentPort: {}, send: () => true }) as any;
    expect(installChildIpcShim(proc)).toBe(false);
  });
});
