import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { blankFileCandidate, completeBlankFileName } from '../src/shared/blankFile';
import { createBlankFile } from '../src/main/service/blankFile';
import { makeRoot, makeService, tmpDir, write } from './helpers';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const { svc, dataDir } = await makeService();
  const rootDir = makeRoot();
  const root = svc.addRoot(rootDir);
  await svc.scanRoot(root.id);
  const extra: string[] = [];
  cleanups.push(async () => {
    await svc.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    for (const dir of extra) fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    svc,
    dataDir,
    rootDir,
    root,
    extraDir() {
      const dir = tmpDir('kbblank-');
      extra.push(dir);
      return dir;
    },
  };
}

describe('空白文件名', () => {
  it('默认补 md，已带所选扩展名不再加一遍', () => {
    expect(completeBlankFileName('笔记', 'md')).toEqual({ stem: '笔记', ext: 'md', fileName: '笔记.md' });
    expect(completeBlankFileName('笔记.md', 'md').fileName).toBe('笔记.md');
    expect(completeBlankFileName('笔记.MD', 'MD').fileName).toBe('笔记.md');
    expect(completeBlankFileName('笔记.txt', 'txt').fileName).toBe('笔记.txt');
    expect(completeBlankFileName('笔记.txt', 'md').fileName).toBe('笔记.txt.md');
    expect(blankFileCandidate('笔记', 'md', 1)).toBe('笔记.md');
    expect(blankFileCandidate('笔记', 'md', 2)).toBe('笔记(2).md');
  });

  it('拒绝空名、路径字符、保留名和其他类型', () => {
    expect(() => completeBlankFileName('  ', 'md')).toThrow(/文件名/);
    expect(() => completeBlankFileName('a/b', 'md')).toThrow(/不能使用的字符/);
    expect(() => completeBlankFileName('con', 'txt')).toThrow(/保留名/);
    expect(() => completeBlankFileName('笔记', 'pdf')).toThrow(/md 或 txt/);
  });
});

describe('新建空白文件', () => {
  it('根内写出空文件并出现在目录索引里，不新增根', async () => {
    const { svc, rootDir, root } = await setup();
    const seen: { relPath: string }[][] = [];
    svc.on('fs-change', (ev: { relPath: string }[]) => seen.push(ev));
    const before = svc.rootsToWatch().length;
    const created = await createBlankFile(svc, { dir: rootDir, name: '笔记', ext: 'md' });
    expect(created.placed).toBe('indexed');
    expect(created.name).toBe('笔记.md');
    expect(created.rootId).toBe(root.id);
    expect(created.expandIds[0]).toBe(root.resourceId);
    expect(fs.readFileSync(created.absPath)).toEqual(Buffer.alloc(0));
    expect(fs.readFileSync(created.absPath, 'utf8')).toBe('');
    const row = svc.listDir(root.id, '').find((e) => e.name === '笔记.md');
    expect(row?.resourceId).toBe(created.resourceId);
    expect(row?.kind).toBe('file');
    expect(svc.rootsToWatch()).toHaveLength(before);
    expect(seen.flat().some((ev) => ev.relPath === '笔记.md')).toBe(true);
    expect(svc.readText(created.resourceId)).toMatchObject({ text: '', size: 0 });
  });

  it('重名加序号，不覆盖已有内容和同名目录', async () => {
    const { svc, rootDir, root, extraDir } = await setup();
    write(path.join(rootDir, '报告.md'), '旧内容\n---\n');
    write(path.join(rootDir, '报告(2).md'), '第二份');
    const created = await createBlankFile(svc, { dir: rootDir, name: '报告.md', ext: 'md' });
    expect(created.name).toBe('报告(3).md');
    expect(fs.readFileSync(path.join(rootDir, '报告.md'), 'utf8')).toBe('旧内容\n---\n');
    expect(fs.readFileSync(path.join(rootDir, '报告(2).md'), 'utf8')).toBe('第二份');
    expect(fs.readFileSync(created.absPath, 'utf8')).toBe('');
    expect(svc.listDir(root.id, '').some((e) => e.name === '报告(3).md')).toBe(true);

    const outside = extraDir();
    fs.mkdirSync(path.join(outside, '报告.md'));
    const next = await createBlankFile(svc, { dir: outside, name: '报告', ext: 'md' });
    expect(next.name).toBe('报告(2).md');
    expect(next.placed).toBe('source');
    expect(fs.statSync(path.join(outside, '报告.md')).isDirectory()).toBe(true);
    expect(fs.readFileSync(next.absPath, 'utf8')).toBe('');
  });

  it('子目录里的新文件挂到该根，并让上级目录可展开', async () => {
    const { svc, rootDir, root } = await setup();
    const sub = path.join(rootDir, '新目录');
    fs.mkdirSync(sub);
    const created = await createBlankFile(svc, { dir: sub, name: 'a', ext: 'txt' });
    expect(created.placed).toBe('indexed');
    expect(created.name).toBe('a.txt');
    expect(created.absPath).toBe(path.join(sub, 'a.txt'));
    expect(svc.listDir(root.id, '').some((e) => e.name === '新目录' && e.kind === 'dir')).toBe(true);
    const file = svc.listDir(root.id, '新目录').find((e) => e.name === 'a.txt');
    expect(file?.resourceId).toBe(created.resourceId);
    expect(created.expandIds.length).toBeGreaterThan(1);
    expect(created.expandIds).toContain(svc.resourceIdFor(root.id, '新目录'));
  });

  it('根外的文件按单文件来源登记', async () => {
    const { svc, dataDir, extraDir } = await setup();
    const outside = extraDir();
    const before = svc.rootsToWatch().length;
    const created = await createBlankFile(svc, { dir: outside, name: '外来', ext: 'txt' });
    expect(created.placed).toBe('source');
    expect(created.name).toBe('外来.txt');
    expect(svc.rootsToWatch()).toHaveLength(before + 1);
    const added = svc.rootsToWatch().find((r) => r.resourceId === created.resourceId);
    expect(added?.kind).toBe('file');
    expect(path.resolve(added!.path)).toBe(path.resolve(created.absPath));
    expect(created.expandIds).toEqual([created.resourceId]);
    expect(svc.readText(created.resourceId).text).toBe('');
    expect(created.absPath.startsWith(dataDir)).toBe(false);
  });

  it('不在应用数据目录里创建，范围外的文件不留在磁盘', async () => {
    const { svc, dataDir, extraDir } = await setup();
    const nested = path.join(dataDir, 'nested');
    fs.mkdirSync(nested);
    await expect(createBlankFile(svc, { dir: dataDir, name: 'x', ext: 'md' })).rejects.toThrow(/应用数据目录/);
    await expect(createBlankFile(svc, { dir: nested, name: 'x', ext: 'md' })).rejects.toThrow(/应用数据目录/);
    expect(fs.existsSync(path.join(dataDir, 'x.md'))).toBe(false);
    expect(fs.existsSync(path.join(nested, 'x.md'))).toBe(false);

    const limited = extraDir();
    write(path.join(limited, 'keep.pdf'), '%PDF');
    const root = svc.addRoot(limited, '仅pdf', ['pdf']);
    await svc.scanRoot(root.id);
    await expect(createBlankFile(svc, { dir: limited, name: 'a', ext: 'md' })).rejects.toThrow(/不在访问范围/);
    expect(fs.existsSync(path.join(limited, 'a.md'))).toBe(false);
    expect(fs.readFileSync(path.join(limited, 'keep.pdf'), 'utf8')).toBe('%PDF');
  });

  it('不是文件夹或文件名不合法时不写文件', async () => {
    const { svc, rootDir } = await setup();
    const file = path.join(rootDir, '笔记/待办.txt');
    const before = fs.readdirSync(rootDir);
    await expect(createBlankFile(svc, { dir: file, name: 'a', ext: 'md' })).rejects.toThrow(/不是文件夹/);
    await expect(createBlankFile(svc, { dir: path.join(rootDir, '不存在'), name: 'a', ext: 'md' })).rejects.toThrow(/文件夹不存在/);
    await expect(createBlankFile(svc, { dir: rootDir, name: 'a/b', ext: 'md' })).rejects.toThrow(/不能使用的字符/);
    await expect(createBlankFile(svc, { dir: rootDir, name: 'a', ext: 'docx' })).rejects.toThrow(/md 或 txt/);
    expect(fs.readdirSync(rootDir)).toEqual(before);
  });
});
