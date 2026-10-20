/**
 * 标红落在 userData/agent-marks.json。不写用户源文件，不进工作区布局，不改 agent-live-state.json。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  MAX_MARK_CHARS,
  ROUND_RESET_EVENT,
  marksAfterRoundEvent,
  forgetAttentionPaths,
  relocateConversationMarks,
  retargetAttentionPaths,
  sameMarkPath,
  toSignal,
  unmarkOverlapping,
  type AttentionConversation,
  type AttentionDraft,
  type AttentionMark,
  type AttentionSignal,
  type MarkRetention,
} from '../../shared/agentMarks';

export interface AgentMarkStore {
  refreshRebirth(resolve: (id:string) => {file:string;title:string;blocks:{idx:number;body:string;start:number}[];source:string} | null): void;
  list(): AttentionMark[];
  signals(): AttentionSignal[];
  retention(): MarkRetention;
  setRetention(next: MarkRetention): MarkRetention;
  add(draft: AttentionDraft): AttentionMark;
  unmark(absPath: string, start: number, end: number): AttentionMark[];
  clearAll(): void;
  /**
   * 对话文件刷新后按块号和原文重定位。块消失或原文对不上则剔除。
   * 返回是否改了标红。
   */
  relocate(absPath: string, source: string): boolean;
  /** 对话文件 rename 后改标红里的路径。返回是否改了。 */
  retarget(moves: readonly { from: string; to: string; title?: string }[]): boolean;
  /** 对话文件删除后去掉标红。返回是否改了。 */
  forget(paths: readonly string[]): boolean;
  /** 返回是否因此清掉了标红。 */
  onRoundReset(eventType: string): boolean;
}

function atomicWrite(dest: string, data: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, dest);
}

function isRetention(value: unknown): value is MarkRetention {
  return value === 'round' || value === 'manual';
}

function asMark(raw: unknown): AttentionMark | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id) return null;
  if (typeof row.absPath !== 'string' || !row.absPath.trim()) return null;
  if (typeof row.text !== 'string' || !row.text) return null;
  if (!Number.isInteger(row.startLine) || !Number.isInteger(row.endLine)) return null;
  if (!Number.isInteger(row.startOffset) || !Number.isInteger(row.endOffset)) return null;
  const startLine = row.startLine as number;
  const endLine = row.endLine as number;
  const startOffset = row.startOffset as number;
  const endOffset = row.endOffset as number;
  if (startLine < 1 || endLine < startLine) return null;
  if (startOffset < 0 || endOffset <= startOffset) return null;
  if (endOffset - startOffset !== row.text.length) return null;
  if (row.text.length > MAX_MARK_CHARS) return null;
  const conversation = asConversation(row.conversation);
  return {
    id: row.id,
    absPath: row.absPath.trim(),
    startLine,
    endLine,
    startOffset,
    endOffset,
    text: row.text,
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : '',
    ...(conversation ? { conversation } : {}),
    ...(row.rebirth && typeof row.rebirth === 'object' && /^R[1-9]\d*$/.test(String((row.rebirth as any).id)) && Number.isInteger((row.rebirth as any).blockIdx) && (row.rebirth as any).blockIdx > 0 ? { rebirth: { id: (row.rebirth as any).id, no: (row.rebirth as any).no, title: String((row.rebirth as any).title), blockIdx: (row.rebirth as any).blockIdx } } : {}),
  };
}

function readFile(file: string): { retention: MarkRetention; marks: AttentionMark[] } {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { retention: 'round', marks: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { retention: 'round', marks: [] };
  }
  if (!parsed || typeof parsed !== 'object') return { retention: 'round', marks: [] };
  const body = parsed as Record<string, unknown>;
  if (body.v !== 1) return { retention: 'round', marks: [] };
  const marks = Array.isArray(body.marks) ? body.marks.map(asMark).filter((row): row is AttentionMark => row !== null) : [];
  return { retention: isRetention(body.retention) ? body.retention : 'round', marks };
}

function asConversation(raw: unknown): AttentionConversation | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const file = typeof row.path === 'string' ? row.path.trim() : '';
  const agent = typeof row.agent === 'string' ? row.agent.trim() : '';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const blockId = typeof row.blockId === 'string' ? row.blockId.trim() : '';
  if (!file || !agent || !title || !/^[UA]\d+$/.test(blockId)) return undefined;
  return { path: file, agent, title, blockId };
}

function sameStoredMarks(left: readonly AttentionMark[], right: readonly AttentionMark[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    if (a.id !== b.id || a.absPath !== b.absPath || a.text !== b.text) return false;
    if (a.startLine !== b.startLine || a.endLine !== b.endLine) return false;
    if (a.startOffset !== b.startOffset || a.endOffset !== b.endOffset) return false;
    if (JSON.stringify(a.conversation ?? null) !== JSON.stringify(b.conversation ?? null)) return false;
  }
  return true;
}

function isSecretName(absPath: string): boolean {
  const base = absPath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return base === 'agent-token.json';
}

export function createAgentMarkStore(file: string): AgentMarkStore {
  let state = readFile(file);

  const save = () => {
    const body = {
      v: 1,
      retention: state.retention,
      marks: state.marks,
    };
    atomicWrite(file, `${JSON.stringify(body, null, 2)}\n`);
  };

  return {
    refreshRebirth(resolve) {
      const next = state.marks.flatMap(mark => {
        if(!mark.rebirth)return [mark];
        const doc=resolve(mark.rebirth.id);if(!doc)return [];
        const block=doc.blocks.find(b=>b.idx===mark.rebirth!.blockIdx && b.body.includes(mark.text)) ?? doc.blocks.find(b=>b.body.includes(mark.text));
        if(!block)return [];
        const startOffset=block.start+block.body.indexOf(mark.text),endOffset=startOffset+mark.text.length;
        return [{...mark,absPath:doc.file,startOffset,endOffset,startLine:doc.source.slice(0,startOffset).split('\n').length,endLine:doc.source.slice(0,endOffset).split('\n').length,rebirth:{...mark.rebirth,title:doc.title,blockIdx:block.idx}}];
      });
      if(JSON.stringify(next)!==JSON.stringify(state.marks)){state={...state,marks:next};save();}
    },
    list: () => state.marks.map((mark) => ({ ...mark })),
    signals: () => state.marks.filter((mark) => !isSecretName(mark.absPath)).map(toSignal),
    retention: () => state.retention,
    setRetention(next) {
      if (!isRetention(next)) throw new Error('未知的标红保留方式');
      if (state.retention === next) return state.retention;
      state = { ...state, retention: next };
      save();
      return state.retention;
    },
    add(draft) {
      const mark = asMark({
        ...draft,
        id: randomBytes(8).toString('hex'),
        createdAt: new Date().toISOString(),
      });
      if (!mark) throw new Error('标红内容无效');
      if (isSecretName(mark.absPath)) throw new Error('不能标红该文件');
      const existing = state.marks.find(
        (row) => sameMarkPath(row.absPath, mark.absPath) && row.startOffset === mark.startOffset && row.endOffset === mark.endOffset,
      );
      if (existing) return { ...existing };
      state = { ...state, marks: [...state.marks, mark] };
      save();
      return { ...mark };
    },
    unmark(absPath, start, end) {
      const next = unmarkOverlapping(state.marks, String(absPath ?? ''), Number(start), Number(end));
      if (next.length !== state.marks.length) {
        state = { ...state, marks: next };
        save();
      }
      return next.map((mark) => ({ ...mark }));
    },
    clearAll() {
      if (!state.marks.length) return;
      state = { ...state, marks: [] };
      save();
    },
    relocate(absPath, source) {
      const next = relocateConversationMarks(state.marks, String(absPath ?? ''), String(source ?? ''));
      if (sameStoredMarks(state.marks, next)) return false;
      state = { ...state, marks: next };
      save();
      return true;
    },
    retarget(moves) {
      const next = retargetAttentionPaths(state.marks, moves);
      if (sameStoredMarks(state.marks, next)) return false;
      state = { ...state, marks: next };
      save();
      return true;
    },
    forget(paths) {
      const next = forgetAttentionPaths(state.marks, paths);
      if (next.length === state.marks.length) return false;
      state = { ...state, marks: next };
      save();
      return true;
    },
    onRoundReset(eventType) {
      const next = marksAfterRoundEvent(state.marks, state.retention, eventType);
      if (next.length === state.marks.length) return false;
      state = { ...state, marks: next };
      save();
      return true;
    },
  };
}

export { ROUND_RESET_EVENT };
