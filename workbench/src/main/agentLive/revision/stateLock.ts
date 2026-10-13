import fs from 'node:fs';
import path from 'node:path';
import { AgentLiveError } from './errors';

function delaySpin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* 只在状态文件锁冲突时占用，正常发布路径不进这里 */
  }
}

/** 与组 1 相同的独占目录锁 `${file}.lock`。不 import materials。 */
export async function withStateLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let held = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      held = true;
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      delaySpin(5);
    }
  }
  if (!held) throw new AgentLiveError('state_locked', 'agent-live-state.json 正在被占用');
  try {
    return await fn();
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
