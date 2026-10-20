import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { previewContextMenu } from '../src/shared/agentMarks';
import { parseRenameLines, takeCompleteLines } from '../src/shared/obsidianBridge/jsonl';
import { locateByHeadingText, locateOpenTarget, mapPreviewPoint } from '../src/shared/obsidianBridge/target';
import { SETTINGS_CATEGORIES, categoryNeedsData } from '../src/renderer/settings/categories';
import { isRendererDataMethod, MAIN_METHOD_SET } from '../src/shared/dataMethods';
import { isRewritableMarkdown } from '../src/main/obsidianBridge/files';
import { rewriteWikilinks } from '../src/shared/obsidianBridge/wikilink';
import {
  bridgeStateDir,
  classifyMarkdownOpen,
  defaultRelayVaultDir,
  exchangeDirName,
  isOfficialWorkbenchData,
  readJunctionFlag,
  resolveBridgeToolsDir,
} from '../src/shared/obsidianBridge/vault';

const note = [
  '---',
  'title: 前言',
  '---',
  '',
  '## 市场范围 ^kb-a1b2c3',
  '',
  '见正文。',
  '',
  '段落自己的块 ^kb-ccc111',
  '',
  '## 没有锚点',
  '',
  '```',
  '## 假标题 ^kb-zzzzzz',
  '```',
  '',
  '围栏后面',
].join('\n');

function at(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe('预览定位块和标题', () => {
  it('标题上的 kb- 块、段落后的块、没有锚点的标题', () => {
    expect(locateOpenTarget(note, at(note, '## 市场范围'))).toEqual({ block: 'kb-a1b2c3', heading: '市场范围' });
    expect(locateOpenTarget(note, at(note, '见正文'))).toEqual({ block: 'kb-a1b2c3', heading: '市场范围' });
    expect(locateOpenTarget(note, at(note, '段落自己的块'))).toEqual({ block: 'kb-ccc111', heading: '市场范围' });
    expect(locateOpenTarget(note, at(note, '## 没有锚点'))).toEqual({ heading: '没有锚点' });
  });

  it('前言和围栏里的标记不算块', () => {
    expect(locateOpenTarget(note, at(note, 'title:'))).toEqual({});
    expect(locateOpenTarget(note, at(note, '## 假标题'))).toEqual({ heading: '没有锚点' });
    expect(locateOpenTarget(note, at(note, '围栏后面'))).toEqual({ heading: '没有锚点' });
    expect(locateOpenTarget(note, null)).toEqual({});
  });

  it('预览落点和标题文字能对回原文', () => {
    const source = '## 市场范围 ^kb-a1b2c3\n\n正文\n';
    const preview = '市场范围 ^kb-a1b2c3\n\n正文\n';
    const point = mapPreviewPoint(source, preview, preview.indexOf('正文'));
    expect(point).toBe(source.indexOf('正文'));
    expect(locateOpenTarget(source, point)).toEqual({ block: 'kb-a1b2c3', heading: '市场范围' });
    expect(mapPreviewPoint(source, `${preview}\n正文`, preview.length)).toBeNull();
    expect(locateByHeadingText(source, '市场范围 ^kb-a1b2c3')).toEqual({ block: 'kb-a1b2c3', heading: '市场范围' });
  });
});

describe('根路径 Wikilink', () => {
  const from = '项目/旧名.md';
  const to = '资料/新名.md';

  it('改路径，留下显示名和块，笔记可以不写 .md', () => {
    const source = '见 [[项目/旧名#^kb-a1b2c3|这三家]] 和 [[项目/旧名.md]]，还有 ![[项目/旧名]]。';
    const next = rewriteWikilinks(source, [{ from, to }]);
    expect(next.count).toBe(3);
    expect(next.text).toBe('见 [[资料/新名#^kb-a1b2c3|这三家]] 和 [[资料/新名.md]]，还有 ![[资料/新名]]。');
  });

  it('不改围栏、行内代码、相对路径和只是同名的另一条路径', () => {
    const source = [
      '[[其他/项目/旧名]]',
      '[[../旧名]]',
      '[[#^kb-a1b2c3]]',
      '`[[项目/旧名]]`',
      '```',
      '[[项目/旧名]]',
      '```',
      '[[项目/报告.pdf|原报告]]',
    ].join('\n');
    const next = rewriteWikilinks(source, [
      { from, to },
      { from: '项目/报告.pdf', to: '归档/报告.pdf' },
    ]);
    expect(next.text).toContain('[[其他/项目/旧名]]');
    expect(next.text).toContain('[[../旧名]]');
    expect(next.text).toContain('[[#^kb-a1b2c3]]');
    expect(next.text).toContain('`[[项目/旧名]]`');
    expect(next.text).toContain('```\n[[项目/旧名]]\n```');
    expect(next.text).toContain('[[归档/报告.pdf|原报告]]');
  });

  it('按记录顺序连着改', () => {
    const next = rewriteWikilinks('[[项目/旧名]]', [
      { from, to },
      { from: '资料/新名.md', to: '资料/最终.md' },
    ]);
    expect(next.text).toBe('[[资料/最终]]');
  });
});

describe('改名日志偏移', () => {
  it('只消费完整行，中文按字节计', () => {
    const line = `${JSON.stringify({ from: '项目/旧名.md', to: '项目/新名.md', ts: '2026-10-19T00:00:00.000Z' })}\n`;
    const buf = Buffer.from(`垃圾\n${line}`, 'utf8');
    const first = takeCompleteLines(buf, 0);
    expect(first.lines).toEqual(['垃圾', line.trim()]);
    expect(first.nextOffset).toBe(buf.length);
    const parsed = parseRenameLines(first.lines);
    expect(parsed.bad).toBe(1);
    expect(parsed.records).toEqual([{ from: '项目/旧名.md', to: '项目/新名.md', ts: '2026-10-19T00:00:00.000Z' }]);
    const partial = Buffer.from(`${line}{"from":"a.md"`);
    expect(takeCompleteLines(partial, 0).lines).toEqual([line.trim()]);
    expect(takeCompleteLines(partial, Buffer.byteLength(line))).toEqual({ lines: [], nextOffset: Buffer.byteLength(line) });
  });
});

describe('库判断和菜单', () => {
  it('已经在库里就用库内路径，配置目录和正式用户库拒绝', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkw-vault-'));
    try {
      fs.mkdirSync(path.join(root, '.obsidian'));
      fs.mkdirSync(path.join(root, '项目'));
      const file = path.join(root, '项目', '市场范围.md');
      fs.writeFileSync(file, '# x\n');
      const isDir = (dir: string) => {
        try { return fs.statSync(dir).isDirectory(); } catch { return false; }
      };
      expect(classifyMarkdownOpen(file, {}, isDir)).toEqual({
        kind: 'vault',
        hit: { vaultRoot: root, vaultName: path.basename(root), relPath: '项目/市场范围.md' },
      });
      const hidden = path.join(root, '.obsidian', 'note.md');
      fs.writeFileSync(hidden, '# x\n');
      expect(classifyMarkdownOpen(hidden, {}, isDir).kind).toBe('refuse');
      const outside = path.join(root, '..', `out-${path.basename(root)}.md`);
      fs.writeFileSync(outside, '# x\n');
      expect(classifyMarkdownOpen(path.resolve(outside), {}, isDir)).toEqual({ kind: 'relay' });
      fs.unlinkSync(outside);
      expect(classifyMarkdownOpen(path.join(root, '图片.png'), {}, isDir).kind).toBe('refuse');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('正式用户库不写，默认中转库在用户目录下', () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), 'lkw-local-'));
    const env = { LOCALAPPDATA: local, USERPROFILE: path.join(local, 'home'), HOME: path.join(local, 'home') };
    const official = path.join(local, 'LocalKnowledgeWorkbench');
    expect(isOfficialWorkbenchData(official, env)).toBe(true);
    expect(isOfficialWorkbenchData(path.join(local, 'other'), env)).toBe(false);
    expect(bridgeStateDir(official, env)).toBe(path.join(env.HOME, '.lkw-obsidian-bridge'));
    expect(bridgeStateDir(path.join(local, 'other'), env)).toBe(path.join(local, 'other', 'obsidian-bridge'));
    expect(defaultRelayVaultDir({ USERPROFILE: env.HOME }, env.HOME)).toBe(path.join(env.HOME, 'LKW-Relay-Vault'));
    expect(defaultRelayVaultDir({ LKW_RELAY_VAULT: path.join(local, 'custom') }, env.HOME)).toBe(path.join(local, 'custom'));
    expect(readJunctionFlag(undefined)).toBe(false);
    expect(readJunctionFlag({ crossVolumeJunction: 'true' })).toBe(false);
    expect(readJunctionFlag({ crossVolumeJunction: true, highlight: false })).toBe(true);
    expect(exchangeDirName({ exchangeDir: '交换' })).toBe('交换');
    expect(exchangeDirName({ exchangeDir: '../x' })).toBe('lkw-exchange');
    fs.rmSync(local, { recursive: true, force: true });
  });

  it('Markdown 才出现「在 Obsidian 打开」，点不了的项照旧置灰显示', () => {
    const idle = previewContextMenu({ hasSelection: false, fileInRound: true, selectionOrClickOnMark: false });
    expect(idle.map((item) => item.testId)).toEqual(['preview-ctx-copy', 'preview-ctx-mark', 'preview-ctx-unmark']);
    expect(idle.every((item) => !item.enabled)).toBe(true);
    const md = previewContextMenu({ hasSelection: false, fileInRound: false, selectionOrClickOnMark: false, markdownFile: true });
    expect(md.map((item) => item.testId)).toEqual(['preview-ctx-copy', 'preview-ctx-mark', 'preview-ctx-unmark', 'preview-ctx-obsidian']);
    expect(md.filter((item) => item.enabled).map((item) => item.testId)).toEqual(['preview-ctx-obsidian']);
    const ready = previewContextMenu({
      hasSelection: true,
      fileInRound: true,
      selectionOrClickOnMark: false,
      markdownFile: true,
    });
    expect(ready.map((item) => [item.label, item.enabled])).toEqual([
      ['复制', true],
      ['标红给 Agent', true],
      ['取消此处标红', false],
      ['在 Obsidian 打开', true],
    ]);
  });

  it('设置分类、主进程方法和可改写的 md', () => {
    expect(SETTINGS_CATEGORIES).toContainEqual({ id: 'obsidian', label: 'Obsidian', needsData: false });
    expect(categoryNeedsData('obsidian')).toBe(false);
    for (const name of ['obsidianBridgeGet', 'obsidianBridgeSetVault', 'obsidianBridgeInit', 'obsidianBridgeSetJunction', 'obsidianOpen']) {
      expect(MAIN_METHOD_SET.has(name)).toBe(true);
      expect(isRendererDataMethod(name)).toBe(false);
    }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkw-md-'));
    const noteFile = path.join(root, '笔记.md');
    const hidden = path.join(root, '.obsidian', 'x.md');
    expect(isRewritableMarkdown(noteFile, [])).toBe(true);
    expect(isRewritableMarkdown(hidden, [])).toBe(false);
    expect(isRewritableMarkdown(path.join(root, 'lkw-exchange', 'a.md'), [])).toBe(false);
    expect(isRewritableMarkdown(noteFile, [root])).toBe(false);
    const menu = fs.readFileSync(path.join(__dirname, '../src/renderer/agent-marks/menu.tsx'), 'utf8');
    expect(menu).not.toContain('visibleMenuItems');
    expect(menu).toContain("item.id === 'obsidian'");
    expect(menu).toContain('event.preventDefault()');
    const reader = fs.readFileSync(path.join(__dirname, '../src/renderer/plugins/builtin-readers/index.tsx'), 'utf8');
    expect(reader).toContain('markdownFile: resource.ext === \'md\' || resource.ext === \'markdown\'');
    const service = fs.readFileSync(path.join(__dirname, '../src/main/obsidianBridge/service.ts'), 'utf8');
    expect(service).not.toContain('child_process');
    expect(service).not.toContain('relay-open.mjs');
    expect(service).toContain('openRelayFromSettings');
    expect(service).toContain('cleanupClosed');
    const tools = resolveBridgeToolsDir({}, (file) => file.endsWith('relay-core.mjs') || file.endsWith('make-uri.mjs'), path.resolve('/workspace/kb-restore/ob-open-r21'));
    expect(tools).toBe(path.resolve('/workspace/ob-plugin/lkw-bridge/tools'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
