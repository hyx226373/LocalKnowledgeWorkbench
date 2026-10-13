import { type IssuedToken, type TokenSpec, type WorkbenchServices } from './types.js';
export interface StartServerOptions {
    /** 只能是 127.0.0.1。0.0.0.0 和其他地址在 listen 之前抛错。 */
    host?: string;
    /** 默认 0，由系统分配。 */
    port?: number;
    dataDir: string;
    tokens: TokenSpec[];
    services: WorkbenchServices;
}
export interface StartedServer {
    host: '127.0.0.1';
    port: number;
    url: string;
    tokenFile: string;
    tokens: IssuedToken[];
    close(): Promise<void>;
}
export declare function assertLoopbackHost(host: string): void;
export declare function startServer(opts: StartServerOptions): Promise<StartedServer>;
