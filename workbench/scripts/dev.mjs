// 开发模式：先打包主进程，再启动 vite dev server 与 Electron
import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await new Promise((r, j) => spawn(process.execPath, ['scripts/build-main.mjs'], { stdio: 'inherit' }).on('exit', (c) => (c ? j(c) : r())));
const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const p = spawn(require('electron'), ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
p.on('exit', async () => {
  await server.close();
  process.exit(0);
});
