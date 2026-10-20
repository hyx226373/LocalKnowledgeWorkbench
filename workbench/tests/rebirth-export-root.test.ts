import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { bindRebirthMethods } from '../src/main/rebirth/ipc';
import { exportRebirthToRoot, writeUniqueFileWithContent } from '../src/main/service/blankFile';
import { REBIRTH_METHODS } from '../src/shared/rebirth';
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

  const rebirthDir = tmpDir('kbrebirth-');
  const repo = new RebirthRepository(
    rebirthDir,
    vi.fn(),
    async (file) => fs.rmSync(file, { recursive: true, force: true }),
  );

  const extra: string[] = [];
  cleanups.push(async () => {
    repo.close();
    await svc.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(rebirthDir, { recursive: true, force: true });
    for (const dir of extra) fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    svc,
    dataDir,
    rootDir,
    root,
    repo,
    rebirthDir,
    extraDir() {
      const dir = tmpDir('kbextra-');
      extra.push(dir);
      return dir;
    },
  };
}

const sampleDoc = `---
lkw: rebirth/1
agent: Codex
title: 架构设计方案
topic: 设计
---
## [背景] 需求描述
这是需求背景细节，包含了上下文信息。
## [决定] 架构决策
这是架构核心决策，决定采用模块化架构。
## [资料] 内部隐秘
这是保密资料，默认在导出时可能被隐藏。
`;

describe('重生资料导出到根目录', () => {
  it('REBIRTH_METHODS 包含 rebirthExportRoot 且与 bindRebirthMethods 导出的方法一致', () => {
    expect(REBIRTH_METHODS).toContain('rebirthExportRoot');
    const dummyRepo = {
      file: vi.fn(),
      read: vi.fn(),
      generate: vi.fn(),
      settings: vi.fn(() => ({ attachRootInfo: false })),
    } as unknown as RebirthRepository;
    const api = bindRebirthMethods(dummyRepo, {
      pickJson: vi.fn(async () => null),
      saveFile: vi.fn(async () => null),
      copy: vi.fn(),
      startDrag: vi.fn(),
    });
    expect(Object.keys(api).sort()).toEqual([...REBIRTH_METHODS].sort());
  });

  describe('重名处理', () => {
    it('重名自动加 (2)、(3)，跳过同名目录，绝不覆盖已有文件，用独占创建', async () => {
      const { svc, rootDir, root, repo } = await setup();
      const { id } = repo.import(sampleDoc);
      const defaultName = 'R1-架构设计方案.md';

      // 预先写入已存在的文件，检查内容绝不被覆盖
      const originalPath = path.join(rootDir, defaultName);
      write(originalPath, '旧第一份文件内容');
      const secondPath = path.join(rootDir, 'R1-架构设计方案(2).md');
      write(secondPath, '旧第二份文件内容');

      // 构造同名的目录 R1-架构设计方案(3).md，测试独占创建跳过 EISDIR
      const dirCollision = path.join(rootDir, 'R1-架构设计方案(3).md');
      fs.mkdirSync(dirCollision);

      // 导出到 rootDir
      const created = await exportRebirthToRoot(repo, svc, { id, dir: rootDir });
      expect(created.name).toBe('R1-架构设计方案(4).md');
      expect(created.placed).toBe('indexed');

      // 验证未覆盖已有文件或目录
      expect(fs.readFileSync(originalPath, 'utf8')).toBe('旧第一份文件内容');
      expect(fs.readFileSync(secondPath, 'utf8')).toBe('旧第二份文件内容');
      expect(fs.statSync(dirCollision).isDirectory()).toBe(true);

      // 验证新创建的文件包含生成的内容
      const exportedContent = fs.readFileSync(created.absPath, 'utf8');
      expect(exportedContent).toBe(repo.generate(id).text);

      // 自定义名字重名测试
      const customPath = path.join(rootDir, '自定义导出.md');
      write(customPath, '已存在');
      const customCreated = await exportRebirthToRoot(repo, svc, { id, dir: rootDir, name: '自定义导出' });
      expect(customCreated.name).toBe('自定义导出(2).md');
      expect(fs.readFileSync(customPath, 'utf8')).toBe('已存在');
      expect(fs.readFileSync(customCreated.absPath, 'utf8')).toBe(repo.generate(id).text);
    });

    it('writeUniqueFileWithContent 严格使用 flag: wx，已有同名时不覆盖', () => {
      const dir = tmpDir('kbrb-unique-');
      cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));

      const first = writeUniqueFileWithContent(dir, '测试', 'md', '版本1');
      expect(first.name).toBe('测试.md');
      expect(fs.readFileSync(first.abs, 'utf8')).toBe('版本1');

      const second = writeUniqueFileWithContent(dir, '测试', 'md', '版本2');
      expect(second.name).toBe('测试(2).md');
      expect(fs.readFileSync(first.abs, 'utf8')).toBe('版本1');
      expect(fs.readFileSync(second.abs, 'utf8')).toBe('版本2');
    });
  });

  describe('没勾就导出全部', () => {
    it('selection 为 null 时导出所有未隐藏块，隐藏块永不导出', async () => {
      const { svc, rootDir, repo } = await setup();
      const { id } = repo.import(sampleDoc);

      // 隐藏第 3 块（内部隐秘）
      repo.setSelection(id, null, [3]);
      expect(repo.selection(id)).toEqual({ selected: null, hidden: [3] });

      const created = await exportRebirthToRoot(repo, svc, { id, dir: rootDir });
      const text = fs.readFileSync(created.absPath, 'utf8');

      expect(text).toContain('需求描述');
      expect(text).toContain('架构决策');
      expect(text).not.toContain('内部隐秘');
    });

    it('有具体勾选时仅导出勾选块；全不选时导出提示文本', async () => {
      const { svc, rootDir, repo } = await setup();
      const { id } = repo.import(sampleDoc);

      // 仅勾选第 1 块
      repo.setSelection(id, [1], []);
      const created1 = await exportRebirthToRoot(repo, svc, { id, dir: rootDir, name: '仅块一' });
      const text1 = fs.readFileSync(created1.absPath, 'utf8');
      expect(text1).toContain('需求描述');
      expect(text1).not.toContain('架构决策');
      expect(text1).not.toContain('内部隐秘');

      // 全不选
      repo.setSelection(id, [], []);
      const createdEmpty = await exportRebirthToRoot(repo, svc, { id, dir: rootDir, name: '空' });
      const textEmpty = fs.readFileSync(createdEmpty.absPath, 'utf8');
      expect(textEmpty).toBe('（未选择任何内容）');
    });
  });

  describe('内容和「导出为文件…」完全一致', () => {
    it('对比 exportRebirthToRoot 与 rebirthExportFile 生成的文件内容，两者完全一致', async () => {
      const { svc, rootDir, repo, extraDir } = await setup();
      const { id } = repo.import(sampleDoc);
      const outDir = extraDir();
      const exportFileDest = path.join(outDir, 'export-file-dest.md');

      const api = bindRebirthMethods(repo, {
        pickJson: vi.fn(async () => null),
        saveFile: vi.fn(async () => exportFileDest),
        copy: vi.fn(),
        startDrag: vi.fn(),
      });

      // 1. 默认选择（没勾就导出全部）
      const fileRes = await api.rebirthExportFile({ id }) as { canceled: boolean; path: string };
      expect(fileRes.canceled).toBe(false);
      const contentFile = fs.readFileSync(fileRes.path, 'utf8');

      const rootRes = await exportRebirthToRoot(repo, svc, { id, dir: rootDir });
      const contentRoot = fs.readFileSync(rootRes.absPath, 'utf8');

      expect(contentRoot).toBe(contentFile);
      expect(contentRoot).toBe(repo.generate(id).text);

      // 2. 部分选择（仅勾选第 2 块）
      repo.setSelection(id, [2], []);
      const exportFileDest2 = path.join(outDir, 'export-file-dest2.md');
      const api2 = bindRebirthMethods(repo, {
        pickJson: vi.fn(async () => null),
        saveFile: vi.fn(async () => exportFileDest2),
        copy: vi.fn(),
        startDrag: vi.fn(),
      });

      await api2.rebirthExportFile({ id });
      const contentFile2 = fs.readFileSync(exportFileDest2, 'utf8');

      const rootRes2 = await exportRebirthToRoot(repo, svc, { id, dir: rootDir, name: '第二份' });
      const contentRoot2 = fs.readFileSync(rootRes2.absPath, 'utf8');

      expect(contentRoot2).toBe(contentFile2);
      expect(contentRoot2).toBe(repo.generate(id).text);
      expect(contentRoot2).toContain('架构决策');
      expect(contentRoot2).not.toContain('需求描述');
    });
  });

  describe('不允许写进应用数据目录', () => {
    it('试图写入应用数据目录或其子目录时抛出错误，且磁盘不产生文件', async () => {
      const { svc, dataDir, repo } = await setup();
      const { id } = repo.import(sampleDoc);

      const subDataDir = path.join(dataDir, 'nested-sub');
      fs.mkdirSync(subDataDir, { recursive: true });

      await expect(exportRebirthToRoot(repo, svc, { id, dir: dataDir })).rejects.toThrow(/应用数据目录/);
      await expect(exportRebirthToRoot(repo, svc, { id, dir: subDataDir })).rejects.toThrow(/应用数据目录/);

      expect(fs.readdirSync(dataDir).filter((f) => f.endsWith('.md'))).toHaveLength(0);
      expect(fs.readdirSync(subDataDir)).toHaveLength(0);
    });
  });

  describe('生成后登记进索引', () => {
    it('落在已注册根内登记为 indexed，更新目录并返回展开链，侧栏即时可查', async () => {
      const { svc, rootDir, root, repo } = await setup();
      const { id } = repo.import(sampleDoc);

      const created = await exportRebirthToRoot(repo, svc, { id, dir: rootDir });
      expect(created.placed).toBe('indexed');
      expect(created.rootId).toBe(root.id);
      expect(created.expandIds).toContain(root.resourceId);

      // 验证索引中已存在该条目
      const entry = svc.listDir(root.id, '').find((e) => e.name === created.name);
      expect(entry).toBeDefined();
      expect(entry?.resourceId).toBe(created.resourceId);
      expect(entry?.kind).toBe('file');
      expect(svc.readText(created.resourceId).text).toBe(repo.generate(id).text);
    });

    it('落在根外按单文件来源登记为 source', async () => {
      const { svc, repo, extraDir } = await setup();
      const { id } = repo.import(sampleDoc);
      const outsideDir = extraDir();

      const beforeRoots = svc.rootsToWatch().length;
      const created = await exportRebirthToRoot(repo, svc, { id, dir: outsideDir });
      expect(created.placed).toBe('source');
      expect(svc.rootsToWatch()).toHaveLength(beforeRoots + 1);

      const added = svc.rootsToWatch().find((r) => r.resourceId === created.resourceId);
      expect(added?.kind).toBe('file');
      expect(svc.readText(created.resourceId).text).toBe(repo.generate(id).text);
    });
  });

  describe('IPC 管道与 Host 协作', () => {
    it('通过 bindRebirthMethods 的 host.exportToRoot 转发', async () => {
      const { svc, rootDir, repo } = await setup();
      const { id } = repo.import(sampleDoc);

      const exportToRootMock = vi.fn(async (input: { dir: string; name: string; content: string }) => {
        return await exportRebirthToRoot(repo, svc, { id, dir: input.dir, name: input.name });
      });

      const api = bindRebirthMethods(repo, {
        pickJson: vi.fn(async () => null),
        saveFile: vi.fn(async () => null),
        copy: vi.fn(),
        startDrag: vi.fn(),
        exportToRoot: exportToRootMock,
      });

      const res = await (api.rebirthExportRoot as Function)({ id, dir: rootDir, name: '测试转发.md' });
      expect(exportToRootMock).toHaveBeenCalledWith({
        dir: rootDir,
        name: '测试转发.md',
        content: repo.generate(id).text,
      });
      expect(res.name).toBe('测试转发.md');
      expect(res.placed).toBe('indexed');
    });

    it('独立模式（无 host.exportToRoot）时通过 fallback 安全写出', async () => {
      const { repo, extraDir } = await setup();
      const { id } = repo.import(sampleDoc);
      const targetDir = extraDir();

      const api = bindRebirthMethods(repo, {
        pickJson: vi.fn(async () => null),
        saveFile: vi.fn(async () => null),
        copy: vi.fn(),
        startDrag: vi.fn(),
      });

      const res = await (api.rebirthExportRoot as Function)({ id, dir: targetDir }) as { name: string; absPath: string };
      expect(res.name).toBe('R1-架构设计方案.md');
      expect(fs.existsSync(res.absPath)).toBe(true);
      expect(fs.readFileSync(res.absPath, 'utf8')).toBe(repo.generate(id).text);
    });
  });
});
