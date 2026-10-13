/** 在独立工作线程里做 SQLite backup。主进程不打开这条连接。 */
import Database from 'better-sqlite3';
import { parentPort } from 'node:worker_threads';

interface Req {
  id: number;
  op: 'backup' | 'put-canary' | 'get-canary';
  src?: string;
  dest?: string;
  file?: string;
  value?: string;
}

const CANARY_KEY = 'update.canary';

async function run(req: Req): Promise<unknown> {
  if (req.op === 'backup') {
    const db = new Database(req.src!, { readonly: true, fileMustExist: true, timeout: 8000 });
    try {
      await db.backup(req.dest!);
    } finally {
      db.close();
    }
    return { ok: true };
  }
  const db = new Database(req.file!, { readonly: req.op === 'get-canary', fileMustExist: true, timeout: 8000 });
  try {
    if (req.op === 'put-canary') {
      db.prepare(
        `INSERT INTO layout(key, json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
      ).run(CANARY_KEY, req.value ?? 'null', Date.now());
      return { ok: true };
    }
    const row = db.prepare('SELECT json FROM layout WHERE key=?').get(CANARY_KEY) as { json: string } | undefined;
    return { ok: true, json: row?.json ?? null };
  } finally {
    db.close();
  }
}

parentPort?.on('message', (req: Req) => {
  void run(req)
    .then((result) => parentPort?.postMessage({ id: req.id, ...(result as object) }))
    .catch((err: unknown) => parentPort?.postMessage({ id: req.id, ok: false, error: String((err as Error).message ?? err) }));
});
