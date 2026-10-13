// 内置适配器打包（第 11 轮 A）：builtin-adapters/<id>/（源码 + manifest）→ resources/builtin-adapters/<id>/（manifest.json + 单文件 main）。
//   node scripts/bundle-builtin-adapters.mjs           重新打包全部内置适配器（产物提交到仓库，dist:win 通过 build.extraResources 带上）
//   node scripts/bundle-builtin-adapters.mjs --check   只检查产物是否与源码一致（单测与集成前用；不一致时退出码 1）
// 打包复用 scripts/build-adapter-plugin.mjs（esbuild，SDK 导入解析到核心内置副本 src/shared/adapter-sdk）。
// 每个产物目录另写 BUILTIN.json：{ id, version, sourceHash }，sourceHash = 源码目录（manifest + src/**）与 SDK 副本的 sha256，用于 --check。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'builtin-adapters');
const OUT = path.join(ROOT, 'resources/builtin-adapters');
const check = process.argv.includes('--check');

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export function sourceHash(id) {
  const h = crypto.createHash('sha256');
  const files = [...listFiles(path.join(SRC, id)), ...['index.ts', 'policy.ts', 'types.ts'].map((f) => path.join(ROOT, 'src/shared/adapter-sdk', f))];
  for (const f of files) {
    h.update(path.relative(ROOT, f).replaceAll('\\', '/'));
    h.update('\0');
    h.update(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
    h.update('\0');
  }
  return h.digest('hex');
}

const ids = fs.existsSync(SRC) ? fs.readdirSync(SRC, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(SRC, e.name, 'manifest.json'))).map((e) => e.name) : [];
let bad = 0;
for (const id of ids) {
  const mf = JSON.parse(fs.readFileSync(path.join(SRC, id, 'manifest.json'), 'utf8'));
  if (mf.id !== id) throw new Error(`builtin-adapters/${id}/manifest.json 的 id（${mf.id}）必须与目录名一致`);
  const hash = sourceHash(id);
  const outDir = path.join(OUT, id);
  if (check) {
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(outDir, 'BUILTIN.json'), 'utf8'));
    } catch {
      /* 缺失 */
    }
    const ok = meta && meta.sourceHash === hash && meta.version === mf.version && fs.existsSync(path.join(outDir, ...mf.main.split('/')));
    if (!ok) {
      bad++;
      console.error(`内置适配器 ${id} 的打包产物已过期：请运行 node scripts/bundle-builtin-adapters.mjs`);
    } else console.log(`内置适配器 ${id}@${mf.version} 产物与源码一致`);
    continue;
  }
  execFileSync(process.execPath, [path.join(ROOT, 'scripts/build-adapter-plugin.mjs'), path.join(SRC, id), '--out', outDir], { stdio: 'inherit' });
  fs.writeFileSync(path.join(outDir, 'BUILTIN.json'), JSON.stringify({ id, version: mf.version, sourceHash: hash }, null, 2) + '\n');
}
if (!ids.length) console.log('没有内置适配器');
process.exit(bad ? 1 : 0);
