import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { atomicWriteText, readText } from './fsio';

/** 应用目录下的数据文件夹名。正式版即 <exe 目录>/agent-data。 */
export const AGENT_DATA_DIR_NAME = 'agent-data';
export const LOCATION_FILE = 'location.json';

export interface ResolvedAgentData {
  root: string;
  /** location.json 所在目录。KB_AGENT_DATA 覆盖时为 null，设置不能改位置。 */
  anchor: string | null;
  source: 'env' | 'location' | 'default';
}

interface ElectronAppLike {
  isPackaged?: boolean;
  getPath?: (name: string) => string;
  getAppPath?: () => string;
}

/**
 * 安装目录。
 * 打包：exe 所在目录。开发：app.getAppPath()。
 * 数据进程没有 app 时，由主进程经 KB_APP_DIR 传入。
 */
export function appInstallDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env.KB_APP_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const app = tryElectronApp();
  if (!app?.getAppPath || !app.getPath) return null;
  try {
    if (app.isPackaged) return path.dirname(app.getPath('exe'));
    return app.getAppPath();
  } catch {
    return null;
  }
}

export function defaultAgentDataDir(appDir: string): string {
  return path.join(appDir, AGENT_DATA_DIR_NAME);
}

/** 读 <appDir>/agent-data/location.json。没有或 dir 为空则返回 null。 */
export function readLocationDir(anchorDir: string): string | null {
  const text = readText(path.join(anchorDir, LOCATION_FILE));
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { v?: unknown; dir?: unknown };
    if (!parsed || parsed.v !== 1) return null;
    if (typeof parsed.dir !== 'string' || !parsed.dir.trim()) return null;
    return path.resolve(parsed.dir);
  } catch {
    return null;
  }
}

export function writeLocationDir(anchorDir: string, dir: string | null): void {
  const payload = { v: 1 as const, dir: dir ? path.resolve(dir) : null };
  atomicWriteText(path.join(anchorDir, LOCATION_FILE), `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * KB_AGENT_DATA 优先（测试用，忽略 location.json）。
 * 否则用应用目录 agent-data；若 location.json 指了别的目录，用那个目录。
 * 没有 Electron app 时以当前应用目录为基准，始终创建目录。
 */
export function resolveAgentDataRoot(env: NodeJS.ProcessEnv = process.env): ResolvedAgentData | null {
  const override = env.KB_AGENT_DATA?.trim();
  if (override) return ensure({ root: path.resolve(override), anchor: null, source: 'env' });
  const appDir = appInstallDir(env);
  if (!appDir) return ensure({root:defaultAgentDataDir(process.cwd()),anchor:defaultAgentDataDir(process.cwd()),source:'default'});
  const anchor = defaultAgentDataDir(appDir);
  const chosen = readLocationDir(anchor);
  if (!chosen) return ensure({ root: anchor, anchor, source: 'default' });
  if (fs.existsSync(chosen) && !fs.statSync(chosen).isDirectory()) {
    return ensure({ root: anchor, anchor, source: 'default' });
  }
  return ensure({ root: chosen, anchor, source: 'location' });
}

function tryElectronApp(): ElectronAppLike | null {
  try {
    const req = createRequire(import.meta.url);
    const electron = req('electron') as { app?: ElectronAppLike } | string;
    if (!electron || typeof electron === 'string' || !electron.app) return null;
    const app = electron.app;
    if (typeof app.getAppPath !== 'function' || typeof app.getPath !== 'function') return null;
    return app;
  } catch {
    return null;
  }
}

function ensure(value:ResolvedAgentData):ResolvedAgentData {fs.mkdirSync(value.root,{recursive:true});return value;}
