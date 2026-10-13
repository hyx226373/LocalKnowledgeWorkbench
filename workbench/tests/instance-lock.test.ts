import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireInstance, finishInstance, markInstanceExiting, reapRecordedChildren, restartSkipsDiskCache, shouldReapProcess, waitIfHolderExits, type ProcRow } from '../src/main/instanceLock';
import { tmpDir } from './helpers';

function deadPid(): number {
  for (let pid = 2_100_000_000; pid > 2_100_000_000 - 30; pid -= 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return pid;
    }
  }
  throw new Error('找不到已退出的 pid');
}

function row(partial: Partial<ProcRow> & { pid: number }): ProcRow {
  return { ppid: 0, name: '', image: '', command: '', ...partial };
}

describe('残留进程筛选', () => {
  it('父进程已退出时清掉它的 electron 子进程，跳过已安装的工作台', () => {
    expect(shouldReapProcess(row({ pid: 10, ppid: 4, name: 'electron.exe', command: '--type=gpu-process --user-data-dir=D:\\kb-r13-work\\userdata' }), {
      selfPid: 99, recorded: false, childOfDead: true, ownExeName: 'electron.exe',
    })).toBe(true);
    expect(shouldReapProcess(row({ pid: 11, name: 'LocalKnowledgeWorkbench.exe', image: 'D:\\study_dev\\LocalKnowledgeWorkbench\\LocalKnowledgeWorkbench.exe' }), {
      selfPid: 99, recorded: true, childOfDead: false, ownExeName: 'electron.exe',
    })).toBe(false);
    expect(shouldReapProcess(row({ pid: 12, name: 'powershell.exe', command: 'Start-Sleep; study_dev\\LocalKnowledgeWorkbench' }), {
      selfPid: 99, recorded: true, childOfDead: false, ownExeName: 'electron.exe',
    })).toBe(false);
    expect(shouldReapProcess(row({ pid: 13, name: 'powershell.exe', command: 'Start-Sleep -Seconds 30' }), {
      selfPid: 99, recorded: true, childOfDead: false, ownExeName: 'electron.exe',
    })).toBe(true);
    expect(shouldReapProcess(row({ pid: 14, name: 'powershell.exe' }), {
      selfPid: 99, recorded: true, childOfDead: false, ownExeName: 'electron.exe',
    })).toBe(false);
  });
});

describe('死锁后的磁盘缓存', () => {
  it('只有已退出的锁才跳过磁盘缓存', () => {
    const dir = tmpDir('kblock-cache-');
    expect(restartSkipsDiskCache(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: deadPid() }));
    expect(restartSkipsDiskCache(dir)).toBe(true);
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: process.pid }));
    expect(restartSkipsDiskCache(dir)).toBe(false);
    const prev = process.env.LOCALAPPDATA;
    const root = tmpDir('kblock-amy-');
    process.env.LOCALAPPDATA = root;
    try {
      const amy = path.join(root, 'LocalKnowledgeWorkbench');
      fs.mkdirSync(amy);
      fs.writeFileSync(path.join(amy, 'instance.lock'), JSON.stringify({ pid: deadPid() }));
      expect(restartSkipsDiskCache(amy)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = prev;
    }
  });
});

describe('数据目录实例锁', () => {
  it('另一个活进程占着这个目录时不打开', async () => {
    const dir = tmpDir('kblock-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid }));
      const result = await acquireInstance(dir);
      expect(result.ok).toBe(false);
      expect(result.reaped).toEqual([]);
    } finally {
      child.kill();
    }
  }, 15000);

  it('锁的进程已经退出时清掉登记的子进程，但跳过已安装的工作台', async () => {
    const dir = tmpDir('kbreap-');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const installed = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30; "study_dev\\LocalKnowledgeWorkbench"'],
      { windowsHide: true, stdio: 'ignore' },
    );
    try {
      fs.writeFileSync(path.join(dir, 'child-pids.json'), JSON.stringify({ pids: [child.pid, installed.pid] }));
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: deadPid() }));
      const result = await acquireInstance(dir);
      expect(result.ok).toBe(true);
      expect(result.reaped).toContain(child.pid);
      expect(result.reaped).not.toContain(installed.pid);
      let installedAlive = true;
      try {
        process.kill(installed.pid!, 0);
      } catch {
        installedAlive = false;
      }
      expect(installedAlive).toBe(true);
    } finally {
      child.kill();
      installed.kill();
    }
  }, 25000);

  it('直接清名单时也不结束命令行里的已安装程序', async () => {
    const dir = tmpDir('kbreap2-');
    const installed = spawn(
      'powershell.exe',
      ['-NoProfile', '-Command', 'Start-Sleep -Seconds 20; "D:\\study_dev\\LocalKnowledgeWorkbench\\LocalKnowledgeWorkbench.exe"'],
      { windowsHide: true, stdio: 'ignore' },
    );
    try {
      fs.writeFileSync(path.join(dir, 'child-pids.json'), JSON.stringify({ pids: [installed.pid] }));
      const killed = await reapRecordedChildren(dir);
      expect(killed).not.toContain(installed.pid);
    } finally {
      installed.kill();
    }
  }, 20000);

  it('正在退出的锁会短等，死掉之后可以接手', async () => {
    const dir = tmpDir('kblock-exiting-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid, exiting: true }));
      const pending = acquireInstance(dir);
      setTimeout(() => child.kill(), 150);
      const result = await pending;
      expect(result.ok).toBe(true);
    } finally {
      child.kill();
    }
  }, 15000);

  it('活着且没在退出时立刻拒绝', async () => {
    const dir = tmpDir('kblock-live-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid }));
      const started = Date.now();
      const result = await acquireInstance(dir);
      expect(result.ok).toBe(false);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      child.kill();
    }
  }, 15000);
});

describe('退出中的实例锁', () => {
  it('只有自己的锁才标成正在退出', () => {
    const dir = tmpDir('kblock-mark-');
    markInstanceExiting(dir);
    expect(fs.existsSync(path.join(dir, 'instance.lock'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: process.pid, at: 't0' }));
    markInstanceExiting(dir);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'instance.lock'), 'utf8')) as { pid: number; exiting: boolean; at: string };
    expect(parsed).toEqual({ pid: process.pid, exiting: true, at: 't0' });
  });

  it('活着但没在退出时不等待', () => {
    const dir = tmpDir('kblock-nowait-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid }));
      const started = Date.now();
      expect(waitIfHolderExits(dir)).toBe(false);
      expect(Date.now() - started).toBeLessThan(400);
    } finally {
      child.kill();
    }
  }, 15000);

  it('正在退出并且马上死掉时可以接手', () => {
    const dir = tmpDir('kblock-wait-');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    const killer = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Sleep -Milliseconds 200; Stop-Process -Id ${child.pid} -Force -ErrorAction SilentlyContinue`], {
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: child.pid, exiting: true }));
      const started = Date.now();
      expect(waitIfHolderExits(dir, 2000)).toBe(true);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      child.kill();
      killer.kill();
    }
  }, 15000);

  it('先结束登记的子进程，再放开自己的锁', async () => {
    const dir = tmpDir('kblock-finish-');
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 30'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    try {
      fs.writeFileSync(path.join(dir, 'instance.lock'), JSON.stringify({ pid: process.pid }));
      fs.writeFileSync(path.join(dir, 'child-pids.json'), JSON.stringify({ pids: [child.pid] }));
      await finishInstance(dir);
      expect(fs.existsSync(path.join(dir, 'instance.lock'))).toBe(false);
      let childAlive = true;
      try { process.kill(child.pid!, 0); } catch { childAlive = false; }
      expect(childAlive).toBe(false);
    } finally {
      child.kill();
    }
  }, 20000);
});
