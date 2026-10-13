import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: path.join(import.meta.dirname, '../../..'),
  test: {
    include: ['src/renderer/agent-live/**/*.test.ts'],
    pool: 'forks',
  },
});
