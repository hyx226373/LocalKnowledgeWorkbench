// Electron 主进程、无窗口。证明安装目录里的 app.asar 按字节备份，备份失败时不关机。
// 用法：electron.exe scripts/update-backup-headless.mjs
// 不要设置 ELECTRON_RUN_AS_NODE。结果写到 KB_UPDATE_HEADLESS_LOG，没有则写临时文件。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { app } from 'electron';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logFile = process.env.KB_UPDATE_HEADLESS_LOG || path.join(os.tmpdir(), `kb-update-backup-headless-${process.pid}.txt`);

function log(line) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `${line}\n`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

function fail(message) {
  log(`FAIL ${message}`);
  app.exit(1);
  throw new Error(message);
}

app.whenReady().then(() => main()).catch((err) => fail(err instanceof Error ? err.stack || err.message : String(err)));

async function main() {
  if (process.env.ELECTRON_RUN_AS_NODE) fail('ELECTRON_RUN_AS_NODE 开着，复现不了 asar 拦截');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-update-asar-'));
  const bundle = path.join(dir, 'update-service.cjs');
  try {
    const asarSrc = path.join(dir, 'asar-src');
    fs.mkdirSync(path.join(asarSrc, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(asarSrc, 'nested', 'hello.txt'), 'asar-payload-v1', 'utf8');
    const asarMod = require('@electron/asar');
    const asarFile = path.join(dir, 'install', 'resources', 'app.asar');
    fs.mkdirSync(path.dirname(asarFile), { recursive: true });
    await asarMod.createPackage(asarSrc, asarFile);
    fs.writeFileSync(path.join(dir, 'install', 'version.txt'), '0.2.1', 'utf8');
    const raw = require('original-fs');
    const patchedStat = fs.statSync(asarFile);
    const rawStat = raw.statSync(asarFile);
    log(`PATCHED_IS_DIR ${patchedStat.isDirectory()} RAW_IS_FILE ${rawStat.isFile()} RAW_SIZE ${rawStat.size}`);
    if (!patchedStat.isDirectory() || !rawStat.isFile()) fail('当前进程没有把 app.asar 当成目录，测不到拦截');
    const sourceBytes = raw.readFileSync(asarFile);

    const esbuild = require('esbuild');
    await esbuild.build({
      entryPoints: [path.join(root, 'src', 'main', 'update', 'service.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: bundle,
      external: ['electron', 'original-fs', 'better-sqlite3'],
      logLevel: 'silent',
    });
    const { UpdateService } = require(bundle);

    const user = path.join(dir, 'user');
    fs.mkdirSync(user, { recursive: true });
    fs.mkdirSync(path.join(dir, 'roam'), { recursive: true });
    const db = Buffer.alloc(8192);
    Buffer.from('SQLite format 3\0').copy(db);
    fs.writeFileSync(path.join(user, 'workbench.db'), db);
    fs.writeFileSync(path.join(user, 'canary.json'), 'keep-me', 'utf8');
    writeFeed(path.join(dir, 'feed'), '0.2.2-test', Buffer.alloc(8192, 6));

    const shutdowns = [];
    const reasons = [];
    let exited = false;
    const hooks = {
      currentVersion: '0.2.1',
      userDataDir: user,
      roamingDir: path.join(dir, 'roam'),
      installDir: path.join(dir, 'install'),
      defaultFeed: path.join(dir, 'feed'),
      backupSqlite: async (src, dest) => { await fs.promises.copyFile(src, dest); },
      prepareShutdown: async () => { shutdowns.push('now'); return 'closed'; },
      closeDatabase: async () => undefined,
      spawnDetached: () => undefined,
      requestExit: () => { exited = true; },
      showReason: async (_title, body) => { reasons.push(String(body)); },
      applyMode: 'nsis',
      noRelaunch: true,
      helperDone: path.join(dir, 'helper-done.txt'),
      relaunchPath: null,
    };
    const svc = new UpdateService(hooks);
    await svc.init();
    const ready = await svc.check();
    if (ready.phase !== 'ready') fail(`检查没有到 ready：${ready.phase} ${ready.error || ''}`);
    await svc.installNow();
    if (shutdowns.length !== 1) fail(`成功路径关机次数 ${shutdowns.length}`);
    if (!exited) fail('成功路径没有请求退出');
    const journal = JSON.parse(fs.readFileSync(path.join(user, 'update-journal.json'), 'utf8'));
    const rec = journal.backups[0];
    const copied = path.join(rec.dir, 'install', 'resources', 'app.asar');
    const copiedBytes = raw.readFileSync(copied);
    const same = sourceBytes.length === copiedBytes.length && sourceBytes.equals(copiedBytes);
    const sha = createHash('sha256').update(sourceBytes).digest('hex');
    log(`ASAR_BYTES_MATCH ${same} size=${sourceBytes.length} sha256=${sha}`);
    if (!same) fail('备份里的 app.asar 和原文件字节不同');
    if (fs.readFileSync(path.join(rec.dir, 'install', 'version.txt'), 'utf8') !== '0.2.1') fail('普通文件没有拷到');

    const broken = path.join(dir, 'user', 'canary.json');
    const failDir = path.join(dir, 'fail-user');
    fs.mkdirSync(failDir, { recursive: true });
    fs.writeFileSync(path.join(failDir, 'workbench.db'), db);
    fs.writeFileSync(path.join(failDir, 'canary.json'), 'keep-me', 'utf8');
    const failShutdowns = [];
    let failExited = false;
    const failHooks = {
      ...hooks,
      userDataDir: failDir,
      installDir: broken,
      prepareShutdown: async () => { failShutdowns.push('now'); return 'closed'; },
      requestExit: () => { failExited = true; },
      helperDone: path.join(dir, 'helper-done-fail.txt'),
    };
    const failed = new UpdateService(failHooks);
    await failed.init();
    await failed.check();
    let threw = false;
    try {
      await failed.installNow();
    } catch {
      threw = true;
    }
    if (!threw) fail('坏安装目录没有让备份失败');
    if (failShutdowns.length !== 0 || failExited) fail('备份失败后仍然关机或退出');
    const snap = failed.snapshot();
    if (snap.phase !== 'ready' || !snap.downloaded) fail(`失败后不能重试：${snap.phase} downloaded=${snap.downloaded}`);
    if (!reasons.some((line) => line.includes('备份失败'))) fail('界面没有提示备份失败');
    const retry = await failed.check();
    if (retry.phase !== 'ready') fail(`失败后再次检查没有到 ready：${retry.phase} ${retry.error || ''}`);
    failHooks.installDir = path.join(dir, 'install');
    let retrySaw = false;
    failHooks.prepareShutdown = async () => {
      failShutdowns.push('retry');
      const saved = JSON.parse(fs.readFileSync(path.join(failDir, 'update-journal.json'), 'utf8'));
      const again = raw.readFileSync(path.join(saved.backups[0].dir, 'install', 'resources', 'app.asar'));
      retrySaw = sourceBytes.equals(again);
      return 'closed';
    };
    await failed.installNow();
    if (!retrySaw || failShutdowns.join(',') !== 'retry') fail('重试没有在关机前得到字节一致的 asar');
    log('BACKUP_FAIL_STAYS_UP shutdowns=0 retry=ok');
    log('PASS');
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      log(`CLEANUP_WARN ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  app.exit(0);
}

function writeFeed(feed, version, body) {
  fs.mkdirSync(feed, { recursive: true });
  const name = `LocalKnowledgeWorkbench-${version}-win-x64-setup.exe`;
  const sha = createHash('sha512').update(body).digest('base64');
  const block = zlib.gzipSync(Buffer.from(`{"version":"${version}"}`));
  fs.writeFileSync(path.join(feed, name), body);
  fs.writeFileSync(path.join(feed, `${name}.blockmap`), block);
  const yml = [
    `version: ${version}`,
    'files:',
    `  - url: ${name}`,
    `    sha512: '${sha}'`,
    `    size: ${body.length}`,
    `    blockMapSize: ${block.length}`,
    `path: ${name}`,
    `sha512: '${sha}'`,
    'releaseNotes: |',
    '  headless',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(feed, 'latest.yml'), yml, 'utf8');
}
