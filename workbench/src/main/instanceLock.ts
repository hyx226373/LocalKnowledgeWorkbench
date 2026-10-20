/**
 * 按用户数据目录加锁，不使用 Electron 的全局单实例锁（开发用的 electron 会和已装程序撞车）。
 * 锁上的 pid 已经退出时，结束它留下的 electron / node 子进程，以及这个目录登记过的子进程。
 * 渲染、GPU、网络服务不在登记名单里，但会占着缓存和 modules 库；不结束它们，下一次开窗会等大约 30 秒。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setOwnedPidFile } from './ownedPids';

export interface ProcRow {
  pid: number;
  ppid: number;
  name: string;
  image: string;
  command: string;
}

const INSTALLED = /example_dev[\\/]+LocalKnowledgeWorkbench/i;

export function isOwnerLiveDataDir(dataDir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const local = env.LOCALAPPDATA;
  if (!local) return false;
  const user = path.resolve(local, 'LocalKnowledgeWorkbench');
  return path.resolve(dataDir).toLowerCase() === user.toLowerCase();
}

/** 已安装的工作台。命令行或镜像路径对上就跳过，避免误伤正在运行的正式程序。 */
export function isProtectedInstall(row: ProcRow): boolean {
  const ident = `${row.name}\n${row.image}\n${row.command}`;
  if (/LocalKnowledgeWorkbench\.exe/i.test(row.name) || /LocalKnowledgeWorkbench\.exe/i.test(row.image)) {
    if (INSTALLED.test(ident)) return true;
  }
  return INSTALLED.test(ident);
}

/**
 * 上次进程是被杀掉的：这次不要再搬 GPU/HTTP 磁盘缓存。不要改走进程内 GPU。
 * 活着的实例、没有锁、以及已安装数据目录都不走这条路径。
 */
export function restartSkipsDiskCache(dataDir: string, selfPid = process.pid): boolean {
  if (isOwnerLiveDataDir(dataDir)) return false;
  let holder = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.lock'), 'utf8')) as { pid?: number };
    if (typeof parsed.pid === 'number') holder = parsed.pid;
  } catch {
    return false;
  }
  if (!holder || holder === selfPid) return false;
  return !alive(holder);
}

export function shouldReapProcess(
  row: ProcRow,
  opts: { selfPid: number; recorded: boolean; childOfDead: boolean; ownExeName: string },
): boolean {
  if (!row.pid || row.pid === opts.selfPid) return false;
  const own = opts.ownExeName.toLowerCase();
  const name = row.name.toLowerCase();
  const imageBase = path.basename(row.image || '').toLowerCase();
  if (opts.childOfDead && (imageBase === own || name === own) && own.endsWith('.exe')) return true;
  if (isProtectedInstall(row)) return false;
  if (opts.childOfDead && (name === 'electron.exe' || name === 'node.exe')) return true;
  if (!opts.recorded) return false;
  if (!row.command && !row.image) return false;
  return true;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

interface LockBody {
  pid?: number;
  exiting?: boolean;
  at?: string;
}

function readLock(dataDir: string): LockBody | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.lock'), 'utf8')) as LockBody;
  } catch {
    return null;
  }
}

const waitedDirs = new Set<string>();

function dirKey(dataDir: string): string {
  return path.resolve(dataDir).toLowerCase();
}

/** 正常退出一开始就标上。新实例只对这个标记做短等，活着且没在退出的实例仍然立刻让开。 */
export function markInstanceExiting(dataDir: string): void {
  const lockFile = path.join(dataDir, 'instance.lock');
  try {
    const parsed = readLock(dataDir);
    if (!parsed || parsed.pid !== process.pid) return;
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, exiting: true, at: parsed.at ?? new Date().toISOString() }));
  } catch {
    /* 没有锁 */
  }
}

/**
 * 锁的进程还活着、并且已经标了正在退出：阻塞最多 maxMs，等它死掉。
 * 返回 true 表示现在没有活着的持有者。没在退出的活进程立刻返回 false，不等。
 * 同一个目录只等这一次，后面的 acquireInstance 不再加等。
 */
/** 旧实例正在退出时，新实例最多等这么久，然后按收割规则处理。 */
export const EXITING_WAIT_MS = 1000;

export function waitIfHolderExits(dataDir: string, maxMs = EXITING_WAIT_MS): boolean {
  waitedDirs.add(dirKey(dataDir));
  const parsed = readLock(dataDir);
  const holder = typeof parsed?.pid === 'number' ? parsed.pid : 0;
  if (!holder || holder === process.pid || !alive(holder)) return true;
  if (parsed?.exiting !== true) return false;
  const deadline = Date.now() + maxMs;
  while (alive(holder) && Date.now() < deadline) sleepSync(40);
  return !alive(holder);
}

function helperExe(): string | null {
  const candidates = [
    path.join(__dirname, 'reap-orphans.exe'),
    path.join(__dirname, '../../out/main/reap-orphans.exe'),
    path.join(process.cwd(), 'out/main/reap-orphans.exe'),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function parseRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const pid = Number(parts[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    rows.push({
      pid,
      ppid: Number(parts[1]) || 0,
      name: parts[2] || '',
      image: parts[3] || '',
      command: parts.slice(4).join('\t'),
    });
  }
  return rows;
}

function runHelper(exe: string, args: string[]): Promise<ProcRow[] | null> {
  return new Promise((resolve) => {
    execFile(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(parseRows(String(stdout || '')));
    });
  });
}

function decodeProcessText(stdout: Buffer | string): string {
  const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.includes(0)) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  return buf.toString('utf8');
}

function parseWmic(text: string, pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  let command = '';
  let pid = 0;
  const flush = () => {
    if (pids.includes(pid)) out.set(pid, command);
    command = '';
    pid = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (line.startsWith('CommandLine=')) command = line.slice('CommandLine='.length);
    else if (line.startsWith('ProcessId=')) pid = Number(line.slice('ProcessId='.length));
  }
  flush();
  return out;
}

/** 辅助程序缺失时才走 wmic。只用于登记过的 pid，读不到命令行就不杀。 */
function commandLines(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (process.platform !== 'win32' || pids.length === 0) return Promise.resolve(out);
  const where = pids.map((pid) => `ProcessId=${pid}`).join(' or ');
  return new Promise((resolve) => {
    execFile(
      'wmic.exe',
      ['process', 'where', where, 'get', 'ProcessId,CommandLine', '/value'],
      { encoding: 'buffer', windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (!err) {
          resolve(parseWmic(decodeProcessText(stdout), pids));
          return;
        }
        const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
        execFile(
          'powershell.exe',
          ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { $_.ProcessId.ToString() + [char]9 + [string]$_.CommandLine }`],
          { encoding: 'utf8', windowsHide: true, timeout: 8000 },
          (psErr, psOut) => {
            if (!psErr) {
              for (const line of String(psOut).split(/\r?\n/)) {
                const tab = line.indexOf('\t');
                if (tab <= 0) continue;
                const pid = Number(line.slice(0, tab));
                if (pids.includes(pid)) out.set(pid, line.slice(tab + 1));
              }
            }
            resolve(out);
          },
        );
      },
    );
  });
}

function readRecorded(dataDir: string): number[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataDir, 'child-pids.json'), 'utf8')) as { pids?: number[] };
    return Array.isArray(parsed.pids) ? parsed.pids.filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function describe(holder: number, recorded: number[]): Promise<{ rows: ProcRow[]; descendants: Set<number>; via: 'helper' | 'wmic' | 'none' }> {
  const exe = process.platform === 'win32' ? helperExe() : null;
  if (exe) {
    const fromParent = holder > 0 ? await runHelper(exe, ['children', String(holder)]) : [];
    if (fromParent) {
      const known = new Set(fromParent.map((row) => row.pid));
      const missing = recorded.filter((pid) => pid !== process.pid && !known.has(pid) && alive(pid));
      const extra = missing.length > 0 ? await runHelper(exe, ['query', ...missing.map(String)]) : [];
      return { rows: [...fromParent, ...(extra ?? [])], descendants: known, via: 'helper' };
    }
  }
  const lines = await commandLines(recorded.filter((pid) => alive(pid)));
  const rows: ProcRow[] = [];
  for (const [pid, command] of lines) {
    rows.push({ pid, ppid: 0, name: '', image: '', command });
  }
  return { rows, descendants: new Set<number>(), via: 'wmic' };
}

export async function reapRecordedChildren(dataDir: string, holder = 0): Promise<number[]> {
  if (isOwnerLiveDataDir(dataDir)) return [];
  const recorded = readRecorded(dataDir);
  const recordedSet = new Set(recorded);
  const described = await describe(holder, recorded);
  const ownExeName = path.basename(process.execPath);
  const killed: number[] = [];
  for (const row of described.rows) {
    if (!alive(row.pid)) continue;
    if (!shouldReapProcess(row, {
      selfPid: process.pid,
      recorded: recordedSet.has(row.pid),
      childOfDead: described.descendants.has(row.pid),
      ownExeName,
    })) continue;
    try {
      process.kill(row.pid);
      killed.push(row.pid);
    } catch {
      /* 已经退出 */
    }
  }
  const deadline = Date.now() + 800;
  for (const pid of killed) {
    while (alive(pid) && Date.now() < deadline) await pause(20);
  }
  try {
    fs.rmSync(path.join(dataDir, 'child-pids.json'), { force: true });
  } catch {
    /* 下次启动再清 */
  }
  const stallFile = process.env.KB_STALL_LOG;
  if (stallFile) {
    try {
      fs.appendFileSync(stallFile, `${new Date().toISOString()} reap via=${described.via} holder=${holder} recorded=${recorded.join(',') || '-'} killed=${killed.join(',') || '-'}\n`);
    } catch {
      /* 诊断日志写失败不影响启动 */
    }
  }
  return killed;
}

/** 另一个活着的进程正用着这个数据目录时返回 false。调用方不要再打开数据库。 */
/** 抢锁：死 PID 或 exiting 超时/僵死时清除残留并允许启动；活着且未 exiting 的持有者仍拒绝。 */
export async function acquireInstance(dataDir: string): Promise<{ ok: boolean; reaped: number[] }> {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockFile = path.join(dataDir, 'instance.lock');
  const parsed = readLock(dataDir);
  let holder = typeof parsed?.pid === 'number' ? parsed.pid : 0;
  if (holder && holder !== process.pid) {
    if (alive(holder)) {
      if (parsed?.exiting === true && !waitedDirs.has(dirKey(dataDir))) {
        waitedDirs.add(dirKey(dataDir));
        const deadline = Date.now() + EXITING_WAIT_MS;
        while (alive(holder) && Date.now() < deadline) await pause(40);
      }
      if (alive(holder) && parsed?.exiting === true) {
        // L1/P0: do not steal lock from a still-alive exiting holder (dual DB write).
        // Ask it to die, wait briefly; only clear lock once dead. If still alive, refuse.
        try { process.kill(holder); } catch { /* already gone */ }
        const killDeadline = Date.now() + EXITING_WAIT_MS;
        while (alive(holder) && Date.now() < killDeadline) await pause(40);
        if (alive(holder)) {
          return { ok: false, reaped: [] };
        }
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          /* 下一写覆盖 */
        }
        holder = 0;
      } else if (alive(holder)) {
        return { ok: false, reaped: [] };
      }
    }
    // holder 已死：视为陈旧 lock，下面直接覆盖
  }
  const reaped = holder && holder !== process.pid ? await reapRecordedChildren(dataDir, holder) : [];
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  setOwnedPidFile(path.join(dataDir, 'child-pids.json'));
  return { ok: true, reaped };
}
export function releaseInstance(dataDir: string) {
  const lockFile = path.join(dataDir, 'instance.lock');
  try {
    const parsed = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid?: number };
    if (parsed.pid === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {
    /* 锁已经没了 */
  }
}

/** 先清掉自己的子进程和监听留下的 electron / node，再放开锁。 */
export async function finishInstance(dataDir: string): Promise<void> {
  if (!dataDir) return;
  // 真库目录不 reap 子进程，但仍必须释放 instance.lock，否则 markInstanceExiting 留下 exiting:true 死锁
  if (isOwnerLiveDataDir(dataDir)) {
    releaseInstance(dataDir);
    return;
  }
  await reapRecordedChildren(dataDir, process.pid);
  const exe = process.platform === 'win32' ? helperExe() : null;
  const ownExeName = path.basename(process.execPath);
  const deadline = Date.now() + 8000;
  while (exe && Date.now() < deadline) {
    const rows = await runHelper(exe, ['children', String(process.pid)]);
    if (!rows) break;
    const live = rows.filter((row) => alive(row.pid) && shouldReapProcess(row, {
      selfPid: process.pid,
      recorded: false,
      childOfDead: true,
      ownExeName,
    }));
    if (live.length === 0) break;
    for (const row of live) {
      try { process.kill(row.pid); } catch { /* 已经退出 */ }
    }
    await pause(50);
  }
  releaseInstance(dataDir);
}
