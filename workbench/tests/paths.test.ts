import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { normalizeRelPath, parseKbfileUrl, resolveInRootLexical, PathEscapeError } from '../src/main/service/paths';

const RID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('normalizeRelPath', () => {
  it('统一分隔符并去掉 . 与多余斜杠', () => {
    expect(normalizeRelPath('a\\b//./c/')).toBe('a/b/c');
    expect(normalizeRelPath('')).toBe('');
  });
  it.each(['..', 'a/../../b', '..\\x', 'C:/Windows', 'c:foo', '//server/share', '\\\\server\\share', 'a\0b', 'file.txt:stream'])(
    '拒绝危险路径 %j',
    (p) => {
      expect(() => normalizeRelPath(p)).toThrow(PathEscapeError);
    },
  );
});

describe('resolveInRootLexical（Windows 语义）', () => {
  it('大小写不敏感地判断在根内', () => {
    expect(resolveInRootLexical('C:\\Data\\Root', 'Sub\\A.md', path.win32)).toBe('C:\\Data\\Root\\Sub\\A.md');
  });
  it('拒绝越出根', () => {
    expect(() => resolveInRootLexical('C:\\Data\\Root', '..\\Other', path.win32)).toThrow(PathEscapeError);
    expect(() => resolveInRootLexical('C:\\Data\\Root', 'D:\\x', path.win32)).toThrow(PathEscapeError);
  });
  it('前缀相同的兄弟目录不算在根内', () => {
    // C:\Data\Root2 不在 C:\Data\Root 内 —— 通过 normalize 已拒绝 ..，这里直接校验 posix 语义
    expect(() => resolveInRootLexical('/data/root', '../root2/x', path.posix)).toThrow(PathEscapeError);
  });
});

describe('parseKbfileUrl', () => {
  it('解析资源 URL 与根 URL', () => {
    expect(parseKbfileUrl(`kbfile://res/${RID}/a.pdf`)).toEqual({ type: 'res', resourceId: RID });
    expect(parseKbfileUrl(`kbfile://root/${RID}/%E7%AC%94%E8%AE%B0/a%20b.md`)).toEqual({ type: 'root', rootId: RID, relPath: '笔记/a b.md' });
  });
  it('URL 层面的 .. 被规范化：要么仍在根内，要么吃掉 rootId 段后被拒绝', () => {
    expect(parseKbfileUrl(`kbfile://root/${RID}/a/../etc/passwd`)).toEqual({ type: 'root', rootId: RID, relPath: 'etc/passwd' });
    expect(() => parseKbfileUrl(`kbfile://root/${RID}/../../../etc/passwd`)).toThrow(PathEscapeError);
    expect(() => parseKbfileUrl(`kbfile://root/${RID}/%2e%2e/%2e%2e/etc/passwd`)).toThrow(PathEscapeError);
  });
  it.each([
    `kbfile://root/${RID}/..%2F..%2Fetc%2Fpasswd`,
    `kbfile://root/${RID}/..%5C..%5Cwindows%5Cwin.ini`,
    `kbfile://root/${RID}/C%3A%5Cwindows`,
    `kbfile://root/not-a-uuid/a.txt`,
    `kbfile://res/../../etc/passwd`,
    `kbfile://evil/${RID}/a`,
    `file:///etc/passwd`,
    `kbfile://root/${RID}/%E0%A4%A`,
  ])('拒绝 %s', (u) => {
    expect(() => parseKbfileUrl(u)).toThrow(PathEscapeError);
  });
});
