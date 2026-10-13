import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createFileOps, type FileOps } from '@kb/fileops';
import { ensureResource, resolveInsideRoot, updateLocation } from '@kb/identity-watch';
import { createPlanService, type PlanService } from '@kb/plan';
import { createWorkbench, rpcCall, startServer } from '../src/index.ts';
import type { RpcCallResult, StartedServer, WorkbenchServices } from '../src/index.ts';

export interface UiPlan {
  plans: PlanService;
  fileOps: FileOps;
  close(): void;
}

/** 测试进程里用 actor ui 调计划库。不走 HTTP。 */
export function openUiPlan(dataDir: string): UiPlan {
  const db = new Database(path.join(dataDir, 'workbench.db'));
  db.pragma('busy_timeout = 5000');
  const fileOps = createFileOps({
    db,
    dataDir,
    resolveInsideRoot,
    ensureResource,
    onMoved(resourceId, before, after) {
      return updateLocation(db, resourceId, before, after);
    },
  });
  const plans = createPlanService({ db, fileOps });
  plans.migrate();
  return {
    plans,
    fileOps,
    close() {
      db.close();
    },
  };
}

export interface Boot {
  base: string;
  rootA: string;
  rootB: string;
  dataDir: string;
  services: WorkbenchServices;
  started: StartedServer;
  writerSecret: string;
  readerSecret: string;
  cleanup(): Promise<void>;
}

export async function boot(): Promise<Boot> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-agent-'));
  const rootA = path.join(base, 'a');
  const rootB = path.join(base, 'b');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootA, 'docs'), { recursive: true });
  fs.mkdirSync(rootB, { recursive: true });
  fs.writeFileSync(path.join(rootA, 'docs', 'hello.txt'), 'hello knowledge base', 'utf8');
  fs.writeFileSync(path.join(rootA, 'docs', 'cn.txt'), '知识库正文', 'utf8');
  fs.writeFileSync(path.join(rootB, 'secret.txt'), 'secret-b-only-zz', 'utf8');
  const services = await createWorkbench({
    dataDir,
    roots: [
      { id: 'root-a', name: 'A', localPath: rootA },
      { id: 'root-b', name: 'B', localPath: rootB },
    ],
  });
  const started = await startServer({
    dataDir,
    services,
    tokens: [
      { name: 'writer', rootIds: ['root-a'], permission: 'readwrite' },
      { name: 'reader', rootIds: ['root-a'], permission: 'read' },
    ],
  });
  const writer = started.tokens.find((token) => token.name === 'writer');
  const reader = started.tokens.find((token) => token.name === 'reader');
  if (!writer || !reader) throw new Error('tokens missing');
  return {
    base,
    rootA,
    rootB,
    dataDir,
    services,
    started,
    writerSecret: writer.secret,
    readerSecret: reader.secret,
    async cleanup() {
      await started.close();
      await services.close();
      await removeTree(base);
    },
  };
}

export function rpcResult<T>(response: RpcCallResult): T {
  const body = response.body as { result?: T; error?: { message?: string } } | null;
  if (response.status !== 200 || !body || body.error) {
    throw new Error(`rpc ${response.status}: ${response.raw}`);
  }
  return body.result as T;
}

export async function call(
  port: number,
  token: string | undefined,
  method: string,
  params?: unknown,
  extra?: { hostHeader?: string; origin?: string },
): Promise<RpcCallResult> {
  return rpcCall({ port, token, method, params, hostHeader: extra?.hostHeader, origin: extra?.origin });
}

export function makeJunction(link: string, target: string): void {
  execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], {
    windowsHide: true,
    stdio: 'pipe',
  });
}

export function lanIpv4(): string[] {
  const found: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      const family = info.family as string | number;
      if ((family === 'IPv4' || family === 4) && !info.internal) found.push(info.address);
    }
  }
  return found;
}

export function tcpConnect(host: string, port: number, timeoutMs = 800): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timeout ${host}:${port}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

export function aclLines(filePath: string): string[] {
  const out = path.join(os.tmpdir(), `kb-acl-${process.pid}-${Date.now()}.txt`);
  const script = `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:KB_ACL_PATH
$lines = New-Object System.Collections.Generic.List[string]
foreach ($ace in $acl.Access) {
  $sid = [string]$ace.IdentityReference.Value
  try { $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  $rights = [int64]$ace.FileSystemRights.value__
  $lines.Add("$sid|$rights|$($ace.AccessControlType)")
}
[System.IO.File]::WriteAllLines($env:KB_ACL_OUT, $lines, (New-Object System.Text.UTF8Encoding $false))
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, KB_ACL_PATH: filePath, KB_ACL_OUT: out },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Get-Acl failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  const text = fs.readFileSync(out, 'utf8');
  fs.rmSync(out, { force: true });
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const READ_DATA = 1n;
const GENERIC_READ = 0x80000000n;
const GENERIC_ALL = 0x10000000n;

export function aceGrantsRead(rightsText: string): boolean {
  let rights = BigInt(rightsText);
  if (rights < 0n) rights = BigInt.asUintN(32, rights);
  return (rights & READ_DATA) !== 0n || (rights & GENERIC_READ) !== 0n || (rights & GENERIC_ALL) !== 0n;
}

export function isEveryoneOrUsers(sid: string): boolean {
  const value = sid.toLowerCase();
  return (
    value === 's-1-1-0' ||
    value === 's-1-5-32-545' ||
    value === 'everyone' ||
    value.endsWith('\\users') ||
    value.endsWith('\\用户') ||
    value === '所有人'
  );
}

export function snapshotFiles(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isFile()) out.set(name, fs.readFileSync(full));
  }
  return out;
}

export function sameSnapshot(left: Map<string, Buffer>, right: Map<string, Buffer>): boolean {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) {
    const other = right.get(name);
    if (!other || !other.equals(bytes)) return false;
  }
  return true;
}

async function removeTree(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
