// G1 隔离迁移。不启动 Electron。夹具只在 updater-0027\g1\fixture。
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = 'D:\\kb-r13-work\\updater-0027\\tmp';
const FIXTURE = 'D:\\kb-r13-work\\updater-0027\\g1\\fixture';
const RESULT = 'D:\\kb-r13-work\\updater-0027\\g1\\g1-result.json';
const NOW = '2026-10-10T12:00:00.000Z';

async function bundle(build, fs, entry, name) {
  await fs.mkdir(TMP, { recursive: true });
  const outfile = path.join(TMP, name);
  await build({
    absWorkingDir: repo,
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
  });
  return require(outfile);
}

async function exists(fs, file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

const fs = await import('node:fs/promises');
const { build } = await import('esbuild');

let payload = { ok: false, version: null, currentJson: null, rootExeRenamed: false };
try {
  const layout = await bundle(build, fs, path.join(repo, 'src', 'shared', 'layout', 'index.ts'), 'g1-layout.cjs');
  const migrate = await bundle(build, fs, path.join(repo, 'src', 'migrate', 'runMigrate.ts'), 'g1-migrate.cjs');
  await fs.rm(FIXTURE, { recursive: true, force: true });
  await fs.mkdir(FIXTURE, { recursive: true });
  for (const rel of layout.VERSION_TREE_REQUIRED) {
    const file = path.join(FIXTURE, ...rel.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from('fake-byte'));
  }
  const result = await migrate.migrateLayout({ installRoot: FIXTURE, fileVersion: '0.2.4', now: NOW });
  const exe = path.join(FIXTURE, layout.APP_EXE);
  const renamed = path.join(FIXTURE, `${layout.APP_EXE}.pre-layout`);
  let currentJson = null;
  if (await exists(fs, path.join(FIXTURE, 'current.json'))) {
    currentJson = layout.parseCurrent(await fs.readFile(path.join(FIXTURE, 'current.json'), 'utf8'));
  }
  const rootExeRenamed = !(await exists(fs, exe)) && (await exists(fs, renamed));
  payload = {
    ok: result.ok === true && currentJson?.current === '0.2.4' && rootExeRenamed,
    version: result.ok ? result.version : null,
    currentJson,
    rootExeRenamed,
    reason: result.ok ? null : result.reason,
  };
} catch (err) {
  payload = {
    ok: false,
    version: null,
    currentJson: null,
    rootExeRenamed: false,
    reason: err instanceof Error ? err.message : String(err),
  };
}

await fs.mkdir(path.dirname(RESULT), { recursive: true });
await fs.writeFile(RESULT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(payload));
process.exit(payload.ok === true ? 0 : 1);
