// Isolated auto-update checks. Temp data only. No SendInput. No the user install.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = 'C:\\Users\\example\\kb-r12-update-e2e';
const EVIDENCE = path.resolve(ROOT, '..', '汇报', '一次并行-2026-10-06', '安装包修复-回交', 'UPDATE-0009');
const SEGMENT_MS = 8 * 60 * 1000;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
}

function stamp(file) {
  try {
    const st = fs.statSync(file);
    return { file, exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { file, exists: false };
  }
}

const ownerDb = path.join(process.env.LOCALAPPDATA || '', 'LocalKnowledgeWorkbench', 'workbench.db');
const ownerExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LocalKnowledgeWorkbench', 'LocalKnowledgeWorkbench.exe');
const ownerBefore = [stamp(ownerDb), stamp(ownerExe)];

fs.rmSync(RUNTIME, { recursive: true, force: true });
fs.mkdirSync(RUNTIME, { recursive: true });
fs.mkdirSync(EVIDENCE, { recursive: true });

function writeEvidence(name, value) {
  fs.writeFileSync(path.join(EVIDENCE, name), JSON.stringify(value, null, 2), 'utf8');
}

async function writeFeed(dir, version, body, sha = createHash('sha512').update(body).digest('base64')) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `LocalKnowledgeWorkbench-${version}-win-x64-setup.exe`;
  const block = zlib.gzipSync(Buffer.from(JSON.stringify({ version })));
  fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(dir, `${name}.blockmap`), block);
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
    '  隔离环境测试包',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'latest.yml'), yml, 'utf8');
  return { name, sha, size: body.length };
}

function baseEnv(extra) {
  const env = { ...process.env };
  delete env.VITE_DEV_SERVER_URL;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KB_UPDATE_SELF_CHECK;
  delete env.KB_UPDATE_SELF_CHECK_REASON;
  delete env.KB_UPDATE_DAMAGE_BEFORE_ROLLBACK;
  delete env.KB_TEST_FREEZE_RENDERER;
  Object.assign(env, extra);
  env.KB_UPDATE_TEST_HOOK = '1';
  env.KB_UPDATE_AUTO_CHECK = '0';
  env.KB_UPDATE_APPLY = 'copy';
  env.KB_UPDATE_NO_RELAUNCH = '1';
  env.KB_UPDATE_CHECK_DELAY_MS = '3600000';
  return env;
}

function killPid(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function waitHook(app) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ready = await app.evaluate(() => !!globalThis.__kbUpdate).catch(() => false);
    if (ready) return;
    await sleep(100);
  }
  throw new Error('更新钩子没有挂上');
}

async function launch(env) {
  const app = await electron.launch({
    args: ['.', '--no-sandbox', '--disable-gpu', '--force-device-scale-factor=1'],
    cwd: ROOT,
    env,
  });
  const pid = app.process().pid;
  return { app, pid };
}

function waitExit(app, ms) {
  return new Promise((resolve, reject) => {
    const proc = app.process();
    if (!proc || proc.exitCode != null) {
      resolve(proc ? proc.exitCode : null);
      return;
    }
    const timer = setTimeout(() => reject(new Error('应用没有在时限内退出')), ms);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitFile(file, ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const log = fs.existsSync(`${file}.log`) ? fs.readFileSync(`${file}.log`, 'utf8') : '';
  throw new Error(`等不到 ${file}\n${log}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installFromTray(app) {
  const exitP = waitExit(app, 120000);
  const invoked = app.evaluate(() => globalThis.__kbUpdate.trayInstall()).catch((err) => err);
  await Promise.race([invoked, exitP]);
  return exitP;
}

async function caseUpgrade() {
  const id = 'case1-upgrade';
  const root = path.join(RUNTIME, id);
  const user = path.join(root, 'user');
  const roam = path.join(root, 'roam');
  const install = path.join(root, 'install');
  const feed = path.join(root, 'feed');
  const done = path.join(root, 'helper-done.txt');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'version.txt'), '0.2.0', 'utf8');
  fs.writeFileSync(path.join(install, 'build-id.txt'), 'old', 'utf8');
  const body = Buffer.alloc(700 * 1024, 11);
  const packed = await writeFeed(feed, '0.2.1-test', body);
  const env = baseEnv({
    KB_USER_DATA: user,
    KB_UPDATE_ROAMING: roam,
    KB_UPDATE_INSTALL_DIR: install,
    KB_UPDATE_FEED: feed,
    KB_UPDATE_HELPER_DONE: done,
    KB_UPDATE_CURRENT_VERSION: '0.2.0',
    KB_UPDATE_RATE_LIMIT: '250000',
  });
  const started = Date.now();
  const { app, pid } = await launch(env);
  const evidence = { pid, started, packed, samples: [], pageProgress: [], p99: null };
  try {
    await waitHook(app);
    const page = await app.firstWindow();
    page.on('pageerror', (err) => {
      evidence.pageErrors = evidence.pageErrors || [];
      evidence.pageErrors.push(String(err && err.stack ? err.stack : err));
      console.log('[pageerror]', err);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.log('[renderer]', msg.text());
    });
    await page.waitForSelector('[data-testid="app"]', { timeout: 45000 });
    await app.evaluate((electron) => {
      const win = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      if (!win) throw new Error('没有主窗口');
      win.webContents.send('kb:menu-command', 'app.update.open');
    });
    await page.waitForSelector('[data-testid="update-page"]', { timeout: 20000 });
    await page.waitForFunction(() => {
      const node = document.querySelector('[data-testid="update-current"]');
      return !!(node && node.textContent && node.textContent.includes('0.2.0'));
    }, null, { timeout: 20000 });
    const poll = setInterval(async () => {
      const text = await page.locator('[data-testid="update-progress"]').innerText().catch(() => '');
      if (text && evidence.pageProgress[evidence.pageProgress.length - 1] !== text) evidence.pageProgress.push(text);
    }, 80);
    const main = await app.evaluate(async () => {
      const hook = globalThis.__kbUpdate;
      const samples = [];
      let stop = false;
      const pending = hook.check().finally(() => {
        stop = true;
      });
      while (!stop) {
        const snap = hook.snapshot();
        if (snap.progress) samples.push({ transferred: snap.progress.transferred, total: snap.progress.total });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const snap = await pending;
      return { snap, samples, p99: hook.eventLoopP99() };
    });
    clearInterval(poll);
    await sleep(300);
    evidence.samples = main.samples;
    evidence.p99 = main.p99;
    evidence.snap = {
      phase: main.snap.phase,
      downloaded: main.snap.downloaded,
      unsignedNotice: main.snap.unsignedNotice,
      version: main.snap.available && main.snap.available.version,
      error: main.snap.error,
    };
    const unsigned = await page.locator('[data-testid="update-unsigned"]').innerText();
    const available = await page.locator('[data-testid="update-available"]').innerText();
    const progress = await page.locator('[data-testid="update-progress"]').innerText();
    evidence.unsigned = unsigned;
    evidence.available = available;
    evidence.progressAfter = progress;
    check('检查后未签名', unsigned === '未签名', unsigned);
    check('可用版本是 0.2.1-test', available.includes('0.2.1-test'), available);
    check('主进程进度字节递增', main.samples.length > 0 && main.samples.every((row) => row.total === packed.size && row.transferred <= row.total), JSON.stringify(main.samples.slice(0, 3)));
    check('页面进度是真实字节', evidence.pageProgress.some((text) => /^已下载 \d+ 字节 \/ 共 \d+ 字节$/.test(text)) && evidence.pageProgress.every((text) => !text.includes('%')), evidence.pageProgress.join(' | '));
    check('下载校验完成', main.snap.phase === 'ready' && main.snap.downloaded === true, main.snap.phase);
    check('下载期间 p99 < 100ms', typeof main.p99 === 'number' && main.p99 < 100, String(main.p99));
    await app.evaluate(() => globalThis.__kbUpdate.writeCanary('case1-canary'));
    const code = await installFromTray(app);
    evidence.exitCode = code;
    const helper = await waitFile(done, 120000);
    evidence.helper = helper;
    evidence.versionAfterInstall = fs.readFileSync(path.join(install, 'version.txt'), 'utf8').trim();
    check('安装后版本文件是 0.2.1-test', evidence.versionAfterInstall === '0.2.1-test', evidence.versionAfterInstall);
    const env2 = baseEnv({
      KB_USER_DATA: user,
      KB_UPDATE_ROAMING: roam,
      KB_UPDATE_INSTALL_DIR: install,
      KB_UPDATE_FEED: feed,
      KB_UPDATE_HELPER_DONE: path.join(root, 'helper-done-2.txt'),
      KB_UPDATE_CURRENT_VERSION: '0.2.1-test',
    });
    const second = await launch(env2);
    evidence.secondPid = second.pid;
    try {
      await waitHook(second.app);
      const passed = await second.app.evaluate(async () => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
          const snap = globalThis.__kbUpdate.snapshot();
          if (snap.info === '新版本自检通过') return snap.info;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return globalThis.__kbUpdate.snapshot().info;
      });
      const canary = await second.app.evaluate(() => globalThis.__kbUpdate.readCanary());
      evidence.selfCheck = passed;
      evidence.canary = canary;
      check('新版本自检通过', passed === '新版本自检通过', String(passed));
      check('升级后金丝雀还在', canary && canary.file === 'case1-canary' && String(canary.row).includes('case1-canary'), JSON.stringify(canary));
    } finally {
      await second.app.close().catch(() => undefined);
      killPid(second.pid);
    }
  } catch (err) {
    evidence.thrown = err && err.stack ? err.stack : String(err);
    const page = app.windows()[0];
    if (page) await page.screenshot({ path: path.join(EVIDENCE, 'case1-boot.png') }).catch(() => undefined);
    throw err;
  } finally {
    evidence.elapsedMs = Date.now() - started;
    writeEvidence('case1-upgrade.json', evidence);
    await app.close().catch(() => undefined);
    killPid(pid);
  }
}

async function caseTamper() {
  const id = 'case2-tamper';
  const root = path.join(RUNTIME, id);
  const user = path.join(root, 'user');
  const install = path.join(root, 'install');
  const feed = path.join(root, 'feed');
  const done = path.join(root, 'helper-done.txt');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'version.txt'), '0.2.0', 'utf8');
  const body = Buffer.alloc(128 * 1024, 3);
  const sha = createHash('sha512').update(body).digest('base64');
  const flipped = Buffer.from(body);
  flipped[0] = 9;
  const packed = await writeFeed(feed, '0.2.1-test', flipped, sha);
  const env = baseEnv({
    KB_USER_DATA: user,
    KB_UPDATE_ROAMING: path.join(root, 'roam'),
    KB_UPDATE_INSTALL_DIR: install,
    KB_UPDATE_FEED: feed,
    KB_UPDATE_HELPER_DONE: done,
    KB_UPDATE_CURRENT_VERSION: '0.2.0',
  });
  const { app, pid } = await launch(env);
  const evidence = { pid, packed: packed.name };
  try {
    await waitHook(app);
    const main = await app.evaluate(() => globalThis.__kbUpdate.check());
    evidence.phase = main.phase;
    evidence.error = main.error;
    evidence.downloaded = main.downloaded;
    evidence.p99 = await app.evaluate(() => globalThis.__kbUpdate.eventLoopP99());
    const dest = path.join(user, 'update-downloads', packed.name);
    evidence.fileLeft = fs.existsSync(dest);
    evidence.version = fs.readFileSync(path.join(install, 'version.txt'), 'utf8').trim();
    check('篡改包被拒绝', main.phase === 'failed' && main.downloaded === false && /丢弃|不一致/.test(main.error || ''), main.error || '');
    check('篡改包没有留下', evidence.fileLeft === false && evidence.version === '0.2.0' && !fs.existsSync(done), evidence.version);
    check('拒绝时 p99 < 100ms', typeof evidence.p99 === 'number' && evidence.p99 < 100, String(evidence.p99));
  } finally {
    writeEvidence('case2-tamper.json', evidence);
    await app.close().catch(() => undefined);
    killPid(pid);
  }
}

async function caseRollback() {
  const id = 'case3-rollback';
  const root = path.join(RUNTIME, id);
  const user = path.join(root, 'user');
  const roam = path.join(root, 'roam');
  const install = path.join(root, 'install');
  const feed = path.join(root, 'feed');
  const done = path.join(root, 'helper-done.txt');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'version.txt'), '0.2.0', 'utf8');
  fs.writeFileSync(path.join(install, 'build-id.txt'), 'old', 'utf8');
  await writeFeed(feed, '0.2.1-test', Buffer.alloc(48 * 1024, 6));
  const env = baseEnv({
    KB_USER_DATA: user,
    KB_UPDATE_ROAMING: roam,
    KB_UPDATE_INSTALL_DIR: install,
    KB_UPDATE_FEED: feed,
    KB_UPDATE_HELPER_DONE: done,
    KB_UPDATE_CURRENT_VERSION: '0.2.0',
  });
  const { app, pid } = await launch(env);
  const evidence = { pid };
  try {
    await waitHook(app);
    await app.evaluate(async () => {
      await globalThis.__kbUpdate.writeCanary('case3-canary');
      await globalThis.__kbUpdate.check();
    });
    await installFromTray(app);
    await waitFile(done, 120000);
    evidence.versionAfterInstall = fs.readFileSync(path.join(install, 'version.txt'), 'utf8').trim();
    const env2 = baseEnv({
      KB_USER_DATA: user,
      KB_UPDATE_ROAMING: roam,
      KB_UPDATE_INSTALL_DIR: install,
      KB_UPDATE_FEED: feed,
      KB_UPDATE_HELPER_DONE: path.join(root, 'helper-done-rollback.txt'),
      KB_UPDATE_CURRENT_VERSION: '0.2.1-test',
      KB_UPDATE_SELF_CHECK: 'fail',
      KB_UPDATE_SELF_CHECK_REASON: '自检被测试钩子标为失败',
      KB_UPDATE_DAMAGE_BEFORE_ROLLBACK: '1',
      KB_UPDATE_SELF_CHECK_MS: '120000',
    });
    const second = await launch(env2);
    evidence.secondPid = second.pid;
    try {
      const code = await waitExit(second.app, 120000);
      evidence.rollbackExit = code;
      const helper = await waitFile(env2.KB_UPDATE_HELPER_DONE, 120000);
      evidence.helper = helper;
    } finally {
      killPid(second.pid);
    }
    evidence.versionAfterRollback = fs.readFileSync(path.join(install, 'version.txt'), 'utf8').trim();
    evidence.buildId = fs.readFileSync(path.join(install, 'build-id.txt'), 'utf8').trim();
    evidence.canaryFile = fs.readFileSync(path.join(user, 'canary.json'), 'utf8');
    evidence.reason = fs.readFileSync(path.join(user, 'update-rollback-reason.txt'), 'utf8');
    const env3 = baseEnv({
      KB_USER_DATA: user,
      KB_UPDATE_ROAMING: roam,
      KB_UPDATE_INSTALL_DIR: install,
      KB_UPDATE_FEED: feed,
      KB_UPDATE_HELPER_DONE: path.join(root, 'helper-done-read.txt'),
      KB_UPDATE_CURRENT_VERSION: '0.2.0',
    });
    const third = await launch(env3);
    evidence.thirdPid = third.pid;
    try {
      await waitHook(third.app);
      evidence.canary = await third.app.evaluate(() => globalThis.__kbUpdate.readCanary());
    } finally {
      await third.app.close().catch(() => undefined);
      killPid(third.pid);
    }
    check('回滚后版本回到 0.2.0', evidence.versionAfterRollback === '0.2.0' && evidence.buildId === 'old', evidence.versionAfterRollback);
    check('回滚后金丝雀完好', evidence.canaryFile === 'case3-canary' && String(evidence.canary && evidence.canary.row).includes('case3-canary'), JSON.stringify(evidence.canary));
    check('回滚原因已写明', evidence.reason.includes('自检被测试钩子标为失败'), evidence.reason.replace(/\n/g, ' '));
  } finally {
    writeEvidence('case3-rollback.json', evidence);
    await app.close().catch(() => undefined);
    killPid(pid);
  }
}

async function caseFrozenTray() {
  const id = 'case4-frozen-tray';
  const root = path.join(RUNTIME, id);
  const user = path.join(root, 'user');
  const install = path.join(root, 'install');
  const feed = path.join(root, 'feed');
  const done = path.join(root, 'helper-done.txt');
  fs.mkdirSync(install, { recursive: true });
  fs.writeFileSync(path.join(install, 'version.txt'), '0.2.0', 'utf8');
  await writeFeed(feed, '0.2.1-test', Buffer.alloc(64 * 1024, 2));
  const env = baseEnv({
    KB_USER_DATA: user,
    KB_UPDATE_ROAMING: path.join(root, 'roam'),
    KB_UPDATE_INSTALL_DIR: install,
    KB_UPDATE_FEED: feed,
    KB_UPDATE_HELPER_DONE: done,
    KB_UPDATE_CURRENT_VERSION: '0.2.0',
    KB_TEST_FREEZE_RENDERER: '1',
  });
  const { app, pid } = await launch(env);
  const evidence = { pid };
  try {
    await waitHook(app);
    const main = await app.evaluate(async (electron) => {
      const deadline = Date.now() + 90000;
      while (!globalThis.__kbRendererFreezeStarted) {
        if (Date.now() > deadline) throw new Error('渲染进程冻结钩子没有出现');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const win = electron.BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      let rendererReplied = false;
      if (win) void win.webContents.executeJavaScript('1').then(() => { rendererReplied = true; }).catch(() => { rendererReplied = true; });
      const snap = await globalThis.__kbUpdate.check();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return {
        rendererReplied,
        phase: snap.phase,
        downloaded: snap.downloaded,
        error: snap.error,
        freeze: globalThis.__kbRendererFreezeStarted === true,
        p99: globalThis.__kbUpdate.eventLoopP99(),
      };
    });
    evidence.phase = main.phase;
    evidence.p99 = main.p99;
    evidence.rendererReplied = main.rendererReplied;
    evidence.freeze = main.freeze;
    await installFromTray(app);
    await waitFile(done, 120000);
    evidence.version = fs.readFileSync(path.join(install, 'version.txt'), 'utf8').trim();
    check('渲染进程已冻结', main.freeze === true && main.rendererReplied === false, JSON.stringify({ freeze: main.freeze, rendererReplied: main.rendererReplied }));
    check('冻结后托盘立即升级完成', main.phase === 'ready' && main.downloaded === true && evidence.version === '0.2.1-test', `${main.phase} ${evidence.version} ${main.error || ''}`);
    check('冻结路径 p99 < 100ms', typeof main.p99 === 'number' && main.p99 < 100, String(main.p99));
  } finally {
    writeEvidence('case4-frozen-tray.json', evidence);
    killPid(pid);
  }
}

const startedAll = Date.now();
for (const run of [caseUpgrade, caseTamper, caseRollback, caseFrozenTray]) {
  try {
    await run();
  } catch (err) {
    check(run.name + ' 没有抛出', false, err && err.stack ? err.stack : String(err));
  }
}
const ownerAfter = [stamp(ownerDb), stamp(ownerExe)];
const ownerSame = ownerBefore.every((before, index) => {
  const after = ownerAfter[index];
  if (!before.exists && !after.exists) return true;
  return before.exists === after.exists && before.mtimeMs === after.mtimeMs && before.size === after.size;
});
check('用户的数据库和安装版没有被改', ownerSame, JSON.stringify({ ownerBefore, ownerAfter }));
check('每段开窗短于 20 分钟', Date.now() - startedAll < 20 * 60 * 1000, String(Date.now() - startedAll));
writeEvidence('summary.json', { results, ownerBefore, ownerAfter, elapsedMs: Date.now() - startedAll, segmentBudgetMs: SEGMENT_MS });
const failed = results.filter((row) => !row.ok);
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, elapsedMs: Date.now() - startedAll }, null, 2));
if (failed.length) process.exit(1);
