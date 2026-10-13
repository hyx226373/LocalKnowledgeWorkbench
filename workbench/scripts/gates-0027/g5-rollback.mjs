// G5 新版启动失败则回退指针。未获主线放行时不启动 Electron。不删版本目录。
if (process.env.KB_GATE_ALLOW_ELECTRON !== '1') {
  console.log('未获主线放行，不启动 Electron');
  process.exit(2);
}

async function main() {
  const { createRequire } = await import('node:module');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const fs = await import('node:fs/promises');
  const { build } = await import('esbuild');
  const { spawn } = await import('node:child_process');
  const require = createRequire(import.meta.url);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tmp = 'D:\\kb-r13-work\\updater-0027\\tmp';

  function arg(flag) {
    const index = process.argv.indexOf(flag);
    if (index < 0) return '';
    const value = process.argv[index + 1] ?? '';
    if (!value || value.startsWith('--')) return '';
    return value;
  }

  const installRoot = arg('--root');
  if (!installRoot) {
    console.error('用法: node scripts/gates-0027/g5-rollback.mjs --root <安装根> [--launch]');
    process.exit(2);
  }

  await fs.mkdir(tmp, { recursive: true });
  const outfile = path.join(tmp, 'g5-layout.cjs');
  await build({
    absWorkingDir: repo,
    entryPoints: [path.join(repo, 'src', 'shared', 'layout', 'index.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  const layout = require(outfile);
  if (layout.isUnderStudyDev(installRoot)) {
    console.error('拒绝写入 D:\\study_dev');
    process.exit(2);
  }

  const pointer = await layout.readCurrent(installRoot);
  let phase = 'verifying';
  let fromVersion = pointer.previous ?? pointer.current;
  let toVersion = pointer.current;
  const readyVersion = null;
  try {
    const text = await fs.readFile(layout.stateFile(installRoot), 'utf8');
    const state = layout.parseUpdaterState(text);
    phase = state.phase;
    fromVersion = state.fromVersion;
    toVersion = state.toVersion;
  } catch {
    // 没有状态文件时按坏候选处理：当前指针已指向新版，但没有就绪标记。
  }
  const action = layout.decideRecovery({
    phase,
    current: pointer.current,
    fromVersion,
    toVersion,
    readyVersion,
  });
  if (action.action !== 'rollback-pointer') {
    const reason = 'reason' in action ? action.reason : '';
    console.error(`不回退：${action.action}${reason ? ` ${reason}` : ''}`);
    process.exit(1);
  }
  const rolled = layout.pointBack(pointer, new Date().toISOString());
  await layout.writeCurrent(installRoot, rolled);
  if (process.argv.includes('--launch')) {
    const exe = layout.appExe(installRoot, rolled.current);
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  console.log(JSON.stringify({
    ok: true,
    action: action.action,
    current: rolled.current,
    previous: rolled.previous,
  }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
