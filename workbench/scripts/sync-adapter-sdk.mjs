// 从 kb-adapter-sdk 重新同步 types.ts / policy.ts 到 src/shared/adapter-sdk（只改 import 后缀）。用法：node scripts/sync-adapter-sdk.mjs <SDK 路径>
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
const sdk = path.resolve(process.argv[2] ?? '../kb-adapter-sdk');
let commit = 'unknown';
try { commit = execSync('git rev-parse --short HEAD', { cwd: sdk }).toString().trim(); } catch {}
for (const f of ['types', 'policy']) {
  const src = fs.readFileSync(path.join(sdk, 'src', `${f}.ts`), 'utf8').replaceAll("from './types.js'", "from './types'");
  const head = `/* 来自 kb-adapter-sdk@${commit} src/${f}.ts（逐字复制，仅把 './types.js' 改为 './types'）。不要在这里改规则：规则变更先改 SDK，再重新同步。 */\n`;
  fs.writeFileSync(path.join('src/shared/adapter-sdk', `${f}.ts`), head + src);
}
const idx = 'src/shared/adapter-sdk/index.ts';
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/ADAPTER_SDK_COMMIT = '[^']*'/, `ADAPTER_SDK_COMMIT = '${commit}'`));
console.log(`已同步 kb-adapter-sdk@${commit}`);
