import { describe, expect, it } from 'vitest';
import { absDirFromRoot, absPathFromRoot, docTabNativePath, nativeDirPath, nativeFilePath, nativeTreeDragPath, setNativeDragRootIndex } from '../src/renderer/nativeDrag/paths';

describe('从根拼绝对路径', () => {
  it('文件拼进根内，目录、.. 和单文件来源按各自规则', () => {
    expect(absPathFromRoot('C:\\Data\\Root', 'folder', '论文/笔记.md')).toBe('C:\\Data\\Root\\论文\\笔记.md');
    expect(absPathFromRoot('/data/root', 'folder', 'a/b.md')).toBe('/data/root/a/b.md');
    expect(absPathFromRoot('C:\\Data\\Root', 'folder', '../outside.md')).toBeNull();
    expect(absPathFromRoot('C:\\Data\\Root', 'folder', '')).toBeNull();
    expect(absPathFromRoot('C:\\Data\\one.md', 'file', '')).toBe('C:\\Data\\one.md');
    setNativeDragRootIndex([
      { id: 'root-1', path: 'C:\\Data\\Root', kind: 'folder' },
      { id: 'file-1', path: 'C:\\Data\\one.md', kind: 'file' },
    ]);
    expect(nativeFilePath('root-1', 'a.md', 'file')).toBe('C:\\Data\\Root\\a.md');
    expect(nativeFilePath('root-1', 'a.md', 'dir')).toBeNull();
    expect(nativeFilePath('file-1', '', 'file')).toBe('C:\\Data\\one.md');
    expect(nativeFilePath('missing', 'a.md', 'file')).toBeNull();
    expect(absDirFromRoot('C:\\Data\\Root\\', '')).toBe('C:\\Data\\Root');
    expect(absDirFromRoot('C:\\Data\\Root', '论文/章')).toBe('C:\\Data\\Root\\论文\\章');
    expect(absDirFromRoot('C:\\Data\\Root', '../outside')).toBeNull();
    expect(absDirFromRoot('/data/root', 'a')).toBe('/data/root/a');
    expect(nativeDirPath('root-1', '')).toBe('C:\\Data\\Root');
    expect(nativeDirPath('root-1', '论文/章')).toBe('C:\\Data\\Root\\论文\\章');
    expect(nativeDirPath('root-1', '..')).toBeNull();
    expect(nativeDirPath('file-1', '')).toBeNull();
    expect(nativeTreeDragPath('root-1', '', 'folder')).toBe('C:\\Data\\Root');
    expect(nativeTreeDragPath('root-1', 'a.md', 'file')).toBe('C:\\Data\\Root\\a.md');
    expect(nativeTreeDragPath('root-1', 'a', 'dir')).toBe('C:\\Data\\Root\\a');
    expect(nativeTreeDragPath('file-1', '', 'file')).toBe('C:\\Data\\one.md');
    expect(docTabNativePath({ absPath: ' D:\\notes\\笔记.md ' })).toBe('D:\\notes\\笔记.md');
    expect(docTabNativePath({ sourceId: 'root-1', relPath: 'a.md' })).toBe('C:\\Data\\Root\\a.md');
    expect(docTabNativePath({ sourceId: 'file-1', relPath: '' })).toBe('C:\\Data\\one.md');
    expect(docTabNativePath({ sourceId: 'root-1', relPath: '' })).toBeNull();
    expect(docTabNativePath({ sourceId: null, relPath: 'a.md' })).toBeNull();
  });
});
