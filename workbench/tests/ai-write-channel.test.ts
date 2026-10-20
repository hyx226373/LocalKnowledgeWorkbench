import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createLiveEntryWriter } from '../src/main/agentLive/entry/writer';
import { InboxEngine } from '../src/main/aiWrite/inboxCopy';
import { AiWriteChannel, loadWriteChannelSnapshot } from '../src/main/aiWrite/service';
import { rootEntryLink } from '../src/main/rebirth/links';
import { setNativeDragRootIndex } from '../src/renderer/nativeDrag/paths';
import { linkTargetsFromPayload } from '../src/renderer/aiWrite/drops';
import {
  applyUnifiedDiff,
  classicRootEntry,
  changeActions,
  changeSummary,
  composeScopedLink,
  DISCARD_PENDING_WARNING,
  defaultSettings,
  defaultTemplate,
  discardManifestBody,
  evaluateMediumChange,
  isLargeDeletion,
  legacyStageSummary,
  linkRowSummary,
  markdownFormatDamaged,
  normalizeSettings,
  reviewMediumChange,
  rootKey,
  sessionSummary,
  toWriteChannelSnapshot,
  WRITE_TIER_META,
  type AiWriteSettings,
  type ScopedLinkItem,
} from '../src/shared/aiWriteChannel';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(dir);
  return dir;
}

function sha(text: string): string {
  return createHash('sha256').update(Buffer.from(text)).digest('hex');
}

function backups(store: string): Buffer[] {
  const root = path.join(store, 'backups');
  const out: Buffer[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.bak')) out.push(fs.readFileSync(abs));
    }
  };
  walk(root);
  return out;
}

function withTier(tier: AiWriteSettings['defaultTier'], agentId = 'codex'): AiWriteSettings {
  return { ...defaultSettings(), defaultTier: tier, pasteAgentId: agentId };
}

function item(path: string, tier: ScopedLinkItem['tier'], kind: ScopedLinkItem['kind'] = 'dir', childDirs: string[] = []): ScopedLinkItem {
  return { path, name: path.split(/[\\/]/).pop() || path, kind, tier, childDirs };
}

it('各档备份标签：高中低是软件备份，快速通道无备份', () => {
  expect(WRITE_TIER_META.high.backup).toBe('软件备份');
  expect(WRITE_TIER_META.medium.backup).toBe('软件备份');
  expect(WRITE_TIER_META.low.backup).toBe('软件备份');
  expect(WRITE_TIER_META.fast.backup).toBe('无备份');
  const pane = fs.readFileSync(path.join(process.cwd(), 'src/renderer/settings/AiWriteChannelPane.tsx'), 'utf8');
  expect(pane).toContain('ai-write-backup-');
  expect(pane).toContain('meta.backup');
});

it('链接只带链接区里的项，不列文件，按档位给路径', () => {
  const entry = 'D:\\bridge\\live\\current\\ENTRY.md';
  const root = 'D:\\笔记\\重要';
  const other = 'D:\\别的根';
  const fast = composeScopedLink({ items: [item(root, 'fast', 'dir', ['项目', '归档'])], settings: defaultSettings() });
  expect(fast).toContain(root);
  expect(fast).toContain('项目');
  expect(fast).toContain('Read only needed scoped files');
  expect(fast).not.toContain('note.txt');
  expect(fast).not.toContain(other);
  expect(fast).not.toContain(entry);
  expect(fast).not.toContain('请立即执行：读取当前根目录');
  expect(classicRootEntry([root], entry)).toBe(rootEntryLink([root], entry));
  const inbox = 'D:\\kb-inbox\\s_ab12cd34';
  const high = composeScopedLink({
    items: [item(root, 'high', 'dir', ['机密', 'note.txt'])],
    settings: withTier('high'),
    agentId: 'claude',
    inboxPath: inbox,
  });
  expect(high.startsWith('Write channel: high.')).toBe(true);
  expect(high).toContain('Changes are proposals until the user approves');
  expect(high).toContain(inbox);
  expect(high).toContain('never write plan.json or .kb-stage');
  expect(high).not.toContain('expectedHash');
  expect(high).not.toContain('机密');
  expect(high).not.toContain('note.txt');
  expect(high).not.toContain(root);
  expect(high).not.toContain(entry);
  const fileItem = item(`${root}\\note.txt`, 'high', 'file');
  const highFile = composeScopedLink({ items: [fileItem], settings: withTier('high'), inboxPath: inbox });
  expect(highFile).toContain(inbox);
  expect(highFile).toContain('never write plan.json or .kb-stage');
  expect(highFile).not.toContain('expectedHash');
  expect(highFile).not.toContain(root);
  const blocked = composeScopedLink({ items: [item(root, 'high')], settings: withTier('high') });
  expect(blocked).toContain('missing: stop and request an inbox');
  expect(blocked).not.toContain(root);
  expect(blocked).toContain('never write plan.json or .kb-stage');
  const medium = composeScopedLink({ items: [item(root, 'medium', 'dir', ['项目'])], settings: withTier('medium') });
  expect(medium).toContain('files, change scope, and conflict handling');
  expect(medium).toContain('Before reading target files or writing');
  expect(medium).toContain(root);
  expect(medium).toContain('项目');
  expect(medium).not.toContain('note.txt');
  expect(medium).not.toContain('expectedHash');
  const low = composeScopedLink({ items: [item(root, 'low')], settings: withTier('low') });
  expect(low).toContain(root);
  expect(low).toContain("user's already clear scope");
  expect(low).toContain('LKW backs up tracked writes');
  expect(low).toContain('or create .kb-bak files');
  const empty = composeScopedLink({ items: [], settings: defaultSettings() });
  expect(empty).toContain('No scoped files were supplied');
  expect(empty).not.toContain(root);
});

it('各 agent 的高档提示词不同，改完能按原样保存', () => {
  expect(defaultTemplate('codex', 'high')).toBe(defaultTemplate('claude', 'high'));
  expect(defaultTemplate('grok', 'high')).toContain('Write channel: high');
  expect(defaultTemplate('cursor', 'fast')).toContain('Direct writes have no LKW backup');
  const settings = defaultSettings();
  const agents = settings.agents.map((agent) => agent.id === 'codex' ? { ...agent, templates: { ...agent.templates, high: '自定义高档，必须先提交计划' } } : agent);
  const saved = normalizeSettings({ ...settings, defaultTier: 'high', agents });
  const dropped = [item('D:\\笔记', 'high')];
  const text = composeScopedLink({ items: dropped, settings: saved, agentId: 'codex' });
  expect(text.startsWith('Write channel: high.')).toBe(true); expect(text).not.toContain('必须先提交计划');
  const claude = composeScopedLink({ items: dropped, settings: saved, agentId: 'claude' });
  expect(claude.startsWith('Write channel: high.')).toBe(true);
  expect(defaultTemplate('codex', 'high')).toContain('No inbox/mapping means stop');
});

it('文件夹规则盖过默认档，但链接只含放进去的路径', () => {
  const root = 'D:\\项目';
  const child = 'D:\\项目\\机密';
  const settings = normalizeSettings({
    ...defaultSettings(),
    defaultTier: 'fast',
    folders: [{ id: 'f1', path: child, tier: 'high' }],
    linkItems: [{ id: 'l1', path: child, name: '机密', kind: 'dir' }],
  });
  const text = composeScopedLink({
    items: [{ path: child, name: '机密', kind: 'dir', tier: 'high' }],
    settings,
    inboxPath: 'D:\\kb-inbox\\s_aabbccdd',
  });
  expect(text).not.toContain(root);
  expect(text).not.toContain(child);
  expect(text).toContain('never write plan.json or .kb-stage');
  expect(text).toContain('D:\\kb-inbox\\s_aabbccdd');
  expect(text.startsWith('Write channel: high.')).toBe(true);
  expect(defaultTemplate('codex', 'medium')).toContain('files, change scope, and conflict handling');
  expect(defaultTemplate('codex', 'low')).toContain("user's already clear scope");
  expect(defaultTemplate('codex', 'low')).toContain('or create .kb-bak files');
  expect(defaultTemplate('codex', 'medium').length).toBeGreaterThan(defaultTemplate('codex', 'low').length);
});

it('中档审查：大段删除和 md 格式损坏要拦，小改动放行', () => {
  const body = '正文'.repeat(80);
  const prev = `---\n来源对话: a\n---\n\n## 概述\n<!-- type: overview -->\n${body}\n`;
  const broken = `## 概述\n${body}\n`;
  expect(markdownFormatDamaged(prev, broken)).toBe(true);
  expect(markdownFormatDamaged(prev, prev.replace('正文', '改写'))).toBe(false);
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  expect(isLargeDeletion(long, 'short')).toBe(true);
  expect(isLargeDeletion('hello', 'world')).toBe(false);
  expect(reviewMediumChange({
    previousHash: 'a', expectedHash: 'a', hadFile: true, zonePath: '/notes', absPath: '/notes/a.md', rel: 'a.md', previousText: prev, nextText: broken, markdown: true,
  })).toContain('format');
  expect(reviewMediumChange({
    previousHash: 'a', expectedHash: 'b', hadFile: true, zonePath: '/notes', absPath: '/notes/a.txt', rel: 'a.txt', previousText: 'hello', nextText: 'world', markdown: false,
  })).toEqual(['hash']);
  expect(reviewMediumChange({
    previousHash: 'a', expectedHash: 'a', hadFile: true, zonePath: '/notes', absPath: '/other/a.txt', rel: '../a.txt', previousText: 'hello', nextText: 'world', markdown: false,
  })).toContain('escape');
});

it('拒绝把通道数据写进 LocalAppData 正式目录', () => {
  const banned = 'C:\\Users\\user\\AppData\\Local\\LocalKnowledgeWorkbench\\ai-write';
  expect(() => new AiWriteChannel(banned)).toThrow(/LocalKnowledgeWorkbench/);
  expect(fs.existsSync(banned)).toBe(false);
  const store = temp('ai-write-store-');
  const channel = new AiWriteChannel(store, { watch: false });
  const saved = channel.setSettings({
    ...channel.getSettings(),
    folders: [{ id: 'bad', path: 'C:\\Users\\user\\AppData\\Local\\LocalKnowledgeWorkbench\\docs', tier: 'low' }],
  });
  expect(saved.folders).toEqual([]);
  const src = fs.readFileSync(path.join(process.cwd(), 'src/main/aiWrite/service.ts'), 'utf8');
  expect(src).not.toContain('clipboard');
  expect(fs.readFileSync(path.join(process.cwd(), 'src/main/aiWrite/ipc.ts'), 'utf8')).not.toContain('clipboard');
});

it('高档批准才写入，并先备份、校验哈希', () => {
  const store = temp('ai-write-high-');
  const root = path.join(store, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  const entry = path.join(store, 'ENTRY.md');
  const link = channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry, agentId: 'codex' });
  expect(link.startsWith('Write channel: high.')).toBe(true);
  expect(link).not.toContain(root);
  expect(link).not.toContain(entry);
  expect(fs.existsSync(path.join(root, '.kb-stage'))).toBe(false);
  const key = rootKey(root);
  const bad = { files: [{ virtualPath: `kb-stage://${key}/note.txt`, expectedHash: sha('nope'), content: 'world' }] };
  fs.mkdirSync(path.join(root, '.kb-stage', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kb-stage', 'inbox', 'plan.json'), JSON.stringify(bad));
  const blocked = channel.approve(channel.pending().plans[0]!.planId);
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.reason).toBe('conflict');
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('hello');
  const plan = { files: [{ virtualPath: `kb-stage://${key}/note.txt`, expectedHash: sha('hello'), content: 'world' }] };
  fs.writeFileSync(path.join(root, '.kb-stage', 'inbox', 'plan.json'), JSON.stringify(plan));
  const pending = channel.pending();
  expect(pending.plans[0]?.files[0]?.conflict).toBe(false);
  const result = channel.approve(pending.plans[0]!.planId);
  expect(result.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('world');
  expect(backups(path.join(store, 'state')).some((buf) => buf.toString() === 'hello')).toBe(true);
  expect(fs.existsSync(path.join(root, '.kb-stage', 'inbox', 'plan.json'))).toBe(false);
});

it('高档可以用 diff 计划写入', () => {
  const store = temp('ai-write-diff-');
  const root = path.join(store, 'root');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  const diff = ['--- a/note.txt', '+++ b/note.txt', '@@ -1 +1 @@', '-hello', '+world', ''].join('\n');
  expect(applyUnifiedDiff('hello', diff)).toBe('world');
  expect(fs.existsSync(path.join(root, '.kb-stage'))).toBe(false);
  const plan = { files: [{ virtualPath: `kb-stage://${rootKey(root)}/note.txt`, expectedHash: `sha256:${sha('hello')}`, unifiedDiff: diff }] };
  fs.mkdirSync(path.join(root, '.kb-stage', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(root, '.kb-stage', 'inbox', 'plan.json'), JSON.stringify(plan));
  expect(channel.approve(channel.pending().plans[0]!.planId).ok).toBe(true);
  expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('world');
});

it('中档由工作台在改动前留版，基线对不上就停下', () => {
  expect(evaluateMediumChange({ previousHash: 'a', expectedHash: 'a', hadFile: true })).toBe('accept');
  expect(evaluateMediumChange({ previousHash: 'b', expectedHash: 'a', hadFile: true })).toBe('conflict');
  const store = temp('ai-write-mid-');
  const root = path.join(store, 'root');
  const file = path.join(root, 'note.txt');
  fs.mkdirSync(root);
  fs.writeFileSync(file, 'hello');
  const state = path.join(store, 'state');
  const channel = new AiWriteChannel(state, { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'medium' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  channel.addLinkItems([{ path: root, kind: 'dir' }]);
  const link = channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  expect(link).toContain(root);
  expect(link).toContain('Before reading target files or writing');
  expect(link).not.toContain('note.txt');
  fs.writeFileSync(file, 'world');
  channel.ingestPath(file);
  expect(fs.readFileSync(file, 'utf8')).toBe('world');
  expect(backups(state).some((buf) => buf.toString() === 'hello')).toBe(true);
  const drifted = new AiWriteChannel(path.join(store, 'state-2'), { watch: false });
  const root2 = path.join(store, 'root2');
  const file2 = path.join(root2, 'note.txt');
  fs.mkdirSync(root2);
  fs.writeFileSync(file2, 'hello');
  drifted.setSettings({ ...drifted.getSettings(), defaultTier: 'medium' });
  drifted.syncRoots([{ path: root2, name: '笔记' }]);
  fs.writeFileSync(path.join(store, 'state-2', 'preimage', rootKey(root2), 'note.txt'), 'other');
  fs.writeFileSync(file2, 'world');
  drifted.ingestPath(file2);
  const conflict = drifted.pending().conflicts[0];
  expect(conflict?.reasons).toContain('哈希冲突');
  expect(fs.readFileSync(file2, 'utf8')).toBe('world');
  drifted.resolveConflict(conflict!.id, 'restore');
  expect(fs.readFileSync(file2, 'utf8')).toBe('other');
  expect(drifted.pending().conflicts).toEqual([]);
});

it('snapshot 和 ENTRY 只追加写入通道，高档不带绝对路径', async () => {
  const bridge = temp('ai-write-entry-');
  const secret = 'D:\\秘密\\笔记';
  const writer = createLiveEntryWriter({
    bridgeRoot: bridge,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    loadScene: (workspaceId) => workspaceId === 'ws-m' ? {
      workspaceName: '试验',
      writeChannel: { defaultTier: 'high', folders: [{ id: 'ab', name: '笔记', tier: 'high', virtualPath: 'kb-stage://ab', absPath: secret }] },
    } : { workspaceName: '普通' },
  });
  await writer.render('ws-m', 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
    schemaVersion: number;
    sections: string[];
    writeChannel?: { folders: { absPath?: string; virtualPath: string }[] };
  };
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.sections.slice(0, 7)).toEqual(['workspace', 'panels', 'reading', 'materials', 'sessionMaterials', 'pinnedMaterials', 'nav']);
  expect(snapshot.sections.at(-1)).toBe('writeChannel');
  expect(snapshot.writeChannel?.folders[0]?.virtualPath).toBe('kb-stage://ab');
  expect(snapshot.writeChannel?.folders[0]?.absPath).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  const entry = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
  expect(entry.startsWith('<!-- kb-live schemaVersion=1 ')).toBe(true);
  expect(entry).toContain('## 6. 接入约定');
  expect(entry.indexOf('## 6. 接入约定')).toBeLessThan(entry.indexOf('## 7. AI 写入通道'));
  expect(entry).toContain('kb-stage://ab');
  expect(entry).not.toContain(secret);
  await writer.render('ws-n', 1);
  const plain = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-n', 'ENTRY.md'), 'utf8');
  expect(plain).not.toContain('## 7. AI 写入通道');
  const plainSnap = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-n', 'snapshot.json'), 'utf8')) as { sections: string[] };
  expect(plainSnap.sections).not.toContain('writeChannel');
});

it('快照只列链接区，高档文件不写绝对路径，别的根不进去', () => {
  const snap = toWriteChannelSnapshot(normalizeSettings({
    ...defaultSettings(),
    defaultTier: 'fast',
    linkItems: [
      { id: 'a', path: 'D:\\笔记', name: '笔记', kind: 'dir' },
      { id: 'b', path: 'D:\\秘密\\note.txt', name: 'note', kind: 'file' },
    ],
    folders: [{ id: 'f', path: 'D:\\秘密', tier: 'high' }],
  }), [{ path: 'D:\\别的根', name: '别的' }]);
  expect(snap.folders.map((folder) => folder.name)).toEqual(['笔记', 'note']);
  expect(snap.folders[0]?.absPath).toBe('D:\\笔记');
  expect(snap.folders[1]?.absPath).toBeUndefined();
  expect(snap.folders[1]?.virtualPath).toBe(`kb-stage://${rootKey('D:\\秘密')}/note.txt`);
  expect(JSON.stringify(snap)).not.toContain('别的根');
  expect(JSON.stringify(snap.folders[1])).not.toContain('秘密');
});

it('服务端链接不列文件，也不带没放进链接区的根', () => {
  const store = temp('ai-write-link-');
  const root = path.join(store, 'root');
  const other = path.join(store, 'other');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, '项目'));
  fs.writeFileSync(path.join(root, 'secret-note.txt'), 'x');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'other.txt'), 'y');
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'fast' });
  channel.addLinkItems([{ path: root, kind: 'dir' }]);
  const link = channel.composeLink({ roots: [{ path: root, name: '根' }, { path: other, name: '别的' }], entry: path.join(store, 'ENTRY.md') });
  expect(link).toContain(root);
  expect(link).toContain('项目');
  expect(link).not.toContain('secret-note.txt');
  expect(link).not.toContain(other);
  expect(link).not.toContain('other.txt');
  expect(link).toContain('no LKW backup');
});

it('低档软件备份后直接放行', () => {
  const store = temp('ai-write-low-');
  const root = path.join(store, 'root');
  const file = path.join(root, 'note.txt');
  fs.mkdirSync(root);
  fs.writeFileSync(file, 'hello');
  const state = path.join(store, 'state');
  const channel = new AiWriteChannel(state, { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'low' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  fs.writeFileSync(file, 'world');
  channel.ingestPath(file);
  expect(fs.readFileSync(file, 'utf8')).toBe('world');
  expect(channel.pending().conflicts).toEqual([]);
  expect(backups(state).some((buf) => buf.toString() === 'hello')).toBe(true);
});

it('中档大段删除和格式损坏不自动还原', () => {
  const store = temp('ai-write-review-');
  const root = path.join(store, 'root');
  fs.mkdirSync(root);
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, long);
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'medium' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  fs.writeFileSync(file, 'short');
  channel.ingestPath(file);
  const deletion = channel.pending().conflicts[0];
  expect(deletion?.reasons).toContain('大段删除');
  expect(fs.readFileSync(file, 'utf8')).toBe('short');
  channel.resolveConflict(deletion!.id, 'restore');
  expect(fs.readFileSync(file, 'utf8')).toBe(long);
  const body = '正文'.repeat(80);
  const md = path.join(root, 'page.md');
  const prev = `---\n来源对话: a\n---\n\n## 概述\n<!-- type: overview -->\n${body}\n`;
  fs.writeFileSync(md, prev);
  channel.ingestPath(md);
  expect(channel.pending().conflicts).toEqual([]);
  const broken = `## 概述\n${body}\n`;
  fs.writeFileSync(md, broken);
  channel.ingestPath(md);
  const format = channel.pending().conflicts[0];
  expect(format?.reasons).toContain('md 文件头或块格式损坏');
  expect(fs.readFileSync(md, 'utf8')).toBe(broken);
  channel.resolveConflict(format!.id, 'keep');
  expect(fs.readFileSync(md, 'utf8')).toBe(broken);
  expect(channel.pending().conflicts).toEqual([]);
});

it('中档符号链接越出根目录时不跟随、不还原到外面', () => {
  const store = temp('ai-write-escape-');
  const root = path.join(store, 'root');
  const outside = path.join(store, 'outside.txt');
  fs.mkdirSync(root);
  fs.writeFileSync(outside, 'secret');
  const link = path.join(root, 'link.txt');
  fs.symlinkSync(outside, link);
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'medium' });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  channel.ingestPath(link);
  const row = channel.pending().conflicts[0];
  expect(row?.reasons).toContain('越出根目录');
  expect(row?.canRestore).toBe(false);
  expect(fs.readFileSync(outside, 'utf8')).toBe('secret');
});

it('树里拖进链接区能解析成真实路径', () => {
  setNativeDragRootIndex([{ id: 'r1', path: 'D:\\笔记', kind: 'folder' }]);
  const dir = linkTargetsFromPayload({
    v: 1,
    items: [{ resourceId: 'a', sourceKind: 'file', from: { kind: 'root', rootId: 'r1', relPath: '子' }, entry: 'dir-entry', name: '子', rootId: 'r1', relPath: '子' }],
  });
  expect(dir[0]).toMatchObject({ kind: 'dir', name: '子' });
  expect(dir[0]?.path).toContain('子');
  expect(dir[0]?.path).not.toContain('note.txt');
  const file = linkTargetsFromPayload({
    v: 1,
    items: [{ resourceId: 'b', sourceKind: 'file', from: { kind: 'root', rootId: 'r1', relPath: 'a.txt' }, entry: 'file', name: 'a.txt' }],
  });
  expect(file[0]?.kind).toBe('file');
  expect(file[0]?.path).toContain('a.txt');
  expect(linkTargetsFromPayload({
    v: 1,
    items: [{ resourceId: 'w', sourceKind: 'web', from: { kind: 'workspace-refs', workspaceId: 'ws' }, entry: 'file', name: '网页' }],
  })).toEqual([]);
});

it('高档文件项复制进收件箱，粘贴只给收件箱路径', () => {
  const store = temp('ai-write-high-hash-');
  const inbox = temp('ai-write-high-hash-box-');
  const root = path.join(store, 'root');
  fs.mkdirSync(root);
  const file = path.join(root, 'note.md');
  fs.writeFileSync(file, 'hello');
  const missing = path.join(root, 'later.md');
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false, randomId: () => 's_ab12cd34' });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: file, kind: 'file' }, { path: missing, kind: 'file' }]);
  const link = channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md'), agentId: 'codex' });
  expect(link).toContain(path.join(inbox, 's_ab12cd34'));
  expect(link).not.toContain('expectedHash');
  expect(link).toContain('never write plan.json or .kb-stage');
  expect(link).not.toContain(root);
  expect(link).not.toContain('hello');
  expect(fs.readFileSync(path.join(inbox, 's_ab12cd34', 'note.md'), 'utf8')).toBe('hello');
  expect(fs.existsSync(path.join(root, '.kb-stage'))).toBe(false);
});

it('收件箱根不预填，并拒绝资料目录、agent-data 和正式用户目录', () => {
  expect(defaultSettings().inboxRoot).toBeUndefined();
  const kept = normalizeSettings({ ...defaultSettings(), inboxRoot: 'D:\\kb-inbox' });
  expect(kept.version).toBe(1);
  expect(kept.inboxRoot).toBe('D:\\kb-inbox');
  expect(normalizeSettings({ ...defaultSettings(), inboxRoot: 'C:\\Users\\user\\AppData\\Local\\LocalKnowledgeWorkbench\\inbox' }).inboxRoot).toBeUndefined();
  const store = temp('ai-write-inbox-ban-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const channel = new AiWriteChannel(path.join(store, 'state'), { watch: false });
  channel.syncRoots([{ path: root, name: '笔记' }]);
  expect(() => channel.setSettings({ ...channel.getSettings(), inboxRoot: root })).toThrow(/资料/);
  expect(() => channel.setSettings({ ...channel.getSettings(), inboxRoot: store })).toThrow(/agent-data/);
  expect(() => channel.setSettings({ ...channel.getSettings(), inboxRoot: 'C:\\Users\\user\\AppData\\Local\\LocalKnowledgeWorkbench\\in' })).toThrow(/LocalKnowledgeWorkbench/);
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high' });
  channel.addLinkItems([{ path: root, kind: 'dir' }]);
  expect(() => channel.composeLink({ roots: [{ path: root }], entry: path.join(store, 'ENTRY.md') })).toThrow(/收件箱/);
  expect(fs.existsSync(path.join(root, '.kb-stage'))).toBe(false);
});

it('高档副本改完后原件未变可写回，原件变了不覆盖', async () => {
  const store = temp('ai-write-inbox-copy-');
  const inbox = temp('ai-write-inbox-box-');
  const root = path.join(store, 'notes');
  const other = path.join(store, 'other');
  fs.mkdirSync(path.join(root, '子'), { recursive: true });
  fs.writeFileSync(path.join(root, '子', 'a.md'), 'hello');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'config'), 'secret');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'nope.txt'), 'no');
  const state = path.join(store, 'state');
  const ids = ['s_ab12cd34', 's_bbccddee'];
  let n = 0;
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => ids[n++] || 's_ccddeeff',
    trash: async (file) => {
      fs.rmSync(file, { recursive: true, force: true });
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: root, kind: 'dir' }]);
  const extra = path.join(other, 'extra.md');
  fs.writeFileSync(extra, 'from-agent');
  const link = channel.composeLink({
    roots: [{ path: root, name: '笔记' }, { path: other, name: '别的' }],
    entry: path.join(store, 'ENTRY.md'),
    agentId: 'codex',
    materials: [{ absPath: path.join(root, '子', 'a.md'), name: 'a.md' }, { absPath: extra, name: 'extra.md' }],
  });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  expect(link.startsWith('Write channel: high.')).toBe(true);
  expect(link).toContain(inboxDir);
  expect(link).not.toContain(root);
  expect(link).not.toContain(other);
  expect(link).toContain('never write plan.json or .kb-stage');
  expect(link).not.toContain('expectedHash');
  expect(link).not.toContain('nope.txt');
  expect(ids[0]).not.toBe(rootKey(root));
  const copy = path.join(inboxDir, 'notes', '子', 'a.md');
  expect(fs.readFileSync(copy, 'utf8')).toBe('hello');
  expect(fs.existsSync(path.join(inboxDir, 'notes', '.git'))).toBe(false);
  expect(fs.readFileSync(path.join(inboxDir, 'extra.md'), 'utf8')).toBe('from-agent');
  expect(fs.readdirSync(inboxDir).filter((name) => name === 'a.md')).toEqual([]);
  expect(fs.existsSync(path.join(root, '.kb-stage'))).toBe(false);
  expect(fs.existsSync(path.join(other, '.kb-stage'))).toBe(false);
  const index = JSON.parse(fs.readFileSync(path.join(state, 'sessions', 'index.json'), 'utf8')) as { sessionId: string; status: string; inboxDir: string; sourceCount: number }[];
  expect(index[0]).toMatchObject({ sessionId: 's_ab12cd34', status: 'open', inboxDir, sourceCount: 2 });
  fs.writeFileSync(copy, 'world');
  expect(fs.readFileSync(path.join(root, '子', 'a.md'), 'utf8')).toBe('hello');
  const changes = channel.collect();
  expect(changes.map((row) => row.op)).toEqual(['modify']);
  expect(changes[0]?.note).toBe('原件未变');
  const applied = await channel.apply({ sessionId: 's_ab12cd34', fileId: changes[0]!.fileId, decision: 'approve' });
  expect(applied.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, '子', 'a.md'), 'utf8')).toBe('world');
  expect(backups(state).some((buf) => buf.toString() === 'hello')).toBe(true);
  // 全部批准后副本不自动删，要用户结束会话、确认清单后才进回收站。
  expect(fs.existsSync(inboxDir)).toBe(true);
  const listed = await channel.discardSession('s_ab12cd34');
  expect(listed).toMatchObject({ needsConfirm: true, removed: false, pendingCount: 0 });
  expect(fs.existsSync(inboxDir)).toBe(true);
  const ended = await channel.discardSession('s_ab12cd34', true);
  expect(ended).toMatchObject({ removed: true, via: 'trash' });
  expect(fs.existsSync(inboxDir)).toBe(false);
  fs.writeFileSync(path.join(root, '子', 'a.md'), 'hello2');
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const copy2 = path.join(inbox, 's_bbccddee', 'notes', '子', 'a.md');
  fs.writeFileSync(copy2, 'world2');
  fs.writeFileSync(path.join(root, '子', 'a.md'), 'user-edit');
  const again = channel.collect('s_bbccddee');
  expect(again[0]?.op).toBe('conflict');
  const blocked = await channel.apply({ sessionId: 's_bbccddee', fileId: again[0]!.fileId, decision: 'approve' });
  expect(blocked.ok).toBe(false);
  if (!blocked.ok) expect(blocked.reason).toBe('conflict');
  expect(fs.readFileSync(path.join(root, '子', 'a.md'), 'utf8')).toBe('user-edit');
  expect(backups(state).some((buf) => buf.toString() === 'hello2')).toBe(true);
});

it('对不上源文件夹的新建文件，不指定目标就不能写回', async () => {
  const store = temp('ai-write-inbox-new-');
  const inbox = temp('ai-write-inbox-new-box-');
  const root = path.join(store, 'notes');
  const landing = path.join(store, 'landing');
  fs.mkdirSync(root);
  fs.mkdirSync(landing);
  fs.writeFileSync(path.join(root, 'a.md'), 'hello');
  const channel = new AiWriteChannel(path.join(store, 'state'), {
    watch: false,
    randomId: () => 's_ab12cd34',
    trash: async (file) => {
      fs.rmSync(file, { recursive: true, force: true });
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: root, kind: 'dir' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  fs.writeFileSync(path.join(inboxDir, '草稿.md'), 'new');
  fs.writeFileSync(path.join(inboxDir, 'notes', '新稿.md'), 'inside');
  const changes = channel.collect();
  const loose = changes.find((row) => row.inboxRel === '草稿.md');
  const nested = changes.find((row) => row.inboxRel === 'notes/新稿.md');
  expect(loose?.op).toBe('create');
  expect(loose?.needsLanding).toBe(true);
  expect(nested?.needsLanding).toBe(false);
  expect(nested?.landingAbs).toBe(path.join(root, '新稿.md'));
  await expect(channel.apply({ sessionId: 's_ab12cd34', fileId: loose!.fileId, decision: 'approve' })).rejects.toThrow(/目标文件夹/);
  expect(fs.existsSync(path.join(root, '草稿.md'))).toBe(false);
  const saved = await channel.apply({ sessionId: 's_ab12cd34', fileId: loose!.fileId, decision: 'approve', landingDir: landing });
  expect(saved.ok).toBe(true);
  expect(fs.readFileSync(path.join(landing, '草稿.md'), 'utf8')).toBe('new');
  const written = await channel.apply({ sessionId: 's_ab12cd34', fileId: nested!.fileId, decision: 'approve' });
  expect(written.ok).toBe(true);
  expect(fs.readFileSync(path.join(root, '新稿.md'), 'utf8')).toBe('inside');
});

it('混档粘贴只有高档项进收件箱，旧 plan.json 仍在批准列表', () => {
  const store = temp('ai-write-mix-');
  const inbox = temp('ai-write-mix-box-');
  const highDir = path.join(store, 'high');
  const midDir = path.join(store, 'mid');
  const fastDir = path.join(store, 'fast');
  fs.mkdirSync(highDir);
  fs.writeFileSync(path.join(highDir, 'a.md'), 'hello');
  fs.mkdirSync(path.join(highDir, '.kb-stage', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(highDir, '.kb-stage', 'inbox', 'plan.json'), JSON.stringify({
    files: [{ virtualPath: `kb-stage://${rootKey(highDir)}/a.md`, expectedHash: `sha256:${sha('hello')}`, content: 'planned' }],
  }));
  fs.mkdirSync(midDir);
  fs.writeFileSync(path.join(midDir, 'm.txt'), 'mid');
  fs.mkdirSync(fastDir);
  fs.writeFileSync(path.join(fastDir, 'f.txt'), 'fast');
  const channel = new AiWriteChannel(path.join(store, 'state'), {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
  });
  channel.setSettings({
    ...channel.getSettings(),
    defaultTier: 'fast',
    inboxRoot: inbox,
    folders: [
      { id: 'high', path: highDir, tier: 'high' },
      { id: 'mid', path: midDir, tier: 'medium' },
    ],
  });
  channel.addLinkItems([{ path: highDir, kind: 'dir' }, { path: midDir, kind: 'dir' }, { path: fastDir, kind: 'dir' }]);
  const link = channel.composeLink({
    roots: [{ path: highDir, name: '高' }, { path: midDir, name: '中' }, { path: fastDir, name: '快' }],
    entry: path.join(store, 'ENTRY.md'),
  });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  expect(link).toContain(inboxDir);
  expect(link).not.toContain(midDir);
  expect(link).not.toContain(fastDir); expect(link).toContain('separate link for other targets');
  expect(link).not.toContain(highDir);
  expect(link).toContain('never write plan.json or .kb-stage');
  expect(fs.readFileSync(path.join(inboxDir, 'high', 'a.md'), 'utf8')).toBe('hello');
  expect(fs.existsSync(path.join(inboxDir, 'high', '.kb-stage'))).toBe(false);
  expect(fs.existsSync(path.join(inboxDir, 'mid'))).toBe(false);
  expect(fs.existsSync(path.join(inboxDir, 'fast'))).toBe(false);
  expect(fs.readFileSync(path.join(midDir, 'm.txt'), 'utf8')).toBe('mid');
  const status = channel.linkStatus();
  const highRow = status.rows.find((row) => row.path === highDir);
  const midRow = status.rows.find((row) => row.path === midDir);
  expect(linkRowSummary(highRow!)).toContain('文件夹');
  expect(linkRowSummary(highRow!)).toContain('已复制 1');
  expect(linkRowSummary(midRow!)).not.toContain('已复制');
  expect(status.session?.inboxDir).toBe(inboxDir);
  expect(status.session?.label).toBe('未收取');
  expect(sessionSummary(status.session!)).toBe(`收件箱 ${inboxDir} · 未收取`);
  const pending = channel.pending();
  expect(pending.plans).toHaveLength(1);
  expect(pending.plans[0]?.files[0]?.rel).toBe('a.md');
  expect(pending.changes ?? []).toEqual([]);
  const snap = toWriteChannelSnapshot(channel.getSettings(), [], inboxDir);
  expect(snap.inboxPath).toBe(inboxDir);
  expect(snap.folders.find((folder) => folder.tier === 'high')?.absPath).toBeUndefined();
  expect(snap.folders.find((folder) => folder.tier === 'high')?.virtualPath.startsWith('kb-stage://')).toBe(true);
  expect(snap.folders.find((folder) => folder.tier === 'medium')?.absPath).toBe(midDir);
  expect(JSON.stringify(snap.folders.find((folder) => folder.tier === 'high'))).not.toContain(highDir);
  const loose = { sessionId: 's', fileId: 'f', inboxRel: '草稿.md', op: 'create' as const, role: 'created' as const, binary: false, copySize: 0, nextSize: 3, needsLanding: true, landingAbs: '', oldText: '', newText: 'new' };
  expect(changeActions(loose).approve).toBe(false);
  expect(changeActions(loose).pickLanding).toBe(true);
  expect(changeSummary({ ...loose, needsLanding: false, note: '新建' })).toBe('草稿.md · 新建');
  expect(changeSummary({ ...loose, op: 'conflict', role: 'copy', needsLanding: false, note: '复制后原件已变 · 不覆盖' })).toContain('冲突');
  const pane = fs.readFileSync(path.join(process.cwd(), 'src/renderer/settings/AiWriteChannelPane.tsx'), 'utf8');
  const area = fs.readFileSync(path.join(process.cwd(), 'src/renderer/aiWrite/linkArea.tsx'), 'utf8');
  const board = fs.readFileSync(path.join(process.cwd(), 'src/renderer/aiWrite/approval.tsx'), 'utf8');
  expect(pane).toContain('data-testid="ai-write-inbox-root"');
  expect(pane).toContain('收件箱根目录');
  expect(area).toContain('data-testid="ai-write-collect"');
  expect(area).toContain('data-testid="ai-write-discard"');
  expect(area).toContain('aiWriteLinkStatus');
  expect(board).toContain('批准所选');
  expect(board).toContain('全部驳回');
  expect(board).toContain('aiWriteApply');
  expect(board).toContain('aiWriteApprove');
});

it('快照和 ENTRY 追加收件箱目录，高档仍不带资料绝对路径', async () => {
  const bridge = temp('ai-write-inbox-entry-');
  const secret = path.join(bridge, 'secret-notes');
  const inbox = path.join(bridge, 'inbox', 's_ab12cd34');
  const writer = createLiveEntryWriter({
    bridgeRoot: bridge,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    loadScene: () => ({
      workspaceName: '试验',
      writeChannel: { defaultTier: 'high', inboxPath: inbox, folders: [{ id: 'ab', name: '笔记', tier: 'high', virtualPath: 'kb-stage://ab', absPath: secret }] },
    }),
  });
  await writer.render('ws-m', 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
    schemaVersion: number;
    sections: string[];
    writeChannel?: { inboxPath?: string; folders: { absPath?: string; virtualPath: string }[] };
  };
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.sections.at(-1)).toBe('writeChannel');
  expect(snapshot.writeChannel?.inboxPath).toBe(inbox);
  expect(snapshot.writeChannel?.folders[0]?.virtualPath).toBe('kb-stage://ab');
  expect(snapshot.writeChannel?.folders[0]?.absPath).toBeUndefined();
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  const entry = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
  expect(entry.indexOf('## 6. 接入约定')).toBeLessThan(entry.indexOf('## 7. AI 写入通道'));
  expect(entry).toContain(`收件箱：${inbox}`);
  expect(entry).toContain('kb-stage://ab');
  expect(entry).not.toContain(secret);
  const data = temp('ai-write-load-snap-');
  const previous = process.env.KB_AGENT_DATA;
  process.env.KB_AGENT_DATA = data;
  try {
    const dir = path.join(data, 'ai-write');
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({
      ...defaultSettings(),
      defaultTier: 'high',
      linkItems: [{ id: 'a', path: secret, name: '笔记', kind: 'dir' }],
      folders: [{ id: 'f', path: secret, tier: 'high' }],
    }));
    fs.writeFileSync(path.join(dir, 'sessions', 'index.json'), JSON.stringify([
      { sessionId: 's_00112233', status: 'applied', createdAt: '2026-10-01T00:00:00.000Z', inboxDir: path.join(data, 'old'), sourceCount: 1 },
      { sessionId: 's_ab12cd34', status: 'open', createdAt: '2026-10-16T12:00:00.000Z', inboxDir: inbox, sourceCount: 1 },
    ]));
    const loaded = loadWriteChannelSnapshot([]);
    expect(loaded?.inboxPath).toBe(inbox);
    expect(loaded?.defaultTier).toBe('high');
    expect(loaded?.folders[0]?.absPath).toBeUndefined();
    expect(loaded?.folders[0]?.virtualPath.startsWith('kb-stage://')).toBe(true);
    expect(JSON.stringify(loaded?.folders[0])).not.toContain(secret);
  } finally {
    if (previous === undefined) delete process.env.KB_AGENT_DATA;
    else process.env.KB_AGENT_DATA = previous;
  }
});

it('写到一半不进批准，未处理完不直接删收件箱，原件和备份还在', async () => {
  const store = temp('ai-write-watch-');
  const inbox = temp('ai-write-watch-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const file = path.join(root, 'a.md');
  fs.writeFileSync(file, 'hello');
  const state = path.join(store, 'state');
  let trashed = 0;
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
    trash: async () => {
      trashed += 1;
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: file, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  const copy = path.join(inboxDir, 'a.md');
  fs.writeFileSync(copy, 'wor');
  channel.noteInboxActivity(copy);
  expect(channel.linkStatus().session?.dirty).toBe(true);
  expect(channel.linkStatus().session?.label).toBe('有未收取改动');
  expect(channel.pending().changes ?? []).toEqual([]);
  expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  fs.writeFileSync(copy, 'world');
  expect(channel.pending().changes ?? []).toEqual([]);
  const changes = channel.collect();
  expect(changes.map((row) => row.op)).toEqual(['modify']);
  expect(channel.linkStatus().session?.label).toBe('已收取');
  fs.writeFileSync(copy, 'world!');
  channel.noteInboxActivity(inboxDir);
  expect(channel.pending().changes ?? []).toEqual([]);
  expect(channel.linkStatus().session?.label).toBe('有未收取改动');
  const held = await channel.discardSession('s_ab12cd34');
  expect(held.needsConfirm).toBe(true);
  expect(held.removed).toBe(false);
  expect(held.pendingCount).toBeGreaterThan(0);
  expect(fs.existsSync(inboxDir)).toBe(true);
  expect(fs.readFileSync(file, 'utf8')).toBe('hello');
  expect(backups(state).some((buf) => buf.toString() === 'hello')).toBe(true);
  expect(trashed).toBe(0);
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/aiWrite/service.ts'), 'utf8');
  expect(source).not.toContain(".on('add', () => this.scanInboxes())");
  expect(source).toContain('noteInboxActivity(String(file))');
});

it('截断、二进制、重命名建议和多会话都只出现在收取之后', async () => {
  const store = temp('ai-write-edge-');
  const inbox = temp('ai-write-edge-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const big = path.join(root, 'big.txt');
  const bin = path.join(root, 'pic.bin');
  const renamed = path.join(root, 'old.md');
  const other = path.join(root, 'other.md');
  fs.writeFileSync(big, 'hello world');
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
  fs.writeFileSync(renamed, 'hello');
  fs.writeFileSync(other, 'second');
  const ids = ['s_ab12cd34', 's_bbccddee', 's_ccddeeff'];
  let n = 0;
  const channel = new AiWriteChannel(path.join(store, 'state'), {
    watch: false,
    now: () => new Date('2026-10-16T18:00:00.000Z'),
    randomId: () => ids[n++] || 's_ddeeff00',
    limits: { maxFile: 8 },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: big, kind: 'file' }]);
  const truncated = channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  expect(truncated).toContain('Inbox copies are incomplete');
  expect(fs.existsSync(path.join(inbox, 's_ab12cd34', 'big.txt'))).toBe(false);
  expect(fs.readFileSync(big, 'utf8')).toBe('hello world');
  const skipped = channel.linkStatus();
  expect(skipped.session?.truncated).toBe(true);
  expect(linkRowSummary(skipped.rows[0]!)).toContain('已跳过（超过大小上限）');
  expect(sessionSummary(skipped.session!)).toContain('副本不完整');
  channel.clearLinkItems();
  channel.addLinkItems([{ path: bin, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const binCopy = path.join(inbox, 's_bbccddee', 'pic.bin');
  fs.writeFileSync(binCopy, Buffer.from([0, 1, 2, 3, 4]));
  const binChanges = channel.collect('s_bbccddee');
  expect(binChanges[0]?.binary).toBe(true);
  expect(binChanges[0]?.op).toBe('modify');
  expect(binChanges[0]?.note).toContain('二进制');
  expect(binChanges[0]?.oldText).toBe('');
  expect(binChanges[0]?.newText).toBe('');
  expect(fs.readFileSync(bin).equals(Buffer.from([0, 1, 2, 3]))).toBe(true);
  channel.addLinkItems([{ path: renamed, kind: 'file' }, { path: other, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const renameDir = path.join(inbox, 's_ccddeeff');
  fs.rmSync(path.join(renameDir, 'old.md'));
  fs.writeFileSync(path.join(renameDir, 'new.md'), 'hello');
  const renamedChanges = channel.collect('s_ccddeeff');
  expect(renamedChanges.map((row) => row.op).sort()).toEqual(['rename', 'rename']);
  expect(renamedChanges.every((row) => row.note?.includes('重命名建议'))).toBe(true);
  expect(fs.readFileSync(renamed, 'utf8')).toBe('hello');
  const status = channel.linkStatus();
  expect(status.session?.otherOpen).toBeGreaterThan(0);
  expect(sessionSummary(status.session!)).toContain('已有进行中的会话');
});

it('空的旧暂存只列出，确认后才移入回收站', async () => {
  const store = temp('ai-write-legacy-');
  const state = path.join(store, 'state');
  const empty = path.join(store, 'empty-notes');
  const other = path.join(store, 'other-notes');
  const live = path.join(store, 'live-notes');
  const done = path.join(store, 'done-notes');
  const linked = path.join(store, 'link-notes');
  const secret = path.join(store, 'secret-target');
  const bin = path.join(store, 'recycle');
  fs.mkdirSync(path.join(empty, '.kb-stage', 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(other, '.kb-stage'), { recursive: true });
  fs.writeFileSync(path.join(other, '.kb-stage', 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(live, '.kb-stage', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(live, '.kb-stage', 'inbox', 'plan.json'), '{"files":[{"virtualPath":"kb-stage://ab/a.md"}]}');
  const body = Buffer.from('{"files":[]}');
  fs.mkdirSync(path.join(state, 'processed'), { recursive: true });
  fs.writeFileSync(path.join(state, 'processed', 'plan.done.json'), body);
  fs.mkdirSync(path.join(done, '.kb-stage', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(done, '.kb-stage', 'inbox', 'plan.json'), body);
  fs.mkdirSync(secret);
  fs.writeFileSync(path.join(secret, 'secret.txt'), 'no');
  fs.mkdirSync(linked);
  fs.symlinkSync(secret, path.join(linked, '.kb-stage'));
  fs.mkdirSync(bin);
  const mirror = rootKey(empty);
  fs.mkdirSync(path.join(state, 'stage', mirror, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(state, 'stage', 'notes', 'inbox'), { recursive: true });
  const trashed: string[] = [];
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    trash: async (file) => {
      trashed.push(file);
      fs.renameSync(file, path.join(bin, String(trashed.length)));
    },
  });
  channel.syncRoots([
    { path: empty, name: '空' },
    { path: other, name: '有文件' },
    { path: live, name: '未处理' },
    { path: done, name: '已处理' },
    { path: linked, name: '链接' },
  ]);
  const listed = channel.listLegacyStages();
  const paths = listed.map((row) => row.path);
  expect(paths).toContain(path.join(empty, '.kb-stage'));
  expect(paths).toContain(path.join(done, '.kb-stage'));
  expect(paths).toContain(path.join(state, 'stage', mirror));
  expect(paths.some((item) => item.includes('other-notes'))).toBe(false);
  expect(paths.some((item) => item.includes('live-notes'))).toBe(false);
  expect(paths.some((item) => item.includes('link-notes'))).toBe(false);
  expect(paths.some((item) => item.endsWith(`${path.sep}notes`))).toBe(false);
  expect(listed.find((row) => row.path === path.join(empty, '.kb-stage'))?.kind).toBe('empty');
  expect(listed.find((row) => row.path === path.join(done, '.kb-stage'))?.kind).toBe('processed-plan');
  expect(legacyStageSummary(listed.find((row) => row.kind === 'empty')!)).toContain('空');
  expect(trashed).toEqual([]);
  channel.pending();
  expect(trashed).toEqual([]);
  expect(fs.existsSync(path.join(empty, '.kb-stage'))).toBe(true);
  expect(fs.readFileSync(path.join(secret, 'secret.txt'), 'utf8')).toBe('no');
  await expect(channel.trashLegacyStages([path.join(other, '.kb-stage')])).rejects.toThrow(/清单/);
  expect(fs.readFileSync(path.join(other, '.kb-stage', 'keep.txt'), 'utf8')).toBe('keep');
  const target = path.join(empty, '.kb-stage');
  const result = await channel.trashLegacyStages([target]);
  expect(result.trashed).toEqual([target]);
  expect(trashed).toEqual([target]);
  expect(fs.existsSync(target)).toBe(false);
  expect(fs.existsSync(path.join(bin, '1'))).toBe(true);
  expect(fs.existsSync(path.join(done, '.kb-stage', 'inbox', 'plan.json'))).toBe(true);
  expect(fs.readFileSync(path.join(secret, 'secret.txt'), 'utf8')).toBe('no');
  const board = fs.readFileSync(path.join(process.cwd(), 'src/renderer/aiWrite/approval.tsx'), 'utf8');
  expect(board).toContain('data-testid="ai-write-legacy-stages"');
  expect(board).toContain('aiWriteLegacyStageTrash');
  expect(board).toContain('移入回收站');
  expect(board).toContain('dialogs.confirm');
});

function symlinkOrSkip(target: string, linkPath: string, type: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'ENOTSUP' || code === 'EACCES' || code === 'EINVAL')) return false;
    throw err;
  }
}

it('删除前 realpath 限定在收件箱根内，符号链接整单拒绝', async () => {
  const store = temp('ai-write-rm-guard-');
  const inbox = temp('ai-write-rm-guard-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const file = path.join(root, 'a.md');
  fs.writeFileSync(file, 'hello');
  const state = path.join(store, 'state');
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
    trash: async () => {
      throw new Error('这条不该进回收站');
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: file, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  const sentinel = path.join(inbox, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  const sessionFile = path.join(state, 'sessions', 's_ab12cd34.json');
  const doc = JSON.parse(fs.readFileSync(sessionFile, 'utf8')) as { inboxDir: string };
  const savedDir = doc.inboxDir;
  expect(savedDir).toBe(inboxDir);

  doc.inboxDir = inbox;
  fs.writeFileSync(sessionFile, JSON.stringify(doc));
  await expect(channel.discardSession('s_ab12cd34')).rejects.toThrow(/收件箱/);
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');
  expect(fs.existsSync(inboxDir)).toBe(true);

  const outside = path.join(store, 'outside');
  fs.mkdirSync(path.join(outside, 's_ab12cd34'), { recursive: true });
  fs.writeFileSync(path.join(outside, 's_ab12cd34', 'secret.txt'), 'secret');
  doc.inboxDir = path.join(outside, 's_ab12cd34');
  fs.writeFileSync(sessionFile, JSON.stringify(doc));
  await expect(channel.discardSession('s_ab12cd34')).rejects.toThrow(/收件箱/);
  expect(fs.readFileSync(path.join(outside, 's_ab12cd34', 'secret.txt'), 'utf8')).toBe('secret');
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');

  const rootNamed = path.join(store, 's_ab12cd34');
  fs.mkdirSync(rootNamed);
  fs.writeFileSync(path.join(rootNamed, 'keep.txt'), 'root');
  channel.setSettings({ ...channel.getSettings(), inboxRoot: rootNamed });
  doc.inboxDir = rootNamed;
  fs.writeFileSync(sessionFile, JSON.stringify(doc));
  await expect(channel.discardSession('s_ab12cd34', true)).rejects.toThrow(/不能删除收件箱根/);
  expect(fs.readFileSync(path.join(rootNamed, 'keep.txt'), 'utf8')).toBe('root');
  channel.setSettings({ ...channel.getSettings(), inboxRoot: inbox });

  const probe = path.join(store, 'probe-target');
  fs.mkdirSync(probe);
  if (!symlinkOrSkip(probe, path.join(store, 'probe-link'), 'dir')) return;

  const evil = path.join(store, 'evil');
  fs.mkdirSync(path.join(evil, 's_ab12cd34'), { recursive: true });
  fs.writeFileSync(path.join(evil, 's_ab12cd34', 'secret.txt'), 'secret');
  const linkRoot = path.join(store, 'link-root');
  expect(symlinkOrSkip(evil, linkRoot, 'dir')).toBe(true);
  channel.setSettings({ ...channel.getSettings(), inboxRoot: linkRoot });
  doc.inboxDir = path.join(linkRoot, 's_ab12cd34');
  fs.writeFileSync(sessionFile, JSON.stringify(doc));
  await expect(channel.discardSession('s_ab12cd34')).rejects.toThrow(/符号链接/);
  expect(fs.readFileSync(path.join(evil, 's_ab12cd34', 'secret.txt'), 'utf8')).toBe('secret');
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');

  channel.setSettings({ ...channel.getSettings(), inboxRoot: inbox });
  const linkedOutside = path.join(store, 'linked-outside');
  fs.mkdirSync(linkedOutside);
  fs.writeFileSync(path.join(linkedOutside, 'secret.txt'), 'linked');
  fs.rmSync(inboxDir, { recursive: true });
  expect(symlinkOrSkip(linkedOutside, inboxDir, 'dir')).toBe(true);
  doc.inboxDir = inboxDir;
  fs.writeFileSync(sessionFile, JSON.stringify(doc));
  await expect(channel.discardSession('s_ab12cd34')).rejects.toThrow(/符号链接/);
  expect(fs.readFileSync(path.join(linkedOutside, 'secret.txt'), 'utf8')).toBe('linked');
  expect(fs.lstatSync(inboxDir).isSymbolicLink()).toBe(true);
  expect(fs.readFileSync(sentinel, 'utf8')).toBe('keep');

  fs.unlinkSync(inboxDir);
  fs.mkdirSync(inboxDir);
  fs.writeFileSync(path.join(inboxDir, 'a.md'), 'copy');
  const secretFile = path.join(store, 'secret.txt');
  fs.writeFileSync(secretFile, 'no-touch');
  expect(symlinkOrSkip(secretFile, path.join(inboxDir, 'alias.txt'), 'file')).toBe(true);
  await expect(channel.discardSession('s_ab12cd34')).rejects.toThrow(/符号链接/);
  expect(fs.readFileSync(secretFile, 'utf8')).toBe('no-touch');
  expect(fs.readFileSync(path.join(inboxDir, 'a.md'), 'utf8')).toBe('copy');
  expect(fs.lstatSync(path.join(inboxDir, 'alias.txt')).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(path.join(state, 'inbox-delete.log'))).toBe(false);
});

it('待批准时不直接删，确认后进回收站而不是 rmSync', async () => {
  const store = temp('ai-write-rm-pending-');
  const inbox = temp('ai-write-rm-pending-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const file = path.join(root, 'a.md');
  fs.writeFileSync(file, 'hello');
  const state = path.join(store, 'state');
  const bin = path.join(store, 'bin');
  fs.mkdirSync(bin);
  const trashed: string[] = [];
  let logAtTrash = '';
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
    trash: async (target) => {
      logAtTrash = fs.readFileSync(path.join(state, 'inbox-delete.log'), 'utf8');
      trashed.push(target);
      fs.renameSync(target, path.join(bin, 'gone'));
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: file, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  fs.writeFileSync(path.join(inboxDir, 'a.md'), 'world');
  const changes = channel.collect();
  expect(changes.map((row) => row.op)).toEqual(['modify']);
  const held = await channel.discardSession('s_ab12cd34');
  expect(held.needsConfirm).toBe(true);
  expect(held.removed).toBe(false);
  expect(held.pendingCount).toBe(1);
  expect(held.sessionId).toBe('s_ab12cd34');
  expect(held.inboxDir).toBe(inboxDir);
  expect(held.fileCount).toBe(1);
  expect(held.warning).toBe(DISCARD_PENDING_WARNING);
  expect(discardManifestBody(held).indexOf(DISCARD_PENDING_WARNING)).toBe(0);
  expect(discardManifestBody(held)).toContain('会话编号 s_ab12cd34');
  expect(discardManifestBody(held)).toContain(`副本目录 ${inboxDir}`);
  expect(discardManifestBody(held)).toContain('文件数 1');
  expect(fs.existsSync(inboxDir)).toBe(true);
  expect(trashed).toEqual([]);
  expect(fs.existsSync(path.join(state, 'inbox-delete.log'))).toBe(false);
  const realRm = fs.rmSync;
  const removed: string[] = [];
  const spy = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
    removed.push(path.resolve(String(target)));
    return realRm.call(fs, target, options);
  });
  try {
    const tossed = await channel.discardSession('s_ab12cd34', true);
    expect(tossed.needsConfirm).toBe(false);
    expect(tossed.removed).toBe(true);
    expect(tossed.via).toBe('trash');
    expect(trashed).toEqual([inboxDir]);
    expect(removed.some((item) => item === inboxDir || item.startsWith(`${inboxDir}${path.sep}`))).toBe(false);
    expect(fs.existsSync(inboxDir)).toBe(false);
    expect(fs.existsSync(path.join(bin, 'gone'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('hello');
    expect(logAtTrash).toContain('session=s_ab12cd34');
    expect(logAtTrash).toContain('files=1');
  } finally {
    spy.mockRestore();
  }
  const area = fs.readFileSync(path.join(process.cwd(), 'src/renderer/aiWrite/linkArea.tsx'), 'utf8');
  expect(area).toContain('needsConfirm');
  expect(area).toContain('discardManifestBody');
  expect(area).toContain('manifest.warning');
  expect(area).toContain('confirm: true');
  expect(area).toContain('移入回收站');
});

it('删除前写下会话编号和文件数', async () => {
  const store = temp('ai-write-rm-log-');
  const inbox = temp('ai-write-rm-log-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const first = path.join(root, 'a.md');
  const second = path.join(root, 'b.md');
  fs.writeFileSync(first, 'aaa');
  fs.writeFileSync(second, 'bbb');
  const state = path.join(store, 'state');
  let trashed = 0;
  const channel = new AiWriteChannel(state, {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
    trash: async () => {
      trashed += 1;
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: first, kind: 'file' }, { path: second, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  expect(fs.readdirSync(inboxDir).sort()).toEqual(['a.md', 'b.md']);
  const logFile = path.join(state, 'inbox-delete.log');
  let seen = '';
  const spy = vi.spyOn(fs, 'rmSync');
  try {
    const listed = await channel.discardSession('s_ab12cd34');
    expect(listed).toMatchObject({ needsConfirm: true, removed: false, fileCount: 2 });
    expect(fs.existsSync(logFile)).toBe(false);
    expect(trashed).toBe(0);
    const result = await channel.discardSession('s_ab12cd34', true);
    seen = fs.readFileSync(logFile, 'utf8');
    expect(result.needsConfirm).toBe(false);
    expect(result.via).toBe('trash');
    expect(result.removed).toBe(true);
    // 结束会话不调用 fs.rmSync 删副本目录。
    expect(spy.mock.calls.some(([target]) => path.resolve(String(target)) === inboxDir)).toBe(false);
  } finally {
    spy.mockRestore();
  }
  expect(seen).toContain('session=s_ab12cd34');
  expect(seen).toContain('files=2');
  expect(fs.readFileSync(first, 'utf8')).toBe('aaa');
  expect(fs.readFileSync(second, 'utf8')).toBe('bbb');
  expect(trashed).toBe(1);

  const box = temp('ai-write-rm-log-rollback-');
  const notes = path.join(box, 'notes');
  fs.mkdirSync(notes);
  fs.writeFileSync(path.join(notes, 'a.md'), 'aaa');
  const data = path.join(box, 'data');
  const inbox2 = path.join(box, 'inbox');
  fs.mkdirSync(inbox2);
  const engine = new InboxEngine({
    dir: data,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_bbccddee',
    backup: () => { throw new Error('备份失败'); },
    assertSafe: () => {},
    writeFile: () => {},
  });
  const order: string[] = [];
  const origAppend = fs.appendFileSync;
  const origRm = fs.rmSync;
  const appendSpy = vi.spyOn(fs, 'appendFileSync').mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
    if (String(args[0]).endsWith('inbox-delete.log')) order.push('log');
    return origAppend.apply(fs, args);
  });
  const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation((...args: Parameters<typeof fs.rmSync>) => {
    if (String(args[0]).includes('s_bbccddee')) order.push('rm');
    return origRm.apply(fs, args);
  });
  try {
    expect(() => engine.prepare(inbox2, [{ abs: path.join(notes, 'a.md'), name: 'a.md', kind: 'file', parentItemId: 'p' }], [])).toThrow(/备份失败/);
  } finally {
    appendSpy.mockRestore();
    rmSpy.mockRestore();
  }
  expect(order[0]).toBe('log');
  expect(order).toContain('rm');
  const rolled = fs.readFileSync(path.join(data, 'inbox-delete.log'), 'utf8');
  expect(rolled).toContain('session=s_bbccddee');
  expect(rolled).toContain('files=1');
  expect(fs.existsSync(path.join(inbox2, 's_bbccddee'))).toBe(false);
  expect(fs.readFileSync(path.join(notes, 'a.md'), 'utf8')).toBe('aaa');
});

it('设置 inboxDiscardConfirm=false 时免确认，但结束会话仍进回收站', async () => {
  const store = temp('ai-write-noconfirm-');
  const inbox = temp('ai-write-noconfirm-box-');
  const root = path.join(store, 'notes');
  fs.mkdirSync(root);
  const file = path.join(root, 'a.md');
  fs.writeFileSync(file, 'aaa');
  const trashed: string[] = [];
  const channel = new AiWriteChannel(path.join(store, 'state'), {
    watch: false,
    now: () => new Date('2026-10-16T12:00:00.000Z'),
    randomId: () => 's_ab12cd34',
    trash: async (target) => {
      trashed.push(target);
    },
  });
  expect(normalizeSettings({ ...defaultSettings() }).inboxDiscardConfirm).toBeUndefined();
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox, inboxDiscardConfirm: false });
  expect(channel.getSettings().inboxDiscardConfirm).toBe(false);
  channel.addLinkItems([{ path: file, kind: 'file' }]);
  channel.composeLink({ roots: [{ path: root, name: '笔记' }], entry: path.join(store, 'ENTRY.md') });
  const result = await channel.discardSession('s_ab12cd34');
  expect(result).toMatchObject({ needsConfirm: false, removed: true, via: 'trash' });
  expect(trashed).toEqual([path.join(inbox, 's_ab12cd34')]);
});
