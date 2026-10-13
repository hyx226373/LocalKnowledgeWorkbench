/** 规划 Electron 运行时如何铺进 launcher/。只读目录，不复制、不启动。 */
import fs from 'node:fs';
import path from 'node:path';
import { LAUNCHER_EXE } from '../shared/layout/names';

export interface RuntimeCopy {
  /** 相对 electron dist */
  from: string;
  /** 相对 launcher/ */
  to: string;
}

export interface LauncherRuntimePlan {
  copies: RuntimeCopy[];
  /** resources/app/package.json 的 main */
  packageMain: string;
  /** 根上的 electron.exe 改名为 kb-launch.exe */
  renameExe: { from: 'electron.exe'; to: typeof LAUNCHER_EXE };
}

const ELECTRON_EXE = 'electron.exe';

function destOf(rel: string): string {
  if (path.dirname(rel) === '.' && path.basename(rel).toLowerCase() === ELECTRON_EXE) return LAUNCHER_EXE;
  return rel;
}

function walk(dir: string, relDir: string, out: RuntimeCopy[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), rel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.toLowerCase() === 'debug.log') continue;
    out.push({ from: rel, to: destOf(rel) });
  }
}

export function planLauncherRuntime(distDir: string): LauncherRuntimePlan {
  const copies: RuntimeCopy[] = [];
  walk(distDir, '', copies);
  copies.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return {
    copies,
    packageMain: 'main.js',
    renameExe: { from: ELECTRON_EXE, to: LAUNCHER_EXE },
  };
}
