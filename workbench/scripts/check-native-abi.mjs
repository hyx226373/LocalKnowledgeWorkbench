// 发布门禁：任一 better_sqlite3.node 在真实 Electron 里不能 SELECT 1，就失败。
// ABI 137/149 不再当作允许失败。dualdb 的 afterEach 不在这个脚本里。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/check-native-abi.mjs <manifest.json | unpacked 资源目录>');
  process.exit(2);
}

function findNodes(root) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (name === 'better_sqlite3.node' || name.endsWith('.node') && p.includes(`${path.sep}better-sqlite3${path.sep}`)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function packageDirOf(nodeFile) {
  let dir = path.dirname(nodeFile);
  for (let i = 0; i < 6; i++) {
    const pj = path.join(dir, 'package.json');
    if (fs.existsSync(pj)) {
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (pkg.name === 'better-sqlite3') return dir;
    }
    dir = path.dirname(dir);
  }
  return path.dirname(nodeFile);
}

let packageDirs = [];
if (arg.endsWith('.json')) {
  const manifest = JSON.parse(fs.readFileSync(arg, 'utf8'));
  packageDirs = manifest.copies.map((c) => ({ id: c.id, packageDir: c.packageDir }));
} else {
  packageDirs = findNodes(arg).map((nodeFile) => ({ id: nodeFile, packageDir: packageDirOf(nodeFile) }));
}
if (!packageDirs.length) {
  console.error('没有找到 better-sqlite3 副本');
  process.exit(1);
}

const dir = path.join(process.env.TEMP || 'C:\\Users\\sana2\\AppData\\Local\\Temp', 'kb-abi-gate');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'out.json');
const util = path.join(dir, 'util.json');
fs.writeFileSync(path.join(dir, 'child.cjs'), `
const fs = require('fs');
const pkgs = JSON.parse(process.env.KB_PROBE_PKGS);
fs.writeFileSync(process.env.KB_PROBE_UTIL, JSON.stringify({
  modules: process.versions.modules,
  loads: pkgs.map(tryLoad),
}));
process.exit(0);
function tryLoad(item) {
  try {
    const Database = require(item.packageDir);
    const db = new Database(':memory:');
    const row = db.prepare('select 1 as ok').get();
    db.close();
    return { id: item.id, select1: row };
  } catch (e) {
    return { id: item.id, error: String(e && e.message ? e.message : e) };
  }
}
`);
fs.writeFileSync(path.join(dir, 'main.cjs'), `
const { app, utilityProcess } = require('electron');
const fs = require('fs');
const path = require('path');
const pkgs = JSON.parse(process.env.KB_PROBE_PKGS);
function tryLoad(item) {
  try {
    const Database = require(item.packageDir);
    const db = new Database(':memory:');
    const row = db.prepare('select 1 as ok').get();
    db.close();
    return { id: item.id, select1: row };
  } catch (e) {
    return { id: item.id, error: String(e && e.message ? e.message : e) };
  }
}
app.whenReady().then(() => {
  const main = { modules: process.versions.modules, electron: process.versions.electron, loads: pkgs.map(tryLoad) };
  const child = utilityProcess.fork(path.join(__dirname, 'child.cjs'), [], { serviceName: 'abi-gate', env: { ...process.env } });
  child.on('exit', () => {
    const utility = JSON.parse(fs.readFileSync(process.env.KB_PROBE_UTIL, 'utf8'));
    fs.writeFileSync(process.env.KB_PROBE_OUT, JSON.stringify({ main, utility }));
    app.exit(0);
  });
});
`);
const env = { ...process.env, KB_PROBE_PKGS: JSON.stringify(packageDirs), KB_PROBE_OUT: out, KB_PROBE_UTIL: util };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const r = spawnSync(electronExe, [path.join(dir, 'main.cjs')], { encoding: 'utf8', env, stdio: 'ignore', timeout: 30000 });
if (!fs.existsSync(out)) {
  console.error(r.stderr || r.stdout || '探针没有输出');
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(out, 'utf8'));
const bad = [];
for (const side of [result.main, result.utility]) {
  for (const load of side.loads || []) {
    if (!load.select1 || load.select1.ok !== 1) bad.push(`${side.modules}:${load.id}:${load.error || 'empty'}`);
  }
}
if (bad.length) {
  console.error('[check-native-abi] 失败');
  for (const line of bad) console.error(line);
  process.exit(1);
}
console.log(`[check-native-abi] ${packageDirs.length} 个副本在 Electron ${result.main.electron} modules ${result.main.modules} 的主进程和 utilityProcess 里 SELECT 1 通过`);
