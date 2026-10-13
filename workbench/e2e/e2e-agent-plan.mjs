/**
 * G2：计划审批与冲突。不连 HTTP。
 * 单测覆盖冲突映射；文件请求覆盖伪 approved、人批 success、改计划 conflict、外改、拒绝、重启不幽灵执行。
 * 与 e2e-plans 相同的批准入口（UiOps.approve）在 tests/agent-plan-bridge.test.ts 里对真实 op_log 再跑一遍。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const esbuildCandidates = [
  path.resolve(project, 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.resolve(project, '..', 'kb-workbench-r11', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  path.resolve(project, '..', 'kb-workbench', 'node_modules', 'esbuild', 'bin', 'esbuild'),
];
const esbuild = esbuildCandidates.find((candidate) => fs.existsSync(candidate));
if (!esbuild) {
  console.error('找不到 esbuild');
  process.exit(1);
}

function assertNoSelfApprove() {
  const root = path.join(project, 'src', 'main', 'agent-bridge');
  const banned = ['.approve(', 'better-sqlite3', 'runAsNode'];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'templates') continue;
        walk(full);
      } else if (ent.name.endsWith('.ts')) {
        const text = fs.readFileSync(full, 'utf8');
        for (const word of banned) {
          if (text.includes(word)) {
            console.error(`${path.relative(project, full)} 含有禁止片段 ${word}`);
            process.exit(1);
          }
        }
      }
    }
  };
  walk(root);
  const agentOps = fs.readFileSync(path.join(project, 'src', 'main', 'backend', 'operations.ts'), 'utf8');
  const face = agentOps.slice(agentOps.indexOf('export interface AgentOps'), agentOps.indexOf('const sha'));
  if (face.includes('approve')) {
    console.error('AgentOps 被加上了 approve');
    process.exit(1);
  }
}

assertNoSelfApprove();
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-bundle-'));
const bundle = path.join(out, 'planBridge.test.mjs');
const result = spawnSync(process.execPath, [
  esbuild,
  path.join(project, 'src', 'main', 'agent-bridge', 'planBridge.test.ts'),
  '--bundle',
  '--platform=node',
  '--format=esm',
  '--external:chokidar',
  `--outfile=${bundle}`,
], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
const test = spawnSync(process.execPath, ['--test', bundle], { stdio: 'inherit' });
if (test.status !== 0) process.exit(test.status ?? 1);
console.log('e2e-agent-plan ok');
