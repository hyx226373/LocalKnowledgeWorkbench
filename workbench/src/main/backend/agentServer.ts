/**
 * Agent 入口（第 10 轮）：仅 127.0.0.1 + Bearer token。
 * 只暴露 propose / get / preview；approve / apply 一律 403。
 * 与界面共用 OperationService，agent 提出的计划出现在 UI pending 列表。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AgentOps, OperationService, ProposedOp } from './operations';

export interface AgentServerInfo {
  host: '127.0.0.1';
  port: number;
  url: string;
  tokenFile: string;
  token: string;
  close(): Promise<void>;
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function assertLoopbackHost(host: string) {
  if (host !== '127.0.0.1' && host !== '::1') throw new Error(`agent 只能绑定 loopback，收到 ${host}`);
}

export async function startAgentServer(opts: {
  dataDir: string;
  ops: OperationService;
  agentName?: string;
  port?: number;
}): Promise<AgentServerInfo> {
  const host = '127.0.0.1';
  assertLoopbackHost(host);
  const tokenFile = path.join(opts.dataDir, 'agent-token.json');
  let token = crypto.randomBytes(24).toString('hex');
  try {
    const prev = JSON.parse(fs.readFileSync(tokenFile, 'utf8')) as { token?: string };
    if (prev.token && typeof prev.token === 'string') token = prev.token;
  } catch {
    /* new */
  }
  fs.mkdirSync(opts.dataDir, { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({ token, host, note: '仅本机 loopback；勿提交到版本库' }, null, 2), { mode: 0o600 });

  const agent: AgentOps = opts.ops.forAgent(opts.agentName ?? 'http');

  const server = http.createServer(async (req, res) => {
    try {
      const addr = req.socket.remoteAddress || '';
      if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') {
        send(res, 403, { error: 'host_forbidden' });
        return;
      }
      const auth = req.headers.authorization || '';
      const got = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (got !== token) {
        send(res, 401, { error: 'unauthorized' });
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        send(res, 200, { ok: true });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/rpc') {
        send(res, 404, { error: 'not_found' });
        return;
      }
      const body = (await readJson(req)) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      const id = body.id ?? null;
      const method = String(body.method || '');
      if (method === 'plans.approve' || method === 'plans.apply' || method === 'approve' || method === 'apply') {
        send(res, 403, { jsonrpc: '2.0', id, error: { code: -32003, message: 'user_approval_required' } });
        return;
      }
      if (method === 'plans.create' || method === 'propose') {
        const title = String(body.params?.title ?? '');
        const ops = (body.params?.ops ?? []) as ProposedOp[];
        const result = await agent.propose(title, ops);
        send(res, 200, { jsonrpc: '2.0', id, result });
        return;
      }
      if (method === 'plans.get' || method === 'get') {
        const planId = String(body.params?.planId ?? '');
        const result = await agent.get(planId);
        send(res, 200, { jsonrpc: '2.0', id, result });
        return;
      }
      if (method === 'plans.preview') {
        const planId = String(body.params?.planId ?? '');
        const plan = await agent.get(planId);
        send(res, 200, { jsonrpc: '2.0', id, result: plan });
        return;
      }
      send(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'method_not_found' } });
    } catch (e) {
      send(res, 500, { error: String((e as Error).message ?? e) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('agent server 未取得端口');
  const port = addr.port;
  return {
    host,
    port,
    url: `http://127.0.0.1:${port}/rpc`,
    tokenFile,
    token,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeIdleConnections();
        server.closeAllConnections();
      }),
  };
}
