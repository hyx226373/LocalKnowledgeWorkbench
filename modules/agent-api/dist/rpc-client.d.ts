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
export declare function rpcCall(opts: RpcCallOptions): Promise<RpcCallResult>;
