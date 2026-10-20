/** 可见更新器入口。只做窗口和状态机的接线。 */
import { app, BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  handoffFile,
  isUnderStudyDev,
  parseHandoff,
  parseUpdaterState,
  readCurrent,
  stateFile,
  UPDATE_WINDOW_TITLE,
  type UpdaterPhase,
  type UpdaterState,
} from '../shared/layout';
import { acquireUpdateLock, createSwitchIo, readReadyVersion } from './io';
import { entryAction, rollbackToPrevious, runRecover, runSwitch, type SwitchIo } from './machine';
import { pageHtml, statusScript, toPageStatus, type PageStatus } from './page';

function discoverInstallRoot(): string {
  const fromEnv = process.env.KB_UPDATER_INSTALL_ROOT;
  if (fromEnv && fromEnv.trim()) return path.win32.resolve(fromEnv);
  return path.win32.resolve(path.dirname(process.execPath), '..');
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 640,
    height: 460,
    title: UPDATE_WINDOW_TITLE,
    show: true,
    autoHideMenuBar: true,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.show();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  let busy = false;
  const root = discoverInstallRoot();
  const io = createSwitchIo(root);

  const publish = async (status: PageStatus) => {
    if (win.isDestroyed()) return;
    await win.webContents.executeJavaScript(statusScript(status)).catch(() => undefined);
  };
  const showState = async (state: UpdaterState, elapsedMs = 0) => {
    await publish(toPageStatus(state, elapsedMs));
  };
  const showError = async (message: string) => {
    await publish({ phase: 'failed', phaseText: '更新失败', elapsedText: '0 秒', error: message, logFile: '' });
  };

  io.onStatus = (state, elapsedMs) => {
    void showState(state, elapsedMs);
  };

  const runFresh = async () => {
    const handoff = parseHandoff(await fs.readFile(handoffFile(root), 'utf8'));
    const state = await runSwitch(io, handoff);
    await showState(state, elapsedOf(io, state));
  };

  const runRecovery = async () => {
    const handoff = parseHandoff(await fs.readFile(handoffFile(root), 'utf8'));
    const parsed = parseUpdaterState(await fs.readFile(stateFile(root), 'utf8'));
    const pointer = await readCurrent(root);
    const ready = await readReadyVersion(handoff.userDataDir);
    const result = await runRecover(io, parsed, pointer, ready);
    await showState(result.state, elapsedOf(io, result.state));
  };

  const runManualRollback = async () => {
    const state = await rollbackToPrevious(io);
    await showState(state, elapsedOf(io, state));
  };

  win.webContents.on('will-navigate', (event, url) => {
    let action = '';
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== 'kb-updater.local') {
        event.preventDefault();
        return;
      }
      action = parsed.pathname;
    } catch {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    if (busy) return;
    busy = true;
    const job = action === '/retry' ? runFresh() : action === '/rollback' ? runManualRollback() : Promise.resolve();
    void job.catch((err: unknown) => showError(err instanceof Error ? err.message : String(err))).finally(() => {
      busy = false;
    });
  });

  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(UPDATE_WINDOW_TITLE))}`).then(async () => {
    busy = true;
    try {
      if (isUnderStudyDev(root)) {
        await showError('禁止在 D:\\example_dev 下运行更新器');
        return;
      }
      await acquireUpdateLock(root);
      if (process.argv.includes('--rollback')) {
        await runManualRollback();
        return;
      }
      const phase = await readPhase(root);
      const choice = entryAction(phase);
      if (choice === 'switch') await runFresh();
      else if (choice === 'recover') await runRecovery();
      else await showState(parseUpdaterState(await fs.readFile(stateFile(root), 'utf8')));
    } catch (err) {
      await showError(err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  }).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
  });
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
});

app.on('window-all-closed', () => {
  app.quit();
});

async function readPhase(root: string): Promise<UpdaterPhase | null> {
  try {
    return parseUpdaterState(await fs.readFile(stateFile(root), 'utf8')).phase;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function elapsedOf(io: SwitchIo, state: UpdaterState): number {
  if (!state.startedAt) return 0;
  const started = Date.parse(state.startedAt);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, io.now() - started);
}
