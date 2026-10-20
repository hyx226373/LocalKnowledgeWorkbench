/**
 * skill 库的纯解析。不读盘。渲染进程会加载拆块函数，所以这里不用路径模块。
 * 合格条件：闭合文件头、lkw: skill/1、name 与目录一致、description 与 when-to-use 非空。
 */
import { isSkillName } from './skillDistill';

export const SKILL_FILE_MAX = 256 * 1024;
export const SKILL_TOTAL_MAX = 1024 * 1024;

export interface SkillSnapshotEntry {
  name: string;
  description: string;
  whenToUse: string;
}

export interface ReadySkill {
  name: string;
  description: string;
  whenToUse: string;
}

export interface SkillProblem {
  name: string;
  reason: string;
}

export interface MisplacedSkill {
  rel: string;
  reason: string;
}

export interface SkillLibraryView {
  ready: ReadySkill[];
  pending: SkillProblem[];
  misplaced: MisplacedSkill[];
}

export interface SkillSidecar {
  rel: string;
  body: string;
}

export interface DistillPasteParts {
  summary: string;
  skill: string | null;
  files: SkillSidecar[];
  errors: string[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  raw: string;
}

export function splitFrontmatter(text: string): { closed: boolean; yaml: string; body: string } {
  const src = text.replace(/^\uFEFF/, '');
  const lines = src.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { closed: false, yaml: '', body: src };
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { closed: false, yaml: lines.slice(1).join('\n'), body: '' };
  return { closed: true, yaml: lines.slice(1, end).join('\n'), body: lines.slice(end + 1).join('\n') };
}

const YAML_LINE = '多行 YAML 无法解析。请把 name、description、when-to-use、lkw 各写成一行';
const FIELD_LINE = /^([A-Za-z0-9_-]+):\s*(.*)$/;
const BLOCK_SCALAR = /^(?:[|>][+-]?)$/;

/** 只接受单行字段。多行值会丢内容，所以直接拒绝并提示改成一行。 */
function fieldsOf(yaml: string): { ok: true; fields: Record<string, string> } | { ok: false; reason: string } {
  const fields: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = FIELD_LINE.exec(line);
    if (!match) return { ok: false, reason: YAML_LINE };
    const key = match[1] ?? '';
    let value = (match[2] ?? '').trim();
    const quoted = (value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2);
    if (!quoted && BLOCK_SCALAR.test(value)) return { ok: false, reason: `${key} 是多行 YAML。请改成一行；目前解析不了多行值` };
    if (quoted) value = value.slice(1, -1);
    fields[key] = value;
  }
  return { ok: true, fields };
}

/** 文件头（未闭合时只看开头一段）里有 lkw: skill/1。正文里的同句不算。 */
export function frontmatterHasSkillMarker(text: string): boolean {
  const src = text.replace(/^\uFEFF/, '');
  if (!src.startsWith('---')) return false;
  const split = splitFrontmatter(src);
  const head = split.closed ? split.yaml : src.slice(0, 8192);
  return /^lkw:\s*skill\/1\s*$/m.test(head);
}

export function parseSkillDocument(raw: string, dirName?: string): { ok: true; skill: ParsedSkill } | { ok: false; reason: string } {
  const split = splitFrontmatter(raw);
  if (!split.closed) return { ok: false, reason: '文件头未闭合' };
  const parsedFields = fieldsOf(split.yaml);
  if (!parsedFields.ok) return { ok: false, reason: parsedFields.reason };
  const fields = parsedFields.fields;
  if (fields.lkw !== 'skill/1') return { ok: false, reason: '缺少 lkw: skill/1' };
  const name = fields.name ?? '';
  if (!isSkillName(name)) return { ok: false, reason: 'name 不合法' };
  if (dirName !== undefined && dirName !== name) return { ok: false, reason: 'name 与目录不一致' };
  const description = (fields.description ?? '').trim();
  if (!description) return { ok: false, reason: 'description 为空' };
  const whenToUse = (fields['when-to-use'] ?? '').trim();
  if (!whenToUse) return { ok: false, reason: 'when-to-use 为空' };
  return { ok: true, skill: { name, description, whenToUse, body: split.body, raw } };
}

export function renameSkillDocument(raw: string, name: string): string | null {
  if (!isSkillName(name)) return null;
  const split = splitFrontmatter(raw);
  if (!split.closed) return null;
  if (!/^name:\s*.*$/m.test(split.yaml)) return null;
  const yaml = split.yaml.replace(/^name:\s*.*$/m, `name: ${name}`);
  const body = split.body ? `\n${split.body}` : '';
  return `---\n${yaml}\n---${body.endsWith('\n') || body.length === 0 ? body : `${body}\n`}`;
}

/** scripts/、references/ 下的相对路径。拒绝 ..、绝对路径和空段。 */
export function skillSidecarRel(rel: string): { ok: true; parts: string[] } | { ok: false; reason: string } {
  const norm = rel.replace(/\\/g, '/').trim();
  if (!norm) return { ok: false, reason: '旁路路径不完整' };
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return { ok: false, reason: '旁路路径必须是相对路径' };
  const parts = norm.split('/').filter((part) => part.length > 0);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return { ok: false, reason: '旁路路径不能包含 ..' };
  if (parts[0] !== 'scripts' && parts[0] !== 'references') return { ok: false, reason: '旁路文件只能放在 scripts 或 references' };
  if (parts.length < 2) return { ok: false, reason: '旁路路径不完整' };
  return { ok: true, parts };
}

/**
 * 收件箱相对路径 skills/<name>/SKILL.md 或 skills/<name>/(scripts|references)/...
 * 对不上时返回 null，仍由用户选目录。
 */
export function skillLandingFromInboxRel(inboxRel: string): { name: string; parts: string[] } | null {
  const parts = inboxRel.split('/').filter((part) => part.length > 0);
  if (parts[0] !== 'skills' || parts.length < 3) return null;
  if (parts.some((part) => part === '.' || part === '..')) return null;
  const name = parts[1] ?? '';
  if (!isSkillName(name)) return null;
  const rest = parts.slice(2);
  if (rest.length === 1 && rest[0] === 'SKILL.md') return { name, parts: rest };
  if ((rest[0] === 'scripts' || rest[0] === 'references') && rest.length >= 2) return { name, parts: rest };
  return null;
}

const FENCE_LINE = /^(`{3,})([^`]*)$/;
const FENCE_HINT = '代码块没有闭合。正文里的代码围栏请成对书写，或把外层改成更长的围栏';

/** 按围栏长度嵌套。内层没闭合就不要把后文切进 skill。 */
function readFence(lines: readonly string[], start: number): { closed: boolean; next: number; bodyLines: string[] } {
  const open = FENCE_LINE.exec(lines[start] ?? '');
  const stack = [(open?.[1] ?? '```').length];
  const bodyLines: string[] = [];
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const mark = FENCE_LINE.exec(line);
    if (mark) {
      const len = (mark[1] ?? '').length;
      const info = (mark[2] ?? '').trim();
      const top = stack[stack.length - 1] ?? len;
      if (!info && len >= top) {
        stack.pop();
        i += 1;
        if (!stack.length) return { closed: true, next: i, bodyLines };
        bodyLines.push(line);
        continue;
      }
      if (info) {
        stack.push(len);
        bodyLines.push(line);
        i += 1;
        continue;
      }
    }
    bodyLines.push(line);
    i += 1;
  }
  return { closed: false, next: i, bodyLines };
}

function fenceBody(bodyLines: readonly string[]): string {
  if (!bodyLines.length) return '';
  return `${bodyLines.join('\n')}\n`;
}

export function splitDistillPaste(input: string): DistillPasteParts {
  const errors: string[] = [];
  const files: SkillSidecar[] = [];
  let skill: string | null = null;
  let skillCount = 0;
  const lines = input.split(/\r?\n/);
  const summaryLines: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = FENCE_LINE.exec(lines[i] ?? '');
    if (!open) {
      summaryLines.push(lines[i] ?? '');
      i += 1;
      continue;
    }
    const info = (open[2] ?? '').trim().toLowerCase();
    const kind = info === 'skill' || info === 'skill-file' ? info : '';
    const start = i;
    const block = readFence(lines, start);
    if (!block.closed) {
      if (kind) errors.push(`${kind} ${FENCE_HINT}`);
      else summaryLines.push(...lines.slice(start));
      break;
    }
    i = block.next;
    if (!kind) {
      summaryLines.push(...lines.slice(start, block.next));
      continue;
    }
    summaryLines.push('');
    const text = fenceBody(block.bodyLines);
    if (kind === 'skill') {
      skillCount += 1;
      if (skillCount === 1) skill = text;
      else errors.push('一次只能导入一个 skill');
      continue;
    }
    const nl = text.indexOf('\n');
    const rel = (nl === -1 ? text : text.slice(0, nl)).trim();
    const fileBody = nl === -1 ? '' : text.slice(nl + 1);
    files.push({ rel, body: fileBody });
  }
  if (files.length && !skill) errors.push('skill-file 缺少 skill 块');
  if (skillCount > 1) skill = null;
  return { summary: summaryLines.join('\n').trim(), skill, files, errors };
}

export function skillBackupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function normalizeSkillSnapshot(value: readonly { name?: string; description?: string; whenToUse?: string }[] | undefined): SkillSnapshotEntry[] {
  if (!value?.length) return [];
  const out: SkillSnapshotEntry[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    const description = typeof row?.description === 'string' ? row.description.trim() : '';
    const whenToUse = typeof row?.whenToUse === 'string' ? row.whenToUse.trim() : '';
    if (!isSkillName(name) || !description || !whenToUse || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description, whenToUse });
  }
  return out;
}
