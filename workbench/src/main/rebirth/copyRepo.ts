import fs from 'node:fs';
import path from 'node:path';
import { isLocalKnowledgeUserData } from '../../shared/aiWriteChannel';

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 把仓库整套复制到新地址：正文、封面、目录、index.json、membership.json、file-tags.json（若有）、selection.json。
 * 不复制控制根的 settings.json。不删除、不改写旧地址。
 */
export function copyAgentRepoSet(fromDir: string, toDir: string): string[] {
  const from = path.resolve(fromDir);
  const to = path.resolve(toDir);
  if (from === to) return [];
  if (isInside(from, to)) throw new Error('新位置不能在原目录内');
  if (isInside(to, from)) throw new Error('新位置不能包含原目录');
  if (isLocalKnowledgeUserData(to)) throw new Error('新位置不能在 LocalKnowledgeWorkbench 用户目录里');
  // review-fix：先列出要复制的文件，新位置已有同名但内容不同的文件就整体拒绝，绝不覆盖用户文件。
  const plan: string[] = [];
  const dirs: string[] = [];
  const conflicts: string[] = [];
  const collect = (rel: string): void => {
    const src = rel ? path.join(from, rel) : from;
    let st: fs.Stats;
    try { st = fs.lstatSync(src); } catch { return; }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      const base = path.basename(src);
      if (rel && (base.startsWith('~') || base === '_out')) return;
      if (rel) dirs.push(rel);
      for (const name of fs.readdirSync(src)) {
        if (name.startsWith('~') || name.endsWith('~') || name.endsWith('.tmp')) continue;
        collect(rel ? path.join(rel, name) : name);
      }
      return;
    }
    if (!st.isFile()) return;
    if (path.basename(src) === 'settings.json' && !rel.includes(path.sep)) return;
    const dest = path.join(to, rel);
    let dst: fs.Stats | null = null;
    try { dst = fs.lstatSync(dest); } catch { dst = null; }
    if (dst) {
      if (!dst.isFile() || !fs.readFileSync(dest).equals(fs.readFileSync(src))) conflicts.push(rel.split(path.sep).join('/'));
      return; // 内容相同：已经在了，跳过
    }
    plan.push(rel);
  };
  collect('');
  if (conflicts.length) throw new Error(`新位置已有同名文件，未复制任何内容：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? ` 等 ${conflicts.length} 个` : ''}`);
  fs.mkdirSync(to, { recursive: true });
  for (const rel of dirs) fs.mkdirSync(path.join(to, rel), { recursive: true });
  const copied: string[] = [];
  for (const rel of plan) {
    const dest = path.join(to, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(from, rel), dest, fs.constants.COPYFILE_EXCL);
    copied.push(rel.split(path.sep).join('/'));
  }
  return copied;
}
