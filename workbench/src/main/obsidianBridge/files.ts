/**
 * 收集工作台里的 Markdown。跳过符号链接、点号目录和 .obsidian。
 * 只读出路径。改写时按原路径写回，不删除、不改名。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isMarkdownFile, isObsidianJson, isInside } from '../../shared/obsidianBridge/vault';

export interface WorkbenchRoot {
  path: string;
  kind: 'folder' | 'file';
}

const MAX_FILES = 20000;
const MAX_DEPTH = 40;

export function collectWorkbenchMarkdown(roots: readonly WorkbenchRoot[], forbiddenDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root?.path || out.length >= MAX_FILES) continue;
    const abs = path.resolve(root.path);
    if (root.kind === 'file') {
      consider(abs, forbiddenDirs, out, seen);
      continue;
    }
    walk(abs, forbiddenDirs, out, seen, 0);
  }
  return out;
}

function consider(file: string, forbiddenDirs: readonly string[], out: string[], seen: Set<string>): void {
  if (out.length >= MAX_FILES || seen.has(file)) return;
  if (!isRewritableMarkdown(file, forbiddenDirs)) return;
  seen.add(file);
  out.push(file);
}

export function isRewritableMarkdown(file: string, forbiddenDirs: readonly string[]): boolean {
  const resolved = path.resolve(file);
  if (isObsidianJson(resolved) || !isMarkdownFile(resolved)) return false;
  const parts = resolved.split(path.sep);
  if (parts.some((part) => part === '.obsidian' || part === '.git' || part === 'node_modules' || part === 'lkw-exchange')) return false;
  for (const dir of forbiddenDirs) {
    if (dir && isInside(resolved, dir)) return false;
  }
  return true;
}

function walk(dir: string, forbiddenDirs: readonly string[], out: string[], seen: Set<string>, depth: number): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  if (forbiddenDirs.some((item) => item && isInside(dir, item))) return;
  const base = path.basename(dir);
  if (base === '.obsidian' || base === '.git' || base === 'node_modules' || base === 'lkw-exchange' || base.startsWith('.')) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return;
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, forbiddenDirs, out, seen, depth + 1);
      continue;
    }
    if (entry.isFile()) consider(abs, forbiddenDirs, out, seen);
  }
}
