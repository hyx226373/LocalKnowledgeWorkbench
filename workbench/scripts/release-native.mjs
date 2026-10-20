// 在仓库外的 staging 里准备 better-sqlite3 的 Electron 二进制。
// 不写仓库 node_modules，不拆 junction。任何一个副本在真实 Electron 里 SELECT 1 失败，进程以 1 退出。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { removeGenerated } from './release-paths.mjs';

const repoRoot = path.resolve(process.env.KB_RELEASE_SOURCE || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sha = process.env.KB_RELEASE_COMMIT || gitShort();
const staging = process.env.KB_RELEASE_STAGING
  || path.join(repoRoot, '..', 'release-staging', sha.slice(0, 12));
const manifestPath = path.join(staging, 'native-abi-manifest.json');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
const shared12 = path.join('D:\\workspace\\kb', 'node_modules', 'better-sqlite3');

function gitShort() {
  const r = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'git rev-parse failed');
  return r.stdout.trim();
}

function assertOutsideRepo(dir) {
  const rel = path.relative(repoRoot, dir);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error(`staging 必须在仓库外: ${dir}`);
  }
}

function readlinkOrNull(p) {
  try { return fs.readlinkSync(p); } catch { return null; }
}

function copyPhysical(src, dest, seen = new Set()) {
  const real = fs.realpathSync(src);
  if (seen.has(real)) return;
  const st = fs.lstatSync(src);
  if (readlinkOrNull(src)) {
    copyPhysical(real, dest, seen);
    return;
  }
  if (st.isDirectory()) {
    seen.add(real);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyPhysical(path.join(src, name), path.join(dest, name), seen);
    return;
  }
  if (!st.isFile()) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// 索引器工作区里还没提交的 6 个文件。不进安装包，也不参与 staging 编译。
const UNTRACKED_INDEXER = new Set(['disk.ts', 'resolveBatch.ts', 'segmentGate.ts', 'disk.js', 'resolveBatch.js', 'segmentGate.js']); // D3: fork/host tracked modules@7631af3; skip unused orphans

function skipUntrackedIndexer(abs) {
  const norm = abs.replaceAll('/', '\\');
  return norm.includes('\\indexer\\') && UNTRACKED_INDEXER.has(path.basename(abs));
}
/** D3: App requires @kb/indexer/fork (setIndexerFork). Fail fast if staging copy lacks it. */
function assertIndexerForkExport(vendorDir) {
  const pkgPath = path.join(vendorDir, 'package.json');
  const forkSrc = path.join(vendorDir, 'src', 'fork.ts');
  if (!fs.existsSync(pkgPath)) throw new Error(`D3: missing ${pkgPath}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (!pkg?.exports?.['./fork']) {
    throw new Error('D3: @kb/indexer package.json missing exports["./fork"] (need modules tip with fork tracked)');
  }
  if (!fs.existsSync(forkSrc)) {
    throw new Error(`D3: missing ${forkSrc} — commit indexer/src/fork.ts in modules before release`);
  }
}

// @kb 包自带的 node_modules 不进安装包。运行时依赖走上面这一份 node_modules。
function copyPackageTree(src, dest) {
  if (skipUntrackedIndexer(src)) return;
  if (readlinkOrNull(src)) {
    copyPackageTree(fs.realpathSync(src), dest);
    return;
  }
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name === 'node_modules' || name === '.git') continue;
      copyPackageTree(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  if (!st.isFile()) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function assertSharedSqlite(nmDest, deps) {
  const shared = path.join(nmDest, 'better-sqlite3');
  const resolved = [];
  for (const dep of deps) {
    const scoped = dep.name.startsWith('@') ? dep.name.split('/')[1] : dep.name;
    const pkgDir = path.join(nmDest, '@kb', scoped);
    const req = createRequire(path.join(pkgDir, 'package.json'));
    let hit;
    try { hit = req.resolve('better-sqlite3'); }
    catch (e) { throw new Error(dep.name + ' 解析不到 better-sqlite3: ' + (e && e.message ? e.message : e)); }
    const rel = path.relative(shared, hit);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(dep.name + ' 的 better-sqlite3 不在共享副本里: ' + hit);
    }
    resolved.push({ name: dep.name, resolved: hit });
  }
  return resolved;
}

function skipDir(abs) {
  const norm = abs.replaceAll('/', '\\');
  if (norm.endsWith('\\node_modules\\electron\\dist')) return true;
  if (norm.includes('\\node_modules\\electron\\dist\\')) return true;
  return false;
}

function copyTree(src, dest) {
  if (skipDir(src)) return;
  if (readlinkOrNull(src)) {
    copyPhysical(fs.realpathSync(src), dest);
    return;
  }
  const st = fs.lstatSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const from = path.join(src, name);
      if (skipDir(from)) continue;
      copyTree(from, path.join(dest, name));
    }
    return;
  }
  if (st.isFile()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function assertNoReparse(file) {
  let cur = file;
  const hits = [];
  while (cur.startsWith(staging)) {
    if (readlinkOrNull(cur)) hits.push(cur);
    if (cur === staging) break;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (hits.length) throw new Error('staging 路径上有 junction 或符号链接: ' + hits.join(' | '));
}

function walkReparse(dir, hits, depth = 0) {
  if (depth > 40) return;
  if (readlinkOrNull(dir)) {
    hits.push(dir);
    return;
  }
  let st;
  try { st = fs.lstatSync(dir); } catch { return; }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(dir)) walkReparse(path.join(dir, name), hits, depth + 1);
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function rebuild12(electronVersion) {
  const rebuildRoot = path.join(staging, '_rebuild');
  const mod = path.join(rebuildRoot, 'node_modules', 'better-sqlite3');
  removeGenerated(staging, rebuildRoot);
  copyPhysical(shared12, mod);
  fs.writeFileSync(path.join(rebuildRoot, 'package.json'), JSON.stringify({
    name: 'kb-native-rebuild', private: true, version: '0.0.0',
    dependencies: { 'better-sqlite3': '12.11.1' },
  }));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const r = spawnSync(process.execPath, [
    path.join(repoRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js'),
    '-v', electronVersion,
    '-f',
    '-o', 'better-sqlite3',
    '--build-from-source',
    '-m', rebuildRoot,
    '-e', path.join(repoRoot, 'node_modules', 'electron'),
  ], { stdio: 'inherit', cwd: rebuildRoot, env });
  if (r.status !== 0) throw new Error('electron-rebuild 退出 ' + r.status);
  const built = path.join(mod, 'build', 'Release', 'better_sqlite3.node');
  if (!fs.existsSync(built)) throw new Error('重编后没有 better_sqlite3.node');
  return built;
}

function extractNode(tarPath, destNode) {
  const tmp = path.join(staging, '_tar');
  removeGenerated(staging, tmp);
  fs.mkdirSync(tmp, { recursive: true });
  const r = spawnSync('tar', ['-xzf', tarPath, '-C', tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'tar failed');
  const found = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.node')) found.push(p);
    }
  };
  walk(tmp);
  if (found.length !== 1) throw new Error('预编译包里的 .node 数量不是 1: ' + found.join(','));
  fs.mkdirSync(path.dirname(destNode), { recursive: true });
  fs.copyFileSync(found[0], destNode);
  removeGenerated(staging, tmp);
}

function place12(destDir, nodeFile) {
  removeGenerated(staging, destDir);
  copyPhysical(shared12, destDir);
  const bindings = path.join('D:\\workspace\\kb', 'node_modules', 'bindings');
  const fileUri = path.join('D:\\workspace\\kb', 'node_modules', 'file-uri-to-path');
  copyPhysical(bindings, path.join(destDir, 'node_modules', 'bindings'));
  copyPhysical(fileUri, path.join(destDir, 'node_modules', 'file-uri-to-path'));
  // 打包器不收集 better-sqlite3 里的 node_modules，所以把 bindings 收进 lib，避免解包后找不到它。
  const bindingsJs = fs.readFileSync(path.join(bindings, 'bindings.js'), 'utf8')
    .replace("require('file-uri-to-path')", "require('./kb-file-uri-to-path')");
  fs.writeFileSync(path.join(destDir, 'lib', 'kb-bindings.js'), bindingsJs);
  fs.copyFileSync(path.join(fileUri, 'index.js'), path.join(destDir, 'lib', 'kb-file-uri-to-path.js'));
  const dbJs = path.join(destDir, 'lib', 'database.js');
  fs.writeFileSync(dbJs, fs.readFileSync(dbJs, 'utf8').replace("require('bindings')", "require('./kb-bindings')"));
  const oldNode = path.join(destDir, 'build', 'Release', 'better_sqlite3.node');
  if (fs.existsSync(oldNode)) removeGenerated(staging, oldNode);
  fs.mkdirSync(path.dirname(oldNode), { recursive: true });
  fs.copyFileSync(nodeFile, oldNode);
  return oldNode;
}

function runProbe(entries) {
  const dir = path.join(staging, '_probe');
  fs.mkdirSync(dir, { recursive: true });
  const pkgs = entries.map((e) => ({ id: e.id, version: e.version, packageDir: e.packageDir }));
  fs.writeFileSync(path.join(dir, 'child.cjs'), `
const fs = require('fs');
const pkgs = JSON.parse(process.env.KB_PROBE_PKGS);
const loads = pkgs.map(tryLoad);
fs.writeFileSync(process.env.KB_PROBE_UTIL, JSON.stringify({
  role: 'utility', electron: process.versions.electron, modules: process.versions.modules,
  arch: process.arch, platform: process.platform, loads,
}));
process.exit(0);
function tryLoad(item) {
  const row = { id: item.id };
  try {
    const Database = require(item.packageDir);
    const db = new Database(':memory:');
    row.select1 = db.prepare('select 1 as ok').get();
    db.close();
  } catch (e) { row.error = String(e && e.message ? e.message : e); }
  return row;
}
`);
  fs.writeFileSync(path.join(dir, 'main.cjs'), `
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const pkgs = JSON.parse(process.env.KB_PROBE_PKGS);
function tryLoad(item) {
  const row = { id: item.id };
  try {
    const Database = require(item.packageDir);
    const db = new Database(':memory:');
    row.select1 = db.prepare('select 1 as ok').get();
    db.close();
  } catch (e) { row.error = String(e && e.message ? e.message : e); }
  return row;
}
app.whenReady().then(() => {
  const main = {
    role: 'main', electron: process.versions.electron, modules: process.versions.modules,
    node: process.versions.node, arch: process.arch, platform: process.platform, loads: pkgs.map(tryLoad),
  };
  const child = utilityProcess.fork(path.join(__dirname, 'child.cjs'), [], {
    serviceName: 'abi-probe',
    env: { ...process.env },
  });
  child.on('exit', (code) => {
    let utility = null;
    try { utility = JSON.parse(fs.readFileSync(process.env.KB_PROBE_UTIL, 'utf8')); }
    catch (e) { utility = { error: String(e), code }; }
    fs.writeFileSync(process.env.KB_PROBE_OUT, JSON.stringify({ main, utility, childExit: code }));
    app.exit(0);
  });
});
`);
  const out = path.join(dir, 'out.json');
  const util = path.join(dir, 'util.json');
  const env = { ...process.env, KB_PROBE_PKGS: JSON.stringify(pkgs), KB_PROBE_OUT: out, KB_PROBE_UTIL: util };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  const r = spawnSync(electronExe, [path.join(dir, 'main.cjs')], { encoding: 'utf8', env, stdio: 'ignore', timeout: 30000 });
  if (!fs.existsSync(out)) throw new Error('Electron 探针没有写出结果: ' + (r.stderr || r.stdout || r.status));
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function fileDeps() {
  const pkg = readPkg(repoRoot);
  const out = [];
  for (const [name, spec] of Object.entries(pkg.dependencies || {})) {
    if (!String(spec).startsWith('file:')) continue;
    const abs = path.resolve(repoRoot, String(spec).slice('file:'.length));
    out.push({ name, abs, spec: String(spec) });
  }
  return out;
}

async function main() {
  assertOutsideRepo(staging);
  if (!fs.existsSync(electronExe)) throw new Error('缺少 Electron: ' + electronExe);
  const electronVersion = fs.readFileSync(path.join(electronDist, 'version'), 'utf8').trim();
  console.log(`[release-native] staging ${staging}`);
  console.log(`[release-native] electron file version ${electronVersion}`);
  // Never remove or reuse an existing staging tree, including on failure.
  if (fs.existsSync(staging)) throw new Error('staging already exists; choose a new path: ' + staging);
  fs.mkdirSync(path.dirname(staging), { recursive: true });
  fs.mkdirSync(staging);
  assertNoReparse(staging);

  const deps = fileDeps();
  for (const dep of deps) {
    const folder = dep.name.startsWith('@') ? dep.name.split('/')[1] : dep.name;
    const dest = path.join(staging, 'vendor', folder);
    copyPackageTree(dep.abs, dest);
    dep.vendor = dest;
    dep.folder = folder;
    dep.declaredSqlite = (readPkg(dest).dependencies || {})['better-sqlite3'] || '';
  }

  const runtime = runProbe([
    { id: 'probe-runtime', version: '0', packageDir: path.join(repoRoot, 'node_modules', 'better-sqlite3') },
  ]).main;
  const modules = runtime.modules;
  const arch = runtime.arch;
  if (runtime.electron !== electronVersion) {
    throw new Error(`Electron 文件版本 ${electronVersion} 与运行时 ${runtime.electron} 不一致`);
  }
  if (String(modules) !== '149') throw new Error('Electron modules 不是 149: ' + modules);
  console.log(`[release-native] runtime electron ${runtime.electron} modules ${modules} ${runtime.platform}/${arch}`);
  console.log('[release-native] 不下载、不重编 better-sqlite3。六个 @kb 包共用应用这一份预编译包');

  const copies = [];
  const mainDir = path.join(repoRoot, 'node_modules', 'better-sqlite3');
  const mainNode = path.join(mainDir, 'prebuilds', `${runtime.platform}-${arch}.node`);
  const mainPkg = readPkg(mainDir);
  const sharedBy = deps.filter((d) => d.declaredSqlite).map((d) => d.name);
  copies.push({
    id: 'shared',
    role: 'shared',
    packageName: mainPkg.name,
    version: mainPkg.version,
    sourcePackage: mainDir,
    packageDir: path.join(staging, 'node_modules', 'better-sqlite3'),
    nodeFile: path.join(staging, 'node_modules', 'better-sqlite3', 'prebuilds', `${runtime.platform}-${arch}.node`),
    abiBefore: 'N-API（在 modules ' + modules + ' 上 SELECT 1 已通过，不替换）',
    abiAfter: modules,
    shaBefore: sha256(mainNode),
    shaAfter: sha256(mainNode),
    source: 'better-sqlite3@' + mainPkg.version + ' 自带 prebuilds/' + runtime.platform + '-' + arch + '.node',
    replaced: false,
    sharedBy,
  });

  console.log('[release-native] copy node_modules');
  const nmSrc = path.join(repoRoot, 'node_modules');
  const nmDest = path.join(staging, 'node_modules');
  fs.mkdirSync(nmDest, { recursive: true });
  for (const name of fs.readdirSync(nmSrc)) {
    if (name === '@kb') continue;
    if (name === 'electron') continue;
    copyTree(path.join(nmSrc, name), path.join(nmDest, name));
  }
  // Compile the authorized indexer source in staging; never write source dist or junctions.
  const idx = deps.find(d => d.name === '@kb/indexer');
  if (idx) assertIndexerForkExport(idx.vendor);
  if (idx) {
    const r = spawnSync(process.execPath, [path.join(nmDest, 'typescript', 'bin', 'tsc'), '-p', path.join(idx.vendor, 'tsconfig.json')], { cwd: idx.vendor, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('staged indexer build failed');
  }
  fs.mkdirSync(path.join(nmDest, '@kb'), { recursive: true });
  for (const dep of deps) {
    const scoped = dep.name.startsWith('@') ? dep.name.split('/')[1] : dep.name;
    copyPackageTree(dep.vendor, path.join(nmDest, '@kb', scoped));
  }
  const sharedResolved = assertSharedSqlite(nmDest, deps);
  console.log('[release-native] 六个包解析到同一份 better-sqlite3: ' + sharedResolved.length);
  copies[0].resolvedFrom = sharedResolved;

  for (const name of fs.readdirSync(repoRoot)) {
    if (/^(tsconfig.*\.json|vite\.config\..*|vitest\.config\..*)$/.test(name)) fs.copyFileSync(path.join(repoRoot, name), path.join(staging, name));
  }
  const appPkg = readPkg(repoRoot);
  const stagedPkg = structuredClone(appPkg);
  stagedPkg.version = process.env.KB_RELEASE_VERSION || appPkg.version;
  for (const dep of deps) {
    stagedPkg.dependencies[dep.name] = 'file:./vendor/' + dep.folder;
  }
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(stagedPkg, null, 2) + '\n');
  for (const rel of ['src', 'out', 'build', 'resources', 'scripts', 'tests', 'e2e', 'theme-kit', 'themes']) {
    const from = path.join(repoRoot, rel);
    if (fs.existsSync(from)) copyTree(from, path.join(staging, rel));
  }
  fs.mkdirSync(path.join(staging, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'afterSign-file-description.mjs'), path.join(staging, 'scripts', 'afterSign-file-description.mjs'));
  fs.writeFileSync(path.join(staging, 'electron-dist-path.txt'), electronDist);

  const probeEntries = [
    { id: 'main', version: copies[0].version, packageDir: copies[0].packageDir },
    ...copies.filter((c) => c.replaced).map((c) => ({ id: c.id, version: c.version, packageDir: c.packageDir })),
  ];
  // main copy is not in staging/node_modules until copy finished; probe the staged main package
  probeEntries[0].packageDir = path.join(nmDest, 'better-sqlite3');
  console.log('[release-native] SELECT 1');
  const probe = runProbe(probeEntries);
  const failed = [];
  for (const side of [probe.main, probe.utility]) {
    for (const load of side.loads || []) {
      if (!load.select1 || load.select1.ok !== 1) failed.push(`${side.role}:${load.id}:${load.error || 'no row'}`);
    }
  }
  if (probe.main.modules !== modules || probe.utility.modules !== modules) failed.push('modules mismatch');
  if (failed.length) throw new Error('SELECT 1 失败: ' + failed.join(' || '));

  const reparseHits = [];
  walkReparse(path.join(staging, 'vendor'), reparseHits);
  for (const c of copies) assertNoReparse(c.nodeFile);
  for (const c of copies) if (c.packagedNodeFile) assertNoReparse(c.packagedNodeFile);
  if (reparseHits.length) throw new Error('vendor 里有 junction: ' + reparseHits.slice(0, 8).join(' | '));

  const manifest = {
    createdAt: new Date().toISOString(),
    git: sha,
    staging,
    electron: {
      version: probe.main.electron,
      modules: probe.main.modules,
      node: probe.main.node,
      arch: probe.main.arch,
      platform: probe.main.platform,
      exe: electronExe,
    },
    reparsePointsInVendor: reparseHits.length,
    select1: { main: probe.main.loads, utility: probe.utility.loads },
    copies: copies.map((c) => ({
      id: c.id,
      role: c.role,
      version: c.version,
      declaredBy: c.sharedBy ? c.sharedBy.join(',') : (c.declaredBy || 'kb-workbench'),
      sharedBy: c.sharedBy || [],
      declaredRange: c.declaredRange || appPkg.dependencies['better-sqlite3'],
      source: c.source,
      replaced: c.replaced,
      abiBefore: c.abiBefore,
      abiAfter: c.abiAfter,
      sha256Before: c.shaBefore,
      sha256After: c.shaAfter,
      nodeFile: c.nodeFile,
      packagedNodeFile: c.packagedNodeFile || c.nodeFile,
      packageDir: c.packageDir,
    })),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('MANIFEST=' + manifestPath);
  console.log('STAGING=' + staging);
}

main().catch((e) => {
  console.error('[release-native] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
