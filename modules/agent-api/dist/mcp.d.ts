import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export declare const mcpScriptPath: string;
interface RpcTarget {
    port: number;
    token: string;
    path: string;
}
export declare function createMcpServer(target: RpcTarget): McpServer;
export declare function startMcpStdio(): Promise<void>;
export {};
