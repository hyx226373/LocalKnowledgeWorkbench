import fs from 'node:fs';
import path from 'node:path';
import { handleRequest } from './handlers';
import { initBridgeTree, buildManifest } from './initBridge';
import { isUuidV4, resolveBridgeRoot, responseFileName } from './paths';
import type { BridgeHost, BridgeResponse } from './types';
import { stripPseudo, validateRequest } from './validate';

const MAX_BYTES = 8 * 1024 * 1024;

export interface BridgeOptions {
  userDataDir: string;
  bridgeRoot?: string;
  appCommit?: string;
  modulesCommit?: string;
  host: BridgeHost;
  pollMs?: number;
  useChokidar?: boolean;
  stableMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RunningBridge {
  root: string;
  pumpOnce(): Promise<void>;
  /** G2：把计划状态回写到响应。没有计划桥时为空操作。 */
  syncPlans(): Promise<void>;
  close(): Promise<void>;
}

function writeResponse(root: string, body: BridgeResponse): void {
  const dest = path.join(root, 'responses', responseFileName(body.requestId));
  const tmp = path.join(root, 'responses', `.${body.requestId}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8');
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
}

function readResponse(root: string, requestId: string): BridgeResponse | null {
  if (!isUuidV4(requestId)) return null;
  const dest = path.join(root, 'responses', responseFileName(requestId));
  try {
    const parsed = JSON.parse(fs.readFileSync(dest, 'utf8')) as BridgeResponse;
    if (!parsed || parsed.requestId?.toLowerCase() !== requestId.toLowerCase() || !parsed.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function startAgentBridge(opts: BridgeOptions): Promise<RunningBridge> {
  const root = resolveBridgeRoot(opts.userDataDir, opts.bridgeRoot);
  const manifest = buildManifest(opts.appCommit, opts.modulesCommit);
  initBridgeTree(root, manifest);
  const requestsDir = path.join(root, 'requests');
  const stableMs = opts.stableMs ?? 150;
  const pollMs = opts.pollMs ?? 400;
  const log = opts.log ?? ((message) => console.error(`[agent-bridge] ${message}`));
  const now = opts.now ?? (() => new Date());
  const inflight = new Map<string, Promise<void>>();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let watcher: { close(): Promise<void> } | undefined;

  const stamp = (requestId: string, status: BridgeResponse['status'], extra: Partial<BridgeResponse> = {}): BridgeResponse => ({
    requestId,
    status,
    updatedAt: now().toISOString(),
    ...extra,
  });

  const enqueue = (name: string): void => {
    if (closed || !name.endsWith('.json')) return;
    const requestId = name.slice(0, -'.json'.length);
    if (!isUuidV4(requestId)) {
      log(`忽略非法请求文件名 ${name}`);
      return;
    }
    if (inflight.has(requestId) || readResponse(root, requestId)) return;
    const job = processFile(requestId).finally(() => inflight.delete(requestId));
    inflight.set(requestId, job);
  };

  async function processFile(requestId: string): Promise<void> {
    const full = path.join(requestsDir, `${requestId}.json`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      return;
    }
    if (stableMs > 0 && Date.now() - stat.mtimeMs < stableMs) return;
    const ignored: string[] = [];
    const baseExtra = () => (ignored.length ? { ignoredFields: ignored } : {});
    if (stat.size > MAX_BYTES) {
      writeResponse(root, stamp(requestId, 'failed', { error: { code: 'incomplete_request', message: '请求过大' }, ...baseExtra() }));
      return;
    }
    let text: string;
    try {
      text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '');
    } catch (err) {
      log(`读取请求失败 ${requestId}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      writeResponse(root, stamp(requestId, 'failed', { error: { code: 'incomplete_request', message: '不是合法 JSON' } }));
      return;
    }
    const stripped = stripPseudo(parsed, ignored);
    const validated = validateRequest(stripped, requestId);
    if (!validated.ok) {
      writeResponse(root, stamp(requestId, 'failed', { error: { code: validated.code, message: validated.message }, ...baseExtra() }));
      return;
    }
    validated.value.ignoredFields = ignored;
    const awaitsUser = validated.value.type === 'plan-submit' || validated.value.classify?.action === 'move';
    writeResponse(root, stamp(requestId, 'pending', baseExtra()));
    if (!awaitsUser) writeResponse(root, stamp(requestId, 'running', baseExtra()));
    try {
      const outcome = await handleRequest(validated.value, opts.host, root, (id) => readResponse(root, id));
      const body = stamp(requestId, outcome.status, {
        ...baseExtra(),
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.planId ? { planId: outcome.planId } : {}),
      });
      writeResponse(root, body);
    } catch (err) {
      writeResponse(root, stamp(requestId, 'failed', {
        ...baseExtra(),
        error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  async function pumpOnce(): Promise<void> {
    if (closed) return;
    let names: string[] = [];
    try {
      names = fs.readdirSync(requestsDir);
    } catch (err) {
      log(`列举请求失败: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    for (const name of names) enqueue(name);
    for (let round = 0; round < 4 && inflight.size; round++) {
      await Promise.all([...inflight.values()]);
      if (stableMs > 0) break;
    }
  }

  if (opts.useChokidar !== false) {
    try {
      const chokidar = await import('chokidar');
      const watched = chokidar.watch(requestsDir, {
        ignoreInitial: true,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: Math.max(stableMs, 50), pollInterval: 50 },
      });
      watched.on('add', (file) => enqueue(path.basename(file)));
      watched.on('change', (file) => enqueue(path.basename(file)));
      watched.on('error', (err) => log(`监视请求目录失败: ${err instanceof Error ? err.message : String(err)}`));
      watcher = { close: () => watched.close() };
    } catch (err) {
      log(`未使用 chokidar，改为轮询: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (pollMs > 0) timer = setInterval(() => void pumpOnce().catch((err) => log(String(err))), pollMs);
  if (timer) timer.unref?.();
  await pumpOnce();

  return {
    root,
    pumpOnce,
    async syncPlans() {},
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await watcher?.close().catch(() => undefined);
      await Promise.all([...inflight.values()]).catch(() => undefined);
    },
  };
}
