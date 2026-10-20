// 外贴 26 的 G4。无窗口，日志在 D:\workspace\kb-work\upgrade-0026\g4\makebackup.log。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logFile = 'D:\\workspace\\kb-work\\upgrade-0026\\g4\\makebackup.log';

fs.mkdirSync(path.dirname(logFile), { recursive: true });

const env = { ...process.env, KB_UPDATE_HEADLESS_LOG: logFile };
delete env.ELECTRON_RUN_AS_NODE;

const electron = require('electron');
const script = path.join(root, 'scripts', 'update-backup-headless.mjs');
const child = spawn(electron, [script], { stdio: 'inherit', env, cwd: root });
child.on('exit', (code) => process.exit(code ?? 1));
