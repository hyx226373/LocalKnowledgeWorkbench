import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { openReadDb } from '../src/main/service/db';
import { createWriteBatcher } from '../src/main/data/writeBatch';
import { EXITING_WAIT_MS } from '../src/main/instanceLock';
import { isRendererDataMethod } from '../src/shared/dataMethods';
import { makeService } from './helpers';

const root = path.resolve(__dirname, '..');

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

function relativeSpecs(text: string): string[] {
  const source = stripComments(text);
  const out: string[] = [];
  const fromRe = /(?:import|export)([\s\S]*?)from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromRe.exec(source))) {
    if (/^\s*type\b/.test(match[1])) continue;
    out.push(match[2]);
  }
  const dynRe = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  while ((match = dynRe.exec(source))) out.push(match[1]);
  return out;
}

function resolveSpec(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.mjs`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function walk(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const pending = [path.resolve(root, entry)];
  while (pending.length) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    files.set(file, text);
    for (const spec of relativeSpecs(text)) {
      const next = resolveSpec(file, spec);
      if (next) pending.push(next);
    }
  }
  return files;
}

describe('数据进程和窗口进程分开', () => {
  test('窗口进程的导入图里没有数据库', () => {
    const files = walk('src/main/index.ts');
    const index = files.get(path.resolve(root, 'src/main/index.ts')) ?? '';
    expect(index.includes('better-sqlite3')).toBe(false);
    expect(index.includes('.prepare(')).toBe(false);
    const offenders: string[] = [];
    let sawFork = false;
    let sawEntry = false;
    for (const [file, text] of files) {
      if (text.includes('utilityProcess')) sawFork = true;
      if (text.includes('dataEntry.js')) sawEntry = true;
      if (text.includes('better-sqlite3') || text.includes('.prepare(')) offenders.push(path.relative(root, file));
    }
    expect(offenders).toEqual([]);
    expect(sawFork).toBe(true);
    expect(sawEntry).toBe(true);
    const backup = path.resolve(root, 'src/main/update/backupWorker.ts');
    expect(files.has(backup)).toBe(false);
  });

  test('数据进程的导入图包含数据库', () => {
    const files = walk('src/main/data/entry.ts');
    const db = [...files.keys()].some((file) => file.replace(/\\/g, '/').endsWith('src/main/service/db.ts'));
    expect(db).toBe(true);
  });

  test('渲染进程不能调用内部方法', () => {
    expect(isRendererDataMethod('aboutInfo')).toBe(false);
    expect(isRendererDataMethod('listRoots')).toBe(true);
    expect(isRendererDataMethod('pickFolder')).toBe(false);
    expect(isRendererDataMethod('plugin.webAccess')).toBe(false);
    expect(isRendererDataMethod('plugin.audit')).toBe(false);
    expect(isRendererDataMethod('resolveKbfile')).toBe(false);
    expect(isRendererDataMethod('migration.info')).toBe(false);
  });

  test('新实例最多等 1 秒', () => {
    expect(EXITING_WAIT_MS).toBe(1000);
  });

  test('只读连接看得到已提交的布局', async () => {
    const { svc } = await makeService();
    try {
      svc.setLayout('probe.layout', { n: 7 });
      expect(svc.getLayout('probe.layout')).toEqual({ n: 7 });
      const read = openReadDb(svc.dbFile);
      expect(read).not.toBeNull();
      const row = read!.prepare('SELECT json FROM layout WHERE key = ?').get('probe.layout') as { json: string };
      expect(JSON.parse(row.json)).toEqual({ n: 7 });
      read!.close();
    } finally {
      await svc.close();
    }
  });

  test('写队列满两件后让出', async () => {
    const batch = createWriteBatcher(2);
    const order: string[] = [];
    const first = batch.enqueue(() => { order.push('a'); });
    const second = batch.enqueue(() => { order.push('b'); });
    const third = batch.enqueue(() => { order.push('c'); });
    expect(order).toEqual(['a', 'b']);
    expect(batch.pending()).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['a', 'b', 'c']);
    await Promise.all([first, second, third]);
  });
});
