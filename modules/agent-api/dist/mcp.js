import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { rpcCall } from "./rpc-client.js";
export const mcpScriptPath = fileURLToPath(import.meta.url);
const PREVIEW_NOTE = '写操作先 preview';
function toolText(value, isError = false) {
    return {
        content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
        ...(isError ? { isError: true } : {}),
    };
}
async function callTool(target, method, params) {
    const response = await rpcCall({
        port: target.port,
        token: target.token,
        path: target.path,
        method,
        params,
        hostHeader: `127.0.0.1:${target.port}`,
    });
    const body = response.body;
    if (response.status !== 200 || !body || typeof body !== 'object') {
        return toolText(response.raw || `HTTP ${response.status}`, true);
    }
    const record = body;
    if (record.error)
        return toolText(record.error.message ?? 'rpc error', true);
    return toolText(record.result ?? null);
}
export function createMcpServer(target) {
    const server = new McpServer({ name: 'kb-agent-api', version: '0.1.0' });
    server.registerTool('roots.list', { description: '列出当前令牌可访问的根目录。', inputSchema: {} }, async () => callTool(target, 'roots.list', {}));
    server.registerTool('fs.list', {
        description: '列出根目录里的一个目录。',
        inputSchema: {
            rootId: z.string(),
            path: z.string().describe('相对路径，空字符串表示根目录本身'),
        },
    }, async (args) => callTool(target, 'fs.list', args));
    server.registerTool('fs.read', {
        description: '读取文本或 PDF 正文。文本超限截断。PDF 用索引器按页返回 pages（page 与 text），超限拒绝。',
        inputSchema: {
            rootId: z.string(),
            path: z.string(),
            maxBytes: z.number().int().positive().optional(),
        },
    }, async (args) => callTool(target, 'fs.read', args));
    server.registerTool('search.query', {
        description: '在令牌允许的根目录里搜索文件名、路径和正文。结果按资料聚合，PDF 锚点是页码，txt 和 md 锚点是行号。',
        inputSchema: {
            query: z.string(),
            rootId: z.string().optional(),
            limit: z.number().int().positive().optional(),
        },
    }, async (args) => callTool(target, 'search.query', args));
    server.registerTool('ops.preview', {
        description: `预览移动、改名或恢复，不修改磁盘。${PREVIEW_NOTE}。`,
        inputSchema: {
            op: z.enum(['move', 'rename', 'restore']),
            rootId: z.string().optional(),
            fromPath: z.string().optional(),
            toPath: z.string().optional(),
            opId: z.string().optional(),
        },
    }, async (args) => callTool(target, 'ops.preview', args));
    server.registerTool('ops.apply', {
        description: `执行已经预览过的移动或改名。${PREVIEW_NOTE}。agent 令牌调用会被拒绝，必须走计划。`,
        inputSchema: { previewId: z.string() },
    }, async (args) => callTool(target, 'ops.apply', args));
    server.registerTool('ops.restore', {
        description: `直接恢复会被拒绝，必须把 restore 放进计划并由界面批准。错误 plan_required。${PREVIEW_NOTE}。`,
        inputSchema: {
            opId: z.string().optional(),
            previewId: z.string().optional(),
            onConflict: z.enum(['cancel', 'rename', 'overwrite']),
        },
    }, async (args) => callTool(target, 'ops.restore', args));
    server.registerTool('ops.log', {
        description: '读取操作记录。',
        inputSchema: {
            limit: z.number().int().positive().optional(),
            rootId: z.string().optional(),
        },
    }, async (args) => callTool(target, 'ops.log', args));
    server.registerTool('plans.create', {
        description: '建立文件操作计划，不写用户文件。create 和 write 的 content 是字符串。',
        inputSchema: {
            title: z.string(),
            ops: z.array(z.object({
                type: z.enum(['create', 'write', 'move', 'rename', 'delete', 'restore']),
                rootId: z.string().optional(),
                relPath: z.string().optional(),
                content: z.string().optional(),
                fromRelPath: z.string().optional(),
                toRelPath: z.string().optional(),
                toRootId: z.string().optional(),
                opId: z.string().optional(),
                onConflict: z.enum(['cancel', 'rename', 'overwrite']).optional(),
            })),
        },
    }, async (args) => callTool(target, 'plans.create', args));
    server.registerTool('plans.preview', {
        description: '按顺序预览计划。不写盘，后面的步骤看得到前面步骤的虚拟结果。',
        inputSchema: { planId: z.string() },
    }, async (args) => callTool(target, 'plans.preview', args));
    server.registerTool('plans.approve', {
        description: 'agent 不能批准计划。任何令牌调用都返回 user_approval_required，不会执行。',
        inputSchema: {
            planId: z.string(),
            approvedOpIds: z.array(z.string()).optional(),
        },
    }, async (args) => callTool(target, 'plans.approve', args));
    server.registerTool('plans.apply', {
        description: 'agent 不能执行计划。任何令牌调用都返回 user_approval_required，不会执行。',
        inputSchema: { planId: z.string() },
    }, async (args) => callTool(target, 'plans.apply', args));
    server.registerTool('plans.get', {
        description: '读取一个计划。',
        inputSchema: { planId: z.string() },
    }, async (args) => callTool(target, 'plans.get', args));
    server.registerTool('tokens.rotate', {
        description: '轮换当前令牌。这会作废旧令牌，只有返回的新令牌仍然有效。',
        inputSchema: {},
    }, async () => callTool(target, 'tokens.rotate', {}));
    return server;
}
export async function startMcpStdio() {
    const urlText = process.env.KB_AGENT_URL;
    const token = process.env.KB_AGENT_TOKEN;
    if (!urlText || !token) {
        console.error('KB_AGENT_URL and KB_AGENT_TOKEN are required');
        process.exit(1);
    }
    const url = new URL(urlText);
    if (url.hostname !== '127.0.0.1' || !url.port) {
        console.error('KB_AGENT_URL must be http://127.0.0.1:<port>/rpc');
        process.exit(1);
    }
    const server = createMcpServer({
        port: Number(url.port),
        token,
        path: url.pathname || '/rpc',
    });
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && entry.toLowerCase() === path.resolve(mcpScriptPath).toLowerCase()) {
    startMcpStdio().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    });
}
//# sourceMappingURL=mcp.js.map