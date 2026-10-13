// Emit generic-provider latest.yml next to the NSIS setup. No cloud account.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SETUP_RE = /^LocalKnowledgeWorkbench-(.+)-win-(x64|arm64)-setup\.exe$/;

function quote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

export function findSetup(releaseDir, version) {
  const names = fs.readdirSync(releaseDir).filter((name) => SETUP_RE.test(name));
  if (names.length === 0) return null;
  if (version) {
    const hit = names.find((name) => SETUP_RE.exec(name)?.[1] === version);
    if (!hit) throw new Error('没有找到版本 ' + version + ' 的安装包');
    return hit;
  }
  if (names.length > 1) throw new Error('release 里有多份安装包，请设置 KB_RELEASE_VERSION');
  return names[0];
}

export function writeLatestYml(releaseDir, opts = {}) {
  const versionWanted = opts.version || process.env.KB_RELEASE_VERSION || '';
  const setup = findSetup(releaseDir, versionWanted || undefined);
  if (!setup) return { written: false };
  const parsed = SETUP_RE.exec(setup);
  const version = versionWanted || parsed[1];
  const blockName = setup + '.blockmap';
  const blockPath = path.join(releaseDir, blockName);
  if (!fs.existsSync(blockPath)) {
    const err = new Error('安装包存在但缺少 ' + blockName);
    err.code = 'BLOCKMAP_MISSING';
    throw err;
  }
  const magic = Buffer.alloc(2);
  const fd = fs.openSync(blockPath, 'r');
  try {
    fs.readSync(fd, magic, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) throw new Error('blockmap 不是 gzip');
  const exePath = path.join(releaseDir, setup);
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(exePath)).digest('base64');
  const size = fs.statSync(exePath).size;
  const blockMapSize = fs.statSync(blockPath).size;
  const releaseDate = opts.releaseDate || new Date().toISOString();
  const notes = opts.notes ?? process.env.KB_RELEASE_NOTES ?? '';
  const lines = [
    'version: ' + version,
    'files:',
    '  - url: ' + setup,
    '    sha512: ' + quote(sha512),
    '    size: ' + size,
    '    blockMapSize: ' + blockMapSize,
    'path: ' + setup,
    'sha512: ' + quote(sha512),
    'releaseDate: ' + quote(releaseDate),
  ];
  if (notes) {
    lines.push('releaseNotes: |');
    for (const line of String(notes).replace(/\r\n/g, '\n').split('\n')) lines.push('  ' + line);
  }
  const file = path.join(releaseDir, 'latest.yml');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return { written: true, file, version, sha512, size, blockMapSize, setup };
}

function main() {
  const releaseDir = path.resolve(process.argv[2] || '');
  if (!releaseDir || !fs.existsSync(releaseDir)) {
    console.error('用法: node scripts/write-latest-yml.mjs <release目录>');
    process.exit(1);
  }
  try {
    const result = writeLatestYml(releaseDir);
    if (!result.written) {
      console.log('LATEST_YML=skipped');
      process.exit(0);
    }
    console.log('LATEST_YML=' + result.file);
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invoked) main();
