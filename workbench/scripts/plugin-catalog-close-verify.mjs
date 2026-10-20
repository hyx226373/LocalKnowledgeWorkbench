/**
 * 插件点装收尾：跑三路径相关单测并落证据 JSON（隔离 tmp dataDir，不碰用户库）。
 * node scripts/plugin-catalog-close-verify.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDirs = [
  path.join(ROOT, '..', '..', '收口-day', '插件点装收尾', 'evidence'),
  path.join(ROOT, 'tmp-plugin-close-evidence'),
];
let evidenceDir = outDirs[1];
for (const d of outDirs) {
  try {
    fs.mkdirSync(d, { recursive: true });
    evidenceDir = d;
    break;
  } catch {}
}

const r = spawnSync(
  process.execPath,
  [path.join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/plugin-catalog-install.test.ts', '--reporter=json', `--outputFile=${path.join(evidenceDir, 'vitest-plugin-catalog.json')}`],
  { cwd: ROOT, encoding: 'utf8', env: { ...process.env } },
);
const summary = {
  at: new Date().toISOString(),
  exitCode: r.status,
  stdoutTail: (r.stdout || '').slice(-2000),
  stderrTail: (r.stderr || '').slice(-2000),
  paths: {
    normalInstall: 'fixture zip+sha256+ed25519 → plugins/',
    verifyFail: 'bad signature → PluginCatalogError 拦装',
    installFail: 'zip missing manifest → 安装失败提示',
    urlSave: 'settings.pluginCatalogUrl absolute path → sourceKind=settings',
    restart: 'close+reopen same dataDir → enabled',
  },
};
fs.writeFileSync(path.join(evidenceDir, 'isolated-three-paths.json'), JSON.stringify(summary, null, 2));
console.log(r.stdout || '');
if (r.stderr) console.error(r.stderr);
console.log('evidence', evidenceDir, 'exit', r.status);
process.exit(r.status ?? 1);
