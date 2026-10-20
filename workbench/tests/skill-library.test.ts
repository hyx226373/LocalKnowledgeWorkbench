import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { createLiveEntryWriter } from '../src/main/agentLive/entry/writer';
import { AiWriteChannel } from '../src/main/aiWrite/service';
import { bindRebirthMethods } from '../src/main/rebirth/ipc';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { loadSkillSnapshot, SKILL_FILE_MAX, writeSkillLibrary } from '../src/main/skills/library';
import { SkillList } from '../src/renderer/rebirth/Skills';
import { changeActions } from '../src/shared/aiWriteChannel';
import { DISTILL_OPENING, SKILL_DISTILL_ENTRY_LINE } from '../src/shared/skillDistill';
import { parseSkillDocument, skillLandingFromInboxRel, splitDistillPaste } from '../src/shared/skillLibrary';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  dirs.push(dir);
  return dir;
}

const CLOCK = new Date('2026-10-16T23:22:00.000Z');
const STAMP = '2026-10-16T23-22-00-000Z';

function skillDoc(name: string, body = '步骤正文独特'): string {
  return `---\nname: ${name}\ndescription: 写发布说明\nwhen-to-use: 写发布说明时使用\nlkw: skill/1\n---\n# 发布说明\n${body}\n`;
}

function summaryJson(title = '发布总结'): string {
  return JSON.stringify({ title, blocks: [{ title: '块', body: '正文' }] });
}

function paste(summary: string, skill: string | null, files: { rel: string; body: string }[] = []): string {
  const parts = ['```json', summary, '```'];
  if (skill !== null) parts.push('```skill', skill, '```');
  for (const file of files) parts.push('```skill-file', `${file.rel}\n${file.body}`, '```');
  return parts.join('\n');
}

function cards(repo: RebirthRepository): { id: string; title: string }[] {
  return repo.list().groups.flatMap((group) => group.topics.flatMap((topic) => topic.items.map((item) => ({ id: item.id, title: item.title }))));
}

it('拆块只留一个 skill，旁路第一行是相对路径', () => {
  const parts = splitDistillPaste(paste(summaryJson(), skillDoc('release-notes'), [{ rel: 'scripts/run.sh', body: 'echo hi' }]));
  expect(parts.summary).toContain('```json');
  expect(parts.summary).toContain('"title":"发布总结"');
  expect(parts.skill).toContain('name: release-notes');
  expect(parts.files).toEqual([{ rel: 'scripts/run.sh', body: 'echo hi\n' }]);
  expect(parts.errors).toEqual([]);
  const doubled = splitDistillPaste(`${paste(summaryJson(), skillDoc('release-notes'))}\n\`\`\`skill\n${skillDoc('other-skill')}\n\`\`\``);
  expect(doubled.skill).toBeNull();
  expect(doubled.errors).toContain('一次只能导入一个 skill');
  expect(splitDistillPaste('```skill-file\nscripts/a.txt\nhi\n```').errors).toContain('skill-file 缺少 skill 块');
  expect(skillLandingFromInboxRel('skills/release-notes/SKILL.md')).toEqual({ name: 'release-notes', parts: ['SKILL.md'] });
  expect(skillLandingFromInboxRel('skills/release-notes/scripts/run.sh')).toEqual({ name: 'release-notes', parts: ['scripts', 'run.sh'] });
  expect(skillLandingFromInboxRel('skills/Bad_Name/SKILL.md')).toBeNull();
  expect(skillLandingFromInboxRel('skills/release-notes/other.md')).toBeNull();
  expect(skillLandingFromInboxRel('skills/../SKILL.md')).toBeNull();
});

it('合格 skill 出现在 Skills，不合格留在原地并标未就绪', () => {
  const dir = temp('skill-ready-');
  const repo = new RebirthRepository(dir);
  fs.mkdirSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), skillDoc('release-notes'));
  fs.mkdirSync(path.join(dir, 'skills', 'draft-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'draft-skill', 'SKILL.md'), '---\nname: draft-skill\ndescription:\nwhen-to-use: later\nlkw: skill/1\n---\n# 草稿\n');
  const view = repo.skills();
  expect(view.ready).toEqual([{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用' }]);
  expect(view.pending).toEqual([{ name: 'draft-skill', reason: 'description 为空' }]);
  expect(fs.readFileSync(path.join(dir, 'skills', 'draft-skill', 'SKILL.md'), 'utf8')).toContain('name: draft-skill');
});

it('重生根里的 SKILL.md 不会变成 R*，侧栏标误放', () => {
  const dir = temp('skill-misplace-');
  const repo = new RebirthRepository(dir);
  fs.mkdirSync(path.join(repo.root, 'nested'), { recursive: true });
  const skill = path.join(repo.root, 'SKILL.md');
  const nested = path.join(repo.root, 'nested', 'SKILL.md');
  const marked = path.join(repo.root, 'marked.md');
  fs.writeFileSync(skill, skillDoc('release-notes'));
  fs.writeFileSync(nested, skillDoc('nested-skill'));
  fs.writeFileSync(marked, '---\nlkw: skill/1\nname: marked-skill\n---\n# 标记\n');
  fs.writeFileSync(path.join(repo.root, 'normal.md'), '## 内容\n正文\n');
  fs.writeFileSync(path.join(repo.root, 'body.md'), '## 旁白\n正文里提到 lkw: skill/1 也不算文件头。\n');
  repo.scan(1000);
  repo.scan(4000);
  const found = cards(repo);
  expect(found.map((item) => item.title).sort()).toEqual(['内容', '旁白']);
  expect(found.every((item) => /^R[1-9]\d*$/.test(item.id))).toBe(true);
  expect(fs.readFileSync(skill, 'utf8')).toContain('name: release-notes');
  expect(fs.readFileSync(nested, 'utf8')).toContain('name: nested-skill');
  expect(fs.readFileSync(marked, 'utf8')).toContain('lkw: skill/1');
  expect(repo.list().quarantined).toEqual([]);
  expect(repo.skills().misplaced).toEqual([
    { rel: 'SKILL.md', reason: '文件名是 SKILL.md' },
    { rel: 'marked.md', reason: '文件头含 lkw: skill/1' },
    { rel: 'nested/SKILL.md', reason: '文件名是 SKILL.md' },
  ]);
});

it('网页粘贴同时得到重生卡片和 skill 目录，失败保留总结', () => {
  const dir = temp('skill-web-');
  const repo = new RebirthRepository(dir, () => {}, async () => undefined);
  const outside = path.join(dir, 'outside.txt');
  const good = paste(summaryJson(), skillDoc('release-notes'), [{ rel: 'scripts/run.sh', body: 'echo hi' }]);
  const landed = repo.importDistillPaste(good, { now: () => CLOCK });
  expect(landed.id).toBe('R1');
  expect(landed.skill).toEqual({ ok: true, name: 'release-notes', overwritten: false });
  expect(cards(repo)).toEqual([{ id: 'R1', title: '发布总结' }]);
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain('name: release-notes');
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
  expect(fs.existsSync(path.join(dir, 'ai-write', 'sessions'))).toBe(false);

  const bad = paste(summaryJson('另一份'), '---\nname: broken-skill\ndescription: 有\nlkw: skill/1\n---\n# 坏\n');
  const failed = repo.importDistillPaste(bad, { now: () => CLOCK });
  expect(failed.id).toBe('R2');
  expect(failed.skill).toMatchObject({ ok: false, reason: 'when-to-use 为空' });
  expect(cards(repo).map((item) => item.id).sort()).toEqual(['R1', 'R2']);
  expect(fs.existsSync(path.join(dir, 'skills', 'broken-skill'))).toBe(false);

  const escaped = repo.importDistillPaste(paste(summaryJson('逃逸'), skillDoc('release-notes'), [{ rel: '../outside.txt', body: 'nope' }]), { summary: false, now: () => CLOCK });
  expect(escaped.id).toBeUndefined();
  expect(escaped.skill).toMatchObject({ ok: false, reason: '旁路路径不能包含 ..' });
  expect(fs.existsSync(outside)).toBe(false);
  expect(cards(repo)).toHaveLength(2);

  const absolute = repo.importDistillPaste(paste(summaryJson('绝对'), skillDoc('other-name'), [{ rel: '/tmp/abs.txt', body: 'nope' }]), { summary: false, now: () => CLOCK });
  expect(absolute.skill).toMatchObject({ ok: false, reason: '旁路路径必须是相对路径' });
  expect(fs.existsSync(path.join(dir, 'skills', 'other-name'))).toBe(false);

  const again = repo.importDistillPaste(good, { summary: false, now: () => CLOCK });
  expect(again.skill).toEqual({ ok: false, reason: '已有同名 skill，请选择覆盖或另起名', name: 'release-notes', conflict: true });
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain('步骤正文独特');

  const renamed = repo.importDistillPaste(paste(summaryJson(), skillDoc('release-notes', '新正文')), { summary: false, rename: 'release-notes-2', now: () => CLOCK });
  expect(renamed.skill).toEqual({ ok: true, name: 'release-notes-2', overwritten: false });
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes-2', 'SKILL.md'), 'utf8')).toContain('name: release-notes-2');
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain('name: release-notes');

  const replaced = repo.importDistillPaste(paste(summaryJson(), skillDoc('release-notes', '覆盖正文')), { summary: false, overwrite: true, now: () => CLOCK });
  expect(replaced.skill).toEqual({ ok: true, name: 'release-notes', overwritten: true });
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain('覆盖正文');
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'scripts', 'run.sh'), 'utf8')).toBe('echo hi\n');
  const backup = path.join(dir, 'ai-write', 'backups', 'skills', 'release-notes', STAMP, 'SKILL.md');
  expect(fs.readFileSync(backup, 'utf8')).toContain('步骤正文独特');
  expect(fs.existsSync(path.join(dir, 'ai-write', 'sessions'))).toBe(false);
});

it('附带只在蒸馏打开时进入创建链接，关闭后链接与原来一致', () => {
  const dir = temp('skill-attach-');
  const repo = new RebirthRepository(dir);
  fs.mkdirSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), skillDoc('release-notes'));
  const createBefore = repo.linkText('create');
  const jsonBefore = repo.linkText('json');
  repo.setSettings({ ...repo.settings(), skillDistill: false, skillAttach: [{ name: 'release-notes', full: true }] });
  expect(repo.linkText('create')).toBe(createBefore);
  expect(repo.linkText('json')).toBe(jsonBefore);
  expect(createBefore).not.toContain('写发布说明时使用');
  repo.setSettings({ ...repo.settings(), skillDistill: true, skillAttach: [{ name: 'release-notes', full: true }] });
  const link = repo.linkText('create');
  const templateAt = link.indexOf('Skill distillation (create/JSON only)');
  const useAt = link.indexOf('写发布说明时使用');
  const bodyAt = link.indexOf('步骤正文独特');
  const openAt = link.indexOf('Extraction — exactly five passes');
  expect(templateAt).toBeGreaterThanOrEqual(0);
  expect(templateAt).toBeLessThan(useAt);
  expect(useAt).toBeLessThan(bodyAt);
  expect(bodyAt).toBeGreaterThan(openAt);
  repo.setSettings({ ...repo.settings(), skillDistill: false });
  expect(repo.linkText('create')).toBe(createBefore);
  expect(repo.linkText('json')).toBe(jsonBefore);
});

it('高档预填技能库，批准前不写，覆盖后备份旧目录', async () => {
  const data = temp('skill-high-data-');
  const inbox = temp('skill-high-inbox-');
  const notes = temp('skill-high-notes-');
  fs.writeFileSync(path.join(notes, 'keep.md'), 'material-original');
  const skillDir = path.join(data, 'skills', 'release-notes');
  fs.mkdirSync(skillDir, { recursive: true });
  const skillFile = path.join(skillDir, 'SKILL.md');
  fs.writeFileSync(skillFile, 'OLD-SKILL');
  fs.writeFileSync(path.join(skillDir, 'extra.txt'), 'keep-extra');
  const channel = new AiWriteChannel(path.join(data, 'ai-write'), {
    watch: false,
    now: () => CLOCK,
    randomId: () => 's_ab12cd34',
    trash: async (file) => {
      fs.rmSync(file, { recursive: true, force: true });
    },
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: notes, kind: 'dir' }]);
  channel.composeLink({ roots: [{ path: notes, name: '笔记' }], entry: path.join(data, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  fs.mkdirSync(path.join(inboxDir, 'skills', 'release-notes', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'skills', 'release-notes', 'SKILL.md'), 'NEW-SKILL');
  fs.writeFileSync(path.join(inboxDir, 'skills', 'release-notes', 'scripts', 'run.sh'), 'echo hi');
  fs.mkdirSync(path.join(inboxDir, 'skills', 'fresh-skill'), { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'skills', 'fresh-skill', 'SKILL.md'), 'FRESH');
  fs.mkdirSync(path.join(inboxDir, 'skills', 'Bad_Name'), { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'skills', 'Bad_Name', 'SKILL.md'), 'nope');
  fs.writeFileSync(path.join(inboxDir, '草稿.md'), 'loose');
  const changes = channel.collect();
  const skill = changes.find((row) => row.inboxRel === 'skills/release-notes/SKILL.md');
  const sidecar = changes.find((row) => row.inboxRel === 'skills/release-notes/scripts/run.sh');
  const fresh = changes.find((row) => row.inboxRel === 'skills/fresh-skill/SKILL.md');
  const invalid = changes.find((row) => row.inboxRel === 'skills/Bad_Name/SKILL.md');
  const loose = changes.find((row) => row.inboxRel === '草稿.md');
  expect(skill).toMatchObject({
    op: 'conflict',
    role: 'created',
    needsLanding: false,
    landingAbs: skillFile,
    note: '目标已存在 · 覆盖会先备份',
  });
  expect(changeActions(skill!).overwrite).toBe(true);
  expect(changeActions(skill!).approve).toBe(false);
  expect(sidecar).toMatchObject({
    op: 'create',
    role: 'created',
    needsLanding: false,
    landingAbs: path.join(skillDir, 'scripts', 'run.sh'),
  });
  expect(fresh).toMatchObject({
    op: 'create',
    role: 'created',
    needsLanding: false,
    landingAbs: path.join(data, 'skills', 'fresh-skill', 'SKILL.md'),
  });
  expect(invalid?.needsLanding).toBe(true);
  expect(invalid?.landingAbs ?? '').toBe('');
  expect(loose?.needsLanding).toBe(true);
  expect(fs.readFileSync(skillFile, 'utf8')).toBe('OLD-SKILL');
  expect(fs.readFileSync(path.join(notes, 'keep.md'), 'utf8')).toBe('material-original');
  const blocked = await channel.apply({ sessionId: 's_ab12cd34', fileId: skill!.fileId, decision: 'approve' });
  expect(blocked.ok).toBe(false);
  expect(fs.readFileSync(skillFile, 'utf8')).toBe('OLD-SKILL');
  const overwritten = await channel.apply({ sessionId: 's_ab12cd34', fileId: skill!.fileId, decision: 'overwrite' });
  expect(overwritten.ok).toBe(true);
  expect(fs.readFileSync(skillFile, 'utf8')).toBe('NEW-SKILL');
  expect(fs.readFileSync(path.join(data, 'ai-write', 'backups', 'skills', 'release-notes', STAMP, 'SKILL.md'), 'utf8')).toBe('OLD-SKILL');
  expect(fs.readFileSync(path.join(data, 'ai-write', 'backups', 'skills', 'release-notes', STAMP, 'extra.txt'), 'utf8')).toBe('keep-extra');
  expect(fs.readFileSync(path.join(skillDir, 'extra.txt'), 'utf8')).toBe('keep-extra');
  expect(fs.readFileSync(path.join(notes, 'keep.md'), 'utf8')).toBe('material-original');
  const side = await channel.apply({ sessionId: 's_ab12cd34', fileId: sidecar!.fileId, decision: 'approve' });
  expect(side.ok).toBe(true);
  expect(fs.readFileSync(path.join(skillDir, 'scripts', 'run.sh'), 'utf8')).toBe('echo hi');
  const created = await channel.apply({ sessionId: 's_ab12cd34', fileId: fresh!.fileId, decision: 'approve' });
  expect(created.ok).toBe(true);
  expect(fs.readFileSync(path.join(data, 'skills', 'fresh-skill', 'SKILL.md'), 'utf8')).toBe('FRESH');
  expect(fs.existsSync(path.join(data, 'ai-write', 'backups', 'skills', 'fresh-skill'))).toBe(false);
  await expect(channel.apply({ sessionId: 's_ab12cd34', fileId: loose!.fileId, decision: 'approve', landingDir: path.join(data, 'skills') })).rejects.toThrow(/agent-data/);
  expect(fs.existsSync(path.join(data, 'skills', '草稿.md'))).toBe(false);
  expect(fs.readFileSync(path.join(notes, 'keep.md'), 'utf8')).toBe('material-original');
});

it('技能库路径经过符号链接时拒绝写入，超限也不落盘', async () => {
  const data = temp('skill-link-data-');
  const inbox = temp('skill-link-inbox-');
  const notes = temp('skill-link-notes-');
  fs.writeFileSync(path.join(notes, 'keep.md'), 'material-original');
  const real = path.join(data, 'real-skill');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'SKILL.md'), 'LINKED-OLD');
  fs.mkdirSync(path.join(data, 'skills'), { recursive: true });
  fs.symlinkSync(real, path.join(data, 'skills', 'release-notes'), 'dir');
  const channel = new AiWriteChannel(path.join(data, 'ai-write'), {
    watch: false,
    now: () => CLOCK,
    randomId: () => 's_ab12cd34',
  });
  channel.setSettings({ ...channel.getSettings(), defaultTier: 'high', inboxRoot: inbox });
  channel.addLinkItems([{ path: notes, kind: 'dir' }]);
  channel.composeLink({ roots: [{ path: notes, name: '笔记' }], entry: path.join(data, 'ENTRY.md') });
  const inboxDir = path.join(inbox, 's_ab12cd34');
  fs.mkdirSync(path.join(inboxDir, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'skills', 'release-notes', 'SKILL.md'), 'NEW-SKILL');
  fs.mkdirSync(path.join(inboxDir, 'skills', 'big-skill'), { recursive: true });
  fs.writeFileSync(path.join(inboxDir, 'skills', 'big-skill', 'SKILL.md'), Buffer.alloc(SKILL_FILE_MAX + 1, 0x61));
  const changes = channel.collect();
  const linked = changes.find((row) => row.inboxRel === 'skills/release-notes/SKILL.md');
  const big = changes.find((row) => row.inboxRel === 'skills/big-skill/SKILL.md');
  expect(linked?.landingAbs).toBe(path.join(data, 'skills', 'release-notes', 'SKILL.md'));
  await expect(channel.apply({ sessionId: 's_ab12cd34', fileId: linked!.fileId, decision: 'overwrite' })).rejects.toThrow(/符号链接/);
  expect(fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8')).toBe('LINKED-OLD');
  expect(fs.readFileSync(path.join(notes, 'keep.md'), 'utf8')).toBe('material-original');
  await expect(channel.apply({ sessionId: 's_ab12cd34', fileId: big!.fileId, decision: 'approve' })).rejects.toThrow(/skill 超过大小限制/);
  expect(fs.existsSync(path.join(data, 'skills', 'big-skill'))).toBe(false);
});

it('快照只在末尾追加 skills，高档仍无资料绝对路径，ENTRY 只在打开时多一行', async () => {
  const bridge = temp('skill-snap-');
  const secret = 'SECRET-NOTES-PATH-9f3a';
  let on = true;
  const writer = createLiveEntryWriter({
    bridgeRoot: bridge,
    now: () => CLOCK,
    loadScene: () => ({
      workspaceName: '试验',
      ...(on
        ? {
            skillDistill: true,
            skills: [{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用', absPath: secret, path: secret }],
          }
        : {}),
      writeChannel: { defaultTier: 'high', folders: [{ id: 'ab', name: '笔记', tier: 'high', virtualPath: 'kb-stage://ab', absPath: secret }] },
    }),
  });
  await writer.render('ws-m', 1);
  const snapshot = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
    schemaVersion: number;
    sections: string[];
    skillDistill?: boolean;
    skills?: Record<string, string>[];
    writeChannel?: { folders: { absPath?: string; virtualPath: string }[] };
  };
  expect(snapshot.schemaVersion).toBe(1);
  expect(snapshot.sections.at(-1)).toBe('skills');
  expect(snapshot.sections.at(-2)).toBe('writeChannel');
  expect(snapshot.skillDistill).toBe(true);
  expect(snapshot.skills).toEqual([{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用' }]);
  expect(Object.keys(snapshot.skills![0] ?? {}).sort()).toEqual(['description', 'name', 'whenToUse']);
  expect(snapshot.writeChannel?.folders[0]?.absPath).toBeUndefined();
  expect(snapshot.writeChannel?.folders[0]?.virtualPath).toBe('kb-stage://ab');
  expect(JSON.stringify(snapshot)).not.toContain(secret);
  const entry = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
  expect(entry).toContain('## 7. AI 写入通道');
  expect(entry).toContain(SKILL_DISTILL_ENTRY_LINE);
  expect(entry.indexOf('## 7. AI 写入通道')).toBeLessThan(entry.indexOf(SKILL_DISTILL_ENTRY_LINE));
  expect(entry).not.toContain(secret);
  expect(entry).not.toMatch(/[A-Za-z]:\\/);
  on = false;
  await writer.render('ws-m', 2);
  const closed = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as { sections: string[]; skillDistill?: boolean; skills?: unknown };
  expect(closed.sections.at(-1)).toBe('writeChannel');
  expect(closed.sections).not.toContain('skills');
  expect(closed.skillDistill).toBeUndefined();
  expect(closed.skills).toBeUndefined();
  const closedEntry = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
  expect(closedEntry).not.toContain(SKILL_DISTILL_ENTRY_LINE);
  expect(closedEntry).toContain('## 7. AI 写入通道');

  const only = temp('skill-entry-only-');
  const bare = createLiveEntryWriter({
    bridgeRoot: only,
    now: () => CLOCK,
    loadScene: () => ({ workspaceName: '试验', skillDistill: true }),
  });
  await bare.render('ws-m', 1);
  const bareEntry = fs.readFileSync(path.join(only, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
  expect(bareEntry).toContain('## 7. AI 写入通道');
  expect(bareEntry).toContain(SKILL_DISTILL_ENTRY_LINE);
  const bareSnap = JSON.parse(fs.readFileSync(path.join(only, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as { schemaVersion: number; sections: string[]; skillDistill?: boolean };
  expect(bareSnap.schemaVersion).toBe(1);
  expect(bareSnap.skillDistill).toBe(true);
  expect(bareSnap.sections).not.toContain('skills');
  expect(bareSnap.sections).not.toContain('writeChannel');
});

it('读快照不带路径，IPC 只追加技能库方法', async () => {
  const dir = temp('skill-ipc-');
  const repo = new RebirthRepository(dir);
  fs.mkdirSync(path.join(dir, 'skills', 'release-notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), skillDoc('release-notes'));
  expect(loadSkillSnapshot(dir)).toEqual({ skills: [{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用' }] });
  expect(loadSkillSnapshot(dir).skillDistill).toBeUndefined();
  repo.setSettings({ ...repo.settings(), skillDistill: true });
  const snap = loadSkillSnapshot(dir);
  expect(snap).toEqual({ skillDistill: true, skills: [{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用' }] });
  expect(JSON.stringify(snap)).not.toContain(dir);
  const api = bindRebirthMethods(repo, { pickJson: async () => null, saveFile: async () => null, copy: () => undefined, startDrag: () => undefined });
  expect(await api.rebirthSkills()).toMatchObject({ ready: [{ name: 'release-notes' }] });
  const imported = await api.rebirthImportDistill({ text: paste(summaryJson('接口'), skillDoc('from-ipc')), summary: true });
  expect(imported).toMatchObject({ id: 'R1', skill: { ok: true, name: 'from-ipc', overwritten: false } });
  expect(fs.existsSync(path.join(dir, 'skills', 'from-ipc', 'SKILL.md'))).toBe(true);
  expect(fs.readFileSync(path.join(process.cwd(), 'src/shared/skillLibrary.ts'), 'utf8')).not.toMatch(/from ['"]node:path['"]/);
  const board = fs.readFileSync(path.join(process.cwd(), 'src/renderer/aiWrite/approval.tsx'), 'utf8');
  expect(board).toContain('覆盖（先备份）');
  expect(board).toContain('目标已存在。覆盖会先备份现在的内容，再写入。');
  expect(board).toContain('复制之后原件已经变过。覆盖会先备份现在的原件。');
});

it('侧栏 Skills 列出就绪、未就绪和误放，关闭时勾选禁用', () => {
  const html = renderToStaticMarkup(React.createElement(SkillList, {
    skillOn: false,
    attach: [],
    onSkill: () => undefined,
    onFull: () => undefined,
    skills: {
      ready: [{ name: 'release-notes', description: '写发布说明', whenToUse: '写发布说明时使用' }],
      pending: [{ name: 'draft-skill', reason: 'description 为空' }],
      misplaced: [{ rel: 'SKILL.md', reason: '文件名是 SKILL.md' }],
    },
  }));
  expect(html).toContain('aria-label="Skills"');
  expect(html).toContain('release-notes');
  expect(html).toContain('写发布说明时使用');
  expect(html).toContain('附带全文');
  expect(html).toContain('draft-skill：未就绪。description 为空');
  expect(html).toContain('SKILL.md：误放。文件名是 SKILL.md');
  expect(html).toContain('disabled');
  const empty = renderToStaticMarkup(React.createElement(SkillList, {
    skillOn: true,
    attach: [{ name: 'release-notes', full: true }],
    onSkill: () => undefined,
    onFull: () => undefined,
    skills: { ready: [], pending: [], misplaced: [] },
  }));
  expect(empty).toContain('还没有 skill。');
  expect(empty).not.toContain('disabled');
});

function bakTexts(dir: string): string[] {
  const root = path.join(dir, 'ai-write', 'backups');
  const out: string[] = [];
  const walk = (current: string) => {
    if (!fs.existsSync(current)) return;
    for (const name of fs.readdirSync(current)) {
      const abs = path.join(current, name);
      if (fs.statSync(abs).isDirectory()) walk(abs);
      else if (name.endsWith('.bak')) out.push(fs.readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

it('多行 YAML 拒绝并提示，正文里成对的代码围栏保留，没闭合的围栏拒绝', () => {
  const block = `---\nname: release-notes\ndescription: |\n  写发布说明\n  第二行\nwhen-to-use: 写发布说明时使用\nlkw: skill/1\n---\n# 发布说明\n`;
  expect(parseSkillDocument(block, 'release-notes')).toMatchObject({ ok: false, reason: expect.stringMatching(/多行 YAML/) });
  const folded = `---\nname: release-notes\ndescription: 写发布说明\n  还有一行\nwhen-to-use: 写发布说明时使用\nlkw: skill/1\n---\n# 发布说明\n`;
  expect(parseSkillDocument(folded, 'release-notes')).toMatchObject({ ok: false, reason: expect.stringMatching(/多行 YAML/) });

  const nestedBody = `${skillDoc('release-notes', '步骤开始')}\n\`\`\`bash\necho hi\n\`\`\`\n步骤结束\n`;
  const nested = splitDistillPaste(paste(summaryJson(), nestedBody));
  expect(nested.errors).toEqual([]);
  expect(nested.skill).toContain('```bash');
  expect(nested.skill).toContain('echo hi');
  expect(nested.skill).toContain('步骤结束');
  expect(nested.summary).toContain('"title":"发布总结"');

  const dir = temp('skill-yaml-fence-');
  const repo = new RebirthRepository(dir, () => {}, async () => undefined);
  const landed = repo.importDistillPaste(paste(summaryJson(), nestedBody), { now: () => CLOCK });
  expect(landed.skill).toMatchObject({ ok: true, name: 'release-notes' });
  const written = fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8');
  expect(written).toContain('```bash');
  expect(written).toContain('步骤结束');

  const rejected = repo.importDistillPaste(paste(summaryJson('多行'), block), { now: () => CLOCK });
  expect(rejected.id).toBe('R2');
  expect(rejected.skill).toMatchObject({ ok: false, reason: expect.stringMatching(/多行 YAML/) });
  expect(fs.existsSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'))).toBe(true);
  expect(fs.readFileSync(path.join(dir, 'skills', 'release-notes', 'SKILL.md'), 'utf8')).toContain('步骤结束');

  const openFence = ['```json', summaryJson('未闭合'), '```', '```skill', skillDoc('open-skill'), '```bash', 'echo hi', '步骤还在'].join('\n');
  const unclosed = repo.importDistillPaste(openFence, { now: () => CLOCK });
  expect(unclosed.id).toBe('R3');
  expect(unclosed.skill).toMatchObject({ ok: false, reason: expect.stringMatching(/代码围栏/) });
  expect(fs.existsSync(path.join(dir, 'skills', 'open-skill'))).toBe(false);
  expect(cards(repo).map((item) => item.title).sort()).toEqual(['发布总结', '多行', '未闭合'].sort());
});

it('中低档直写技能库按软件备份留旧内容，快速和高档直写不备份', () => {
  const open = (name: string, tier: 'medium' | 'low' | 'fast' | 'high', viaLink = false) => {
    const data = temp(name);
    const notes = path.join(data, 'notes');
    fs.mkdirSync(notes, { recursive: true });
    fs.writeFileSync(path.join(notes, 'keep.md'), 'material-original');
    const channel = new AiWriteChannel(path.join(data, 'ai-write'), { watch: false, now: () => CLOCK });
    const base = channel.getSettings();
    if (!viaLink) {
      channel.setSettings({ ...base, defaultTier: tier === 'high' ? 'fast' : tier, folders: [], linkItems: [] });
    } else {
      channel.setSettings({
        ...base,
        defaultTier: 'fast',
        folders: [{ path: notes, tier }],
        linkItems: [{ id: 'notes', path: notes, name: '笔记', kind: 'dir' }],
      });
    }
    return { data, notes, channel };
  };

  const absent = open('skill-tier-absent-', 'medium');
  expect(fs.existsSync(path.join(absent.data, 'skills'))).toBe(false);
  absent.channel.setSettings({ ...absent.channel.getSettings(), defaultTier: 'fast' });
  expect(fs.existsSync(path.join(absent.data, 'skills'))).toBe(false);

  const writeOld = (data: string) => {
    const file = path.join(data, 'skills', 'release-notes', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'OLD-SKILL');
    return file;
  };

  const low = open('skill-tier-low-', 'low');
  const lowFile = writeOld(low.data);
  low.channel.setSettings({ ...low.channel.getSettings(), defaultTier: 'low' });
  fs.writeFileSync(lowFile, 'NEW-SKILL');
  low.channel.ingestPath(lowFile);
  expect(fs.readFileSync(lowFile, 'utf8')).toBe('NEW-SKILL');
  expect(bakTexts(low.data)).toContain('OLD-SKILL');
  expect(low.channel.pending().conflicts).toEqual([]);
  const fresh = path.join(low.data, 'skills', 'fresh-skill', 'SKILL.md');
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  fs.writeFileSync(fresh, 'NEW-ONLY');
  low.channel.ingestPath(fresh);
  expect(bakTexts(low.data)).not.toContain('NEW-ONLY');
  expect(fs.readFileSync(path.join(low.notes, 'keep.md'), 'utf8')).toBe('material-original');

  const medium = open('skill-tier-medium-', 'medium', true);
  const mediumFile = writeOld(medium.data);
  medium.channel.setSettings({
    ...medium.channel.getSettings(),
    defaultTier: 'fast',
    folders: [{ path: medium.notes, tier: 'medium' }],
    linkItems: [{ id: 'notes', path: medium.notes, name: '笔记', kind: 'dir' }],
  });
  fs.writeFileSync(mediumFile, 'NEW-SKILL');
  medium.channel.ingestPath(mediumFile);
  expect(fs.readFileSync(mediumFile, 'utf8')).toBe('NEW-SKILL');
  expect(bakTexts(medium.data)).toContain('OLD-SKILL');
  expect(medium.channel.pending().conflicts).toEqual([]);
  expect(fs.readFileSync(path.join(medium.notes, 'keep.md'), 'utf8')).toBe('material-original');

  const fast = open('skill-tier-fast-', 'fast');
  const fastFile = writeOld(fast.data);
  fast.channel.setSettings({ ...fast.channel.getSettings(), defaultTier: 'fast', folders: [], linkItems: [] });
  fs.writeFileSync(fastFile, 'NEW-SKILL');
  fast.channel.ingestPath(fastFile);
  expect(fs.readFileSync(fastFile, 'utf8')).toBe('NEW-SKILL');
  expect(bakTexts(fast.data)).toEqual([]);

  const high = open('skill-tier-high-', 'high', true);
  const highFile = writeOld(high.data);
  high.channel.setSettings({
    ...high.channel.getSettings(),
    defaultTier: 'low',
    folders: [{ path: high.notes, tier: 'high' }],
    linkItems: [{ id: 'notes', path: high.notes, name: '笔记', kind: 'dir' }],
  });
  fs.writeFileSync(highFile, 'NEW-SKILL');
  high.channel.ingestPath(highFile);
  expect(fs.readFileSync(highFile, 'utf8')).toBe('NEW-SKILL');
  expect(bakTexts(high.data)).toEqual([]);
  expect(fs.readFileSync(path.join(high.notes, 'keep.md'), 'utf8')).toBe('material-original');

  const linked = temp('skill-tier-link-');
  const real = path.join(linked, 'real-skills', 'release-notes');
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(path.join(real, 'SKILL.md'), 'LINKED-OLD');
  fs.mkdirSync(path.join(linked, 'skills'), { recursive: true });
  fs.symlinkSync(real, path.join(linked, 'skills', 'release-notes'), 'dir');
  const linkChannel = new AiWriteChannel(path.join(linked, 'ai-write'), { watch: false, now: () => CLOCK });
  linkChannel.setSettings({ ...linkChannel.getSettings(), defaultTier: 'low', folders: [], linkItems: [] });
  const linkFile = path.join(linked, 'skills', 'release-notes', 'SKILL.md');
  fs.writeFileSync(linkFile, 'NEW-SKILL');
  linkChannel.ingestPath(linkFile);
  expect(fs.readFileSync(path.join(real, 'SKILL.md'), 'utf8')).toBe('NEW-SKILL');
  expect(bakTexts(linked)).toEqual([]);
});

it('技能库落盘前拦住 LocalKnowledgeWorkbench 用户目录', () => {
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'lkw-local-'));
  const prev = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = local;
  try {
    const dataDir = path.join(local, 'LocalKnowledgeWorkbench', 'agent-data');
    const raw = '---\nname: demo-skill\ndescription: 演示\nwhen-to-use: 测试\nlkw: skill/1\n---\n正文\n';
    const result = writeSkillLibrary(dataDir, raw, []);
    expect(result).toMatchObject({ ok: false, reason: '不能写入 LocalKnowledgeWorkbench 用户目录' });
    expect(fs.existsSync(path.join(local, 'LocalKnowledgeWorkbench'))).toBe(false);
  } finally {
    if (prev === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prev;
    fs.rmSync(local, { recursive: true, force: true });
  }
});
