import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test } from 'vitest';
import { boot } from './helpers.ts';

const mcpScript = fileURLToPath(new URL('../src/mcp.ts', import.meta.url));

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  return { ...env, ...extra };
}

test('stdio MCP lists tools and calls search.query and ops.preview', async () => {
  const box = await boot();
  const stderr: string[] = [];
  let transport: StdioClientTransport | undefined;
  let client: Client | undefined;
  try {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [mcpScript],
      env: childEnv({
        KB_AGENT_URL: `http://127.0.0.1:${box.started.port}/rpc`,
        KB_AGENT_TOKEN: box.writerSecret,
      }),
      stderr: 'pipe',
    });
    transport.stderr?.on('data', (chunk: Buffer | string) => {
      stderr.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    client = new Client({ name: 'kb-agent-test', version: '0.0.1' });
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'roots.list',
        'fs.list',
        'fs.read',
        'search.query',
        'ops.preview',
        'ops.apply',
        'ops.restore',
        'ops.log',
        'plans.create',
        'plans.preview',
        'plans.approve',
        'plans.apply',
        'plans.get',
      ]),
    );
    for (const name of ['ops.preview', 'ops.apply', 'ops.restore']) {
      const tool = listed.tools.find((item) => item.name === name);
      expect(tool?.description ?? '', name).toContain('写操作先 preview');
    }
    const applyTool = listed.tools.find((item) => item.name === 'ops.apply');
    expect(applyTool?.description ?? '').toContain('必须走计划');
    const rotate = listed.tools.find((item) => item.name === 'tokens.rotate');
    expect(rotate?.description ?? '').toContain('作废旧令牌');

    const search = await client.callTool({
      name: 'search.query',
      arguments: { query: 'hello knowledge', rootId: 'root-a' },
    });
    expect(search.isError).not.toBe(true);
    const searchText = JSON.stringify(search.content);
    expect(searchText).toContain('hello.txt');

    const before = path.join(box.rootA, 'docs', 'hello.txt');
    const preview = await client.callTool({
      name: 'ops.preview',
      arguments: {
        op: 'move',
        rootId: 'root-a',
        fromPath: 'docs/hello.txt',
        toPath: 'docs/preview-only.txt',
      },
    });
    expect(preview.isError, JSON.stringify(preview)).not.toBe(true);
    expect(JSON.stringify(preview.content)).toContain('previewId');
    const { existsSync } = await import('node:fs');
    expect(existsSync(before)).toBe(true);
    expect(existsSync(path.join(box.rootA, 'docs', 'preview-only.txt'))).toBe(false);

    const approved = await client.callTool({
      name: 'plans.approve',
      arguments: { planId: 'not-a-plan' },
    });
    expect(approved.isError).toBe(true);
    expect(JSON.stringify(approved.content)).toContain('user_approval_required');
    const applied = await client.callTool({
      name: 'plans.apply',
      arguments: { planId: 'not-a-plan' },
    });
    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied.content)).toContain('user_approval_required');
    const restored = await client.callTool({
      name: 'ops.restore',
      arguments: { opId: 'not-an-op', onConflict: 'cancel' },
    });
    expect(restored.isError).toBe(true);
    expect(JSON.stringify(restored.content)).toContain('plan_required');
    expect(existsSync(before)).toBe(true);
  } catch (error) {
    const detail = stderr.join('');
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\nSTDERR:\n${detail}`);
  } finally {
    await client?.close().catch(() => undefined);
    await transport?.close().catch(() => undefined);
    await box.cleanup();
  }
}, 90_000);
