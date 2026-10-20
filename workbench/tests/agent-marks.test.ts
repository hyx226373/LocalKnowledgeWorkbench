import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_FILES } from '../src/main/agent-bridge/embedded';
import { createLiveEntryWriter } from '../src/main/agentLive/entry';
import { renderEntry, type EntryDoc } from '../src/main/agentLive/entry/docs';
import { buildSnapshot } from '../src/main/agentLive/entry/snapshot';
import { createAgentMarkStore } from '../src/main/agentMarks/store';
import {
  MARK_INELIGIBLE_REASON,
  MARK_NEED_SELECTION,
  MARK_NO_HIT,
  MARK_TOO_LONG,
  MARK_UNMAPPED,
  ROUND_RESET_EVENT,
  conversationContextMenu,
  conversationRegions,
  eligibilityForPath,
  highlightSlices,
  mapSelectionToSource,
  marksAfterRoundEvent,
  placeConversationSelection,
  previewContextMenu,
  schemaAppendProblems,
  type AttentionMark,
  type AttentionSignal,
  type JsonSchemaNode,
} from '../src/shared/agentMarks';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-marks-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SIGNAL: AttentionSignal = {
  absPath: 'D:\\论文\\第三章\\实验01.md',
  startLine: 3,
  endLine: 5,
  startOffset: 12,
  endOffset: 17,
  text: '选中的原文',
};

function baseMark(over: Partial<AttentionMark> = {}): AttentionMark {
  return {
    id: 'm1',
    absPath: SIGNAL.absPath,
    startLine: SIGNAL.startLine,
    endLine: SIGNAL.endLine,
    startOffset: SIGNAL.startOffset,
    endOffset: SIGNAL.endOffset,
    text: SIGNAL.text,
    createdAt: '2026-10-15T00:00:00.000Z',
    ...over,
  };
}

function emptyDoc(attention?: AttentionSignal[]): EntryDoc {
  return {
    revision: 3,
    generatedAt: '2026-10-15T00:00:00.000Z',
    workspaceId: 'ws-m',
    workspaceName: '论文第三章',
    panels: [],
    reading: null,
    sessionShown: [],
    pinnedShown: [],
    sessionAll: [],
    pinnedAll: [],
    omitted: 0,
    pathStyle: 'workspace',
    ...(attention?.length ? { attention } : {}),
  };
}

function snap(attention?: AttentionSignal[]) {
  return buildSnapshot({
    appVersion: '0.2.5',
    generatedAt: '2026-10-15T00:00:00.000Z',
    workspaceId: 'ws-m',
    workspaceName: '论文第三章',
    revision: 3,
    panels: [],
    reading: null,
    items: [],
    hidden: () => false,
    ...(attention?.length ? { attention } : {}),
  });
}

/** 追加 attention 之前的 response schema。已有字段必须与此一致。 */
const RESPONSE_SCHEMA_BEFORE: JsonSchemaNode = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'kb://agent-bridge/response.schema.json',
  title: 'Agent bridge response',
  type: 'object',
  additionalProperties: true,
  required: ['requestId', 'status', 'updatedAt'],
  properties: {
    requestId: { type: 'string', format: 'uuid' },
    status: { enum: ['pending', 'awaiting_approval', 'running', 'success', 'failed', 'conflict'] },
    updatedAt: { type: 'string' },
    result: {},
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
    planId: { type: 'string' },
    ignoredFields: { type: 'array', items: { type: 'string' } },
    suggestedAction: { enum: ['re-propose', 'open-restore-ui', 'inspect-plan'] },
  },
};

describe('预览右键菜单', () => {
  it('三项都在，复制和标红看选区，取消标红看是否落在已有标红上', () => {
    const idle = previewContextMenu({ hasSelection: false, fileInRound: true, selectionOrClickOnMark: false });
    expect(idle.map((item) => item.testId)).toEqual(['preview-ctx-copy', 'preview-ctx-mark', 'preview-ctx-unmark']);
    expect(idle.map((item) => item.label)).toEqual(['复制', '标红给 Agent', '取消此处标红']);
    expect(idle.map((item) => item.enabled)).toEqual([false, false, false]);
    expect(idle[0]?.title).toBe(MARK_NEED_SELECTION);
    expect(idle[1]?.title).toBe(MARK_NEED_SELECTION);
    expect(idle[2]?.title).toBe(MARK_NO_HIT);

    const ready = previewContextMenu({ hasSelection: true, fileInRound: true, selectionOrClickOnMark: true });
    expect(ready.map((item) => item.enabled)).toEqual([true, true, true]);
    expect(ready.every((item) => item.title == null)).toBe(true);
  });

  it('文件不在本轮资料里时标红置灰，并写明原因', () => {
    const items = previewContextMenu({ hasSelection: true, fileInRound: false, selectionOrClickOnMark: false });
    expect(items.find((item) => item.id === 'copy')?.enabled).toBe(true);
    const mark = items.find((item) => item.id === 'mark');
    expect(mark?.enabled).toBe(false);
    expect(mark?.title).toBe(MARK_INELIGIBLE_REASON);
    expect(MARK_INELIGIBLE_REASON).toBe('只有放进本轮工作台资料或 Agent 资料的文件才能标红');
    expect(eligibilityForPath('D:\\其他\\笔记.md', ['D:\\论文\\实验01.md'])).toEqual({
      ok: false,
      reason: MARK_INELIGIBLE_REASON,
    });
    expect(eligibilityForPath('D:/论文/实验01.md', ['D:\\论文\\实验01.md'])).toEqual({ ok: true });
  });

  it('对不上原文或选区过长时不能标红', () => {
    const unmapped = previewContextMenu({ hasSelection: true, fileInRound: true, selectionOrClickOnMark: false, unmapped: true });
    expect(unmapped.find((item) => item.id === 'mark')).toMatchObject({ enabled: false, title: MARK_UNMAPPED });
    const tooLong = previewContextMenu({ hasSelection: true, fileInRound: true, selectionOrClickOnMark: false, tooLong: true });
    expect(tooLong.find((item) => item.id === 'mark')).toMatchObject({ enabled: false, title: MARK_TOO_LONG });
    expect(tooLong.find((item) => item.id === 'copy')?.enabled).toBe(true);
  });
});

describe('标红保留与持久化', () => {
  it('取消单个、清除全部，并且不改用户源文件', () => {
    const dir = tempDir();
    const source = path.join(dir, '实验01.md');
    const original = '# 标题\n\n选中的原文\n';
    fs.writeFileSync(source, original);
    const store = createAgentMarkStore(path.join(dir, 'agent-marks.json'));
    const first = store.add({ ...SIGNAL, absPath: source });
    const second = store.add({
      absPath: source,
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 4,
      text: '# 标题',
    });
    expect(store.add({ ...SIGNAL, absPath: source }).id).toBe(first.id);
    expect(store.list()).toHaveLength(2);
    store.unmark(source, first.startOffset, first.endOffset);
    expect(store.list().map((row) => row.id)).toEqual([second.id]);
    store.clearAll();
    expect(store.list()).toEqual([]);
    expect(store.signals()).toEqual([]);
    expect(fs.readFileSync(source, 'utf8')).toBe(original);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agent-marks.json'), 'utf8')) as { v: number; retention: string; marks: unknown[] };
    expect(saved).toMatchObject({ v: 1, retention: 'round', marks: [] });
  });

  it('本轮有效在 session.cleared 时清空；一直保留则留下；别的事件不清', () => {
    const dir = tempDir();
    const file = path.join(dir, 'agent-marks.json');
    const round = createAgentMarkStore(file);
    expect(round.retention()).toBe('round');
    round.add(SIGNAL);
    expect(round.onRoundReset('snapshot.reset')).toBe(false);
    expect(round.onRoundReset('workspace.switched')).toBe(false);
    expect(round.list()).toHaveLength(1);
    expect(ROUND_RESET_EVENT).toBe('session.cleared');
    expect(round.onRoundReset(ROUND_RESET_EVENT)).toBe(true);
    expect(round.list()).toEqual([]);

    round.add(SIGNAL);
    expect(round.setRetention('manual')).toBe('manual');
    expect(round.list()).toHaveLength(1);
    expect(round.onRoundReset(ROUND_RESET_EVENT)).toBe(false);
    expect(round.signals()).toEqual([SIGNAL]);
    expect(() => round.setRetention('forever' as 'round')).toThrow(/标红保留/);

    const again = createAgentMarkStore(file);
    expect(again.retention()).toBe('manual');
    expect(again.list()).toHaveLength(1);
    expect(marksAfterRoundEvent(again.list(), 'round', ROUND_RESET_EVENT)).toEqual([]);
    expect(marksAfterRoundEvent(again.list(), 'manual', ROUND_RESET_EVENT)).toHaveLength(1);
  });

  it('不认的版本不覆盖原文件，密钥文件不能标红', () => {
    const dir = tempDir();
    const file = path.join(dir, 'agent-marks.json');
    const raw = `${JSON.stringify({ v: 2, retention: 'manual', marks: [baseMark()] }, null, 2)}\n`;
    fs.writeFileSync(file, raw);
    const store = createAgentMarkStore(file);
    expect(store.list()).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(raw);
    expect(() => store.add({ ...SIGNAL, absPath: 'D:\\secret\\agent-token.json' })).toThrow(/不能标红/);
  });
});

describe('特别关注写入 snapshot 和 ENTRY', () => {
  it('有标红才追加 attention 和「特别关注」，原文换行在入口里折成一行', () => {
    const empty = snap();
    expect(empty.schemaVersion).toBe(1);
    expect(empty.sections).toEqual(['workspace', 'panels', 'reading', 'materials', 'sessionMaterials', 'pinnedMaterials', 'nav']);
    expect(empty).not.toHaveProperty('attention');
    expect(renderEntry(emptyDoc())).not.toContain('### 特别关注');

    const multiline: AttentionSignal = { ...SIGNAL, text: '第一行\n第二行', endOffset: SIGNAL.startOffset + '第一行\n第二行'.length };
    const filled = snap([SIGNAL, multiline]);
    expect(filled.schemaVersion).toBe(1);
    expect(filled.sections).toEqual([...(empty.sections ?? []), 'attention']);
    expect(filled.attention).toEqual([SIGNAL, multiline]);
    const entry = renderEntry(emptyDoc([SIGNAL, multiline]));
    const pinned = entry.indexOf('### 固定资料');
    const block = entry.indexOf('### 特别关注');
    const nav = entry.indexOf('## 4. 导航');
    expect(pinned).toBe(-1); // r18: empty pinned materials are omitted from ENTRY.
    expect(block).toBeGreaterThan(0);
    expect(nav).toBeGreaterThan(block);
    expect(entry).toContain('- D:\\论文\\第三章\\实验01.md · 行 3-5 · 偏移 12-17 · 原文：选中的原文');
    expect(entry).toContain(`- D:\\论文\\第三章\\实验01.md · 行 3-5 · 偏移 ${multiline.startOffset}-${multiline.endOffset} · 原文：第一行 第二行`);
    expect(entry).not.toContain('原文：第一行\n第二行');
  });

  it('入口写入器把信号写进 snapshot.json 和 ENTRY.md，密钥路径被抹掉', async () => {
    const bridge = tempDir();
    const withMarks = createLiveEntryWriter({
      bridgeRoot: bridge,
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      loadScene: () => ({ workspaceName: '论文第三章', attention: [SIGNAL] }),
    });
    await withMarks.render('ws-m', 4);
    const snapshot = JSON.parse(fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8')) as {
      schemaVersion: number;
      sections: string[];
      attention?: AttentionSignal[];
    };
    const text = fs.readFileSync(path.join(bridge, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.sections).toContain('attention');
    expect(snapshot.attention).toEqual([SIGNAL]);
    expect(text).toContain('### 特别关注');
    expect(text).toContain('行 3-5 · 偏移 12-17 · 原文：选中的原文');

    const secret = tempDir();
    const hidden = createLiveEntryWriter({
      bridgeRoot: secret,
      now: () => new Date('2026-10-15T00:00:00.000Z'),
      loadScene: () => ({
        workspaceName: '论文第三章',
        attention: [{ ...SIGNAL, absPath: 'D:\\secret\\agent-token.json', text: 'TOKENSECRET' }],
      }),
    });
    await hidden.render('ws-m', 1);
    const hiddenSnap = fs.readFileSync(path.join(secret, 'live', 'ws', 'ws-m', 'snapshot.json'), 'utf8');
    const hiddenEntry = fs.readFileSync(path.join(secret, 'live', 'ws', 'ws-m', 'ENTRY.md'), 'utf8');
    expect(hiddenSnap).not.toContain('attention');
    expect(hiddenSnap).not.toContain('TOKENSECRET');
    expect(hiddenEntry).not.toContain('### 特别关注');
    expect(hiddenEntry).not.toContain('TOKENSECRET');
  });
});

describe('高亮切片', () => {
  it('只包住和原文一致的区间，重叠的后一段先跳过', () => {
    const text = 'abcdef';
    expect(highlightSlices(text, [
      { id: 'a', start: 1, end: 3, text: 'bc' },
      { id: 'b', start: 2, end: 4, text: 'cd' },
      { id: 'c', start: 4, end: 5, text: 'ZZ' },
    ])).toEqual([
      { text: 'a' },
      { text: 'bc', markId: 'a' },
      { text: 'def' },
    ]);
    expect(mapSelectionToSource('hello **world**', 'hello world', 6, 11)).toEqual({ start: 8, end: 13, text: 'world' });
  });
});

describe('response schema 只追加', () => {
  it('attention 是可选字段，已有字段和 embedded 副本保持原样', () => {
    const file = path.join(__dirname, '../src/main/agent-bridge/templates/schemas/response.schema.json');
    const raw = fs.readFileSync(file, 'utf8');
    const next = JSON.parse(raw) as JsonSchemaNode;
    expect(schemaAppendProblems(RESPONSE_SCHEMA_BEFORE, next)).toEqual([]);
    expect(next.required).toEqual(['requestId', 'status', 'updatedAt']);
    expect(next.properties?.attention).toBeTruthy();
    expect(SCHEMA_FILES['response.schema.json']).toBe(raw);
    const embedded = JSON.parse(SCHEMA_FILES['response.schema.json']!) as JsonSchemaNode;
    expect(schemaAppendProblems(RESPONSE_SCHEMA_BEFORE, embedded)).toEqual([]);
    const request = JSON.parse(SCHEMA_FILES['request.schema.json']!) as JsonSchemaNode;
    expect(request.properties).not.toHaveProperty('attention');
  });
});

