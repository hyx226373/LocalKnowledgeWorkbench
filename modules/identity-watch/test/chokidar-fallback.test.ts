import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('chokidar fallback', () => {
  it('parcel 不可用时仍能加载 chokidar.watch', () => {
    const chokidar = require('chokidar') as { watch?: unknown; default?: { watch?: unknown } };
    const watch = chokidar.watch ?? chokidar.default?.watch;
    expect(typeof watch).toBe('function');
  });
});
