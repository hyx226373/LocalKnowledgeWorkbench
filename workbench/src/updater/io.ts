/** 生产环境 IO。进程范围只限本次安装根 versions 下的工作台，不碰 D:\\study_dev。 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  handoffFile,
  installPath,
  isUnderStudyDev,
  readCurrent,
  READY_MARKER_FILE,
  READY_SCHEMA,
  stateFile,
  updateLockFile,
  verifyVersionTree,
  writeAtomicJson,
  writeCurrent,
} from '../shared/layout';
import type { SwitchIo } from './machine';

const PROBE_TIMEOUT_MS = 8_000;

export function createSwitchIo(installRoot: string): SwitchIo {
  const logFile = installPath(installRoot, 'updater', 'phase.log');
  const io: SwitchIo = {
    installRoot,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readCurrent: (root) => readCurrent(root),
    writeCurrent: (root, pointer) => writeCurrent(root, pointer),
    readState: async (root) => {
      try {
        return await fs.readFile(stateFile(root), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    writeState: (root, state) => writeAtomicJson(stateFile(root), state, undefined, 'updater/state.json'),
    appendLog: async (line) => {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      await fs.appendFile(logFile, `${line}\n`, 'utf8');
    },
    listAppPids: (root) => listWorkbenchPids(root),
    verify: async (dir) => {
      const electronProc = process as NodeJS.Process & { noAsar?: boolean };
      const prev = electronProc.noAsar;
      electronProc.noAsar = true;
      try {
        return await verifyVersionTree(dir);
      } finally {
        electronProc.noAsar = prev;
      }
    },
    spawnApp: (exe, env) => spawnWorkbench(exe, env),
    waitReady: (userData, version, timeoutMs) => waitForReady(io, userData, version, timeoutMs),
    killSpawned: (pid) => killOne(pid),
    readHandoff: (root) => fs.readFile(handoffFile(root), 'utf8'),
  };
  return io;
}

export async function acquireUpdateLock(installRoot: string): Promise<void> {
  if (isUnderStudyDev(installRoot)) throw new Error('禁止在 D:\\study_dev 下创建更新锁');
  const file = updateLockFile(installRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), 'utf8');
}

export async function readReadyVersion(userData: string): Promise<string | null> {
  if (isUnderStudyDev(userData)) return null;
  try {
    const raw = JSON.parse(await fs.readFile(path.win32.join(userData, READY_MARKER_FILE), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : null;
  } catch {
    return null;
  }
}

async function waitForReady(io: SwitchIo, userData: string, version: string, timeoutMs: number): Promise<{ ok: boolean; version?: string }> {
  if (isUnderStudyDev(userData)) return { ok: false };
  const file = path.win32.join(userData, READY_MARKER_FILE);
  const start = io.now();
  for (;;) {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { schema?: unknown; version?: unknown };
      if (raw.schema === READY_SCHEMA && typeof raw.version === 'string' && raw.version === version) {
        return { ok: true, version: raw.version };
      }
    } catch {
      // 工作台还没写 update-ready.json
    }
    if (io.now() - start >= timeoutMs) return { ok: false };
    await io.sleep(500);
  }
}

function spawnWorkbench(exe: string, env: NodeJS.ProcessEnv): Promise<{ pid: number }> {
  if (isUnderStudyDev(exe)) return Promise.reject(new Error('禁止启动 D:\\study_dev 下的程序'));
  const safe: NodeJS.ProcessEnv = { ...env };
  delete safe.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [], { env: safe, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  if (!child.pid) return Promise.reject(new Error('没有拿到新版进程号'));
  return Promise.resolve({ pid: child.pid });
}

async function killOne(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('进程号不合法');
  try {
    process.kill(pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function listWorkbenchPids(installRoot: string): Promise<number[]> {
  if (isUnderStudyDev(installRoot)) return Promise.reject(new Error('禁止检查 D:\\study_dev 下的进程'));
  const versionsRoot = path.win32.resolve(installRoot, 'versions');
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false',
    "Get-Process -Name 'LocalKnowledgeWorkbench' -ErrorAction SilentlyContinue | ForEach-Object {",
    '  $gone = $false',
    '  try { $gone = $_.HasExited } catch { $gone = $false }',
    '  if ($gone -eq $true) { return }',
    '  $procPath = $null',
    '  try { $procPath = $_.Path } catch {}',
    '  if (-not $procPath) { try { $procPath = $_.MainModule.FileName } catch {} }',
    '  if ($procPath) { Write-Output ($_.Id.ToString() + [char]9 + $procPath) }',
    '}',
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let settled = false;
    const finish = (err: Error | null, ids?: number[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(ids ?? []);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error('检查工作台进程超时'));
    }, PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', () => undefined);
    child.on('error', (err) => finish(err));
    child.on('close', () => {
      try {
        finish(null, filterVersionPids(stdout, versionsRoot));
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

function filterVersionPids(stdout: string, versionsRoot: string): number[] {
  const prefix = versionsRoot.toLowerCase().endsWith('\\') ? versionsRoot.toLowerCase() : `${versionsRoot.toLowerCase()}\\`;
  const ids: number[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const pid = Number(line.slice(0, tab).trim());
    const procPath = line.slice(tab + 1).trim();
    if (!Number.isInteger(pid) || pid <= 0 || !procPath) continue;
    // Amy 本机进程只跳过，不纳入等待列表，也不抛错挡住隔离更新。
    if (isUnderStudyDev(procPath)) continue;
    if (procPath.toLowerCase().startsWith(prefix)) ids.push(pid);
  }
  return ids;
}

