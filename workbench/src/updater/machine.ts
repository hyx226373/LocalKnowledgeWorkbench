/** 外贴 27 可见更新器的切换状态机。自动恢复只走 decideRecovery。手点回退另走 rollbackToPrevious，不删版本目录。 */
import {
  appExe,
  decideRecovery,
  formatPhaseLog,
  installPath,
  isUnderStudyDev,
  parseHandoff,
  parseUpdaterState,
  PHASE_TIMEOUT_MS,
  pointAt,
  pointBack,
  readCurrent,
  verifyVersionTree,
  versionDir,
  writeCurrent,
  type CurrentPointer,
  type RecoverAction,
  type TreeCheck,
  type UpdateHandoff,
  type UpdaterPhase,
  type UpdaterState,
} from '../shared/layout';

const EXIT_POLL_MS = 500;

export interface SwitchIo {
  /** 恢复路径要知道往哪写指针。切换目标以 handoff.installRoot 为准。 */
  installRoot: string;
  now(): number;
  readCurrent(installRoot: string): Promise<CurrentPointer>;
  writeCurrent(installRoot: string, pointer: CurrentPointer): Promise<void>;
  readState(installRoot: string): Promise<string | null>;
  writeState(installRoot: string, state: UpdaterState): Promise<void>;
  appendLog(line: string): Promise<void>;
  /** 只应由调用方返回本次安装根 versions 下的工作台。 */
  listAppPids(installRoot: string): Promise<number[]>;
  sleep(ms: number): Promise<void>;
  verify(dir: string): Promise<TreeCheck>;
  spawnApp(exe: string, env: NodeJS.ProcessEnv): Promise<{ pid: number }>;
  waitReady(userData: string, version: string, timeoutMs: number): Promise<{ ok: boolean; version?: string }>;
  killSpawned(pid: number): Promise<void>;
  readHandoff(installRoot: string): Promise<string>;
  onStatus?(state: UpdaterState, elapsedMs: number): void;
}

export interface RecoverResult {
  action: RecoverAction;
  state: UpdaterState;
  pointer: CurrentPointer;
}

export function entryAction(phase: UpdaterPhase | null): 'switch' | 'recover' | 'show' {
  if (
    phase === 'waiting-exit' ||
    phase === 'switching' ||
    phase === 'starting' ||
    phase === 'verifying' ||
    phase === 'rolling-back' ||
    phase === 'preparing'
  ) {
    return 'recover';
  }
  if (phase === null || phase === 'ready') return 'switch';
  return 'show';
}

export async function runSwitch(io: SwitchIo, handoffInput: UpdateHandoff): Promise<UpdaterState> {
  const handoff = parseHandoff(JSON.stringify(handoffInput));
  if (isUnderStudyDev(handoff.installRoot) || isUnderStudyDev(handoff.userDataDir)) {
    return studyRefusal(handoff);
  }

  const logFile = installPath(handoff.installRoot, 'updater', 'phase.log');
  const existingRaw = await io.readState(handoff.installRoot);
  const existing = existingRaw ? parseUpdaterState(existingRaw) : null;
  const startedAt = iso(io.now());
  let state: UpdaterState = {
    schema: 1,
    phase: 'waiting-exit',
    fromVersion: handoff.fromVersion,
    toVersion: handoff.toVersion,
    candidateRel: handoff.candidateRel,
    error: null,
    logFile,
    attempt: (existing?.attempt ?? 0) + 1,
    startedAt,
    updatedAt: startedAt,
  };
  const hold: { pid: number | null } = { pid: null };

  const fail = async (phase: UpdaterPhase, start: number, error: unknown): Promise<UpdaterState> => {
    let message = error instanceof Error ? error.message : String(error);
    try {
      if (hold.pid !== null && (phase === 'starting' || phase === 'verifying')) {
        const pid = hold.pid;
        hold.pid = null;
        try {
          await io.killSpawned(pid);
        } catch (err) {
          const extra = err instanceof Error ? err.message : String(err);
          message = `${message}；结束新进程失败：${extra}`;
        }
      }
      await rollbackIfNeeded(io, handoff, phase);
    } catch (err) {
      const extra = err instanceof Error ? err.message : String(err);
      message = `${message}；回退失败：${extra}`;
    }
    const atMs = io.now();
    state = {
      ...state,
      phase: 'failed',
      error: withLog(message, state.logFile),
      updatedAt: iso(atMs),
    };
    await io.appendLog(formatPhaseLog({
      phase,
      event: 'fail',
      at: state.updatedAt,
      ms: atMs - start,
      result: 'fail',
      detail: state.error ?? message,
    }));
    await publish(io, handoff.installRoot, state);
    return state;
  };

  let start = io.now();
  state = { ...state, phase: 'waiting-exit', error: null, updatedAt: iso(start) };
  await publish(io, handoff.installRoot, state);
  await io.appendLog(formatPhaseLog({ phase: 'waiting-exit', event: 'start', at: iso(start) }));
  try {
    await waitForExit(io, handoff.installRoot, start);
  } catch (err) {
    return fail('waiting-exit', start, err);
  }
  await endPhase(io, 'waiting-exit', start);

  start = io.now();
  state = { ...state, phase: 'switching', error: null, updatedAt: iso(start) };
  await publish(io, handoff.installRoot, state);
  await io.appendLog(formatPhaseLog({ phase: 'switching', event: 'start', at: iso(start) }));
  try {
    await switchPointer(io, handoff, start);
  } catch (err) {
    return fail('switching', start, err);
  }
  await endPhase(io, 'switching', start);

  start = io.now();
  state = { ...state, phase: 'starting', error: null, updatedAt: iso(start) };
  await publish(io, handoff.installRoot, state);
  await io.appendLog(formatPhaseLog({ phase: 'starting', event: 'start', at: iso(start) }));
  try {
    await startApp(io, handoff, start, hold);
  } catch (err) {
    return fail('starting', start, err);
  }
  await endPhase(io, 'starting', start);

  start = io.now();
  state = { ...state, phase: 'verifying', error: null, updatedAt: iso(start) };
  await publish(io, handoff.installRoot, state);
  await io.appendLog(formatPhaseLog({ phase: 'verifying', event: 'start', at: iso(start) }));
  try {
    await verifyReady(io, handoff, state.logFile, start);
  } catch (err) {
    return fail('verifying', start, err);
  }
  await endPhase(io, 'verifying', start);

  start = io.now();
  state = { ...state, phase: 'done', error: null, updatedAt: iso(start) };
  await publish(io, handoff.installRoot, state);
  await io.appendLog(formatPhaseLog({ phase: 'done', event: 'start', at: iso(start) }));
  await endPhase(io, 'done', start);
  state = { ...state, updatedAt: iso(io.now()) };
  await publish(io, handoff.installRoot, state);
  return state;
}

/** 手点恢复上一版。不走 decideRecovery，不删 versions，不读不写 userData。 */
export async function rollbackToPrevious(io: SwitchIo): Promise<UpdaterState> {
  if (isUnderStudyDev(io.installRoot)) {
    throw new Error('禁止在 D:\\study_dev 下恢复上一版');
  }
  const pointer = await loadPointer(io, io.installRoot);
  if (!pointer.previous) throw new Error('没有上一版可恢复');
  const dir = versionDir(io.installRoot, pointer.previous);
  const reported = await io.verify(dir);
  const tree = await verifyVersionTree(dir, async () => (reported.ok && reported.missing.length === 0 ? 1 : null));
  if (!reported.ok || reported.missing.length > 0 || !tree.ok) {
    const missing = reported.missing.length > 0 ? reported.missing : tree.missing;
    throw new Error(`上一版目录不完整，未恢复指针：${missing.join('、') || '缺文件'}`);
  }
  const atMs = io.now();
  const at = iso(atMs);
  const logFile = installPath(io.installRoot, 'updater', 'phase.log');
  await io.appendLog(formatPhaseLog({
    phase: 'rolling-back',
    event: 'start',
    at,
    detail: '正在恢复上一版',
  }));
  const back = pointBack(pointer, at);
  await commitCurrent(io, io.installRoot, back);
  const endMs = io.now();
  await io.appendLog(formatPhaseLog({
    phase: 'rolling-back',
    event: 'end',
    at: iso(endMs),
    ms: endMs - atMs,
    result: 'ok',
    detail: '正在恢复上一版',
  }));
  const state: UpdaterState = {
    schema: 1,
    phase: 'rolling-back',
    fromVersion: back.current,
    toVersion: back.previous,
    candidateRel: null,
    error: null,
    logFile,
    attempt: 1,
    startedAt: at,
    updatedAt: iso(endMs),
  };
  io.onStatus?.(state, Math.max(0, endMs - atMs));
  return state;
}

export async function runRecover(
  io: SwitchIo,
  state: UpdaterState,
  currentPointer: CurrentPointer,
  readyVersion: string | null,
): Promise<RecoverResult> {
  const parsed = parseUpdaterState(JSON.stringify(state));
  const decision = decideRecovery({
    phase: parsed.phase,
    current: currentPointer.current,
    fromVersion: parsed.fromVersion,
    toVersion: parsed.toVersion,
    readyVersion,
  });

  if (decision.action === 'rollback-pointer') {
    const atMs = io.now();
    const at = iso(atMs);
    await io.appendLog(formatPhaseLog({ phase: 'rolling-back', event: 'start', at }));
    const back = pointBack(currentPointer, at);
    await commitCurrent(io, io.installRoot, back);
    const endMs = io.now();
    await io.appendLog(formatPhaseLog({
      phase: 'rolling-back',
      event: 'end',
      at: iso(endMs),
      ms: endMs - atMs,
      result: 'ok',
    }));
    const nextState: UpdaterState = {
      ...parsed,
      phase: 'rolling-back',
      error: null,
      updatedAt: iso(endMs),
    };
    await publish(io, io.installRoot, nextState);
    return { action: decision, state: nextState, pointer: await loadPointer(io, io.installRoot) };
  }

  if (decision.action === 'retry-switch' || decision.action === 'resume-wait') {
    const handoff = parseHandoff(await io.readHandoff(io.installRoot));
    const switched = await runSwitch(io, handoff);
    return { action: decision, state: switched, pointer: await loadPointer(io, handoff.installRoot) };
  }

  if (decision.action === 'refuse') {
    const nextState: UpdaterState = {
      ...parsed,
      error: decision.reason,
      updatedAt: iso(io.now()),
    };
    await io.writeState(io.installRoot, nextState);
    return { action: decision, state: nextState, pointer: currentPointer };
  }

  return { action: decision, state: parsed, pointer: currentPointer };
}

function studyRefusal(handoff: UpdateHandoff): UpdaterState {
  return {
    schema: 1,
    phase: 'failed',
    fromVersion: handoff.fromVersion,
    toVersion: handoff.toVersion,
    candidateRel: handoff.candidateRel,
    error: '禁止在 D:\\study_dev 下切换或启动',
    logFile: null,
    attempt: 0,
    startedAt: null,
    updatedAt: handoff.createdAt,
  };
}

async function waitForExit(io: SwitchIo, installRoot: string, start: number): Promise<void> {
  const limit = PHASE_TIMEOUT_MS['waiting-exit'];
  for (;;) {
    const pids = await io.listAppPids(installRoot);
    if (pids.length === 0) return;
    if (io.now() - start >= limit) {
      const seconds = Math.round(limit / 1000);
      throw new Error(`工作台进程未在 ${seconds} 秒内退出`);
    }
    await io.sleep(EXIT_POLL_MS);
  }
}

async function switchPointer(io: SwitchIo, handoff: UpdateHandoff, start: number): Promise<void> {
  const dir = versionDir(handoff.installRoot, handoff.toVersion);
  const reported = await io.verify(dir);
  const tree = await verifyVersionTree(dir, async () => (reported.ok && reported.missing.length === 0 ? 1 : null));
  if (!reported.ok || reported.missing.length > 0 || !tree.ok) {
    const missing = reported.missing.length > 0 ? reported.missing : tree.missing;
    throw new Error(`版本目录完整性检查失败，未切换指针：${missing.join('、') || '缺文件'}`);
  }
  const pointer = await loadPointer(io, handoff.installRoot);
  if (pointer.current !== handoff.fromVersion) {
    throw new Error('当前版本指针与交接不一致，未切换指针');
  }
  if (io.now() - start >= PHASE_TIMEOUT_MS.switching) {
    throw new Error('切换版本超时');
  }
  const next = pointAt(pointer, handoff.toVersion, iso(io.now()));
  await commitCurrent(io, handoff.installRoot, next);
  if (io.now() - start >= PHASE_TIMEOUT_MS.switching) {
    throw new Error('切换版本超时');
  }
}

async function startApp(io: SwitchIo, handoff: UpdateHandoff, start: number, hold: { pid: number | null }): Promise<void> {
  const exe = appExe(handoff.installRoot, handoff.toVersion);
  if (isUnderStudyDev(exe)) throw new Error('禁止启动 D:\\study_dev 下的程序');
  const child = await io.spawnApp(exe, launchEnv(handoff));
  hold.pid = child.pid;
  if (io.now() - start >= PHASE_TIMEOUT_MS.starting) throw new Error('启动新版超时');
}

async function verifyReady(io: SwitchIo, handoff: UpdateHandoff, logFile: string | null, start: number): Promise<void> {
  const ready = await io.waitReady(handoff.userDataDir, handoff.toVersion, PHASE_TIMEOUT_MS.verifying);
  if (!ready.ok || (ready.version !== undefined && ready.version !== handoff.toVersion)) {
    throw new Error(`新版验证失败。日志：${logFile ?? ''}`);
  }
  if (io.now() - start >= PHASE_TIMEOUT_MS.verifying) {
    throw new Error(`新版验证超时。日志：${logFile ?? ''}`);
  }
}

async function rollbackIfNeeded(io: SwitchIo, handoff: UpdateHandoff, phase: UpdaterPhase): Promise<void> {
  const pointer = await loadPointer(io, handoff.installRoot);
  const decision = decideRecovery({
    phase,
    current: pointer.current,
    fromVersion: handoff.fromVersion,
    toVersion: handoff.toVersion,
    readyVersion: null,
  });
  if (decision.action !== 'rollback-pointer') return;
  const fresh = await loadPointer(io, handoff.installRoot);
  await commitCurrent(io, handoff.installRoot, pointBack(fresh, iso(io.now())));
}

async function loadPointer(io: SwitchIo, installRoot: string): Promise<CurrentPointer> {
  const pointer = await io.readCurrent(installRoot);
  return readCurrent(installRoot, async () => JSON.stringify(pointer));
}

/** 冻结 writeCurrent 负责校验。真正落盘交给 io.writeCurrent，单测不必写磁盘。 */
async function commitCurrent(io: SwitchIo, installRoot: string, pointer: CurrentPointer): Promise<void> {
  let staged = '';
  await writeCurrent(installRoot, pointer, {
    mkdir: async () => undefined,
    readFile: async () => JSON.stringify(await io.readCurrent(installRoot)),
    writeFile: async (_file, data) => {
      staged = data;
    },
    rename: async () => {
      await io.writeCurrent(installRoot, JSON.parse(staged) as CurrentPointer);
    },
    rm: async () => undefined,
    sleep: async () => undefined,
  });
}

function launchEnv(handoff: UpdateHandoff): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.KB_USER_DATA = handoff.userDataDir;
  env.KB_INSTALL_ROOT = handoff.installRoot;
  env.KB_LAYOUT_VERSION = handoff.toVersion;
  return env;
}

async function endPhase(io: SwitchIo, phase: UpdaterPhase, start: number): Promise<void> {
  const atMs = io.now();
  await io.appendLog(formatPhaseLog({
    phase,
    event: 'end',
    at: iso(atMs),
    ms: atMs - start,
    result: 'ok',
  }));
}

async function publish(io: SwitchIo, installRoot: string, state: UpdaterState): Promise<void> {
  await io.writeState(installRoot, state);
  const started = state.startedAt ? Date.parse(state.startedAt) : io.now();
  io.onStatus?.(state, Math.max(0, io.now() - started));
}

function withLog(message: string, logFile: string | null): string {
  if (!logFile || message.includes(logFile)) return message;
  return `${message} 日志：${logFile}`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}
