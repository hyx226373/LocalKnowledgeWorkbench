// 用真实的 worker_threads 跑扫描：验证进度事件与取消路径（主进程只编排）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { buildSync } from 'esbuild';
import Database from 'better-sqlite3';
import { WorkerIndexRunner } from '../src/main/service/indexRunner';
import { WorkbenchService } from '../src/main/service/WorkbenchService';
import { linkDir, makeRoot, tmpDir, write } from './helpers';

let workerJs: string;
beforeAll(() => {
  const out = tmpDir('kbworker-');
  workerJs = path.join(out, 'indexWorker.js');
  buildSync({ entryPoints: ['src/main/indexWorker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: workerJs, external: ['better-sqlite3'], nodePaths: [path.resolve('node_modules')] });
  // worker 需要能 require 到 better-sqlite3
  linkDir(path.resolve('node_modules'), path.join(out, 'node_modules'));
});

describe('WorkerIndexRunner', () => {
  const svcs: WorkbenchService[] = [];
  afterAll(async () => {
    for (const s of svcs) await s.close();
  });

  it('在 worker 中扫描并报告进度', async () => {
    const progress: number[] = [];
    const svc = new WorkbenchService({
      dataDir: tmpDir('kbdata-'),
      createRunner: (db, ev) => new WorkerIndexRunner(workerJs, db, { onProgress: (r, n) => (progress.push(n), ev.onProgress?.(r, n)) }),
    });
    svcs.push(svc);
    const dir = makeRoot();
    for (let i = 0; i < 1200; i++) write(path.join(dir, `批量/${Math.floor(i / 100)}/f${i}.txt`), String(i));
    const root = svc.addRoot(dir);
    const r = await svc.scanRoot(root.id);
    expect(r?.cancelled).toBe(false);
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress[progress.length - 1]).toBe(r!.processed);
    expect(svc.getIndexStatus()[0]).toMatchObject({ state: 'idle', fileCount: 1205 });
    expect(svc.search('f1199.txt')[0].relPath).toBe('批量/11/f1199.txt');
  });

  it('可以取消正在进行的扫描，且取消不会把未扫描部分误标为缺失', async () => {
    const svc = new WorkbenchService({ dataDir: tmpDir('kbdata-'), createRunner: (db, ev) => new WorkerIndexRunner(workerJs, db, ev) });
    svcs.push(svc);
    const dir = tmpDir('kbbig-');
    for (let i = 0; i < 8000; i++) write(path.join(dir, `d${i % 200}/f${i}.txt`), 'x');
    const root = svc.addRoot(dir); // addRoot 会自动开始扫描
    await new Promise((r) => setTimeout(r, 30));
    svc.cancelScan(root.id);
    const r = await svc.scanRoot(root.id).then(() => null); // 新一轮扫描会清除取消标记，用于验证可重新开始
    expect(r).toBeNull();
    const st = svc.getIndexStatus()[0];
    expect(st.fileCount).toBe(8000);
    // 再验证一次纯取消：开始 → 立即取消 → 结果 cancelled
    const p = svc.scanRoot(root.id);
    svc.cancelScan(root.id);
    const res = await p;
    expect(res?.cancelled).toBe(true);
    expect(svc.getIndexStatus()[0].lastError).toBe('扫描已取消');
    expect(svc.getIndexStatus()[0].fileCount).toBe(8000); // 未被误标
  }, 60000);
  it('closes the worker database before exit and leaves an intact database', async () => {
    const dataDir = tmpDir('kb-exit-');
    const svc = new WorkbenchService({ dataDir, createRunner: (db, ev) => new WorkerIndexRunner(workerJs, db, ev) });
    const dir = tmpDir('kb-exit-root-');
    write(path.join(dir, 'note.md'), 'exit verification');
    const root = svc.addRoot(dir);
    await svc.scanRoot(root.id);
    const started = Date.now();
    await svc.close();
    expect(Date.now() - started).toBeLessThan(5000);
    const db = new Database(path.join(dataDir, 'workbench.db'));
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT COUNT(*) n FROM resources WHERE kind=\'file\'').get()).toEqual({ n: 1 });
    } finally { db.close(); }
  }, 10000);

});
