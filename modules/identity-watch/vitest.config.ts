import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    pool: 'forks',
  },
  ssr: {
    external: ['better-sqlite3', '@parcel/watcher', 'chokidar'],
  },
  server: {
    deps: {
      external: ['better-sqlite3', '@parcel/watcher', 'chokidar'],
    },
  },
});
