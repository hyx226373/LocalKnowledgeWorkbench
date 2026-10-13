// G2 正常更新切换。未获主线放行时不启动 Electron。
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
  const to = arg('--to');
  if (!installRoot || !to) {
    console.error('用法: node scripts/gates-0027/g2-switch.mjs --root <安装根> --to <版本> [--launch]');
    process.exit(2);
  }

  await fs.mkdir(tmp, { recursive: true });
  const outfile = path.join(tmp, 'g2-layout.cjs');
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
  const next = layout.pointAt(pointer, to, new Date().toISOString());
  const tree = await layout.verifyVersionTree(layout.versionDir(installRoot, to));
  if (!tree.ok) {
    console.error(`候选不完整：${tree.missing.join('、')}`);
    process.exit(1);
  }
  await layout.writeCurrent(installRoot, next);
  if (process.argv.includes('--launch')) {
    const exe = layout.appExe(installRoot, next.current);
    const child = spawn(exe, [], { detached: true, stdio: 'ignore' });
    child.unref();
  }
  console.log(JSON.stringify({ ok: true, current: next.current, previous: next.previous }));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
