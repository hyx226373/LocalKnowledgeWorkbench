import http from 'node:http';

export interface RpcCallOptions {
  port: number;
  method: string;
  params?: unknown;
  token?: string;
  hostHeader?: string;
  origin?: string;
  path?: string;
  timeoutMs?: number;
}

export interface RpcCallResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: unknown;
}

export function rpcCall(opts: RpcCallOptions): Promise<RpcCallResult> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: opts.method,
    params: opts.params ?? {},
  });
  const hostHeader = opts.hostHeader ?? `127.0.0.1:${opts.port}`;
  const headers: http.OutgoingHttpHeaders = {
    Host: hostHeader,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    Connection: 'close',
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.origin) headers.Origin = opts.origin;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        path: opts.path ?? '/rpc',
        method: 'POST',
        setHost: false,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              body = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body });
        });
      },
    );
    req.setTimeout(opts.timeoutMs ?? 10_000, () => {
      req.destroy(new Error('rpc timeout'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
