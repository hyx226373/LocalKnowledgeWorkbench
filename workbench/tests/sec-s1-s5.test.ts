/** S1 远程强制签名 + S5 snapshot 删除路径围栏 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyPluginPackageSignature, PluginSignatureError } from '../src/shared/pluginCatalog';
import { deleteWorkspaceSnapshots } from '../src/main/workspaceSnapshot';

describe('S1 verifyPluginPackageSignature requireSignature', () => {
  it('无签名 + requireSignature=true 抛 PluginSignatureError', () => {
    expect(() =>
      verifyPluginPackageSignature(
        { id: 'remote.pkg', sha256: 'a'.repeat(64), signature: null },
        { requireSignature: true },
      ),
    ).toThrow(PluginSignatureError);
  });

  it('无签名 + 默认不强制则跳过', () => {
    expect(() =>
      verifyPluginPackageSignature({ id: 'local.pkg', sha256: 'b'.repeat(64), signature: null }),
    ).not.toThrow();
  });
});

describe('S5 deleteWorkspaceSnapshots path fence', () => {
  let dir: string;
  let outside: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-snap-'));
    outside = path.join(path.dirname(dir), 'kb-snap-outside-' + process.pid);
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(dir, 'keep.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from([9, 9, 9]));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('../ 相对名不能删出快照目录', async () => {
    const escapeName = path.relative(dir, path.join(outside, 'secret.png'));
    expect(escapeName.includes('..')).toBe(true);
    const deleted = await deleteWorkspaceSnapshots(() => dir, [escapeName, 'keep.png']);
    expect(deleted).toEqual(['keep.png']);
    expect(fs.existsSync(path.join(outside, 'secret.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'keep.png'))).toBe(false);
  });
});
