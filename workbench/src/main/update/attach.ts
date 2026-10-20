import { spawn } from 'node:child_process';
import { dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setAppUpdateChecker } from '../../shared/actions/packages/appUpdate';
import { CURRENT_FILE } from '../../shared/layout';
import { defaultFeedDir } from '../../shared/update/feed';
import type { SelfCheckInput } from '../../shared/update/selfCheck';
import type { UpdateSnapshot } from '../../shared/update/types';
import { callBackupWorker } from './workerClient';
import { UpdateService, type UpdateHooks } from './service';
import { createUpdateTray } from './tray';

export interface UpdateRuntime {
  service: UpdateService;
  snapshot: () => UpdateSnapshot;
  check: () => Promise<UpdateSnapshot>;
  saveSettings: UpdateService['saveSettings'];
  installNow: () => Promise<void>;
  installOnQuit: () => Promise<UpdateSnapshot>;
  rollback: () => Promise<void>;
  prepareQuitInstall: () => Promise<boolean>;
  spawnQuitInstall: () => Promise<void>;
  noteWindowLoaded: () => void;
  destroy: () => void;
}

/** 已有 current.json，或 KB_UPDATE_APPLY=dirpack，走目录包。否则仍是原来的 nsis / copy。 */
async function detectApplyMode(installDir: string | null): Promise<UpdateHooks['applyMode']> {
  if (installDir) {
    try {
      await fs.access(path.join(installDir, CURRENT_FILE));
      return 'dirpack';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return 'dirpack';
    }
  }
  if (process.env.KB_UPDATE_APPLY === 'dirpack') return 'dirpack';
  return process.env.KB_UPDATE_APPLY === 'copy' ? 'copy' : 'nsis';
}

export async function attachAutoUpdate(opts: {
  currentVersion: string;
  userDataDir: string;
  roamingDir: string;
  installDir: string | null;
  workerFile: string;
  startup: SelfCheckInput;
  prepareShutdown: () => Promise<'closed' | 'timeout'>;
  closeDatabase: () => Promise<void>;
  requestExit: () => void;
  send: (snapshot: UpdateSnapshot) => void;
  relaunchPath: string | null;
}): Promise<UpdateRuntime> {
  const helperDone = process.env.KB_UPDATE_HELPER_DONE || path.join(opts.userDataDir, 'update-helper-done.txt');
  const localAppData = process.env.LOCALAPPDATA || path.dirname(opts.userDataDir);
  const hooks: UpdateHooks = {
    currentVersion: opts.currentVersion,
    userDataDir: opts.userDataDir,
    roamingDir: opts.roamingDir,
    installDir: opts.installDir,
    defaultFeed: defaultFeedDir(localAppData),
    backupSqlite: async (src, dest) => {
      await callBackupWorker(opts.workerFile, { op: 'backup', src, dest });
    },
    prepareShutdown: opts.prepareShutdown,
    closeDatabase: opts.closeDatabase,
    spawnDetached: (file, args, env) => {
      if (process.platform === 'win32') {
        const cmd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
        return new Promise((resolve) => {
          console.log('[update] spawnDetached windowsHide=false min=false');
          const child = spawn(cmd, ['/d', '/c', 'start', '', file, ...args], { stdio: 'ignore', windowsHide: false, env });
          child.once('exit', () => resolve());
          child.once('error', () => resolve());
        });
      }
      const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
      child.unref();
    },
    requestExit: opts.requestExit,
    showReason: async (title, body) => {
      await dialog.showMessageBox({ type: 'warning', title, message: title, detail: body, buttons: ['确定'] });
    },
    confirmQuit: async (title, body) => {
      if (process.env.KB_UPDATE_ASSUME_QUIT === '1') {
        console.log('[update] assume-quit: ' + body);
        return true;
      }
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        title,
        message: title,
        detail: body,
        buttons: ['继续升级', '取消'],
        cancelId: 1,
      });
      return response === 0;
    },
    selfCheckOverride: () =>
      process.env.KB_UPDATE_SELF_CHECK === 'fail'
        ? { windowLoaded: false, windowError: process.env.KB_UPDATE_SELF_CHECK_REASON || '自检被测试钩子标为失败' }
        : null,
    damageBeforeRollback:
      process.env.KB_UPDATE_DAMAGE_BEFORE_ROLLBACK === '1'
        ? async () => {
            await fs.writeFile(path.join(opts.userDataDir, 'canary.json'), 'damaged', 'utf8');
            await callBackupWorker(opts.workerFile, { op: 'put-canary', file: path.join(opts.userDataDir, 'workbench.db'), value: JSON.stringify('damaged') }).catch((err) => {
              console.error('[update] damage canary', err);
            });
          }
        : undefined,
    applyMode: await detectApplyMode(opts.installDir),
    noRelaunch: process.env.KB_UPDATE_NO_RELAUNCH === '1',
    helperDone,
    relaunchPath: opts.relaunchPath,
    openExternal: (url) => shell.openExternal(url),
  };
  const service = new UpdateService(hooks);
  await service.init();
  setAppUpdateChecker(() => service.check());
  const tray = createUpdateTray({
    onCheck: () => {
      console.log('[update] tray check');
      void service.check();
    },
    onInstall: () => {
      console.log('[update] tray install');
      void service.installNow().catch((err) => console.error('[update] tray install failed', err));
    },
    installEnabled: () => service.snapshot().downloaded,
  });
  const off = service.onChange(() => {
    tray?.refresh();
    opts.send(service.snapshot());
  });
  service.armStartup(opts.startup);
  const delay = Number(process.env.KB_UPDATE_CHECK_DELAY_MS ?? 60_000);
  const interval = Number(process.env.KB_UPDATE_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000);
  const first = setTimeout(() => {
    if (service.snapshot().autoCheck) void service.check();
    const timer = setInterval(() => {
      if (service.snapshot().autoCheck) void service.check();
    }, Number.isFinite(interval) && interval >= 60_000 ? interval : 6 * 60 * 60 * 1000);
    timer.unref?.();
  }, Number.isFinite(delay) && delay >= 0 ? delay : 60_000);
  first.unref?.();
  if (process.env.KB_UPDATE_TEST_HOOK === '1') {
    (globalThis as { __kbUpdate?: unknown }).__kbUpdate = {
      snapshot: () => service.snapshot(),
      check: () => service.check(),
      trayCheck: () => service.check(),
      trayInstall: () => service.installNow(),
      rollback: () => service.rollback('manual', '手动回滚到上一版'),
      eventLoopP99: () => service.eventLoopP99(),
      writeCanary: async (text: string) => {
        await fs.writeFile(path.join(opts.userDataDir, 'canary.json'), text, 'utf8');
        await callBackupWorker(opts.workerFile, { op: 'put-canary', file: path.join(opts.userDataDir, 'workbench.db'), value: JSON.stringify(text) });
      },
      readCanary: async () => {
        let file: string | null = null;
        try {
          file = await fs.readFile(path.join(opts.userDataDir, 'canary.json'), 'utf8');
        } catch {
          file = null;
        }
        let row: string | null = null;
        try {
          const reply = await callBackupWorker(opts.workerFile, { op: 'get-canary', file: path.join(opts.userDataDir, 'workbench.db') });
          row = reply.json ?? null;
        } catch {
          row = null;
        }
        return { file, row };
      },
    };
    console.log('[update] test hook ready');
  }
  return {
    service,
    snapshot: () => service.snapshot(),
    check: () => service.check(),
    saveSettings: (patch) => service.saveSettings(patch),
    installNow: () => service.installNow(),
    installOnQuit: () => service.installOnQuit(),
    rollback: () => service.rollback('manual', '手动回滚到上一版'),
    prepareQuitInstall: () => service.prepareQuitInstall(),
    spawnQuitInstall: () => service.spawnQuitInstall(),
    noteWindowLoaded: () => service.noteWindowLoaded(),
    destroy: () => {
      off();
      tray?.destroy();
      clearTimeout(first);
    },
  };
}
