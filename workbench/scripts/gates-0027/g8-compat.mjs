// G8 双轨。不启动 Electron。parseLatestYml 不读旁边的 dirpack.json。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = 'D:\\workspace\\kb-work\\updater-0027\\tmp';
const FIXTURE = 'D:\\workspace\\kb-work\\updater-0027\\g8\\fixture';
const RESULT = 'D:\\workspace\\kb-work\\updater-0027\\g8\\g8-result.json';

const yml = [
  'version: 0.2.4',
  'files:',
  '  - url: LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe',
  "    sha512: 'abc'",
  '    size: 4',
  'path: LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe',
  "sha512: 'abc'",
  "releaseDate: '2026-10-10T00:00:00.000Z'",
  '',
].join('\n');

const dirpack = `${JSON.stringify({
  schema: 1,
  version: '0.2.5',
  file: 'LocalKnowledgeWorkbench-0.2.5-win-x64-dir.zip',
  size: 10,
  sha512: 'B'.repeat(88),
  releaseDate: '2026-10-11T00:00:00.000Z',
  minBaseline: '0.2.2',
}, null, 2)}\n`;

const fs = await import('node:fs/promises');
const { build } = await import('esbuild');
await fs.mkdir(TMP, { recursive: true });
await fs.mkdir(FIXTURE, { recursive: true });
await fs.writeFile(path.join(FIXTURE, 'latest.yml'), yml, 'utf8');
await fs.writeFile(path.join(FIXTURE, 'dirpack.json'), dirpack, 'utf8');

const outfile = path.join(TMP, 'g8-latest-yml.cjs');
await build({
  absWorkingDir: repo,
  entryPoints: [path.join(repo, 'src', 'shared', 'update', 'latestYml.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile,
  logLevel: 'silent',
});
const { parseLatestYml } = require(outfile);

const alone = parseLatestYml(yml);
const fromDisk = parseLatestYml(await fs.readFile(path.join(FIXTURE, 'latest.yml'), 'utf8'));
const withText = parseLatestYml(`${yml}\n${dirpack}`);
const same = JSON.stringify(alone) === JSON.stringify(fromDisk) && JSON.stringify(alone) === JSON.stringify(withText);
const pathOk = typeof alone.path === 'string' && alone.path.endsWith('-setup.exe');
const versionOk = alone.version === '0.2.4' && !yml.includes('0.2.5');

const payload = {
  ok: same && pathOk && versionOk,
  version: alone.version,
  path: alone.path,
  pathEndsWithSetupExe: pathOk,
  unchangedByDirpackText: same,
  latestYmlVersion: alone.version,
  newClientReads: 'dirpack.json',
  note: '新客户端只读 dirpack.json。0.2.4 的 latest.yml 仍指向 NSIS setup，不因旁边的 dirpack.json 改变 parseLatestYml。差量包不做。',
};
await fs.writeFile(RESULT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload));
process.exit(payload.ok === true ? 0 : 1);
