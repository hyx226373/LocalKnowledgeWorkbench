// 把启动器打进独立 Electron 运行时。不执行生成的 kb-launch.exe。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = process.env.KB_LAYOUT_RUNTIME || path.join(repo, 'node_modules', 'electron', 'dist');
const out = process.env.KB_LAYOUT_OUT || 'D:\\workspace\\kb-work\\updater-0027\\build\\launcher';

if (!fs.existsSync(runtime) || !fs.statSync(runtime).isDirectory()) {
  console.error(`运行时目录不存在：${runtime}`);
  process.exit(2);
}

const planned = await build({
  entryPoints: [path.join(repo, 'src', 'launcher', 'runtimePlan.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  logLevel: 'silent',
});
const planMod = await import(`data:text/javascript;base64,${Buffer.from(planned.outputFiles[0].text).toString('base64')}`);
const plan = planMod.planLauncherRuntime(runtime);
if (!plan.copies.some((item) => item.to === plan.renameExe.to)) {
  console.error('运行时里没有 electron.exe，不能改名为 kb-launch.exe');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
for (const item of plan.copies) {
  const dest = path.join(out, item.to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(runtime, item.from), dest);
}

const appDir = path.join(out, 'resources', 'app');
fs.mkdirSync(appDir, { recursive: true });
await build({
  entryPoints: [path.join(repo, 'src', 'launcher', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(appDir, plan.packageMain),
  external: ['electron'],
  sourcemap: false,
  logLevel: 'info',
  footer: {
    js: [
      'if (require.main === module) {',
      '  Promise.resolve(module.exports.bootFromElectron()).catch((err) => {',
      '    console.error(err);',
      '    process.exit(1);',
      '  });',
      '}',
      '',
    ].join('\n'),
  },
});
fs.writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify({ name: 'kb-launcher', private: true, main: plan.packageMain }, null, 2)}\n`,
  'utf8',
);
console.log(`[launcher] ${out}`);
