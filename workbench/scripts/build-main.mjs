// 用 esbuild 打包主进程、preload 与索引 worker（CJS），better-sqlite3 保持外部依赖（原生模块）；
// 另打包第三方插件沙箱 iframe 的宿主运行时（浏览器 ES 模块，out/plugin-runtime/runtime.js）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
// @kb/indexer 的 exports 只有 import 条件；CJS 主进程按相对路径 require 真实 fork.js（require(esm)），
// 开发版 <仓库>/node_modules、打包版 app.asar/node_modules 都成立，且与 dist/index.js 内的 ./fork.js 同一 ESM 实例
const kbIndexerFork = { name: 'kb-indexer-fork', setup(b) { b.onResolve({ filter: /^@kb\/indexer\/fork$/ }, () => ({ path: '../../node_modules/@kb/indexer/dist/fork.js', external: true })); } };
const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const reapSrc = path.resolve('src/main/reap-orphans.cs');
const reapOut = path.resolve('out/main/reap-orphans.exe');
if (fs.existsSync(csc)) {
  fs.mkdirSync(path.dirname(reapOut), { recursive: true });
  execFileSync(csc, ['/nologo', '/optimize+', `/out:${reapOut}`, reapSrc], { stdio: 'inherit' });
} else {
  console.log('[build] 没有 csc.exe，跳过 reap-orphans.exe');
}
const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: true, external: ['electron', 'better-sqlite3', '@parcel/watcher', 'chokidar', '@kb/indexer', '@kb/sync', '@kb/identity-watch', '@kb/plan', '@kb/fileops', '@kb/agent-api', 'pdfjs-dist'], logLevel: 'info' };
await Promise.all([
  build({ ...common, plugins: [kbIndexerFork], entryPoints: { index: 'src/main/index.ts', dataEntry: 'src/main/data/entry.ts', indexWorker: 'src/main/indexWorker.ts', migrationPreload: 'src/main/migration/preload.ts', updateBackupWorker: 'src/main/update/backupWorker.ts' }, outdir: 'out/main' }),
  build({ ...common, entryPoints: { index: 'src/preload/index.ts' }, outdir: 'out/preload' }),
  build({ bundle: true, platform: 'browser', format: 'esm', target: 'chrome130', sourcemap: false, entryPoints: { runtime: 'src/plugin-runtime/runtime.ts' }, outdir: 'out/plugin-runtime', logLevel: 'info' }),
]);
if (watch) console.log('watch 模式未实现：修改主进程代码后重新运行 npm run dev');
