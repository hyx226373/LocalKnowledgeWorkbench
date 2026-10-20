/**
 * <agent-data>/skills 的扫描和落盘。
 * 不合格的留在原地。覆盖前把旧目录复制到 ai-write/backups/skills/<name>/<时间>/。
 * 不删除用户文件，不跟随符号链接。
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteText, isInside } from '../agentPanel/fsio';
import { isSkillName } from '../../shared/skillDistill';
import { isLocalKnowledgeUserData } from '../../shared/aiWriteChannel';
import {
  SKILL_FILE_MAX,
  SKILL_TOTAL_MAX,
  frontmatterHasSkillMarker,
  parseSkillDocument,
  renameSkillDocument,
  skillBackupStamp,
  skillSidecarRel,
  type MisplacedSkill,
  type ReadySkill,
  type SkillLibraryView,
  type SkillProblem,
  type SkillSidecar,
} from '../../shared/skillLibrary';

export interface SkillWriteResult {
  ok: true;
  name: string;
  overwritten: boolean;
  dir: string;
}

export interface SkillWriteFailure {
  ok: false;
  reason: string;
  name?: string;
  conflict?: boolean;
}

function skipName(name: string): boolean {
  return name === '.' || name === '..' || name.startsWith('~') || name.endsWith('~') || name.endsWith('.tmp');
}

function readRegular(file: string): string | null {
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    if (st.size > SKILL_FILE_MAX) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walkFiles(dir: string, visit: (file: string, st: fs.Stats) => void): { symlink: boolean } {
  let symlink = false;
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { symlink };
  }
  for (const name of names) {
    if (skipName(name)) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      symlink = true;
      continue;
    }
    if (st.isDirectory()) {
      if (walkFiles(file, visit).symlink) symlink = true;
      continue;
    }
    if (st.isFile()) visit(file, st);
  }
  return { symlink };
}

function sidecarProblems(dir: string): string | null {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return '无法读取 skill 目录';
  }
  let total = 0;
  for (const name of names) {
    if (skipName(name)) continue;
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
    } catch {
      return '无法读取 skill 目录';
    }
    if (st.isSymbolicLink()) return '不允许符号链接';
    if (st.isFile()) {
      if (name !== 'SKILL.md') return '旁路文件只能放在 scripts 或 references';
      if (st.size > SKILL_FILE_MAX) return '超过 256KB';
      total += st.size;
      continue;
    }
    if (!st.isDirectory() || (name !== 'scripts' && name !== 'references')) return '旁路文件只能放在 scripts 或 references';
    let bad: string | null = null;
    const walked = walkFiles(file, (child, childSt) => {
      const rel = path.relative(dir, child).split(path.sep).join('/');
      const check = skillSidecarRel(rel);
      if (!check.ok) bad = check.reason;
      else if (childSt.size > SKILL_FILE_MAX) bad = '超过 256KB';
      else total += childSt.size;
    });
    if (walked.symlink) return '不允许符号链接';
    if (bad) return bad;
  }
  if (total > SKILL_TOTAL_MAX) return 'skill 合计超过 1MB';
  return null;
}

export function scanSkillLibrary(skillsRoot: string): { ready: ReadySkill[]; pending: SkillProblem[] } {
  const ready: ReadySkill[] = [];
  const pending: SkillProblem[] = [];
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(skillsRoot);
  } catch {
    return { ready, pending };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { ready, pending };
  let names: string[] = [];
  try {
    names = fs.readdirSync(skillsRoot);
  } catch {
    return { ready, pending };
  }
  names.sort((a, b) => a.localeCompare(b, 'en'));
  for (const name of names) {
    if (skipName(name)) continue;
    const dir = path.join(skillsRoot, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(dir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    const skillFile = path.join(dir, 'SKILL.md');
    let skillStat: fs.Stats;
    try {
      skillStat = fs.lstatSync(skillFile);
    } catch {
      continue;
    }
    if (skillStat.isSymbolicLink()) {
      pending.push({ name, reason: '不允许符号链接' });
      continue;
    }
    if (!skillStat.isFile()) continue;
    if (skillStat.size > SKILL_FILE_MAX) {
      pending.push({ name, reason: '超过 256KB' });
      continue;
    }
    const text = readRegular(skillFile);
    if (text === null) {
      pending.push({ name, reason: '无法读取 SKILL.md' });
      continue;
    }
    const parsed = parseSkillDocument(text, name);
    if (!parsed.ok) {
      pending.push({ name, reason: parsed.reason });
      continue;
    }
    const side = sidecarProblems(dir);
    if (side) {
      pending.push({ name, reason: side });
      continue;
    }
    ready.push({ name: parsed.skill.name, description: parsed.skill.description, whenToUse: parsed.skill.whenToUse });
  }
  return { ready, pending };
}

export function scanMisplacedSkills(root: string): MisplacedSkill[] {
  const out: MisplacedSkill[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipName(entry.name) || entry.name === '_quarantine' || entry.name === '_out') continue;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (entry.name === 'SKILL.md') {
        out.push({ rel, reason: '文件名是 SKILL.md' });
        continue;
      }
      const text = readRegular(file);
      if (text && frontmatterHasSkillMarker(text)) out.push({ rel, reason: '文件头含 lkw: skill/1' });
    }
  };
  visit(root);
  return out;
}

export function skillLibraryView(dataDir: string, rebirthRoot: string): SkillLibraryView {
  const scanned = scanSkillLibrary(path.join(dataDir, 'skills'));
  return { ready: scanned.ready, pending: scanned.pending, misplaced: scanMisplacedSkills(rebirthRoot) };
}

export function readSkillText(dataDir: string, name: string): string | null {
  const file = path.join(dataDir, 'skills', name, 'SKILL.md');
  const root = path.resolve(dataDir, 'skills', name);
  if (!isInside(root, path.resolve(file))) return null;
  return readRegular(file);
}

function copyTree(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    if (skipName(name)) continue;
    const from = path.join(src, name);
    const st = fs.lstatSync(from);
    if (st.isSymbolicLink()) continue;
    const to = path.join(dest, name);
    if (!isInside(dest, to)) continue;
    if (st.isDirectory()) copyTree(from, to);
    else if (st.isFile()) fs.copyFileSync(from, to);
  }
}

export function backupSkillDirectory(srcDir: string, backupRoot: string, name: string, now: Date): string {
  const stamp = skillBackupStamp(now);
  let dest = path.join(backupRoot, 'backups', 'skills', name, stamp);
  let n = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(backupRoot, 'backups', 'skills', name, `${stamp}-${n}`);
    n += 1;
  }
  copyTree(srcDir, dest);
  return dest;
}

function dirOccupied(dir: string): boolean {
  try {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) return true;
    if (!st.isDirectory()) return true;
    return fs.readdirSync(dir).some((name) => !skipName(name));
  } catch {
    return false;
  }
}

function assertCleanDest(skillDir: string, file: string): void {
  if (!isInside(skillDir, file)) throw new Error('旁路路径不能包含 ..');
  let cursor = path.resolve(skillDir);
  const rest = path.relative(cursor, file).split(path.sep).filter(Boolean);
  for (let i = 0; i < rest.length; i += 1) {
    cursor = path.join(cursor, rest[i] ?? '');
    if (!fs.existsSync(cursor)) return;
    const st = fs.lstatSync(cursor);
    if (st.isSymbolicLink()) throw new Error('不允许符号链接');
    if (i < rest.length - 1 && !st.isDirectory()) throw new Error('技能库路径异常');
  }
}

export function projectedSkillBytes(skillDir: string, replacements: readonly { file: string; size: number }[]): number {
  const replaced = new Set(replacements.map((item) => path.resolve(item.file)));
  let total = replacements.reduce((sum, item) => sum + item.size, 0);
  if (!fs.existsSync(skillDir)) return total;
  const st = fs.lstatSync(skillDir);
  if (st.isSymbolicLink() || !st.isDirectory()) return total;
  walkFiles(skillDir, (file, stat) => {
    if (replaced.has(path.resolve(file))) return;
    total += stat.size;
  });
  return total;
}

export function writeSkillLibrary(
  dataDir: string,
  raw: string,
  files: readonly SkillSidecar[],
  opts?: { overwrite?: boolean; rename?: string; now?: () => Date },
): SkillWriteResult | SkillWriteFailure {
  const renamed = opts?.rename ? renameSkillDocument(raw, opts.rename) : raw;
  if (opts?.rename && !renamed) return { ok: false, reason: 'name 不合法', name: opts.rename };
  const source = renamed ?? raw;
  const parsed = parseSkillDocument(source, opts?.rename);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  const name = opts?.rename ?? parsed.skill.name;
  if (opts?.rename && parsed.skill.name !== opts.rename) return { ok: false, reason: 'name 与目录不一致', name };
  const sidecars: { parts: string[]; body: string }[] = [];
  for (const file of files) {
    const check = skillSidecarRel(file.rel);
    if (!check.ok) return { ok: false, reason: check.reason, name };
    const bytes = Buffer.byteLength(file.body);
    if (bytes > SKILL_FILE_MAX) return { ok: false, reason: '超过 256KB', name };
    sidecars.push({ parts: check.parts, body: file.body });
  }
  const skillBytes = Buffer.byteLength(source);
  if (skillBytes > SKILL_FILE_MAX) return { ok: false, reason: '超过 256KB', name };
  const skillDir = path.resolve(dataDir, 'skills', name);
  const skillsRoot = path.resolve(dataDir, 'skills');
  if (!isInside(skillsRoot, skillDir)) return { ok: false, reason: 'name 不合法', name };
  // 落盘前再拦一次：技能库不能落进 LocalKnowledgeWorkbench 用户目录。
  if (isLocalKnowledgeUserData(skillDir)) return { ok: false, reason: '不能写入 LocalKnowledgeWorkbench 用户目录', name };
  try {
    if (fs.existsSync(skillsRoot) && (fs.lstatSync(skillsRoot).isSymbolicLink() || !fs.lstatSync(skillsRoot).isDirectory())) {
      return { ok: false, reason: '不允许符号链接', name };
    }
  } catch {
    return { ok: false, reason: '无法读取 skill 目录', name };
  }
  const skillFile = path.join(skillDir, 'SKILL.md');
  const planned = [{ file: skillFile, size: skillBytes }, ...sidecars.map((item) => ({ file: path.resolve(skillDir, ...item.parts), size: Buffer.byteLength(item.body) }))];
  if (planned.some((item) => !isInside(skillDir, item.file))) return { ok: false, reason: '旁路路径不能包含 ..', name };
  try {
    if (fs.existsSync(skillDir) && fs.lstatSync(skillDir).isSymbolicLink()) return { ok: false, reason: '不允许符号链接', name };
    for (const item of planned) assertCleanDest(skillDir, item.file);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), name };
  }
  const occupied = dirOccupied(skillDir);
  if (occupied && opts?.overwrite !== true) {
    return { ok: false, reason: '已有同名 skill，请选择覆盖或另起名', name, conflict: true };
  }
  if (projectedSkillBytes(skillDir, planned) > SKILL_TOTAL_MAX) return { ok: false, reason: 'skill 合计超过 1MB', name };
  if (occupied && opts?.overwrite === true) backupSkillDirectory(skillDir, path.join(dataDir, 'ai-write'), name, opts.now?.() ?? new Date());
  fs.mkdirSync(skillDir, { recursive: true });
  atomicWriteText(skillFile, source.endsWith('\n') ? source : `${source}\n`);
  for (const item of sidecars) {
    const dest = path.join(skillDir, ...item.parts);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    atomicWriteText(dest, item.body);
  }
  return { ok: true, name, overwritten: occupied, dir: skillDir };
}

/** 绝对路径是否落在 <agent-data>/skills/<name>/ 的允许文件上。 */
export function locateSkillFile(agentData: string, abs: string): { name: string; rel: string } | null {
  const root = path.resolve(agentData, 'skills');
  const target = path.resolve(abs);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep).filter((part) => part.length > 0);
  const name = parts[0] ?? '';
  if (!isSkillName(name)) return null;
  const rest = parts.slice(1);
  if (rest.some((part) => part === '.' || part === '..')) return null;
  if (rest.length === 1 && rest[0] === 'SKILL.md') return { name, rel: parts.join('/') };
  if ((rest[0] === 'scripts' || rest[0] === 'references') && rest.length >= 2) return { name, rel: parts.join('/') };
  return null;
}

export function skillDestAllowed(agentData: string, abs: string): boolean {
  const located = locateSkillFile(agentData, abs);
  if (!located) return false;
  const skillsRoot = path.resolve(agentData, 'skills');
  const skillDir = path.resolve(skillsRoot, located.name);
  const file = path.resolve(abs);
  try {
    if (fs.existsSync(skillsRoot)) {
      const rootStat = fs.lstatSync(skillsRoot);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    }
    if (fs.existsSync(skillDir)) {
      const dirStat = fs.lstatSync(skillDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    }
    assertCleanDest(skillDir, file);
    return isInside(skillDir, file);
  } catch {
    return false;
  }
}

export function loadSkillSnapshot(dataDir: string): { skillDistill?: true; skills?: { name: string; description: string; whenToUse: string }[] } {
  let skillDistill = false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'rebirth', 'settings.json'), 'utf8')) as { skillDistill?: unknown };
    skillDistill = settings.skillDistill === true;
  } catch {
    skillDistill = false;
  }
  const skills = scanSkillLibrary(path.join(dataDir, 'skills')).ready.map((row) => ({
    name: row.name,
    description: row.description,
    whenToUse: row.whenToUse,
  }));
  return {
    ...(skillDistill ? { skillDistill: true as const } : {}),
    ...(skills.length ? { skills } : {}),
  };
}

export function assertIncomingSkillSize(agentData: string, abs: string, next: Buffer): void {
  if (next.length > SKILL_FILE_MAX) throw new Error('skill 超过大小限制');
  const located = locateSkillFile(agentData, abs);
  if (!located) throw new Error('不能写回 agent-data');
  const skillDir = path.resolve(agentData, 'skills', located.name);
  const total = projectedSkillBytes(skillDir, [{ file: path.resolve(abs), size: next.length }]);
  if (total > SKILL_TOTAL_MAX) throw new Error('skill 超过大小限制');
}

export { SKILL_FILE_MAX, SKILL_TOTAL_MAX };
