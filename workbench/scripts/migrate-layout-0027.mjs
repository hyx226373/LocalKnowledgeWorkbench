// 把 runMigrate 打成临时 cjs 再迁移。不启动 Electron，不写 D:\example_dev。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = 'D:\\workspace\\kb-work\\updater-0027\\tmp';

function arg(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return '';
  const value = process.argv[index + 1] ?? '';
  if (!value || value.startsWith('--')) return '';
  return value;
}

function underStudyDev(target) {
  const resolved = path.win32.resolve(target).toLowerCase();
  const banned = 'd:\\example_dev';
  return resolved === banned || resolved.startsWith(`${banned}\\`);
}

const installRoot = arg('--root');
const fileVersion = arg('--version');
if (!installRoot || !fileVersion) {
  console.error('用法: node scripts/migrate-layout-0027.mjs --root <安装根> --version <FileVersion>');
  process.exit(2);
}
if (underStudyDev(installRoot)) {
  console.error('拒绝迁移 D:\\example_dev');
  process.exit(2);
}

const { build } = await import('esbuild');
const fs = await import('node:fs/promises');
await fs.mkdir(TMP, { recursive: true });
const outfile = path.join(TMP, 'migrate-layout-0027.cjs');
await build({
  absWorkingDir: repo,
  entryPoints: [path.join(repo, 'src', 'migrate', 'runMigrate.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});

const mod = require(outfile);
const result = await mod.migrateLayout({ installRoot, fileVersion });
console.log(JSON.stringify(result));
process.exit(result && result.ok === true ? 0 : 1);
