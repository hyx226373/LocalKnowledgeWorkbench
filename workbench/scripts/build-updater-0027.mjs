// 把可见更新器打进独立 Electron 运行时。不启动 exe。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const runtime = process.env.KB_LAYOUT_RUNTIME
  ? path.resolve(process.env.KB_LAYOUT_RUNTIME)
  : path.resolve('node_modules/electron/dist');
const exe = path.join(runtime, 'electron.exe');
if (!fs.existsSync(runtime) || !fs.existsSync(exe)) {
  console.error(`Electron 运行时不存在：${runtime}`);
  process.exit(2);
}

const out = path.resolve(process.env.KB_LAYOUT_OUT || 'D:/kb-r13-work/updater-0027/build/updater');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(runtime, out, { recursive: true, dereference: true });

const stale = path.join(out, 'resources', 'default_app.asar');
if (fs.existsSync(stale)) fs.rmSync(stale, { force: true });

const renamed = path.join(out, 'kb-updater.exe');
fs.renameSync(path.join(out, 'electron.exe'), renamed);

const appDir = path.join(out, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
await build({
  entryPoints: ['src/updater/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(appDir, 'main.js'),
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
});
fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify({ name: 'kb-updater', version: '0.2.4', main: 'main.js' }, null, 2)}\n`, 'utf8');

if (!fs.existsSync(renamed)) {
  console.error('kb-updater.exe 没有生成');
  process.exit(1);
}
console.log(`更新器已输出到 ${out}`);
