import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planSnapshotCacheDelete } from '../../src/shared/workspacePicker/snapshotCache';
import { decideSnapshotCapture, snapshotPngSampleXor } from '../../src/shared/workspacePicker/snapshotCapture';
import { assessSnapshotCapture, guardSnapshotWrite } from '../../src/shared/workspacePicker/snapshotGuard';

const base = {
  workspaceId: 'ws-1',
  revision: 3,
  expectedWorkspaceId: 'ws-1',
  expectedRevision: 3,
  coverRef: null,
  fileName: 'snap-ws-1.png',
  previousFileName: 'snap-old.png',
  snapshotEnabled: true,
};

describe('快照写入守卫', () => {
  it('错写工作区 id 时拒绝写入并保留旧图', () => {
    const result = guardSnapshotWrite({ ...base, workspaceId: 'other' });
    expect(result.write).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('workspace-mismatch');
    expect(result.fileName).toBeNull();
    expect(result.keptFileName).toBe('snap-old.png');
    expect(result.saveError).toBe(false);
    expect(result.replacesCover).toBe(false);
  });

  it('错 revision 时拒绝写入并保留旧图', () => {
    const result = guardSnapshotWrite({ ...base, revision: 2 });
    expect(result.write).toBe(false);
    expect(result.reason).toBe('revision-mismatch');
    expect(result.keptFileName).toBe('snap-old.png');
    expect(result.fileName).toBeNull();
    expect(result.saveError).toBe(false);
    expect(guardSnapshotWrite({ ...base, revision: '3' }).reason).toBe('revision-mismatch');
  });

  it('绝对路径不能当封面或快照文件名', () => {
    const paths = ['C:\\covers\\a.png', 'D:a.png', '\\\\server\\share\\a.png', '/home/me/a.png', 'covers/a.png', 'covers\\a.png'];
    for (const fileName of paths) {
      const result = guardSnapshotWrite({ ...base, fileName });
      expect(result.write, fileName).toBe(false);
      expect(result.reason, fileName).toBe('absolute-path');
      expect(result.fileName, fileName).toBeNull();
      expect(result.keptFileName, fileName).toBe('snap-old.png');
      expect(result.saveError, fileName).toBe(false);
    }
    const cover = guardSnapshotWrite({ ...base, coverRef: 'C:\\covers\\a.png' });
    expect(cover.write).toBe(false);
    expect(cover.reason).toBe('absolute-path');
    expect(cover.coverRef).toBeNull();
    expect(cover.keptFileName).toBe('snap-old.png');
    expect(() => guardSnapshotWrite(null)).not.toThrow();
    expect(guardSnapshotWrite(undefined).saveError).toBe(false);
  });

  it('已有用户封面时采集结果不覆盖它', () => {
    const same = guardSnapshotWrite({ ...base, coverRef: 'user-cover.png', fileName: 'user-cover.png' });
    expect(same.write).toBe(false);
    expect(same.reason).toBe('cover-protected');
    expect(same.coverRef).toBe('user-cover.png');
    expect(same.fileName).toBeNull();
    expect(same.replacesCover).toBe(false);
    expect(same.keptFileName).toBe('snap-old.png');
    expect(same.saveError).toBe(false);

    const other = guardSnapshotWrite({ ...base, coverRef: ' user-cover.png ', fileName: 'snap-ws-1.png' });
    expect(other.write).toBe(false);
    expect(other.coverRef).toBe('user-cover.png');
    expect(other.fileName).not.toBe('user-cover.png');
    expect(other.replacesCover).toBe(false);
  });

  it('关闭开关不产生写入', () => {
    const result = guardSnapshotWrite({ ...base, snapshotEnabled: false });
    expect(result.write).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(result.fileName).toBeNull();
    expect(result.keptFileName).toBe('snap-old.png');
    expect(result.saveError).toBe(false);

    const closedWindow = assessSnapshotCapture({ ...base, snapshotEnabled: false }, true);
    expect(closedWindow.write).toBe(false);
    expect(closedWindow.captured).toBe(false);
    expect(closedWindow.includesNativeWeb).toBe(false);
    expect(closedWindow.nativeWebPresent).toBe(false);
    expect(closedWindow.reason).toBe('disabled');

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const disabledBytes = decideSnapshotCapture({ ...base, snapshotEnabled: false }, { mainPng: png, childPresent: false });
    expect(disabledBytes.write).toBe(false);
    expect(disabledBytes.captured).toBe(false);
    expect(disabledBytes.reason).toBe('disabled');
    expect(disabledBytes.saveError).toBe(false);
  });

  it('无窗口失败且不声称拍到网页；清除计划只给相对文件名', () => {
    const open = guardSnapshotWrite(base);
    expect(open.write).toBe(true);
    expect(open.fileName).toBe('snap-ws-1.png');
    expect(open.saveError).toBe(false);

    const missed = assessSnapshotCapture(base, false);
    expect(missed.write).toBe(false);
    expect(missed.ok).toBe(false);
    expect(missed.reason).toBe('no-window');
    expect(missed.captured).toBe(false);
    expect(missed.includesNativeWeb).toBe(false);
    expect(missed.keptFileName).toBe('snap-old.png');
    expect(missed.fileName).toBeNull();
    expect(missed.saveError).toBe(false);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const noBytes = decideSnapshotCapture(base, { mainPng: null, childPresent: false });
    expect(noBytes.write).toBe(false);
    expect(noBytes.ok).toBe(false);
    expect(noBytes.captured).toBe(false);
    expect(noBytes.reason).toBe('not-captured');
    expect(noBytes.keptFileName).toBe('snap-old.png');
    expect(noBytes.fileName).toBeNull();
    expect(noBytes.saveError).toBe(false);
    expect(decideSnapshotCapture(base, { mainPng: Buffer.alloc(0), childPresent: false }).reason).toBe('not-captured');

    const wrote = decideSnapshotCapture({ ...base, fileName: 'ignored.png' }, { mainPng: png, childPresent: false });
    expect(wrote.write).toBe(true);
    expect(wrote.ok).toBe(true);
    expect(wrote.captured).toBe(true);
    expect(wrote.fileName).toBe('snap-ws-1.png');
    expect(wrote.fileName).not.toBe('ignored.png');
    expect(wrote.includesNativeWeb).toBe(false);
    expect(wrote.nativeWebPresent).toBe(false);
    expect(wrote.saveError).toBe(false);
    expect(wrote.replacesCover).toBe(false);

    const absolute = decideSnapshotCapture({ ...base, fileName: 'C:\\covers\\a.png' }, { mainPng: png, childPresent: false });
    expect(absolute.write).toBe(false);
    expect(absolute.reason).toBe('absolute-path');
    expect(absolute.fileName).toBeNull();
    expect(absolute.captured).toBe(false);
    expect(absolute.keptFileName).toBe('snap-old.png');
    expect(absolute.saveError).toBe(false);

    const cover = decideSnapshotCapture({ ...base, coverRef: 'user-cover.png' }, { mainPng: png, childPresent: true });
    expect(cover.write).toBe(false);
    expect(cover.reason).toBe('cover-protected');
    expect(cover.captured).toBe(false);
    expect(cover.replacesCover).toBe(false);
    expect(cover.coverRef).toBe('user-cover.png');
    expect(cover.fileName).toBeNull();

    const wrongId = decideSnapshotCapture({ ...base, workspaceId: 'other' }, { mainPng: png, childPresent: false });
    expect(wrongId.write).toBe(false);
    expect(wrongId.reason).toBe('workspace-mismatch');
    const wrongRev = decideSnapshotCapture({ ...base, expectedRevision: 9 }, { mainPng: png, childPresent: false });
    expect(wrongRev.write).toBe(false);
    expect(wrongRev.reason).toBe('revision-mismatch');

    expect(planSnapshotCacheDelete(['ws-1', 'ws-1', '', 1])).toEqual(['snap-ws-1.png']);
    const encoded = planSnapshotCacheDelete(['a/b', 'C:\\ws']);
    expect(encoded.every((name) => !/[/\\:]/.test(name))).toBe(true);
    expect(encoded.every((name) => name.startsWith('snap-') && name.endsWith('.png'))).toBe(true);

    const root = process.cwd();
    const cache = readFileSync(path.join(root, 'src/shared/workspacePicker/snapshotCache.ts'), 'utf8');
    expect(cache).not.toContain('readdir');
    expect(cache).not.toMatch(/from\s+['"](?:node:)?fs['"]/);
    const guard = readFileSync(path.join(root, 'src/shared/workspacePicker/snapshotGuard.ts'), 'utf8');
    expect(guard).not.toContain('throw ');
    const main = readFileSync(path.join(root, 'src/main/workspaceSnapshot.ts'), 'utf8');
    expect(main).toContain('registerWorkspaceSnapshot({ getWindow: () => win })');
    expect(main).toContain('capturePage');
    expect(main).toContain('toPNG');
    expect(main).toContain('contentView');
    expect(main).toContain('getSnapshotDir');
    expect(main).not.toContain('webPanels');
    const capture = readFileSync(path.join(root, 'src/shared/workspacePicker/snapshotCapture.ts'), 'utf8');
    expect(capture).not.toMatch(/from\s+['"]electron['"]/);
    expect(capture).not.toContain('throw ');
    const index = readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
    expect(index).toContain('registerWorkspaceSnapshot({ getWindow: () => win })');
    expect(index).toContain("getSnapshotDir: () => path.join(app.getPath('userData'), 'workspace-snapshots')");
    expect(index).not.toMatch(/C:\\Users\\/);
    const preload = readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
    expect(preload).toContain('captureWorkspaceSnapshot');
    expect(preload).toContain('WORKSPACE_SNAPSHOT_CAPTURE_CHANNEL');
    const settings = readFileSync(path.join(root, 'src/renderer/workspace-picker/WorkspacePickerSettings.tsx'), 'utf8');
    expect(settings).toContain('本地快照');
    expect(settings).toContain('清除快照缓存');
    expect(settings).toContain('planSnapshotCacheDelete');
    expect(settings).not.toContain('readdir');
    const css = readFileSync(path.join(root, 'src/renderer/workspace-picker/overview.css'), 'utf8');
    expect(css).toMatch(/aspect-ratio:\s*16\s*\/\s*10/);
    expect(css).toMatch(/grid-auto-rows:\s*auto/);
    expect(css).not.toMatch(/grid-auto-rows:\s*minmax\(\s*0\s*,\s*1fr\s*\)/);
    expect(css).not.toMatch(/grid-template-rows:\s*1fr/);
  });

  it('子视图与主图像摘要不同则 includesNativeWeb 为 false', () => {
    const main = Buffer.alloc(96, 0);
    const child = Buffer.alloc(96, 0);
    for (let i = 0; i < 24; i += 1) {
      main[i] = 0x89;
      child[i] = 0x89;
    }
    main[30] = 0x7f;
    child[30] = 0x7f;
    main[64] = 0x11;
    child[64] = 0x22;
    expect(main.subarray(0, 24).equals(child.subarray(0, 24))).toBe(true);
    expect(snapshotPngSampleXor(main)).not.toBe(snapshotPngSampleXor(child));

    const differ = decideSnapshotCapture({ ...base, fileName: 'D:\\ignored.png' }, { mainPng: main, childPng: child, childPresent: true });
    expect(differ.write).toBe(false);
    expect(differ.reason).toBe('absolute-path');

    const compared = decideSnapshotCapture(base, { mainPng: main, childPng: child, childPresent: true });
    expect(compared.write).toBe(true);
    expect(compared.captured).toBe(true);
    expect(compared.fileName).toBe('snap-ws-1.png');
    expect(compared.includesNativeWeb).toBe(false);
    expect(compared.nativeWebPresent).toBe(true);
    expect(compared.saveError).toBe(false);

    const longer = Buffer.alloc(main.length + 64, 0);
    main.copy(longer);
    const byLength = decideSnapshotCapture(base, { mainPng: main, childPng: longer, childPresent: true });
    expect(byLength.includesNativeWeb).toBe(false);
    expect(byLength.nativeWebPresent).toBe(true);

    const matched = decideSnapshotCapture(base, { mainPng: main, childPng: Buffer.from(main), childPresent: true });
    expect(matched.includesNativeWeb).toBe(true);
    expect(matched.nativeWebPresent).toBe(true);
    expect(snapshotPngSampleXor(main)).toBe(snapshotPngSampleXor(Buffer.from(main)));

    const offStride = Buffer.from(main);
    offStride[30] = 0x01;
    const sampledOnly = decideSnapshotCapture(base, { mainPng: main, childPng: offStride, childPresent: true });
    expect(main[30]).not.toBe(offStride[30]);
    expect(sampledOnly.includesNativeWeb).toBe(true);
    expect(sampledOnly.nativeWebPresent).toBe(true);

    const missingChild = decideSnapshotCapture(base, { mainPng: main, childPng: null, childPresent: true });
    expect(missingChild.includesNativeWeb).toBe(false);
    expect(missingChild.nativeWebPresent).toBe(true);
  });
});
