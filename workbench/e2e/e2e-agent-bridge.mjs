/**
 * 文件桥验收：不起 HTTP 客户端。
 * 先跑单测，再写 requests/*.json 并读 responses/*.json。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const esbuildCandidates = [
  path.resolve(project, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.resolve(project, '..', 'kb-workbench', 'node_modules', 'esbuild', 'bin', 'esbuild'),
];
const esbuild = esbuildCandidates.find((candidate) => fs.existsSync(candidate));
if (!esbuild) {
  console.error('找不到 esbuild。需要应用依赖里的 esbuild，或上一级 kb-workbench/node_modules。');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertNoForbiddenApis() {
  const root = path.join(project, 'src', 'main', 'agent-bridge');
  const banned = ['better-sqlite3', 'node:sqlite', 'node:http', 'node:https', 'child_process', 'eval(', 'new Function', '.approve('];
  const files = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'templates') continue;
        walk(full);
      } else if (ent.name.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of banned) {
      if (text.includes(word)) {
        console.error(`${path.relative(project, file)} 含有禁止片段 ${word}`);
        process.exit(1);
      }
    }
  }
}

assertNoForbiddenApis();
run(process.execPath, [path.join(project, 'scripts', 'embed-templates.mjs')]);

const guide = fs.readFileSync(path.join(project, 'src', 'main', 'agent-bridge', 'templates', 'AGENT_START_HERE.md'), 'utf8');
const embedded = fs.readFileSync(path.join(project, 'src', 'main', 'agent-bridge', 'embedded.ts'), 'utf8');
if (!embedded.includes('文件 Agent 桥') || !guide.includes('批准只在界面')) {
  console.error('模板没有嵌进 embedded.ts');
  process.exit(1);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-bundle-'));
const testBundle = path.join(out, 'bridge.test.mjs');
const driverBundle = path.join(out, 'driver.mjs');
run(process.execPath, [
  esbuild,
  path.join(project, 'src', 'main', 'agent-bridge', 'bridge.test.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--external:chokidar',
  `--outfile=${testBundle}`,
]);
run(process.execPath, ['--test', testBundle]);
run(process.execPath, [
  esbuild,
  path.join(project, 'e2e', 'driver.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--external:chokidar',
  `--outfile=${driverBundle}`,
]);
const driver = await import(pathToFileURL(driverBundle).href);
await driver.runE2E();
console.log('e2e-agent-bridge ok');
