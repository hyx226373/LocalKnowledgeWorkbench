import { describe, expect, it, vi } from 'vitest';
import { once, protocolNotReady, PROTOCOL_NOT_READY_STATUS } from '../src/main/protocolGate';
import { MAX_EARLY_RETRIES, dataReadyNow, scheduleEarlyRetry, withCacheBust } from '../src/renderer/kbfileRetry';

describe('imgfix: kbfile protocol gate', () => {
  it('returns 503 with Retry-After while plane not ready', async () => {
    const r = protocolNotReady(false, { 'X-A': '1' })!;
    expect(r.status).toBe(PROTOCOL_NOT_READY_STATUS);
    expect(r.status).toBe(503);
    expect(r.headers.get('Retry-After')).toBe('1');
    expect(r.headers.get('X-A')).toBe('1');
    expect(r.headers.get('Cache-Control')).toContain('no-store');
  });
  it('passes through (null) once ready', () => {
    expect(protocolNotReady(true)).toBeNull();
  });
  it('registers only once', () => {
    const fn = vi.fn();
    const g = once(fn);
    expect(g()).toBe(true);
    expect(g()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('imgfix: reload after ready', () => {
  it('cache-busts url keeping hash', () => {
    expect(withCacheBust('kbfile://r/a.png', 0)).toBe('kbfile://r/a.png');
    expect(withCacheBust('kbfile://r/a.png', 1)).toBe('kbfile://r/a.png?kbr=1');
    expect(withCacheBust('kbfile://r/a.png?x=1#f', 2)).toBe('kbfile://r/a.png?x=1&kbr=2#f');
  });
  it('early error retries after plane-ready', async () => {
    let resolve!: () => void;
    const ready = new Promise<void>((r) => (resolve = r));
    const api = { isDataReady: () => false, whenDataReady: () => ready };
    const retry = vi.fn();
    expect(dataReadyNow(api)).toBe(false);
    expect(scheduleEarlyRetry(api, true, 0, retry)).toBe(true);
    await Promise.resolve();
    expect(retry).not.toHaveBeenCalled();
    resolve();
    await ready; await Promise.resolve();
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('does not retry for late errors or after max attempts', () => {
    const api = { isDataReady: () => true, whenDataReady: () => Promise.resolve() };
    expect(scheduleEarlyRetry(api, false, 0, () => {})).toBe(false);
    expect(scheduleEarlyRetry(api, true, MAX_EARLY_RETRIES, () => {})).toBe(false);
    expect(scheduleEarlyRetry(undefined, true, 0, () => {})).toBe(false);
  });
});