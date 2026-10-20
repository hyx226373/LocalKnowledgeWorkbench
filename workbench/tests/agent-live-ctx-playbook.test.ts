import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLiveEntryWriter, type LiveEntryController } from '../src/main/agentLive/entry';
import { playbookFile, savedPlaybook, viewPlaybook } from '../src/main/agentLive/playbook/file';
import { loadPackagedPresets, packagedPlaybookDir } from '../src/main/agentLive/playbook/presets';
import { createAgentMaterialsStore, type AgentMaterialsApi } from '../src/main/agentLive/materials';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { AGENT_LIVE_SCHEMA_VERSION, type AgentMaterial } from '../src/shared/agentLive/types';
import { defaultSettings } from '../src/shared/aiWriteChannel';
import {
  AUTO_READ_NOTE,
  PLAYBOOK_DISTILL_RULES,
  PLAYBOOK_RULES,
  applyPlaybookPatch,
  builtinPresets,
  composePlaybookSection,
  disabledPlaybook,
  guessOne,
  idsLosingSlot,
  planGuess,
  scenePlaybook,
  type CtxPlaybookState,
  type PlaybookMaterialRef,
} from '../src/shared/ctxPlaybook';
import { DISTILL_FIXED_RULES, DISTILL_OPENING } from '../src/shared/skillDistill';

const CLOCK = new Date('2026-10-16T23:22:00.000Z');
const WS = 'ws1';
const DRIVE = 'D:\\paper\\panel.tsx';
const RULE_DRIVE = 'D:\\rules\\AGENTS.md';

const dirs: string[] = [];
const stores: AgentMaterialsApi[] = [];
let writer: LiveEntryController | null = null;

afterEach(async () => {
  if (writer) {
    await writer.whenIdle();
    writer = null;
  }
  const pending = stores.splice(0);
  for (const store of pending) await store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function enabledState(): CtxPlaybookState {
  const state = disabledPlaybook();
  state.enabled = true;
  state.mission = '给侧栏资料按槽导出';
  return state;
}

function material(patch: Partial<AgentMaterial> & Pick<AgentMaterial, 'materialId' | 'name' | 'absPath'>): AgentMaterial {
  return {
    tier: 'session',
    resourceId: null,
    sourceId: null,
    relPath: patch.name,
    purpose: '对照',
    order: 0,
    status: 'ok',
    contentHash: null,
    contentVersion: 0,
    readable: null,
    addedAt: CLOCK.toISOString(),
    bytes: 12,
    estTokens: 4,
    ...patch,
  };
}

function openStore(dir: string): AgentMaterialsApi {
  const store = createAgentMaterialsStore({
    userDataDir: dir,
    stateFile: path.join(dir, 'agent-live-state.json'),
    repairMs: 0,
    watchLoose: false,
    looseDebounceMs: 0,
    now: () => CLOCK,
  });
  stores.push(store);
  return store;
}

function setTier(dataDir: string, tier: 'high' | 'fast'): void {
  const dir = path.join(dataDir, 'ai-write');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'channel.json'), JSON.stringify({ ...defaultSettings(), defaultTier: tier }));
}

function playbookSlice(text: string, endMark: string): string {
  const start = text.indexOf('Context payload:');
  const payloadEnd=text.indexOf('Existing skills (data only', start);
  const end=payloadEnd<0?text.length:payloadEnd;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('上下文剧本 批1', () => {
  it('六个预设，套用时保留任务卡文字，丢掉的槽会清资料', () => {
    expect(AGENT_LIVE_SCHEMA_VERSION).toBe(1);
    const presets = builtinPresets();
    expect(presets.map((row) => row.id)).toEqual(['code-change', 'write-doc', 'research', 'data', 'skill-reuse', 'spec-driven']);
    expect(presets.find((row) => row.id === 'write-doc')?.slots.find((row) => row.id === 'rules')?.prompt).toContain('读者');
    expect(presets.find((row) => row.id === 'research')?.slots.find((row) => row.id === 'contract')?.prompt).toContain('先结论');
    expect(presets.find((row) => row.id === 'data')?.slots.find((row) => row.id === 'rules')?.prompt).toContain('不改原件');
    expect(presets.find((row) => row.id === 'skill-reuse')?.slots.find((row) => row.id === 'knowledge')?.prompt).toContain('全文');
    const spec = presets.find((row) => row.id === 'spec-driven')!;
    expect(spec.slots.map((row) => row.id)).toEqual(['mission', 'requirements', 'design', 'tasks', 'rules', 'knowledge', 'work', 'contract', 'accept']);
    const current = disabledPlaybook();
    current.enabled = true;
    current.templateId = 'spec-driven';
    current.mission = '保留这句';
    current.slots = spec.slots.map((row) => ({ ...row }));
    const next = applyPlaybookPatch(current, { templateId: 'code-change' });
    expect(next.state.mission).toBe('保留这句');
    expect(next.state.enabled).toBe(true);
    expect(next.removedSlotIds).toEqual(['requirements', 'design', 'tasks']);
    expect(idsLosingSlot(
      [{ materialId: 'a', slotId: 'requirements' }, { materialId: 'b', slotId: 'rules' }],
      next.removedSlotIds,
    )).toEqual(['a']);
    expect(() => applyPlaybookPatch(current, { templateId: 'missing' })).toThrow(/没有这个模板/);
  });

  it('内置剧本文件和代码里的六份一致，缺一份就不用磁盘', () => {
    const dir = path.join(process.cwd(), 'resources', 'ctx-playbooks');
    const loaded = loadPackagedPresets(dir);
    const embedded = builtinPresets();
    expect(loaded).toEqual(embedded);
    const broken = temp('ctx-pack-');
    fs.mkdirSync(broken, { recursive: true });
    fs.copyFileSync(path.join(dir, 'code-change.md'), path.join(broken, 'code-change.md'));
    expect(loadPackagedPresets(broken)).toBeNull();
    const prev = process.env.KB_CTX_PLAYBOOKS;
    process.env.KB_CTX_PLAYBOOKS = 'none';
    try {
      expect(packagedPlaybookDir()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.KB_CTX_PLAYBOOKS;
      else process.env.KB_CTX_PLAYBOOKS = prev;
    }
  });

  it('缺文件等于关，坏文件不覆盖', () => {
    const bridge = temp('ctx-file-');
    const file = playbookFile(bridge, WS);
    expect(viewPlaybook(file).enabled).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{');
    expect(() => savedPlaybook(file, { enabled: true, mission: '不该写入' })).toThrow(/未覆盖/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{');
    fs.rmSync(file);
    const saved = savedPlaybook(file, { enabled: true, mission: '保留这句', templateId: 'spec-driven' });
    expect(saved.state.templateId).toBe('spec-driven');
    const switched = savedPlaybook(file, { templateId: 'code-change' });
    expect(switched.state.mission).toBe('保留这句');
    expect(switched.state.enabled).toBe(true);
    expect(viewPlaybook(file).templateId).toBe('code-change');
    expect(switched.removedSlotIds).toEqual(['requirements', 'design', 'tasks']);
  });

  it('猜测按文件名和正在读的文件分槽，未分的不进粘贴', () => {
    expect(guessOne({ name: 'AGENTS.md', estTokens: 1501 })).toMatchObject({ slotId: 'rules', mount: 'always', delivery: 'index' });
    expect(guessOne({ name: 'CLAUDE.md', estTokens: 1500 }).delivery).toBe('full');
    expect(guessOne({ name: 'house.mdc', relPath: 'rules/house.mdc' }).slotId).toBe('rules');
    expect(guessOne({ name: 'SKILL.md' })).toMatchObject({ slotId: 'knowledge', mount: 'agent', delivery: 'index', purpose: '查阅 SKILL.md' });
    expect(guessOne({ name: '验收清单.md' }).slotId).toBe('accept');
    expect(guessOne({ name: 'checklist.md' }).slotId).toBe('accept');
    expect(guessOne({ name: 'sample.test.ts' }).slotId).toBe('accept');
    expect(guessOne({ name: 'notes.md', purpose: '背景' })).toMatchObject({ slotId: 'knowledge', mount: 'agent', delivery: 'index' });
    expect(guessOne({ name: 'notes.md', purpose: '背景' }).purpose).toBeUndefined();
    expect(guessOne({ name: 'notes.md', reading: true })).toMatchObject({ slotId: 'work', mount: 'auto', delivery: 'path' });
    const state = enabledState();
    expect(planGuess(disabledPlaybook(), [{ materialId: 'a', name: 'notes.md' }])).toEqual([]);
    expect(planGuess(state, [{ materialId: 'a', name: 'AGENTS.md', slotId: 'rules' }])).toEqual([]);
    expect(planGuess(state, [{ materialId: 'a', name: 'notes.md', absPath: DRIVE }], { absPath: DRIVE })).toEqual([
      { materialId: 'a', slotId: 'work', mount: 'auto', delivery: 'path' },
    ]);
    const narrow = enabledState();
    narrow.slots = narrow.slots.filter((row) => row.id === 'mission');
    expect(planGuess(narrow, [{ materialId: 'a', name: 'AGENTS.md' }])).toEqual([]);

    const loose: PlaybookMaterialRef = { materialId: 'u', name: 'UNIQUE-UNASSIGNED.md', absPath: DRIVE, purpose: '先不进' };
    const placed: PlaybookMaterialRef = { materialId: 'w', name: 'panel.tsx', absPath: DRIVE, purpose: '这次要改', slotId: 'work' };
    const manual: PlaybookMaterialRef = { materialId: 'm', name: 'manual.md', absPath: RULE_DRIVE, purpose: '手动', slotId: 'rules', mount: 'manual' };
    const hidden = composePlaybookSection({ state, materials: [loose, placed, manual], tier: 'high' });
    expect(hidden.unassigned).toBe(1);
    expect(hidden.text).not.toContain('UNIQUE-UNASSIGNED');
    expect(hidden.text).not.toContain('manual.md');
    state.manualIds = ['m'];
    const shown = composePlaybookSection({ state, materials: [loose, placed, manual], tier: 'high' });
    expect(shown.text).toContain('manual.md');
    expect(shown.text).not.toContain(DRIVE);
    expect(shown.text).not.toContain(RULE_DRIVE);
    expect(shown.text).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(shown.text).toContain(`Inbox display name panel.tsx · ${AUTO_READ_NOTE}`);
    expect(shown.text).toContain('Inbox reference manual.md');
  });

  it('高档不贴全文，已附带的 skill 全文不再出现第二次', () => {
    const state = enabledState();
    const body = 'SKILL-BODY-ONCE-77';
    const section = composePlaybookSection({
      state,
      tier: 'fast',
      skillFullNames: ['release-notes'],
      materials: [{
        materialId: 's',
        name: 'SKILL.md',
        absPath: 'D:\\skills\\release-notes\\SKILL.md',
        relPath: 'skills/release-notes/SKILL.md',
        purpose: '技能',
        slotId: 'knowledge',
        mount: 'always',
        delivery: 'full',
        text: body,
      }, {
        materialId: 'r',
        name: 'AGENTS.md',
        absPath: RULE_DRIVE,
        purpose: '仓库约定',
        slotId: 'rules',
        text: 'RULE-BODY-FAST',
      }],
    });
    expect(section.text).not.toContain(body);
    expect(section.text).toContain('RULE-BODY-FAST');
    expect(section.text).toContain(RULE_DRIVE);
    const high = composePlaybookSection({
      state,
      tier: 'high',
      materials: [{
        materialId: 'r',
        name: 'AGENTS.md',
        absPath: RULE_DRIVE,
        purpose: '仓库约定',
        slotId: 'rules',
        text: 'RULE-BODY-SHOULD-NOT-LEAK',
      }],
    });
    expect(high.text).toContain('Inbox reference AGENTS.md');
    expect(high.text).not.toContain('RULE-BODY-SHOULD-NOT-LEAK');
    expect(high.text).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('关闭时创建链接与现在一致；打开后剧本在写入档之后、正文之前', () => {
    const dir = temp('ctx-link-');
    const repo = new RebirthRepository(dir);
    const offCreate = repo.linkText('create');
    const offJson = repo.linkText('json');
    const state = enabledState();
    const input = { enabled: true as const, state, materials: [] as PlaybookMaterialRef[] };
    expect(repo.linkText('create', undefined, 'CHANNEL-WRITE', 'other', undefined, { ...input, enabled: false })).toBe(offCreate);
    expect(repo.linkText('create', undefined, 'CHANNEL-WRITE', 'other', undefined, { enabled: true, state: disabledPlaybook(), materials: [] })).toBe(offCreate);
    expect(repo.linkText('json', undefined, '', 'other', undefined, null)).toBe(offJson);
    const { id } = repo.import('## 内容\n正文');
    const imported = repo.linkText('import', id);
    expect(repo.linkText('import', id, 'CHANNEL-WRITE', 'other', undefined, input)).toBe(imported);

    setTier(dir, 'high');
    const materials: PlaybookMaterialRef[] = [
      { materialId: 'w', name: 'panel.tsx', absPath: DRIVE, purpose: '这次要改的列表', slotId: 'work', estTokens: 12 },
      { materialId: 'u', name: 'UNIQUE-UNASSIGNED.md', absPath: DRIVE, purpose: '不进' },
    ];
    const on = repo.linkText('create', undefined, 'CHANNEL-WRITE\nInbox scope: "/demo/inbox"', 'other', undefined, { enabled: true, state, materials });
    expect(on.indexOf('CHANNEL-WRITE')).toBeLessThan(on.indexOf(PLAYBOOK_RULES));
    expect(on.indexOf(PLAYBOOK_RULES)).toBeLessThan(on.indexOf('Context payload: 改代码'));
    expect(on.indexOf('Context playbook (source selection only)')).toBeLessThan(on.indexOf('Extraction — exactly five passes'));
    const section = playbookSlice(on, '请立即执行：把本对话总结写成文件。');
    expect(on).toContain('supplied mission omitted');
    expect(section).toContain('Inbox display name panel.tsx');
    expect(section).not.toContain('UNIQUE-UNASSIGNED');
    expect(section).not.toContain(DRIVE);
    expect(section).not.toMatch(/[A-Za-z]:[\\/]/);
    const web = repo.linkText('json', undefined, 'CHANNEL-WRITE', 'other', undefined, { enabled: true, state, materials });
    expect(web.indexOf('Context playbook (source selection only)')).toBeLessThan(web.indexOf('Extraction — exactly five passes'));
    expect(web.split('output exactly one fenced json object').length - 1).toBe(1);
    expect(playbookSlice(web, '请立即执行：把本对话总结成下面格式的 JSON')).not.toMatch(/[A-Za-z]:[\\/]/);

    setTier(dir, 'fast');
    const fast = repo.linkText('create', undefined, 'CHANNEL-WRITE', 'other', undefined, { enabled: true, state, materials });
    expect(playbookSlice(fast, '请立即执行：把本对话总结写成文件。')).toContain(DRIVE);

    repo.setSettings({ ...repo.settings(), skillDistill: true });
    const distillOnly = repo.linkText('create', undefined, 'CHANNEL-WRITE');
    expect(distillOnly).toContain(DISTILL_FIXED_RULES);
    expect(distillOnly).not.toContain('Context payload:');
    expect(distillOnly).not.toContain(PLAYBOOK_DISTILL_RULES);
    const skillDir = path.join(dir, 'skills', 'release-notes');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillBody = 'SKILL-BODY-ONCE-77';
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nlkw: skill/1\nname: release-notes\ndescription: 写发布说明\nwhen-to-use: 写发布说明时使用\n---\n${skillBody}\n`);
    repo.setSettings({ ...repo.settings(), skillDistill: true, skillAttach: [{ name: 'release-notes', full: true }] });
    const both = repo.linkText('create', undefined, 'CHANNEL-WRITE', 'other', undefined, {
      enabled: true,
      state,
      materials: [{
        materialId: 's',
        name: 'SKILL.md',
        absPath: path.join(skillDir, 'SKILL.md'),
        relPath: 'skills/release-notes/SKILL.md',
        purpose: '技能',
        slotId: 'knowledge',
        mount: 'always',
        delivery: 'full',
      }],
    });
    expect(both.indexOf('CHANNEL-WRITE')).toBeLessThan(both.indexOf(PLAYBOOK_DISTILL_RULES));
    expect(both.indexOf(PLAYBOOK_DISTILL_RULES)).toBeLessThan(both.indexOf('Skill distillation (create/JSON only)'));
    expect(both.indexOf('Skill distillation (create/JSON only)')).toBeLessThan(both.indexOf('Context payload:'));
    expect(both.indexOf('Context playbook (source selection only)')).toBeLessThan(both.indexOf('Extraction — exactly five passes'));
    expect(both).not.toContain(DISTILL_FIXED_RULES);
    expect(both.split(skillBody).length - 1).toBe(1);
    expect(playbookSlice(both, DISTILL_OPENING)).not.toContain(skillBody);
  });

  it('关时 ENTRY 第 1–7 节与快照不变；开时在第 7 节后加第 8 节，schemaVersion 仍是 1', async () => {
    const abs = DRIVE;
    const row = material({ materialId: 'm01', name: 'panel.tsx', absPath: abs, purpose: '这次要改', slotId: 'work', mount: 'auto', delivery: 'path' });
    const bare = material({ materialId: 'm02', name: 'plain.md', absPath: 'D:\\paper\\plain.md', purpose: null });
    const state = enabledState();
    const sceneBase = {
      workspaceName: '试验',
      materials: [row, bare],
      writeChannel: { defaultTier: 'medium' as const, folders: [{ id: 'ab', name: '笔记', tier: 'medium' as const, virtualPath: 'kb-stage://ab', absPath: 'D:\\inbox\\notes' }] },
      skillDistill: true,
    };
    const offBridge = temp('ctx-entry-off-');
    const offWriter = createLiveEntryWriter({ bridgeRoot: offBridge, now: () => CLOCK, loadScene: () => sceneBase });
    writer = offWriter;
    await offWriter.render('ws-m', 3);
    const offEntry = fs.readFileSync(path.join(offBridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    const offSnap = JSON.parse(fs.readFileSync(path.join(offBridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      schemaVersion: number;
      sections: string[];
      playbook?: unknown;
      materials: Array<{ materialId: string; slotId?: string; absPath?: string }>;
    };
    expect(offEntry).not.toContain('## 8.');
    expect(offSnap.schemaVersion).toBe(1);
    expect(offSnap.playbook).toBeUndefined();
    expect(offSnap.sections).not.toContain('playbook');
    expect(offSnap.sections.at(-1)).toBe('writeChannel');
    expect(offSnap.materials.find((item) => item.materialId === 'm01')?.slotId).toBe('work');
    expect(offSnap.materials.find((item) => item.materialId === 'm02')).not.toHaveProperty('slotId');

    const onBridge = temp('ctx-entry-on-');
    const playbook = scenePlaybook(state, [row, bare]);
    expect(playbook?.snapshot.enabled).toBe(true);
    const onWriter = createLiveEntryWriter({
      bridgeRoot: onBridge,
      now: () => CLOCK,
      loadScene: () => ({ ...sceneBase, playbook }),
    });
    writer = onWriter;
    await onWriter.render('ws-m', 3);
    const onEntry = fs.readFileSync(path.join(onBridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    const onSnap = JSON.parse(fs.readFileSync(path.join(onBridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      schemaVersion: number;
      sections: string[];
      playbook?: { mission?: string; slots?: unknown };
      materials: Array<{ materialId: string; slotId?: string }>;
    };
    expect(onEntry.startsWith(`${offEntry}\n\n## 8. 上下文剧本`)).toBe(true);
    expect(onEntry.indexOf('## 7. AI 写入通道')).toBeLessThan(onEntry.indexOf('skill 蒸馏：开'));
    expect(onEntry.indexOf('skill 蒸馏：开')).toBeLessThan(onEntry.indexOf('## 8. 上下文剧本'));
    const section8 = onEntry.slice(onEntry.indexOf('## 8. 上下文剧本'));
    expect(section8).toContain('给侧栏资料按槽导出');
    expect(section8).toContain('工作对象：1');
    expect(section8).toContain('追溯：0');
    expect(section8).not.toContain(abs);
    expect(section8).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(onSnap.schemaVersion).toBe(1);
    expect(onSnap.sections).toEqual([...offSnap.sections, 'playbook']);
    expect(JSON.stringify(onSnap.playbook)).not.toContain(abs);
    expect(JSON.stringify(onSnap.playbook)).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(onSnap.materials.find((item) => item.materialId === 'm01')?.slotId).toBe('work');

    const closedBridge = temp('ctx-entry-closed-');
    const closed = createLiveEntryWriter({
      bridgeRoot: closedBridge,
      now: () => CLOCK,
      loadScene: () => ({
        ...sceneBase,
        playbook: playbook
          ? { snapshot: { ...playbook.snapshot, enabled: false }, entry: playbook.entry }
          : undefined,
      }),
    });
    writer = closed;
    await closed.render('ws-m', 3);
    const closedEntry = fs.readFileSync(path.join(closedBridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    const closedSnap = JSON.parse(fs.readFileSync(path.join(closedBridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as { playbook?: unknown; sections: string[] };
    expect(closedEntry).toBe(offEntry);
    expect(closedSnap.playbook).toBeUndefined();
    expect(closedSnap.sections).not.toContain('playbook');
  });

  it('分槽、挂载和给法落盘，自取没有为什么就拒绝', async () => {
    const dir = temp('ctx-mat-');
    const file = path.join(dir, 'notes.md');
    fs.writeFileSync(file, 'hello');
    const store = openStore(dir);
    expect(store.add(WS, { absPath: file })).toBe('added');
    const id = store.list(WS)[0]!.materialId;
    store.flushSync();
    expect(fs.readFileSync(path.join(dir, 'agent-live-state.json'), 'utf8')).not.toContain('slotId');
    expect(() => store.setPlace(WS, id, { mount: 'agent', slotId: 'knowledge' })).toThrow(/为什么/);
    const state = enabledState();
    const [guess] = planGuess(state, store.list(WS).map((row) => ({
      materialId: row.materialId,
      name: row.name,
      absPath: row.absPath,
      purpose: row.purpose,
      estTokens: row.estTokens,
    })));
    expect(guess).toMatchObject({ slotId: 'knowledge', mount: 'agent', delivery: 'index' });
    if (guess?.purpose) store.setPurpose(WS, id, guess.purpose);
    expect(store.setPlace(WS, id, { slotId: guess?.slotId, mount: guess?.mount, delivery: guess?.delivery, summary: '短摘要' })).toBe(true);
    expect(() => store.setPurpose(WS, id, '  ')).toThrow(/为什么/);
    store.flushSync();
    await store.close();
    const closedAt = stores.indexOf(store);
    if (closedAt >= 0) stores.splice(closedAt, 1);
    const again = openStore(dir);
    const row = again.list(WS)[0]!;
    expect(row.slotId).toBe('knowledge');
    expect(row.mount).toBe('agent');
    expect(row.delivery).toBe('index');
    expect(row.summary).toBe('短摘要');
    expect(row.purpose).toBe('查阅 notes.md');
    expect(again.setPlace(WS, id, { slotId: null, mount: null, delivery: null, summary: null })).toBe(true);
    expect(again.list(WS)[0]).not.toHaveProperty('slotId');
    expect(again.list(WS)[0]).not.toHaveProperty('mount');
    again.flushSync();
    expect(fs.readFileSync(path.join(dir, 'agent-live-state.json'), 'utf8')).not.toContain('slotId');
  });
});
