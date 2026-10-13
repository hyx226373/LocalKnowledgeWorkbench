import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
export { ftsShortTitle, relocateResource } from "./relocate.js";
function samePath(a, b) {
    const left = path.resolve(a);
    const right = path.resolve(b);
    if (process.platform === 'win32')
        return left.toLowerCase() === right.toLowerCase();
    return left === right;
}
function resolveWorkerFile() {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const ts = path.join(dir, 'worker.ts');
    const js = path.join(dir, 'worker.js');
    if (existsSync(ts))
        return ts;
    if (existsSync(js))
        return js;
    throw new Error(`找不到 sync worker（${dir}）`);
}
function workerExecArgv(workerFile) {
    if (workerFile.endsWith('.ts'))
        return ['--experimental-strip-types', '--no-warnings'];
    return ['--no-warnings'];
}
function workerEnv() {
    const env = { ...process.env };
    // vitest fork 的 IPC 不能传进会话线程，否则父进程会报 ERR_IPC_CHANNEL_CLOSED。
    if (env.NODE_CHANNEL_FD) {
        delete env.NODE_CHANNEL_FD;
        delete env.NODE_CHANNEL_SERIALIZATION_MODE;
        delete env.NODE_OPTIONS;
    }
    return env;
}
function startHandle(input) {
    const workerFile = resolveWorkerFile();
    const worker = new Worker(workerFile, {
        execArgv: workerExecArgv(workerFile),
        env: workerEnv(),
        trackUnmanagedFds: false,
    });
    const listeners = new Set();
    const idleWaiters = new Map();
    let idleSeq = 0;
    let settled = false;
    let cancelRequested = false;
    let resolveDone = () => { };
    const done = new Promise((resolve) => {
        resolveDone = resolve;
    });
    let killTimer = null;
    let failMessage = '';
    // 会话在别的线程里跑。主线程如果干等，Windows 会把 20ms 定时器合并到 50ms 以上。
    const keepAwake = setInterval(() => { }, 5);
    function fanout(progress) {
        for (const cb of listeners) {
            try {
                cb(progress);
            }
            catch {
                // 进度回调不能拖垮会话
            }
        }
    }
    function failIdle(err) {
        for (const waiter of idleWaiters.values())
            waiter.reject(err);
        idleWaiters.clear();
    }
    function finish(status) {
        if (settled)
            return;
        settled = true;
        if (killTimer)
            clearTimeout(killTimer);
        killTimer = null;
        clearInterval(keepAwake);
        const resolved = cancelRequested && status === 'error' ? 'cancelled' : status;
        resolveDone({ status: resolved });
        if (resolved === 'error') {
            const err = new Error(failMessage || 'sync 失败');
            failIdle(err);
        }
        else {
            for (const waiter of idleWaiters.values())
                waiter.resolve();
            idleWaiters.clear();
        }
        // terminate 会在 native 插件还开着时把整个测试进程打掉。线程自己收尾，这里只解开引用。
        worker.unref();
    }
    worker.on('message', (msg) => {
        if (msg.type === 'progress') {
            fanout(msg.progress);
            return;
        }
        if (msg.type === 'idle-ack') {
            const waiter = idleWaiters.get(msg.id);
            if (!waiter)
                return;
            idleWaiters.delete(msg.id);
            if (msg.error)
                waiter.reject(new Error(msg.error));
            else
                waiter.resolve();
            return;
        }
        if (msg.type === 'finished') {
            if (msg.message) {
                failMessage = msg.message;
                console.error(msg.message);
            }
            finish(msg.status);
        }
    });
    worker.on('error', (err) => {
        if (settled || cancelRequested)
            return;
        console.error(err);
        finish('error');
    });
    worker.on('exit', (code) => {
        if (settled)
            return;
        if (code !== 0 && !cancelRequested) {
            failMessage = failMessage || `sync worker 退出码 ${code}`;
            console.error(failMessage);
            finish('error');
            return;
        }
        finish(cancelRequested ? 'cancelled' : 'error');
    });
    try {
        worker.postMessage({
            type: 'start',
            rootId: input.rootId,
            dbPath: input.dbPath,
            localPath: input.localPath,
        });
    }
    catch (err) {
        console.error(err);
        finish('error');
    }
    const handle = {
        onProgress(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        cancel() {
            if (settled || cancelRequested)
                return;
            cancelRequested = true;
            try {
                worker.postMessage({ type: 'cancel' });
            }
            catch {
                finish('cancelled');
                return;
            }
            if (killTimer)
                return;
            killTimer = setTimeout(() => {
                if (settled)
                    return;
                worker.terminate().catch(() => { });
                finish('cancelled');
            }, 3000);
            killTimer.unref?.();
        },
        whenIdle() {
            if (settled) {
                if (cancelRequested)
                    return Promise.resolve();
                return Promise.reject(new Error(failMessage || 'sync 失败'));
            }
            const id = ++idleSeq;
            return new Promise((resolve, reject) => {
                idleWaiters.set(id, { resolve, reject });
                try {
                    worker.postMessage({ type: 'when-idle', id });
                }
                catch (err) {
                    idleWaiters.delete(id);
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            });
        },
        done,
    };
    return handle;
}
export function createSync(deps) {
    if (!deps?.db)
        throw new Error('db 不能为空');
    if (!deps.dbPath || deps.dbPath === ':memory:' || deps.db.name === '' || deps.db.name === ':memory:') {
        throw new Error('dbPath 必须是数据库文件，不能是 :memory:');
    }
    const dbPath = path.resolve(deps.dbPath);
    if (!samePath(deps.db.name, dbPath)) {
        throw new Error('dbPath 和 db 不是同一个文件');
    }
    try {
        deps.db.pragma('busy_timeout = 5000');
    }
    catch {
        // 调用方连接只用来校验和之后的 search
    }
    const running = new Map();
    return {
        startSync(rootId) {
            if (!rootId)
                throw new Error('rootId 不能为空');
            const existing = running.get(rootId);
            if (existing)
                return existing;
            const given = deps.resolveLocalPath(rootId);
            if (!given)
                throw new Error('resolveLocalPath 没有返回路径');
            if (!existsSync(given))
                throw new Error('资料根不存在');
            const localPath = realpathSync(given);
            const handle = startHandle({ rootId, dbPath, localPath });
            running.set(rootId, handle);
            void handle.done.finally(() => {
                if (running.get(rootId) === handle)
                    running.delete(rootId);
            });
            return handle;
        },
    };
}
//# sourceMappingURL=index.js.map