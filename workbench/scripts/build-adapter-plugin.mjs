// 把一个 SDK 适配器插件源码目录打包成可安装的插件文件夹（开发者模式“安装本地插件文件夹”选它）：
//   node scripts/build-adapter-plugin.mjs <插件源码目录> --out <输出目录>
// 产物：<out>/manifest.json + <out>/<manifest.main>（单文件 ES 模块，含插件代码与它用到的 SDK 策略函数）。
// '@kb-workbench/adapter-sdk[/policy|/types]' 解析到核心内置的 SDK 副本（src/shared/adapter-sdk，来自 kb-adapter-sdk@050df08），
// 不需要插件目录里有 node_modules。插件入口默认 src/index.ts（可用 --entry 指定）。
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(here, '../src/shared/adapter-sdk');
const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const out = flag('--out');
const entryRel = flag('--entry') ?? 'src/index.ts';
const src = args[0];
if (!src || !out) {
  console.error('用法：node scripts/build-adapter-plugin.mjs <插件源码目录> --out <输出目录> [--entry src/index.ts]');
  process.exit(2);
}
const srcDir = path.resolve(src);
const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'manifest.json'), 'utf8'));
if (typeof manifest.main !== 'string' || !/\.m?js$/.test(manifest.main)) throw new Error('manifest.main 必须是 .js/.mjs');
const outDir = path.resolve(out);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const sdkAlias = {
  name: 'kb-adapter-sdk-alias',
  setup(b) {
    b.onResolve({ filter: /^@kb-workbench\/adapter-sdk(\/(policy|types|mock-host))?$/ }, (a) => {
      const sub = a.path.split('/')[2];
      if (sub === 'mock-host') return { errors: [{ text: 'mock-host 只用于单元测试，不能打包进插件' }] };
      return { path: path.join(sdk, `${sub ?? 'index'}.ts`) };
    });
  },
};
await build({
  entryPoints: [path.join(srcDir, entryRel)],
  outfile: path.join(outDir, ...manifest.main.split('/')),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: false,
  legalComments: 'none',
  plugins: [sdkAlias],
  logLevel: 'warning',
});
fs.copyFileSync(path.join(srcDir, 'manifest.json'), path.join(outDir, 'manifest.json'));
for (const extra of ['README.md', 'LICENSE']) if (fs.existsSync(path.join(srcDir, extra))) fs.copyFileSync(path.join(srcDir, extra), path.join(outDir, extra));
console.log(`已打包 ${manifest.id}@${manifest.version} → ${outDir}`);
