/**
 * 端到端测试用的“模拟外部程序”（只在未打包的开发构建 + 环境变量 KB_E2E_APP_HARNESS=1 时启用，见 index.ts）。
 * Linux 盒子上没有 Notepad++、没有 Authenticode：这里替换 找 exe / 签名校验 / 启动 / 路径形式 / 超限确认 五个平台依赖，
 * 其余（授权、应用档案、参数模板、频率、单实例、启动前备份、退出后记入操作记录、撤销）都走真实代码。
 * 测试经 electronApp.evaluate 访问 globalThis.__kbAppHarness：查看启动记录（exe、argv）、模拟程序退出、设定超限确认的回答。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PlatformDeps } from './appHost';

export interface HarnessLaunch {
  pid: number;
  exe: string;
  argv: string[];
  exited: boolean;
}

export interface AppHarness {
  launches: HarnessLaunch[];
  confirmPrompts: string[];
  /** 超限确认框的回答（缺省 false = 不启动，与真实对话框的默认按钮一致） */
  confirmAnswer: boolean;
  /** argv 里的 Windows 形式路径 → 本机真实路径（测试据此“像外部程序一样”改文件） */
  realPath(winPath: string): string | null;
  /** 模拟程序退出。也可以是上次运行时启动、记在 aliveFile 里“仍在运行”的程序（从文件中删除） */
  exit(pid: number, code?: number): boolean;
}

/**
 * aliveFile：模拟“工作台关闭后外部程序仍在运行”。测试在关闭工作台前把 pid 写进这个 JSON 数组，
 * 下次启动时 isAlive(pid) 为真；harness.exit(pid) 把它删掉（主进程轮询后视为已退出）。
 */
const readAlive = (f?: string): number[] => {
  if (!f) return [];
  try {
    const v = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
};

export function createAppHarness(opts: { aliveFile?: string } = {}): { deps: PlatformDeps; harness: AppHarness } {
  const exits = new Map<number, (code: number | null) => void>();
  const pathMap = new Map<string, string>();
  // 每次启动从不同的 pid 段开始，避免与上次运行留在 aliveFile 里的 pid 重复
  let pid = 10000 + Math.floor(Math.random() * 80000);
  const harness: AppHarness = {
    launches: [],
    confirmPrompts: [],
    confirmAnswer: false,
    realPath: (w) => pathMap.get(w) ?? null,
    exit: (p, code = 0) => {
      const cb = exits.get(p);
      if (!cb) {
        const alive = readAlive(opts.aliveFile);
        if (!alive.includes(p) || !opts.aliveFile) return false;
        fs.writeFileSync(opts.aliveFile, JSON.stringify(alive.filter((x) => x !== p)));
        return true;
      }
      exits.delete(p);
      const l = harness.launches.find((x) => x.pid === p);
      if (l) l.exited = true;
      // 退出回调会写数据库：放到下一个宏任务（e2e 的 evaluate 可能插在另一条同步查询中途执行）
      setImmediate(() => cb(code));
      return true;
    },
  };
  const deps: PlatformDeps = {
    isAlive: (p) => harness.launches.some((l) => l.pid === p && !l.exited) || readAlive(opts.aliveFile).includes(p),
    findExe: (spec) => (spec.exeCandidates[0] ?? '').replace(/^%ProgramFiles%/, 'C:\\Program Files').replace(/^%ProgramFiles\(x86\)%/, 'C:\\Program Files (x86)'),
    verifyExe: async () => ({ ok: true, publisher: '（模拟）', version: '8.9.0.0' }),
    argvPath: (abs) => {
      const w = 'D:\\KB\\' + abs.split(path.sep).filter(Boolean).slice(-3).join('\\');
      pathMap.set(w, abs);
      return w;
    },
    spawn: (exe, argv) => {
      const p = ++pid;
      harness.launches.push({ pid: p, exe, argv: [...argv], exited: false });
      return { pid: p, onExit: (cb) => void exits.set(p, cb) };
    },
    confirmUnprotected: async (info) => {
      harness.confirmPrompts.push(`${info.programName}：${info.detail}`);
      return harness.confirmAnswer;
    },
  };
  return { deps, harness };
}
