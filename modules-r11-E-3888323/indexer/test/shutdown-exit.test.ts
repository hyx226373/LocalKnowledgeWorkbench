import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shutdown-child.ts');

function runChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', childPath],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('closeIndexer 后进程退出码', () => {
  it('子进程连续 3 次退出码是 0，不是 3221225477', async () => {
    const codes: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await runChild();
      codes.push(result.code);
      expect(
        result.code,
        `第 ${i + 1} 次 code=${String(result.code)} stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
      expect(result.code).not.toBe(3221225477);
    }
    console.log(`SHUTDOWN_EXIT ${JSON.stringify(codes)}`);
  }, 120000);
});
