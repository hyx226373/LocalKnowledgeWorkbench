import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbench } from './factory.ts';
import { startServer } from './server.ts';
import type { Permission } from './types.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const rootArg = arg('--root');
  if (!rootArg || !rootArg.includes('=')) {
    console.error(
      '用法: node src/cli.ts --root <id>=<路径> [--data-dir <目录>] [--token-name <名字>] [--permission read|readwrite]',
    );
    process.exit(1);
  }
  const splitAt = rootArg.indexOf('=');
  const rootId = rootArg.slice(0, splitAt);
  const localPath = path.resolve(rootArg.slice(splitAt + 1));
  if (!rootId || !fs.existsSync(localPath) || !fs.statSync(localPath).isDirectory()) {
    console.error('--root 必须是 已存在目录，格式 id=路径');
    process.exit(1);
  }
  const permission = (arg('--permission') ?? 'readwrite') as Permission;
  if (permission !== 'read' && permission !== 'readwrite') {
    console.error('--permission 只能是 read 或 readwrite');
    process.exit(1);
  }
  const dataDir = path.resolve(
    arg('--data-dir') ?? path.join(process.env.APPDATA ?? process.cwd(), 'kb-workbench'),
  );
  const tokenName = arg('--token-name') ?? 'default';
  const services = await createWorkbench({
    dataDir,
    roots: [{ id: rootId, name: rootId, localPath }],
  });
  const started = await startServer({
    dataDir,
    services,
    tokens: [{ name: tokenName, rootIds: [rootId], permission }],
  });
  const token = started.tokens[0];
  if (!token) throw new Error('no token');
  console.log(
    JSON.stringify(
      {
        url: started.url,
        host: `127.0.0.1:${started.port}`,
        port: started.port,
        token: token.secret,
        tokenName: token.name,
        permission: token.permission,
        rootIds: token.rootIds,
        tokenFile: started.tokenFile,
      },
      null,
      2,
    ),
  );
  const shutdown = () => {
    void started
      .close()
      .then(() => services.close())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && entry.toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
