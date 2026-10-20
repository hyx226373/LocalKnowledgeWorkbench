/**
 * 库路径判断。不读盘上的 obsidian.json，也不把正式用户库当成库。
 */
import path from 'node:path';
import { DEFAULT_RELAY_VAULT_NAME } from './types';

export function defaultRelayVaultDir(env: NodeJS.ProcessEnv = process.env, home = ''): string {
  const fromEnv = env.LKW_RELAY_VAULT || env.LKW_RELAY_VAULT_DIR;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  const base = home || env.USERPROFILE || env.HOME || '';
  if (!base) return path.resolve(DEFAULT_RELAY_VAULT_NAME);
  return path.join(base, DEFAULT_RELAY_VAULT_NAME);
}

/** %LOCALAPPDATA%\LocalKnowledgeWorkbench。没有 LOCALAPPDATA 时返回 null。 */
export function officialWorkbenchDataDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const local = env.LOCALAPPDATA;
  if (!local || !String(local).trim()) return null;
  return path.resolve(String(local), 'LocalKnowledgeWorkbench');
}

export function isOfficialWorkbenchData(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const official = officialWorkbenchDataDir(env);
  if (!official || !dir) return false;
  return isInside(path.resolve(dir), official);
}

export function isInside(file: string, dir: string): boolean {
  const target = path.resolve(file);
  const root = path.resolve(dir);
  const left = process.platform === 'win32' ? target.toLowerCase() : target;
  const right = process.platform === 'win32' ? root.toLowerCase() : root;
  return left === right || left.startsWith(right + path.sep);
}

/**
 * 桥自己的偏移和设置。正式用户库不写。
 * 测试把 userDataDir 指到临时目录（KB_USER_DATA）时，状态就在那个目录下。
 */
export function bridgeStateDir(userDataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isOfficialWorkbenchData(userDataDir, env)) {
    const home = env.USERPROFILE || env.HOME || '';
    if (!home) throw new Error('拒绝写入 LocalKnowledgeWorkbench 正式用户库');
    const redirected = path.join(path.resolve(home), '.lkw-obsidian-bridge');
    if (isOfficialWorkbenchData(redirected, env)) throw new Error('拒绝写入 LocalKnowledgeWorkbench 正式用户库');
    return redirected;
  }
  const dir = path.join(path.resolve(userDataDir), 'obsidian-bridge');
  if (isOfficialWorkbenchData(dir, env)) throw new Error('拒绝写入 LocalKnowledgeWorkbench 正式用户库');
  return dir;
}

export function isMarkdownFile(file: string): boolean {
  const base = path.basename(file).toLowerCase();
  return base.endsWith('.md') || base.endsWith('.markdown');
}

export function isObsidianJson(file: string): boolean {
  return path.basename(file).toLowerCase() === 'obsidian.json';
}

export interface VaultHit {
  vaultRoot: string;
  vaultName: string;
  relPath: string;
}

export type OpenClass =
  | { kind: 'refuse'; message: string }
  | { kind: 'vault'; hit: VaultHit }
  | { kind: 'relay' };

/**
 * 文件已经在某个 Obsidian 库里（祖先目录有 .obsidian）时直接打开。
 * 在 .obsidian 里面、或落在正式用户库里，则拒绝，不走中转。
 */
export function classifyMarkdownOpen(
  filePath: string,
  env: NodeJS.ProcessEnv,
  isDirectory: (abs: string) => boolean,
): OpenClass {
  const file = path.resolve(filePath);
  if (isObsidianJson(file)) return { kind: 'refuse', message: '拒绝打开 obsidian.json' };
  if (!isMarkdownFile(file)) return { kind: 'refuse', message: '只有 Markdown 可以在 Obsidian 打开' };
  if (isOfficialWorkbenchData(file, env) || pathSegments(file).includes('LocalKnowledgeWorkbench')) {
    return { kind: 'refuse', message: '拒绝打开 LocalKnowledgeWorkbench 里的文件' };
  }
  const hit = findVaultForFile(file, isDirectory);
  if (!hit) return { kind: 'relay' };
  if (hit.relPath.split('/').includes('.obsidian')) {
    return { kind: 'refuse', message: '这个文件在库的配置目录里，不能打开' };
  }
  return { kind: 'vault', hit };
}

export function findVaultForFile(filePath: string, isDirectory: (abs: string) => boolean): VaultHit | null {
  const file = path.resolve(filePath);
  let dir = path.dirname(file);
  const stop = path.parse(dir).root;
  for (;;) {
    if (isDirectory(path.join(dir, '.obsidian'))) {
      const rel = path.relative(dir, file).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) return null;
      return { vaultRoot: dir, vaultName: path.basename(dir), relPath: rel };
    }
    if (dir === stop) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function pathSegments(file: string): string[] {
  return path.resolve(file).split(path.sep).filter(Boolean);
}

export function assertRelayVaultDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = path.resolve(dir);
  if (isObsidianJson(resolved)) throw new Error('拒绝把 obsidian.json 当成中转库');
  if (isOfficialWorkbenchData(resolved, env) || pathSegments(resolved).includes('LocalKnowledgeWorkbench')) {
    throw new Error('中转库不能放在 LocalKnowledgeWorkbench 里');
  }
  return resolved;
}

/** 插件 data.json 里的交换目录名。缺省或非法时用 lkw-exchange。 */
export function exchangeDirName(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'lkw-exchange';
  const name = (parsed as { exchangeDir?: unknown }).exchangeDir;
  if (typeof name !== 'string') return 'lkw-exchange';
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('.') || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return 'lkw-exchange';
  }
  return trimmed;
}

export function readJunctionFlag(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return (parsed as { crossVolumeJunction?: unknown }).crossVolumeJunction === true;
}

export function bridgeToolCandidates(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string[] {
  const out: string[] = [];
  const fromEnv = env.LKW_BRIDGE_TOOLS;
  if (fromEnv && String(fromEnv).trim()) out.push(path.resolve(String(fromEnv).trim()));
  out.push(
    path.resolve(cwd, '../../ob-plugin/lkw-bridge/tools'),
    path.resolve(cwd, '../ob-plugin/lkw-bridge/tools'),
    path.resolve(cwd, 'ob-plugin/lkw-bridge/tools'),
  );
  return out;
}

export function resolveBridgeToolsDir(
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = () => false,
  cwd = process.cwd(),
): string {
  for (const dir of bridgeToolCandidates(env, cwd)) {
    if (exists(path.join(dir, 'relay-core.mjs')) && exists(path.join(dir, 'make-uri.mjs'))) return dir;
  }
  throw new Error('找不到工作台桥工具（relay-core）。请设置 LKW_BRIDGE_TOOLS 指向插件的 tools 目录。');
}
