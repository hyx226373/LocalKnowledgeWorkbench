import { defineConfig } from 'vitest/config';

// 必须在拉起 fork 之前设好。fork 和里面的索引线程共用这次读到的线程池大小。
if (!process.env.UV_THREADPOOL_SIZE || Number(process.env.UV_THREADPOOL_SIZE) < 32) {
  process.env.UV_THREADPOOL_SIZE = '32';
}

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 180000,
    hookTimeout: 180000,
    pool: 'forks',
    // 索引跑在 worker_threads 里。fork 池再开多个进程时，子线程会关掉父进程的 IPC，
    // vitest 主进程随后报 ERR_IPC_CHANNEL_CLOSED。整个套件固定在一个 fork 里。
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
