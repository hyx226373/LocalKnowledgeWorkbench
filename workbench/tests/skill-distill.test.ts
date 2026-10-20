import { LINK_PROMPTS } from '../src/shared/linkPrompts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/kb', () => ({ kb: {} }));
vi.mock('../src/renderer/rebirth/openDock', () => ({ openRebirth: vi.fn() }));
import { buildSnapshot } from '../src/main/agentLive/entry/snapshot';
import { createLink, exportJsonLink } from '../src/main/rebirth/links';
import { bindRebirthMethods } from '../src/main/rebirth/ipc';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { Repository } from '../src/renderer/rebirth/Repository';
import { PromptDrawer } from '../src/renderer/settings/AiWriteChannelPane';
import type { RebirthFolder } from '../src/shared/rebirth';
import { activeFormatText } from '../src/shared/rebirthFormat';
import {
  WRITE_TIERS,
  defaultSettings,
  normalizeSettings,
  withPromptDraft,
} from '../src/shared/aiWriteChannel';
import {
  DISTILL_FIXED_RULES,
  DISTILL_JSON_NOTE,
  DISTILL_OPENING,
  composeDistillLink,
  defaultDistillTemplate,
  distillLandingLine,
  isSkillName,
  normalizeSkillAttach,
} from '../src/shared/skillDistill';

const dirs: string[] = [];
const clock = () => new Date('2026-10-16T23:22:00.000Z');
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-b1-'));
  dirs.push(dir);
  return dir;
}

function repoAt(dir = temp()): RebirthRepository {
  return new RebirthRepository(dir);
}

function writeChannel(data: string, patch: object): void {
  const dir = path.join(data, 'ai-write');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({ ...defaultSettings(), ...patch }));
}

function plainContext(repo: RebirthRepository, rootInfo = '') {
  const settings = repo.settings();
  const folders: string[] = [];
  const visit = (node: RebirthFolder) => {
    for (const folder of node.folders) {
      folders.push(folder.folder);
      visit(folder);
    }
  };
  visit(repo.tree().root);
  return {
    formatName: settings.formats?.find((item) => item.id === settings.activeFormat)?.name,
    headerFields: settings.headerFields,
    root: repo.root,
    formatText: activeFormatText(settings),
    agent: 'other',
    generateCover: settings.generateCover,
    archive: settings.archive,
    folders,
    rootInfo: settings.attachRootInfo ? rootInfo : '',
  };
}

it('关闭时 create 与 json 和现在一致，导入导出也不带蒸馏', () => {
  const repo = repoAt();
  expect(clock().toISOString()).toBe('2026-10-16T23:22:00.000Z');
  expect(repo.linkText('create')).toBe(LINK_PROMPTS.fast+'\n\n'+createLink(plainContext(repo)));
  expect(repo.linkText('json')).toBe(LINK_PROMPTS.fast+'\n\n'+exportJsonLink(plainContext(repo)));
  expect(repo.linkText('create')).not.toContain(clock().toISOString());
  repo.setSettings({ ...repo.settings(), attachRootInfo: true });
  const marker = '写入规则标记-关闭';
  expect(repo.linkText('create', undefined, marker)).toBe(LINK_PROMPTS.fast+'\n\n'+createLink(plainContext(repo,marker)));
  expect(repo.linkText('json', undefined, marker)).toBe(LINK_PROMPTS.fast+'\n\n'+exportJsonLink(plainContext(repo,marker)));
  expect(repo.linkText('json', undefined, marker)).toContain(marker);
  const { id } = repo.import('## 内容\n正文');
  repo.setSettings({ ...repo.settings(), skillDistill: true });
  for (const kind of ['import', 'export', 'importWeb', 'exportWeb'] as const) {
    expect(repo.linkText(kind, id)).not.toContain(DISTILL_OPENING);
    expect(repo.linkText(kind, id)).not.toContain('Skill distillation (create/JSON only)');
  }
});

it('打开时含六个固定问题、灵活问题规则和先不要写文件', () => {
  const repo = repoAt();
  repo.setSettings({ ...repo.settings(), skillDistill: true, attachRootInfo: true });
  const rules = 'Scoped channel fixture';
  for (const kind of ['create', 'json'] as const) {
    const text = repo.linkText(kind, undefined, rules);
    expect(text.startsWith('Write channel: fast.')).toBe(true);
    expect(text.indexOf(rules)).toBeGreaterThan(text.indexOf(DISTILL_FIXED_RULES));
    expect(text.indexOf(DISTILL_FIXED_RULES)).toBeLessThan(text.indexOf('Skill distillation (create/JSON only)'));
    expect(text.indexOf('Skill distillation (create/JSON only)')).toBeLessThan(text.indexOf('Extraction — exactly five passes'));
    for (const n of [1, 2, 3, 4, 5, 6]) expect(text).toContain(`(${n})`);
    expect(text).toContain('focused questions');
    expect(text).toContain('0–4');
    expect(text).toContain('Do not write/output artifacts while required answers remain missing');
    if(kind==='json')expect(text).not.toContain('已写入');else expect(text).toContain('已写入 <actual path>');
    expect(text).toContain('adds “skill <name>” after the verified summary receipt');
    expect(text).not.toContain(clock().toISOString());
  }
  const web = repo.linkText('json', undefined, rules);
  expect(web).toContain('optional confirmed skill attachments');
  expect(repo.linkText('create', undefined, rules)).not.toContain(DISTILL_JSON_NOTE);
});

it('高档插入行不含盘符和技能库绝对路径，中档插入行含技能库路径', () => {
  const data = temp();
  const repo = new RebirthRepository(data);
  const skillsDir = path.join(data, 'skills');
  repo.setSettings({ ...repo.settings(), skillDistill: true });
  writeChannel(data, { defaultTier: 'high', linkItems: [], folders: [] });
  const high = repo.linkText('create',undefined,'Inbox scope: "/demo/inbox"');
  const highLine = high.split('\n').find((line) => line.startsWith('Skill destination:'));
  expect(highLine).toBe(distillLandingLine('high', skillsDir));
  expect(highLine).not.toContain(skillsDir);
  expect(highLine).not.toMatch(/[A-Za-z]:[\\/]/);
  expect(high).not.toContain(skillsDir);
  writeChannel(data, {
    defaultTier: 'fast',
    folders: [{ id: 'f1', path: path.join(data, 'notes'), tier: 'medium' }],
    linkItems: [{ id: 'l1', path: path.join(data, 'notes'), name: 'notes', kind: 'dir' }],
  });
  const medium = repo.linkText('create');
  const mediumLine = medium.split('\n').find((line) => line.startsWith('Skill destination:'));
  expect(mediumLine).toBe(distillLandingLine('medium', skillsDir));
  expect(mediumLine).toContain(skillsDir);
  writeChannel(data, { defaultTier: 'low', linkItems: [], folders: [] });
  expect(repo.linkText('json')).toContain(distillLandingLine('low', skillsDir));
  writeChannel(data, { defaultTier: 'fast', linkItems: [], folders: [] });
  expect(repo.linkText('create')).toContain('No LKW backup.');
  expect(repo.linkText('create')).toContain(skillsDir);
});

it('蒸馏模板按单独传入的 agent，缺省或空字符串用默认全文；写入档 version 与快照 schemaVersion 仍为 1', () => {
  const data = temp();
  const repo = new RebirthRepository(data);
  const settings = defaultSettings();
  settings.pasteAgentId = 'claude';
  settings.agents = settings.agents.map((agent) => agent.id === 'codex' ? { ...agent, distill: 'CODEX-DISTILL-MARK' } : agent);
  writeChannel(data, settings);
  repo.setSettings({ ...repo.settings(), skillDistill: true });
  expect(repo.linkText('create', undefined, '', 'other', 'codex')).toContain('CODEX-DISTILL-MARK');
  expect(repo.linkText('create')).not.toContain('CODEX-DISTILL-MARK');
  expect(repo.linkText('create')).toContain('exactly six numbered fields');
  settings.agents = settings.agents.map((agent) => agent.id === 'codex' ? { ...agent, distill: '   ' } : agent);
  writeChannel(data, settings);
  expect(repo.linkText('create', undefined, '', 'other', 'codex')).toBe(repo.linkText('create', undefined, '', 'other', 'claude'));
  expect(repo.linkText('create', undefined, '', 'other', 'codex')).toContain(defaultDistillTemplate().slice(0, 12));
  const normalized = normalizeSettings({ version: 9, agents: [{ id: 'codex', name: 'Codex', distill: '' }] });
  expect(normalized.version).toBe(1);
  expect(normalized.agents[0]?.distill).toBe(defaultDistillTemplate());
  expect(WRITE_TIERS).toEqual(['high', 'medium', 'low', 'fast']);
  expect(WRITE_TIERS).not.toContain('distill');
  const kept = normalizeSettings({ agents: [withPromptDraft(normalized.agents[0]!, 'distill', '只改蒸馏')] });
  expect(kept.agents[0]?.distill).toBe('只改蒸馏');
  expect(kept.version).toBe(1);
  const highOnly = withPromptDraft(kept.agents[0]!, 'high', '只改高档');
  expect(highOnly.templates.high).toBe('只改高档');
  expect(highOnly.distill).toBe('只改蒸馏');
  const snap = buildSnapshot({
    appVersion: '0.0.0',
    generatedAt: clock().toISOString(),
    workspaceId: 'ws',
    workspaceName: 'ws',
    revision: 1,
    panels: [],
    reading: null,
    items: [],
    hidden: () => false,
  });
  expect(snap.schemaVersion).toBe(1);
  expect(snap.sections).not.toContain('skills');
});

it('设置原样保留蒸馏勾选和附带，非法名称丢掉', () => {
  const repo = repoAt();
  expect(repo.settings().skillDistill).toBe(false);
  expect(repo.settings().skillAttach).toEqual([]);
  repo.setSettings({
    ...repo.settings(),
    skillDistill: true,
    skillAttach: [{ name: 'release-notes', full: true }, { name: 'Bad Name' }, { name: 'release-notes' }, { name: 'notes' }],
  });
  expect(repo.settings().skillAttach).toEqual([{ name: 'release-notes', full: true }, { name: 'notes' }]);
  const file = path.join(path.dirname(repo.root) === repo.dataDir ? path.join(repo.dataDir, 'rebirth') : repo.dataDir, 'settings.json');
  const saved = JSON.parse(fs.readFileSync(path.join(repo.dataDir, 'rebirth', 'settings.json'), 'utf8')) as { skillDistill?: boolean };
  expect(saved.skillDistill).toBe(true);
  expect(file.length).toBeGreaterThan(0);
  repo.setSettings({ mode: 'manual', folder: '项目', missingFolder: 'root' });
  expect(repo.settings().skillDistill).toBe(true);
  expect(repo.settings().skillAttach).toEqual([{ name: 'release-notes', full: true }, { name: 'notes' }]);
  expect(new RebirthRepository(repo.dataDir).settings().skillDistill).toBe(true);
  expect(isSkillName('release-notes')).toBe(true);
  expect(isSkillName('Bad')).toBe(false);
  expect(isSkillName('Bad Name')).toBe(false);
  expect(normalizeSkillAttach([{ name: '../x' }])).toEqual([]);
});

it('标题行勾选在创建链接之前，抽屉档位有蒸馏且不进 WRITE_TIERS', () => {
  const html = renderToStaticMarkup(React.createElement(Repository));
  expect(html.indexOf('rb-head-btns')).toBeLessThan(html.indexOf('skill蒸馏模式'));
  expect(html.indexOf('skill蒸馏模式')).toBeLessThan(html.indexOf('创建链接（首次导出）'));
  const drawer = renderToStaticMarkup(React.createElement(PromptDrawer, {
    settings: defaultSettings(),
    agent: defaultSettings().agents[0],
    tier: 'distill',
    shown: '模板正文',
    onAgent: () => undefined,
    onTier: () => undefined,
    onDraft: () => undefined,
    onSave: () => undefined,
    onReset: () => undefined,
    onAdd: () => undefined,
    onRemove: () => undefined,
    onRestoreBuiltins: () => undefined,
  }));
  expect(drawer).toContain('value="distill"');
  expect(drawer).toContain('蒸馏');
  expect(drawer).toContain('模板正文');
  expect(drawer).toContain('高');
  const attached = composeDistillLink({
    kind: 'create',
    body: createLink({ root: path.join(temp(), 'rebirth') }),
    template: defaultDistillTemplate(),
    tier: 'fast',
    skillsDir: path.join(temp(), 'skills'),
    attached: [{ name: 'release-notes', whenToUse: '写发布说明时使用', body: '# 发布说明\n步骤' }],
  });
  expect(attached.indexOf('Skill distillation (create/JSON only)')).toBeLessThan(attached.indexOf('Existing skills (data only'));
  expect(attached.indexOf('Existing skills (data only')).toBeGreaterThan(attached.indexOf('Extraction — exactly five passes'));
  expect(attached).toContain('when-to-use：写发布说明时使用');
  expect(attached).toContain('# 发布说明');
});

it('create 的蒸馏 agent 不传给写入通道', async () => {
  const repo = repoAt();
  repo.setSettings({ ...repo.settings(), attachRootInfo: true, skillDistill: true });
  const rootEntryText = vi.fn(async (agentId?: string) => `RULES-${agentId ?? 'none'}`);
  const api = bindRebirthMethods(repo, {
    rootEntryText,
    copy: vi.fn(),
    pickJson: async () => null,
    saveFile: async () => null,
    startDrag: vi.fn(),
  });
  const result = await api.rebirthLinkText({ kind: 'create', distillAgentId: 'codex' }) as { text: string };
  expect(rootEntryText).toHaveBeenCalledWith(undefined);
  expect(result.text).toContain('RULES-none');
  expect(result.text.indexOf('RULES-none')).toBeGreaterThan(result.text.indexOf('Skill distillation (create/JSON only)'));
});
