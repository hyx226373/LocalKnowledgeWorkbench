/** 固定启动器。决策只调用冻结契约，不自己重写阶段表。 */
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';
import {
  SHORTCUT_NAME,
  appExe,
  launcherLockFile,
  mayLauncherWritePointer,
  parseUpdaterState,
  planLaunch,
  pointBack,
  readCurrent,
  stateFile,
  writeCurrent,
  type CurrentPointer,
  type UpdaterPhase,
} from '../shared/layout';
import { acquireLauncherLock } from './lock';

export interface LauncherSpawn {
  exe: string;
  args: readonly string[];
  detached: true;
  stdio: 'ignore';
  windowsHide: false;
  shell: false;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface LauncherPorts {
  installRoot: string;
  selfPid: number;
  env: NodeJS.ProcessEnv;
  isAlive: (pid: number) => boolean;
  showDialog: (message: string, buttons: readonly string[]) => Promise<number>;
  spawnApp: (spec: LauncherSpawn) => void;
  exit: (code: number) => void;
  now?: () => string;
  readFile?: (file: string) => Promise<string>;
  fileExists?: (file: string) => Promise<boolean>;
}

const OFFER_BUTTONS = ['启动上一版', '退出'] as const;
const OK_BUTTON = ['确定'] as const;

async function defaultRead(file: string): Promise<string> {
  return readFile(file, 'utf8');
}

async function defaultExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** 保留调用方环境（含 KB_USER_DATA）。不设置 ELECTRON_RUN_AS_NODE。 */
export function launcherChildEnv(base: NodeJS.ProcessEnv, installRoot: string, version: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.ELECTRON_RUN_AS_NODE;
  env.KB_INSTALL_ROOT = installRoot;
  env.KB_LAYOUT_VERSION = version;
  return env;
}

function spawnSpec(exe: string, env: NodeJS.ProcessEnv): LauncherSpawn {
  return {
    exe,
    args: [],
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    shell: false,
    cwd: path.win32.dirname(exe),
    env,
  };
}

function launchVersion(ports: LauncherPorts, version: string): void {
  const exe = appExe(ports.installRoot, version);
  ports.spawnApp(spawnSpec(exe, launcherChildEnv(ports.env, ports.installRoot, version)));
  ports.exit(0);
}

export async function runLauncher(ports: LauncherPorts): Promise<void> {
  const read = ports.readFile ?? defaultRead;
  const exists = ports.fileExists ?? defaultExists;
  const now = ports.now ?? (() => new Date().toISOString());
  const root = ports.installRoot;

  const lock = await acquireLauncherLock(launcherLockFile(root), ports.selfPid, ports.isAlive, now);
  let pointer: CurrentPointer | null = null;
  let pointerError: string | null = null;
  try {
    pointer = await readCurrent(root, read);
  } catch (err) {
    pointerError = err instanceof Error ? err.message : String(err);
  }

  let phase: UpdaterPhase | null = null;
  let stateError: string | null = null;
  const statePath = stateFile(root);
  if (await exists(statePath)) {
    try {
      phase = parseUpdaterState(await read(statePath)).phase;
    } catch (err) {
      stateError = err instanceof Error ? err.message : String(err);
    }
  }

  const current = pointer?.current ?? null;
  const previous = pointer?.previous ?? null;
  const currentExeExists = current ? await exists(appExe(root, current)) : false;
  const previousExeExists = previous ? await exists(appExe(root, previous)) : false;
  const plan = planLaunch({
    lockHeldByOther: lock === 'held',
    updatePhase: phase,
    pointerError,
    current,
    previous,
    currentExeExists,
    previousExeExists,
  });

  if (plan.action !== 'second-instance' && stateError) {
    await ports.showDialog(stateError, OK_BUTTON);
    ports.exit(1);
    return;
  }

  switch (plan.action) {
    case 'second-instance':
      ports.exit(0);
      return;
    case 'defer-to-updater':
      await ports.showDialog(plan.reason, OK_BUTTON);
      ports.exit(0);
      return;
    case 'spawn':
      launchVersion(ports, plan.version);
      return;
    case 'offer-previous': {
      const choice = await ports.showDialog(plan.reason, OFFER_BUTTONS);
      if (choice !== 0) {
        ports.exit(0);
        return;
      }
      if (!pointer?.previous || !mayLauncherWritePointer(phase)) {
        await ports.showDialog('现在不能切换版本，请查看更新器窗口', OK_BUTTON);
        ports.exit(0);
        return;
      }
      const reverted = pointBack(pointer, now());
      await writeCurrent(root, reverted);
      launchVersion(ports, reverted.current);
      return;
    }
    case 'fail':
      await ports.showDialog(plan.reason, OK_BUTTON);
      ports.exit(1);
      return;
    default: {
      const never: never = plan;
      throw new Error(`未知启动决定：${JSON.stringify(never)}`);
    }
  }
}

interface ElectronApi {
  app: {
    whenReady: () => Promise<void>;
    exit: (code?: number) => void;
    on: (event: string, listener: () => void) => void;
  };
  dialog: {
    showMessageBox: (opts: {
      title?: string;
      message: string;
      buttons: string[];
      noLink?: boolean;
      cancelId?: number;
    }) => Promise<{ response: number }>;
  };
}

function electronApi(mod: unknown): ElectronApi {
  if (mod && typeof mod === 'object' && 'app' in mod && 'dialog' in mod) return mod as ElectronApi;
  const inner = (mod as { default?: unknown } | null)?.default;
  if (inner && typeof inner === 'object' && 'app' in inner && 'dialog' in inner) return inner as ElectronApi;
  throw new Error('Electron API 不可用');
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Electron 入口。单测不要调用。安装根是 kb-launch.exe 的上两级目录。 */
export async function bootFromElectron(): Promise<void> {
  if (!process.versions.electron) throw new Error('bootFromElectron 只能在 Electron 里运行');
  const { app, dialog } = electronApi(await import('electron'));
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  app.on('window-all-closed', () => undefined);
  await app.whenReady();
  const installRoot = path.win32.dirname(path.win32.dirname(process.execPath));
  try {
    await runLauncher({
      installRoot,
      selfPid: process.pid,
      env: process.env,
      isAlive: defaultIsAlive,
      now: () => new Date().toISOString(),
      readFile: (file) => fs.readFile(file, 'utf8'),
      fileExists: async (file) => {
        try {
          await fs.access(file);
          return true;
        } catch {
          return false;
        }
      },
      showDialog: async (message, buttons) => {
        const result = await dialog.showMessageBox({
          title: SHORTCUT_NAME,
          message,
          buttons: [...buttons],
          noLink: true,
          cancelId: Math.max(0, buttons.length - 1),
        });
        return result.response;
      },
      spawnApp: (spec) => {
        const child = spawn(spec.exe, [...spec.args], {
          detached: spec.detached,
          stdio: spec.stdio,
          windowsHide: spec.windowsHide,
          shell: spec.shell,
          cwd: spec.cwd,
          env: spec.env,
        });
        child.unref();
      },
      exit: (code) => {
        app.exit(code);
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      await dialog.showMessageBox({ title: SHORTCUT_NAME, message, buttons: ['确定'], noLink: true });
    } catch {
      console.error(message);
    }
    app.exit(1);
  }
}
