import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleNativeDragIpc, nativeDragWantsSyncReply } from '../src/main/nativeDrag/dispatch';
import { nativeDragIcon } from '../src/main/nativeDrag/icon';
import { nodeNativeDragFs } from '../src/main/nativeDrag/nodeFs';
import { isRendererDataMethod } from '../src/shared/dataMethods';
import {
  allowListFromCatalog,
  createNativeDragController,
  createNativeDragLog,
  isPathInsideRoot,
  NATIVE_DRAG_LOG_CAP,
  performNativeDrag,
  rejectNativeDragPath,
  type NativeDragAllow,
  type NativeDragFs,
  type NativeDragStat,
} from '../src/shared/nativeDragPolicy';

const win = path.win32;

function stat(kind: 'file' | 'dir' | 'symlink' | 'other'): NativeDragStat {
  return {
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'symlink',
  };
}

function memFs(
  entries: { path: string; kind: 'file' | 'dir' | 'symlink' | 'other'; real?: string }[],
  pathLib: typeof path | typeof path.win32,
  caseInsensitive: boolean,
): NativeDragFs {
  const key = (filePath: string) => {
    const resolved = pathLib.resolve(filePath);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const map = new Map(entries.map((entry) => [key(entry.path), entry]));
  return {
    lstat(filePath) {
      const hit = map.get(key(filePath));
      return hit ? stat(hit.kind) : null;
    },
    realpath(filePath) {
      const hit = map.get(key(filePath));
      if (!hit) return null;
      return pathLib.resolve(hit.real ?? filePath);
    },
  };
}

function run(
  requested: unknown,
  allow: NativeDragAllow,
  fsImpl: NativeDragFs,
  opts: { pathLib?: typeof path | typeof path.win32; caseInsensitive?: boolean; fail?: boolean } = {},
) {
  const started: string[][] = [];
  const log = createNativeDragLog();
  const result = performNativeDrag({
    requested,
    allow,
    fs: fsImpl,
    pathLib: opts.pathLib ?? path,
    caseInsensitive: opts.caseInsensitive ?? false,
    startDrag: (files) => {
      if (opts.fail) throw new Error('boom');
      started.push(files);
    },
    log,
    now: () => 1000,
  });
  return { result, started, log: log.read() };
}

describe('根内前缀', () => {
  it('Windows 大小写不敏感，且兄弟目录不算在根内', () => {
    expect(isPathInsideRoot('c:\\data\\root\\a.md', 'C:\\Data\\Root', win, true)).toBe(true);
    expect(isPathInsideRoot('C:/Data/Root/a.md', 'C:\\Data\\Root', win, true)).toBe(true);
    expect(isPathInsideRoot('C:\\Data\\Root2\\a.md', 'C:\\Data\\Root', win, true)).toBe(false);
    expect(isPathInsideRoot('C:\\Data\\Root', 'C:\\Data\\Root', win, true)).toBe(true);
  });

  it('POSIX 区分大小写', () => {
    expect(isPathInsideRoot('/data/root/a.md', '/data/root', path, false)).toBe(true);
    expect(isPathInsideRoot('/data/Root/a.md', '/data/root', path, false)).toBe(false);
    expect(isPathInsideRoot('/data/root2/a.md', '/data/root', path, false)).toBe(false);
  });
});

describe('路径校验', () => {
  const allow: NativeDragAllow = { roots: ['C:\\Data\\Root'], files: ['D:\\loose\\note.md'] };
  const disk = memFs(
    [
      { path: 'C:\\Data\\Root', kind: 'dir' },
      { path: 'C:\\Data\\Root\\a.md', kind: 'file' },
      { path: 'C:\\Data\\Root\\sub', kind: 'dir' },
      { path: 'C:\\Data\\Root\\junction', kind: 'dir', real: 'D:\\secret' },
      { path: 'C:\\Data\\Root\\pipe', kind: 'other' },
      { path: 'C:\\Data\\Root\\dir-link', kind: 'symlink', real: 'C:\\Data\\Root\\sub' },
      { path: 'C:\\Data\\Root\\out-link', kind: 'symlink', real: 'D:\\loose\\fold' },
      { path: 'C:\\Data\\Root2', kind: 'dir' },
      { path: 'C:\\Data\\Root2\\a.md', kind: 'file' },
      { path: 'D:\\loose\\fold', kind: 'dir' },
      { path: 'D:\\other\\a.md', kind: 'file' },
      { path: 'D:\\loose\\note.md', kind: 'file' },
      { path: 'D:\\loose\\jump.md', kind: 'symlink', real: 'D:\\secret\\x.txt' },
      { path: 'C:\\Data\\one.md', kind: 'file' },
      { path: 'C:\\Data\\one.md\\evil.txt', kind: 'file' },
      { path: 'C:\\Data\\Root\\link.md', kind: 'symlink', real: 'D:\\secret\\x.txt' },
      { path: 'D:\\secret\\x.txt', kind: 'file' },
      { path: 'C:\\Data\\Root\\ok-link.md', kind: 'symlink', real: 'C:\\Data\\Root\\a.md' },
      { path: 'C:\\Data\\Root\\via\\secret.txt', kind: 'file', real: 'D:\\secret\\x.txt' },
      { path: 'C:\\Data\\Root\\alias.md', kind: 'symlink', real: 'D:\\loose\\note.md' },
    ],
    win,
    true,
  );

  it('根内文件通过，并按请求的大小写解析', () => {
    const { result, started, log } = run(['c:\\data\\root\\a.md'], allow, disk, { pathLib: win, caseInsensitive: true });
    expect(result.ok).toBe(true);
    expect(started).toEqual([[win.resolve('c:\\data\\root\\a.md')]]);
    expect(log).toEqual([{ paths: [win.resolve('c:\\data\\root\\a.md')], ok: true, at: 1000 }]);
  });

  it('根外、不存在、非文件、越根符号链接拒绝，允许列表里的根外文件通过', () => {
    expect(rejectNativeDragPath('D:\\other\\a.md', allow, disk, win, true)).toBe('outside-root');
    expect(rejectNativeDragPath('C:\\Data\\Root2\\a.md', allow, disk, win, true)).toBe('outside-root');
    expect(rejectNativeDragPath('C:\\Data\\Root\\missing.md', allow, disk, win, true)).toBe('not-found');
    expect(rejectNativeDragPath('C:\\Data\\Root\\pipe', allow, disk, win, true)).toBe('not-file');
    expect(rejectNativeDragPath('C:\\Data\\Root\\link.md', allow, disk, win, true)).toBe('symlink-escape');
    expect(rejectNativeDragPath('C:\\Data\\Root\\via\\secret.txt', allow, disk, win, true)).toBe('symlink-escape');
    expect(rejectNativeDragPath('C:\\Data\\Root\\alias.md', allow, disk, win, true)).toBe('symlink-escape');
    expect(rejectNativeDragPath('C:\\Data\\Root\\ok-link.md', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('d:\\loose\\note.md', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('C:\\DATA\\ROOT\\A.MD', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('note.md', allow, disk, win, true)).toBe('invalid');
    expect(rejectNativeDragPath('C:\\Data\\one.md\\evil.txt', { roots: [], files: ['C:\\Data\\one.md'] }, disk, win, true)).toBe('outside-root');
    expect(rejectNativeDragPath('D:\\loose\\jump.md', { roots: allow.roots, files: ['D:\\loose\\jump.md'] }, disk, win, true)).toBe('symlink-escape');
  });

  it('有一项不合法就整批拒绝，不调用 startDrag', () => {
    const { result, started, log } = run(['C:\\Data\\Root\\a.md', 'D:\\other\\a.md'], allow, disk, { pathLib: win, caseInsensitive: true });
    expect(result).toMatchObject({ ok: false, reason: 'outside-root' });
    expect(started).toEqual([]);
    expect(log[0]).toMatchObject({ ok: false, reason: 'outside-root' });
  });

  it('根目录和子文件夹可以拖出，根外目录和越根目录链接不行', () => {
    expect(rejectNativeDragPath('C:\\Data\\Root', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('c:\\data\\root\\sub', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('C:\\Data\\Root\\dir-link', allow, disk, win, true)).toBeNull();
    expect(rejectNativeDragPath('C:\\Data\\Root2', allow, disk, win, true)).toBe('outside-root');
    expect(rejectNativeDragPath('C:\\Data\\Root\\out-link', allow, disk, win, true)).toBe('symlink-escape');
    expect(rejectNativeDragPath('C:\\Data\\Root\\junction', allow, disk, win, true)).toBe('symlink-escape');
    expect(rejectNativeDragPath('D:\\loose\\fold', { roots: allow.roots, files: ['D:\\loose\\fold'] }, disk, win, true)).toBe('outside-root');
    expect(rejectNativeDragPath('C:\\Data\\Root\\missing-dir', allow, disk, win, true)).toBe('not-found');
  });

  it('文件和目录一次交给 startDrag', () => {
    const { result, started } = run(['C:\\Data\\Root\\a.md', 'C:\\Data\\Root\\sub', 'C:\\Data\\Root'], allow, disk, {
      pathLib: win,
      caseInsensitive: true,
    });
    expect(result.ok).toBe(true);
    expect(started[0]).toEqual([
      win.resolve('C:\\Data\\Root\\a.md'),
      win.resolve('C:\\Data\\Root\\sub'),
      win.resolve('C:\\Data\\Root'),
    ]);
  });

  it('多个根内文件一次交给 startDrag', () => {
    const extra = memFs(
      [
        { path: 'C:\\Data\\Root', kind: 'dir' },
        { path: 'C:\\Data\\Root\\a.md', kind: 'file' },
        { path: 'C:\\Data\\Root\\b.md', kind: 'file' },
      ],
      win,
      true,
    );
    const { result, started } = run(['C:\\Data\\Root\\a.md', 'C:\\Data\\Root\\b.md'], { roots: ['C:\\Data\\Root'], files: [] }, extra, {
      pathLib: win,
      caseInsensitive: true,
    });
    expect(result.ok).toBe(true);
    expect(started[0]).toEqual([win.resolve('C:\\Data\\Root\\a.md'), win.resolve('C:\\Data\\Root\\b.md')]);
  });

  it('空列表、非数组、过多、startDrag 失败都有 reason', () => {
    expect(run([], allow, disk).result.reason).toBe('empty');
    expect(run('C:\\Data\\Root\\a.md', allow, disk).result.reason).toBe('invalid');
    expect(run(Array.from({ length: 65 }, (_, i) => `C:\\Data\\Root\\f${i}.md`), allow, disk).result.reason).toBe('too-many');
    const failed = run(['C:\\Data\\Root\\a.md'], allow, disk, { pathLib: win, caseInsensitive: true, fail: true });
    expect(failed.result.reason).toBe('start-failed: boom');
    expect(failed.started).toEqual([]);
    expect(failed.log[0]?.ok).toBe(false);
    const closed = performNativeDrag({
      requested: ['C:\\Data\\Root\\a.md'],
      allow,
      fs: disk,
      pathLib: win,
      caseInsensitive: true,
      startDrag: () => {
        throw new Error('no-window');
      },
      log: createNativeDragLog(),
      now: () => 1000,
    });
    expect(closed.reason).toBe('no-window');
  });
});

describe('真实文件系统上的符号链接', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('根内文件、目录和根内链接通过，越根链接、缺失、根外拒绝', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-native-drag-'));
    dirs.push(dir);
    const inside = path.join(dir, 'root');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(inside);
    fs.mkdirSync(outside);
    const file = path.join(inside, 'a.txt');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(file, 'a');
    fs.writeFileSync(secret, 's');
    fs.mkdirSync(path.join(inside, 'sub'));
    const escape = path.join(inside, 'escape.txt');
    const stay = path.join(inside, 'stay.txt');
    fs.symlinkSync(secret, escape);
    fs.symlinkSync(file, stay);
    const via = path.join(inside, 'via');
    fs.symlinkSync(outside, via);

    const disk = nodeNativeDragFs();
    const allow: NativeDragAllow = { roots: [inside], files: [] };
    const opts = { pathLib: path, caseInsensitive: false };
    const sub = path.join(inside, 'sub');
    const dirLink = path.join(inside, 'dir-link');
    fs.symlinkSync(sub, dirLink);
    expect(run([file], allow, disk, opts).result.ok).toBe(true);
    expect(run([stay], allow, disk, opts).result.ok).toBe(true);
    expect(run([inside], allow, disk, opts).result.ok).toBe(true);
    expect(run([sub], allow, disk, opts).result.ok).toBe(true);
    expect(run([dirLink], allow, disk, opts).result.ok).toBe(true);
    expect(run([escape], allow, disk, opts).result).toMatchObject({ ok: false, reason: 'symlink-escape' });
    expect(run([path.join(via, 'secret.txt')], allow, disk, opts).result).toMatchObject({ ok: false, reason: 'symlink-escape' });
    expect(run([via], allow, disk, opts).result).toMatchObject({ ok: false, reason: 'symlink-escape' });
    expect(run([path.join(inside, 'missing.txt')], allow, disk, opts).result).toMatchObject({ ok: false, reason: 'not-found' });
    expect(run([secret], allow, disk, opts).result).toMatchObject({ ok: false, reason: 'outside-root' });

    const loose = path.join(outside, 'loose.txt');
    fs.writeFileSync(loose, 'l');
    expect(run([loose], { roots: [inside], files: [loose] }, disk, opts).result.ok).toBe(true);
  });
});

describe('允许列表', () => {
  it('目录根、单文件来源、打开的文件、工作资料和 Agent 资料分开收集', () => {
    const list = allowListFromCatalog({
      rootsToWatch: () => [
        { path: 'C:\\Data\\Root', kind: 'folder' },
        { path: 'C:\\Data\\one.md', kind: 'file' },
        { path: '  ', kind: 'folder' },
      ],
      currentWorkspaceId: () => 'ws-1',
      openFileResourceIds: () => ['open-1', 'ref-1'],
      workspaceFileResourceIds: () => ['ref-1', 'missing'],
      resourceAbsPath: (id) => (id === 'missing' ? null : `D:\\work\\${id}.md`),
      agentFilePaths: () => ['D:\\agent\\note.md', ''],
    });
    expect(list.roots).toEqual(['C:\\Data\\Root']);
    expect(list.files).toEqual(['C:\\Data\\one.md', 'D:\\work\\open-1.md', 'D:\\work\\ref-1.md', 'D:\\agent\\note.md']);
  });

  it('没有当前工作区时只保留根', () => {
    const list = allowListFromCatalog({
      rootsToWatch: () => [{ path: '/data/root', kind: 'folder' }],
      currentWorkspaceId: () => null,
      openFileResourceIds: () => {
        throw new Error('不应读取');
      },
      workspaceFileResourceIds: () => [],
      resourceAbsPath: () => null,
      agentFilePaths: () => [],
    });
    expect(list).toEqual({ roots: ['/data/root'], files: [] });
  });

  it('渲染进程不能读取允许列表', () => {
    expect(isRendererDataMethod('nativeDragAllow')).toBe(false);
    expect(isRendererDataMethod('listRoots')).toBe(true);
  });
});

describe('诊断缓冲', () => {
  it('只保留最近若干条，成功记录没有 reason', () => {
    const log = createNativeDragLog(3);
    for (let i = 0; i < 5; i += 1) log.push({ paths: [`/f/${i}`], ok: i % 2 === 0, reason: i % 2 ? 'outside-root' : undefined, at: i });
    const rows = log.read();
    expect(rows.map((row) => row.at)).toEqual([2, 3, 4]);
    expect(rows[0]).toEqual({ paths: ['/f/2'], ok: true, at: 2 });
    expect(rows[1]).toEqual({ paths: ['/f/3'], ok: false, reason: 'outside-root', at: 3 });
    expect(NATIVE_DRAG_LOG_CAP).toBe(32);
    const controller = createNativeDragController({
      fs: memFs([{ path: '/data/a.md', kind: 'file' }], path, false),
      pathLib: path,
      caseInsensitive: false,
      startDrag: () => undefined,
      now: () => 7,
    });
    controller.setAllow({ roots: ['/data'], files: [] });
    expect(controller.start(['/data/a.md'])).toMatchObject({ ok: true });
    expect(controller.start(['/etc/passwd'])).toMatchObject({ ok: false, reason: 'not-found' });
    expect(controller.deny(['/tmp/nope'], 'no-window')).toMatchObject({ ok: false, reason: 'no-window', paths: ['/tmp/nope'] });
    expect(controller.readLog().map((row) => row.reason ?? 'ok')).toEqual(['ok', 'not-found', 'no-window']);
  });
});

describe('拖出模式', () => {
  const allow: NativeDragAllow = { roots: ['C:\\Data\\Root'], files: [] };
  const disk = memFs(
    [
      { path: 'C:\\Data\\Root', kind: 'dir' },
      { path: 'C:\\Data\\Root\\a.md', kind: 'file' },
      { path: 'C:\\Data\\Root\\b.md', kind: 'file' },
    ],
    win,
    true,
  );

  it('路径模式记录 mode，不调用 startDrag，多条路径原样留下', () => {
    const started: string[][] = [];
    const log = createNativeDragLog();
    const result = performNativeDrag({
      requested: ['C:\\Data\\Root\\a.md', 'C:\\Data\\Root\\b.md'],
      allow,
      fs: disk,
      pathLib: win,
      caseInsensitive: true,
      startDrag: (files) => { started.push(files); },
      log,
      now: () => 1000,
      mode: 'path',
    });
    expect(result).toMatchObject({ ok: true, paths: ['C:\\Data\\Root\\a.md', 'C:\\Data\\Root\\b.md'] });
    expect(started).toEqual([]);
    expect(log.read()).toEqual([{ paths: ['C:\\Data\\Root\\a.md', 'C:\\Data\\Root\\b.md'], ok: true, at: 1000, mode: 'path' }]);
  });

  it('文件模式仍然调用 startDrag，日志带 mode', () => {
    const started: string[][] = [];
    const log = createNativeDragLog();
    const result = performNativeDrag({
      requested: ['C:\\Data\\Root\\a.md'],
      allow,
      fs: disk,
      pathLib: win,
      caseInsensitive: true,
      startDrag: (files) => { started.push(files); },
      log,
      now: () => 1000,
      mode: 'file',
    });
    expect(result.ok).toBe(true);
    expect(started).toEqual([[win.resolve('C:\\Data\\Root\\a.md')]]);
    expect(log.read()[0]).toMatchObject({ ok: true, mode: 'file' });
  });

  it('路径模式的空列表也不调用 startDrag', () => {
    const started: string[][] = [];
    const result = performNativeDrag({
      requested: [],
      allow,
      fs: disk,
      pathLib: win,
      caseInsensitive: true,
      startDrag: (files) => { started.push(files); },
      log: createNativeDragLog(),
      now: () => 1,
      mode: 'path',
    });
    expect(result.reason).toBe('empty');
    expect(started).toEqual([]);
  });
});

describe('拖出图标', () => {
  it('路径图标过大时缩小，全部失败时仍给出非空小图', () => {
    let resized = false;
    const fromPath = nativeDragIcon({
      createFromPath: () => ({
        isEmpty: () => false,
        getSize: () => ({ width: 256, height: 256 }),
        resize: () => {
          resized = true;
          return { isEmpty: () => false };
        },
      }),
      createFromBuffer: () => ({ isEmpty: () => false }),
      createFromDataURL: () => ({ isEmpty: () => false }),
    }, ['/icon.png']);
    expect(fromPath.isEmpty()).toBe(false);
    expect(resized).toBe(true);

    const calls: string[] = [];
    const fallback = nativeDragIcon({
      createFromPath: () => {
        throw new Error('missing');
      },
      createFromBuffer: () => {
        calls.push('buffer');
        return { isEmpty: () => true };
      },
      createFromDataURL: () => {
        calls.push('url');
        return { isEmpty: () => false };
      },
    }, ['']);
    expect(fallback.isEmpty()).toBe(false);
    expect(calls).toEqual(['buffer', 'url']);
  });
});

describe('原生拖出 IPC', () => {
  const allow: NativeDragAllow = { roots: ['C:\\Data\\Root'], files: [] };
  const disk = memFs(
    [
      { path: 'C:\\Data\\Root', kind: 'dir' },
      { path: 'C:\\Data\\Root\\a.md', kind: 'file' },
      { path: 'D:\\other\\a.md', kind: 'file' },
    ],
    win,
    true,
  );
  const iconOk = () => ({ isEmpty: () => false, getSize: () => ({ width: 32, height: 32 }) });

  function controller() {
    const created = createNativeDragController({
      fs: disk,
      pathLib: win,
      caseInsensitive: true,
      startDrag: () => { throw new Error('不应走控制器里的默认 startDrag'); },
      now: () => 1000,
    });
    created.setAllow(allow);
    return created;
  }

  it('拒绝根外路径，不调用 startDrag，并记入日志环', () => {
    const started: string[][] = [];
    const ended: number[] = [];
    const host = controller();
    const result = handleNativeDragIpc({
      payload: { paths: ['D:\\other\\a.md'], mode: 'file' },
      allowed: true,
      controller: host,
      icon: iconOk,
      startDrag: (files) => { started.push(files); },
      notifyEnded: () => { ended.push(1); },
    });
    expect(result).toMatchObject({ ok: false, reason: 'outside-root' });
    expect(started).toEqual([]);
    expect(host.readLog()[0]).toMatchObject({ ok: false, reason: 'outside-root' });
    expect(ended).toEqual([1]);
  });

  it('startDrag 抛错时 reason 含错误信息、图标是否为空和尺寸', () => {
    const host = controller();
    const result = handleNativeDragIpc({
      payload: { paths: ['C:\\Data\\Root\\a.md'], mode: 'file' },
      allowed: true,
      controller: host,
      icon: () => ({ isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }) }),
      startDrag: () => { throw new Error('ole busy'); },
      notifyEnded: () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('ole busy');
    expect(result.reason).toContain('iconEmpty=true');
    expect(result.reason).toContain('icon=0x0');
    expect(host.readLog()[0]?.reason).toBe(result.reason);
  });

  it('通过校验后立刻 startDrag，返回后再通知结束', () => {
    const order: string[] = [];
    const host = controller();
    const result = handleNativeDragIpc({
      payload: { paths: ['C:\\Data\\Root\\a.md'], mode: 'file' },
      allowed: true,
      controller: host,
      icon: iconOk,
      startDrag: (files) => { order.push(`drag:${files[0]}`); },
      notifyEnded: () => { order.push('ended'); },
    });
    expect(result.ok).toBe(true);
    expect(order[0]?.startsWith('drag:')).toBe(true);
    expect(order[1]).toBe('ended');
    expect(host.readLog()[0]).toMatchObject({ ok: true, mode: 'file' });
  });

  it('路径模式不调用 startDrag，异步载荷也不当同步回执', () => {
    const started: string[] = [];
    const host = controller();
    const result = handleNativeDragIpc({
      payload: { paths: ['C:\\Data\\Root\\a.md'], mode: 'path' },
      allowed: true,
      controller: host,
      icon: iconOk,
      startDrag: () => { started.push('drag'); },
      notifyEnded: () => { started.push('ended'); },
    });
    expect(result.ok).toBe(true);
    expect(started).toEqual([]);
    expect(nativeDragWantsSyncReply({ sync: true, mode: 'file' })).toBe(true);
    expect(nativeDragWantsSyncReply({ mode: 'file' })).toBe(false);
    expect(nativeDragWantsSyncReply(['C:\\Data\\Root\\a.md'])).toBe(false);
  });
});
