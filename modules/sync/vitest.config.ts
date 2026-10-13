import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    maxWorkers: 1,
    sequence: { concurrent: false },
    testTimeout: 180000,
    hookTimeout: 180000,
    pool: 'forks',
    // 同步会话再开 indexer / reconcile 的 worker。多个 fork 会把 vitest 的 IPC 拆掉。
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  ssr: {
    external: ['better-sqlite3', '@parcel/watcher', 'chokidar', 'pdfjs-dist', 'pdf-lib'],
  },
  server: {
    deps: {
      external: [
        'better-sqlite3',
        '@parcel/watcher',
        'chokidar',
        'pdfjs-dist',
        'pdf-lib',
        '@kb/indexer',
        '@kb/identity-watch',
      ],
    },
  },
});
