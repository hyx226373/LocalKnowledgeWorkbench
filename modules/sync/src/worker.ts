import { parentPort } from 'node:worker_threads';
import { attachSession } from './session.ts';

if (!parentPort) throw new Error('sync worker 必须在 worker_threads 里运行');

attachSession(parentPort);
