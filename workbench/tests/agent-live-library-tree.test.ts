import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { structureMarkdown } from '../src/main/agentLive/entry/docs';
import {
  collectLibraryTree,
  createLibraryTreeRefresh,
  fileCanOpen,
  LIBRARY_TREE_MAX_DEPTH,
  LIBRARY_TREE_MAX_ENTRIES,
  LIBRARY_TREE_REFRESH_MS,
  libraryTreeToEntryNodes,
  type LibraryTreeNode,
} from '../src/main/agentLive/entry/libraryTree';
import { createLiveEntryWriter } from '../src/main/agentLive/entry/writer';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-libtree-'));
  dirs.push(dir);
  return dir;
}

function findNamed(nodes: LibraryTreeNode[] | undefined, name: string): LibraryTreeNode | undefined {
  if (!nodes) return undefined;
  for (const node of nodes) {
    if (node.name === name) return node;
    const nested = findNamed(node.children, name);
    if (nested) return nested;
  }
  return undefined;
}

function namesOf(nodes: LibraryTreeNode[] | undefined): string[] {
  return (nodes ?? []).map((node) => node.name);
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('资料根目录树', () => {
  it('默认按阅读器分类判断能否打开', () => {
    expect(fileCanOpen('笔记.md')).toBe(true);
    expect(fileCanOpen('图.png')).toBe(true);
    expect(fileCanOpen('稿.pdf')).toBe(true);
    expect(fileCanOpen('数据.bin')).toBe(false);
  });

  it('超过 6 层时截断，并在根上记下 depth', async () => {
    const root = tempDir();
    let cur = root;
    for (let i = 1; i <= LIBRARY_TREE_MAX_DEPTH + 1; i += 1) {
      cur = path.join(cur, `d${i}`);
      fs.mkdirSync(cur);
    }
    fs.writeFileSync(path.join(cur, 'leaf.md'), '不应出现的正文 LEAF_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }]);
    expect(tree.maxDepth).toBe(6);
    expect(tree.truncated).toBe(true);
    expect(tree.truncatedReason).toBe('depth');
    const d6 = findNamed(tree.roots, 'd6');
    expect(d6?.truncated).toBe(true);
    expect(d6?.children).toBeUndefined();
    expect(d6?.path).toBe(path.join(path.resolve(root), 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'));
    expect(path.isAbsolute(d6?.path ?? '')).toBe(true);
    expect(fs.existsSync(d6?.path ?? '')).toBe(true);
    expect(fs.statSync(d6!.path).isDirectory()).toBe(true);
    expect(tree.roots[0]?.path).toBe(path.resolve(root));
    expect(findNamed(tree.roots, 'd7')).toBeUndefined();
    expect(findNamed(tree.roots, 'leaf.md')).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain('LEAF_BODY');
  });

  it('超过条目上限时截断，目录优先且按名字排序', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'c.md'), 'C_BODY');
    fs.writeFileSync(path.join(root, 'a.md'), 'A_BODY');
    fs.mkdirSync(path.join(root, 'm'));
    fs.writeFileSync(path.join(root, 'm', 'nested.md'), 'N_BODY');
    fs.writeFileSync(path.join(root, 'b.md'), 'B_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }], { maxEntries: 3 });
    const listed = tree.roots[0];
    expect(listed?.truncated).toBe(true);
    expect(tree.truncatedReason).toBe('entries');
    expect(tree.maxEntries).toBe(3);
    expect(namesOf(listed?.children)).toEqual(['m']);
    expect(findNamed(tree.roots, 'a.md')).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain('A_BODY');
    expect(JSON.stringify(tree)).not.toContain('N_BODY');
  });

  it('子目录把条目预算用完时，父级没列完的位置也标截断', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'm'));
    fs.writeFileSync(path.join(root, 'm', 'nested.md'), 'N_BODY');
    fs.writeFileSync(path.join(root, 'a.md'), 'A_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }], { maxEntries: 2 });
    const listed = tree.roots[0];
    expect(tree.truncatedReason).toBe('entries');
    expect(listed?.truncated).toBe(true);
    expect(namesOf(listed?.children)).toEqual(['m']);
    expect(findNamed(tree.roots, 'm')?.truncated).toBe(true);
    expect(findNamed(tree.roots, 'm')?.children).toBeUndefined();
    expect(findNamed(tree.roots, 'nested.md')).toBeUndefined();
    expect(findNamed(tree.roots, 'a.md')).toBeUndefined();
  });

  it('跳过隐藏目录、系统目录和符号链接', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'keep.md'), 'KEEP_BODY');
    fs.writeFileSync(path.join(root, '.keep.md'), 'DOT_BODY');
    fs.mkdirSync(path.join(root, '.secret'));
    fs.writeFileSync(path.join(root, '.secret', 'h.md'), 'HIDDEN_BODY');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg.md'), 'PKG_BODY');
    fs.mkdirSync(path.join(root, '$RECYCLE.BIN'));
    fs.writeFileSync(path.join(root, '$RECYCLE.BIN', 'r.md'), 'BIN_BODY');
    fs.mkdirSync(path.join(root, 'System Volume Information'));
    fs.writeFileSync(path.join(root, 'System Volume Information', 's.md'), 'SYS_BODY');
    fs.mkdirSync(path.join(root, 'real'));
    fs.writeFileSync(path.join(root, 'real', 'inside.md'), 'IN_BODY');
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'), 'dir');
    fs.symlinkSync(path.join(root, 'keep.md'), path.join(root, 'keep-link.md'));
    const tree = await collectLibraryTree([{ name: '库', path: root }]);
    const text = JSON.stringify(tree);
    expect(namesOf(tree.roots[0]?.children)).toEqual(['real', '.keep.md', 'keep.md']);
    expect(findNamed(tree.roots, 'inside.md')?.relPath).toBe('real/inside.md');
    expect(findNamed(tree.roots, 'link')).toBeUndefined();
    expect(findNamed(tree.roots, 'keep-link.md')).toBeUndefined();
    expect(findNamed(tree.roots, '.secret')).toBeUndefined();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'outside.md'), 'OUT_BODY');
    fs.symlinkSync(outside, path.join(root, 'out-link'), 'dir');
    const again = await collectLibraryTree([{ name: '库', path: root }]);
    expect(findNamed(again.roots, 'out-link')).toBeUndefined();
    expect(JSON.stringify(again)).not.toContain(path.resolve(outside));
    expect(JSON.stringify(again)).not.toContain('OUT_BODY');
    expect(findNamed(tree.roots, 'node_modules')).toBeUndefined();
    expect(text).not.toContain('$RECYCLE.BIN');
    expect(text).not.toContain('System Volume Information');
    expect(text).not.toContain('HIDDEN_BODY');
    expect(text).not.toContain('PKG_BODY');
    expect(text).not.toContain('KEEP_BODY');
  });

  it('Dirent 报成目录但 lstat 是符号链接时不跟着进去', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'keep.md'), 'KEEP_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }], {
      io: {
        async readdir(dir) {
          if (path.resolve(dir) !== path.resolve(root)) return [];
          return [
            { name: 'junction', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'keep.md', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
          ] as unknown as import('node:fs').Dirent[];
        },
        async lstat(file) {
          if (path.basename(file) === 'junction') {
            return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false } as unknown as import('node:fs').Stats;
          }
          return fs.promises.lstat(file);
        },
      },
    });
    expect(namesOf(tree.roots[0]?.children)).toEqual(['keep.md']);
    expect(findNamed(tree.roots, 'junction')).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain('KEEP_BODY');
  });

  it('隐藏无法打开的文件默认开，关掉后保留这些文件', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'note.md'), 'NOTE');
    fs.writeFileSync(path.join(root, 'pic.png'), 'PNG');
    fs.writeFileSync(path.join(root, 'data.bin'), 'BIN');
    fs.writeFileSync(path.join(root, 'agent-token.json'), 'SECRET');
    const hidden = await collectLibraryTree([{ name: '库', path: root }]);
    expect(hidden.hideUnopenableFiles).toBe(true);
    expect(namesOf(hidden.roots[0]?.children).sort()).toEqual(['note.md', 'pic.png']);
    const shown = await collectLibraryTree([{ name: '库', path: root }], { hideUnopenableFiles: false });
    expect(shown.hideUnopenableFiles).toBe(false);
    expect(namesOf(shown.roots[0]?.children).sort()).toEqual(['data.bin', 'note.md', 'pic.png']);
    expect(JSON.stringify(shown)).not.toContain('agent-token.json');
    expect(JSON.stringify(shown)).not.toContain('SECRET');
  });

  it('读失败的目录记下来并继续', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'stay.md'), 'STAY');
    fs.mkdirSync(path.join(root, 'locked'));
    fs.writeFileSync(path.join(root, 'locked', 'secret.md'), 'LOCKED_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }], {
      io: {
        async readdir(dir) {
          if (path.basename(dir) === 'locked') {
            throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
          }
          return fs.promises.readdir(dir, { withFileTypes: true });
        },
        lstat: (file) => fs.promises.lstat(file),
      },
    });
    expect(findNamed(tree.roots, 'stay.md')).toBeTruthy();
    expect(findNamed(tree.roots, 'locked')?.children).toBeUndefined();
    expect(findNamed(tree.roots, 'secret.md')).toBeUndefined();
    expect(tree.errors).toEqual([{ path: 'locked', message: 'EACCES' }]);
    expect(findNamed(tree.roots, 'locked')?.path).toBe(path.join(path.resolve(root), 'locked'));
    expect(fs.existsSync(findNamed(tree.roots, 'locked')!.path)).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('LOCKED_BODY');
  });

  it('每个节点的 path 是资料根内的真实绝对路径', async () => {
    const root = tempDir();
    const rootAbs = path.resolve(root);
    fs.mkdirSync(path.join(root, '论文'));
    fs.writeFileSync(path.join(root, '论文', '笔记.md'), '正文不应进树');
    const tree = await collectLibraryTree([{ name: '库', path: path.relative(process.cwd(), root) }]);
    const listed = tree.roots[0]!;
    expect(listed).toMatchObject({ name: '库', kind: 'dir', relPath: '' });
    expect(listed.path).toBe(rootAbs);
    expect(path.isAbsolute(listed.path)).toBe(true);
    expect(fs.existsSync(listed.path)).toBe(true);
    expect(fs.statSync(listed.path).isDirectory()).toBe(true);

    const paper = findNamed(tree.roots, '论文')!;
    expect(paper).toMatchObject({ kind: 'dir', relPath: '论文' });
    expect(paper.path).toBe(path.join(rootAbs, '论文'));
    expect(path.isAbsolute(paper.path)).toBe(true);
    expect(fs.existsSync(paper.path)).toBe(true);
    expect(fs.statSync(paper.path).isDirectory()).toBe(true);

    const note = findNamed(tree.roots, '笔记.md')!;
    expect(note).toMatchObject({ kind: 'file', relPath: '论文/笔记.md' });
    expect(note.path).toBe(path.join(rootAbs, '论文', '笔记.md'));
    expect(path.isAbsolute(note.path)).toBe(true);
    expect(fs.existsSync(note.path)).toBe(true);
    expect(fs.statSync(note.path).isFile()).toBe(true);
    if (path.sep === '\\') expect(note.path).not.toContain('/');
    else expect(note.path).not.toContain('\\');
    expect(JSON.stringify(tree)).not.toContain('正文不应进树');

    const structure = structureMarkdown(libraryTreeToEntryNodes(tree), []);
    expect(structure).toContain(`- 库/ · ${rootAbs}`);
    expect(structure).toContain(`  - 论文/ · ${paper.path}`);
    expect(structure).toContain(`    - 笔记.md · ${note.path}`);
    expect(structure).toContain('可直接读取');
    expect(structure).toContain('生成时没有读取正文。');

    const singleDir = tempDir();
    const single = path.join(singleDir, '单文件.md');
    fs.writeFileSync(single, 'SINGLE');
    const fileTree = await collectLibraryTree([{ name: '单文件.md', path: single }]);
    expect(fileTree.roots).toEqual([
      { name: '单文件.md', kind: 'file', relPath: '单文件.md', path: path.resolve(single) },
    ]);
    expect(path.isAbsolute(fileTree.roots[0]!.path)).toBe(true);
    expect(fs.existsSync(fileTree.roots[0]!.path)).toBe(true);
    expect(JSON.stringify(fileTree)).not.toContain('SINGLE');
  });

  it('名为 .. 的条目不会写出根外路径', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'keep.md'), 'KEEP_BODY');
    const tree = await collectLibraryTree([{ name: '库', path: root }], {
      io: {
        async readdir(dir) {
          if (path.resolve(dir) !== path.resolve(root)) return [];
          return [
            { name: '..', isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false },
            { name: 'keep.md', isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true },
          ] as unknown as import('node:fs').Dirent[];
        },
        lstat: (file) => fs.promises.lstat(file),
      },
    });
    expect(findNamed(tree.roots, '..')).toBeUndefined();
    const keep = findNamed(tree.roots, 'keep.md')!;
    expect(keep.path).toBe(path.join(path.resolve(root), 'keep.md'));
    expect(fs.existsSync(keep.path)).toBe(true);
    const back = path.relative(path.resolve(root), keep.path);
    expect(back === '' || (!back.startsWith('..') && !path.isAbsolute(back))).toBe(true);
    expect(JSON.stringify(tree)).not.toContain('KEEP_BODY');
  });

  it('structure.md 是缩进树，标出截断，并说明没有读正文', () => {
    const text = structureMarkdown(
      [
        { name: 'b.md', kind: 'file' },
        {
          name: 'a-dir',
          kind: 'dir',
          truncated: true,
          children: [{ name: 'z.md', kind: 'file', relPath: 'a-dir/z.md' }],
        },
        { name: 'a.md', kind: 'file' },
      ],
      [],
      { truncatedReason: 'depth', errors: [{ path: 'locked', message: 'EACCES' }] },
    );
    const dirAt = text.indexOf('- a-dir （已截断）');
    const aAt = text.indexOf('- a.md');
    const bAt = text.indexOf('- b.md');
    expect(dirAt).toBeGreaterThan(0);
    expect(dirAt).toBeLessThan(aAt);
    expect(aAt).toBeLessThan(bAt);
    expect(text).toContain('  - z.md');
    expect(text).toContain('资料树已截断：超过深度限制。');
    expect(text).toContain('生成时没有读取正文。');
    expect(text).toContain('可直接读取');
    expect(text).not.toContain('没有遍历根目录');
    expect(text).toContain('locked · EACCES');
    const root = path.resolve('/tmp/kb-struct');
    const dirPath = path.join(root, 'a-dir');
    const withPath = structureMarkdown(
      [
        { name: 'b.md', kind: 'file', path: path.join(root, 'b.md') },
        {
          name: 'a-dir',
          kind: 'dir',
          truncated: true,
          path: dirPath,
          children: [{ name: 'z.md', kind: 'file', relPath: 'a-dir/z.md', path: path.join(dirPath, 'z.md') }],
        },
        { name: 'a.md', kind: 'file', path: path.join(root, 'a.md') },
      ],
      [],
      { truncatedReason: 'depth' },
    );
    expect(withPath.indexOf(`- a-dir/ （已截断） · ${dirPath}`)).toBeGreaterThan(0);
    expect(withPath.indexOf(`- a-dir/ （已截断） · ${dirPath}`)).toBeLessThan(withPath.indexOf(`- a.md · ${path.join(root, 'a.md')}`));
    expect(withPath).toContain(`  - z.md · ${path.join(dirPath, 'z.md')}`);
    expect(withPath).toContain(`- b.md · ${path.join(root, 'b.md')}`);
    expect(withPath).toContain('资料树已截断：超过深度限制。');
    const many = structureMarkdown(
      Array.from({ length: 501 }, (_, i) => ({ name: `f${String(i).padStart(3, '0')}.md`, kind: 'file' as const })),
      [],
    );
    expect(many).toContain('快照节点较多，这里只列了前 500 个。');
    expect(many).not.toContain('f500.md');
  });

  it('snapshot.json 追加 libraryTree，schemaVersion 仍是 1', async () => {
    const bridge = tempDir();
    const root = tempDir();
    const rootAbs = path.resolve(root);
    const notePath = path.join(rootAbs, '笔记.md');
    fs.writeFileSync(notePath, 'NOTE_BODY');
    const tree = {
      hideUnopenableFiles: true,
      maxDepth: LIBRARY_TREE_MAX_DEPTH,
      maxEntries: LIBRARY_TREE_MAX_ENTRIES,
      truncated: true as const,
      truncatedReason: 'depth' as const,
      roots: [
        {
          name: '库',
          kind: 'dir' as const,
          relPath: '',
          path: rootAbs,
          children: [
            { name: 'agent-token.json', kind: 'file' as const, relPath: 'agent-token.json', path: path.join(rootAbs, 'agent-token.json') },
            { name: '笔记.md', kind: 'file' as const, relPath: '笔记.md', path: notePath },
          ],
        },
      ],
    };
    const live = createLiveEntryWriter({
      bridgeRoot: bridge,
      now: () => new Date('2026-10-14T00:00:00.000Z'),
      loadScene: () => ({
        workspaceName: '论文',
        libraryTree: tree,
        structure: libraryTreeToEntryNodes(tree),
      }),
    });
    await live.render('ws-m', 3);
    await live.whenIdle();
    const snapshot = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      schemaVersion: number;
      workspaceId: string;
      sections: string[];
      nav: { structure: string };
      libraryTree: {
        hideUnopenableFiles: boolean;
        maxDepth: number;
        maxEntries: number;
        truncatedReason?: string;
        roots: Array<{ name: string; kind: string; relPath: string; path: string; children?: Array<{ name: string; kind: string; relPath: string; path: string }> }>;
      };
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.workspaceId).toBe('ws-m');
    expect(snapshot.nav.structure).toBe('nav/structure.md');
    expect(snapshot.sections.at(-1)).toBe('libraryTree');
    expect(snapshot.libraryTree).toMatchObject({
      hideUnopenableFiles: true,
      maxDepth: LIBRARY_TREE_MAX_DEPTH,
      maxEntries: LIBRARY_TREE_MAX_ENTRIES,
      truncatedReason: 'depth',
    });
    expect(snapshot.libraryTree.roots[0]).toMatchObject({ name: '库', kind: 'dir', relPath: '', path: rootAbs });
    expect(snapshot.libraryTree.roots[0]?.children).toEqual([
      { name: '笔记.md', kind: 'file', relPath: '笔记.md', path: notePath },
    ]);
    expect(path.isAbsolute(notePath)).toBe(true);
    expect(fs.existsSync(rootAbs)).toBe(true);
    expect(fs.existsSync(notePath)).toBe(true);
    expect(fs.statSync(notePath).isFile()).toBe(true);
    const structure = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'nav', 'structure.md'), 'utf8');
    expect(structure).toContain(`- 库/ · ${rootAbs}`);
    expect(structure).toContain(`  - 笔记.md · ${notePath}`);
    expect(structure).not.toContain('agent-token.json');
    expect(structure).not.toContain('NOTE_BODY');
    expect(structure).toContain('生成时没有读取正文。');
    expect(structure).toContain('可直接读取');
    expect(structure).toContain('资料树已截断：超过深度限制。');
    const entry = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    const guide = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'nav', 'guide.md'), 'utf8');
    expect(entry).toContain('可直接读取');
    expect(guide).toContain('可直接读取');
    expect(entry).not.toContain('不能直接读');
    expect(guide).not.toContain('不能直接读');
    expect(entry).not.toContain('须走请求');
    expect(guide).not.toContain('须走请求');
    expect(guide).toContain('不用另走请求');
  });

  it('根目录变化防抖约 1.5 秒，连发只刷新一次', () => {
    vi.useFakeTimers();
    let calls = 0;
    const listeners: Array<() => void> = [];
    const stop = createLibraryTreeRefresh({
      subscribe: (listener) => {
        listeners.push(listener);
        return () => {
          const at = listeners.indexOf(listener);
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      refresh: () => {
        calls += 1;
      },
    });
    const emit = () => {
      for (const listener of [...listeners]) listener();
    };
    expect(LIBRARY_TREE_REFRESH_MS).toBe(1500);
    emit();
    emit();
    vi.advanceTimersByTime(1499);
    expect(calls).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(1);
    emit();
    vi.advanceTimersByTime(1000);
    emit();
    vi.advanceTimersByTime(1499);
    expect(calls).toBe(1);
    vi.advanceTimersByTime(1);
    expect(calls).toBe(2);
    emit();
    stop();
    vi.advanceTimersByTime(2000);
    expect(calls).toBe(2);
    expect(listeners).toHaveLength(0);
  });
});
