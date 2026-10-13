import { expect, it } from 'vitest';
import { stallProcessLabel } from '../src/main/startupTrace';

it('心跳标记分进程，当前这个测试进程算主进程', () => {
  expect(stallProcessLabel()).toBe('主进程');
  expect(['主进程', '数据进程', '扫描线程']).toContain(stallProcessLabel());
});
