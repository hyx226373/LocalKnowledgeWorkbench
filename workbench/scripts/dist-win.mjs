// One-command release: source metadata -> staging -> ABI -> build -> package -> ABI -> manifest.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
const source = path.resolve(process.env.KB_RELEASE_SOURCE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
const commit = process.env.KB_RELEASE_COMMIT || (git.status === 0 ? git.stdout.trim() : '');
if (!commit) throw new Error('Provide KB_RELEASE_SOURCE or KB_RELEASE_COMMIT');
const staging = path.resolve(process.env.KB_RELEASE_STAGING || path.join(source, '..', 'release-staging', commit.slice(0, 12)));
const env = { ...process.env, KB_RELEASE_SOURCE: source, KB_RELEASE_COMMIT: commit, KB_RELEASE_STAGING: staging };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
function run(args, cwd = source) {
  const r = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error('Release step failed: ' + args.join(' ') + ' (exit ' + r.status + ')');
}
run([path.join(source, 'scripts/release-native.mjs')]);
run([path.join(source, 'scripts/check-native-abi.mjs'), path.join(staging, 'native-abi-manifest.json')]);
run([path.join(staging, 'scripts/build-main.mjs')], staging);
run([path.join(staging, 'node_modules/vite/bin/vite.js'), 'build'], staging);
const electronVersion = fs.readFileSync(path.join(source, 'node_modules/electron/dist/version'), 'utf8').trim();
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['dir', 'portable', 'nsis'];
const args = [path.join(source, 'node_modules/electron-builder/cli.js'), '--projectDir', staging,
  '--win', ...new Set(['dir', ...targets]), '--x64', '--publish', 'never',
  '-c.electronVersion=' + electronVersion, '-c.electronDist=' + path.join(source, 'node_modules/electron/dist')];
if (env.KB_WIN_UNSIGNED === '1') args.push('-c.win.signExecutable=false');
run(args);
const releaseDir = path.join(staging, 'release');
run([path.join(source, 'scripts/write-latest-yml.mjs'), releaseDir]);
const resources = path.join(staging, 'release/win-unpacked/resources');
run([path.join(source, 'scripts/check-native-abi.mjs'), resources]);
const pkg = JSON.parse(fs.readFileSync(path.join(staging, 'package.json'), 'utf8'));
const artifacts = [path.join(staging, 'release/win-unpacked', pkg.productName + '.exe'),
  ...fs.readdirSync(releaseDir).filter(n => n.endsWith('.exe') || n.endsWith('.blockmap') || n === 'latest.yml').map(n => path.join(releaseDir, n))];
const fuses = await import(pathToFileURL(path.join(source, 'node_modules/@electron/fuses/dist/index.js')).href);
const fuseWire = await fuses.getCurrentFuseWire(artifacts[0]);
const manifest = { createdAt: new Date().toISOString(), source, commit, version: pkg.version, staging,
  nativeManifest: path.join(staging, 'native-abi-manifest.json'), abiBefore: 'passed', abiAfter: 'passed',
  electronVersion, fuses: fuseWire, artifacts: artifacts.map(file => ({ file, bytes: fs.statSync(file).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') })) };
const manifestFile = path.join(staging, 'release-manifest.json');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
console.log('RELEASE_MANIFEST=' + manifestFile);
