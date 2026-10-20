import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteWorkspaceSnapshots, loadWorkspaceSnapshots } from '../../src/main/workspaceSnapshot';
import { snapshotCacheFileName } from '../../src/shared/workspacePicker/snapshotCache';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('workspace snapshot disk hydrate', () => {
  it('loads PNG from getSnapshotDir by workspace id and skips missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-snap-load-'));
    dirs.push(dir);
    const id = 'ws-demo';
    const name = snapshotCacheFileName(id)!;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    fs.writeFileSync(path.join(dir, name), png);
    const loaded = await loadWorkspaceSnapshots(() => dir, [id, 'ws-missing']);
    expect(Object.keys(loaded)).toEqual([id]);
    expect(loaded[id]?.fileName).toBe(name);
    expect(loaded[id]?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(typeof loaded[id]?.takenAt === 'string' || loaded[id]?.takenAt === null).toBe(true);
  });

  it('deletes only basename-safe relative names under getSnapshotDir', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-snap-del-'));
    dirs.push(dir);
    const name = snapshotCacheFileName('ws-del')!;
    fs.writeFileSync(path.join(dir, name), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, 'keep.png'), Buffer.from([4]));
    const deleted = await deleteWorkspaceSnapshots(() => dir, [name, '../escape.png', 'C:\\abs.png']);
    expect(deleted).toEqual([name]);
    expect(fs.existsSync(path.join(dir, name))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'keep.png'))).toBe(true);
  });
});
