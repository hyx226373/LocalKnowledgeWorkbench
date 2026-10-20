// 把 unpacked、launcher、updater 组装成版本目录布局。不启动程序。
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

async function isDir(fs, dir) {
  if (!dir) return false;
  try {
    const info = await fs.stat(dir);
    return info.isDirectory();
  } catch {
    return false;
  }
}

const unpacked = arg('--unpacked');
const versionArg = arg('--version');
const out = arg('--out');
const launcher = arg('--launcher');
const updater = arg('--updater');
if (!unpacked || !versionArg || !out || !launcher || !updater) {
  console.error('用法: node scripts/assemble-layout-0027.mjs --unpacked <dir> --version <版本> --out <dir> --launcher <dir> --updater <dir>');
  process.exit(2);
}
if (underStudyDev(out)) {
  console.error('拒绝写入 D:\\example_dev');
  process.exit(2);
}

const fs = await import('node:fs/promises');
const missing = [];
for (const dir of [unpacked, out, launcher, updater]) {
  if (!(await isDir(fs, dir))) missing.push(dir);
}
if (missing.length > 0) {
  console.error(`目录不存在：${missing.join('、')}`);
  process.exit(2);
}

const { build } = await import('esbuild');
await fs.mkdir(TMP, { recursive: true });
const outfile = path.join(TMP, 'assemble-layout-0027.cjs');
await build({
  absWorkingDir: repo,
  entryPoints: [path.join(repo, 'src', 'shared', 'layout', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const layout = require(outfile);
if (layout.isUnderStudyDev(out)) {
  console.error('拒绝写入 D:\\example_dev');
  process.exit(2);
}

let version = '';
try {
  version = layout.versionDirName(versionArg);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const dest = layout.versionDir(out, version);
await fs.rm(dest, { recursive: true, force: true });
await fs.mkdir(path.win32.dirname(dest), { recursive: true });
await fs.cp(unpacked, dest, { recursive: true, force: true });
await layout.writeCurrent(out, {
  schema: 1,
  current: version,
  previous: null,
  updatedAt: new Date().toISOString(),
});
const launcherDest = path.win32.join(path.win32.resolve(out), 'launcher');
const updaterDest = path.win32.join(path.win32.resolve(out), 'updater');
await fs.rm(launcherDest, { recursive: true, force: true });
await fs.rm(updaterDest, { recursive: true, force: true });
await fs.cp(launcher, launcherDest, { recursive: true, force: true });
await fs.cp(updater, updaterDest, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, version, out: path.win32.resolve(out) }));
