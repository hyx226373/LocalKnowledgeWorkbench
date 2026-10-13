// 用 Electron 自带的 Node 运行命令（ELECTRON_RUN_AS_NODE），保证原生模块 ABI 与应用一致。
// 用法：node scripts/run-electron-node.mjs <script> [...args]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const electron = require('electron');
const [script, ...args] = process.argv.slice(2);
const p = spawn(electron, [script, ...args], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
p.on('exit', (c) => process.exit(c ?? 1));
