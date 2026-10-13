import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo script moves, logs actor, and restores bytes', async () => {
  const env = { ...process.env };
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  delete env.NODE_OPTIONS;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  const child = spawn(process.execPath, [path.join(packageRoot, 'scripts', 'demo.mjs')], {
    cwd: packageRoot,
    env,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8');
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  expect(code, output).toBe(0);
  expect(output).toContain('demo ok');
  expect(output).toMatch(/resourceId \S+/);
  expect(output).toContain('movedRel archive/note.txt');
  expect(output).toContain('restoredRel note.txt');
}, 90_000);
