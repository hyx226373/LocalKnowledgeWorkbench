import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RebirthRepository } from '../src/main/rebirth/repository';
import { bindRebirthMethods } from '../src/main/rebirth/ipc';
import { rebirthFewerBlocksDialog, rebirthFewerBlocksHold } from '../src/shared/rebirth';
import { dialogs } from '../src/renderer/ui/dialogs';
import { confirmFewerImport, confirmPickedImport } from '../src/renderer/rebirth/importConfirm';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function doc(n: number, title = '原题', body: (i: number) => string = (i) => `正文${i + 1}`) {
  return { lkw: 'rebirth/1', title, agent: 'codex', blocks: Array.from({ length: n }, (_, i) => ({ type: '背景', title: `块${i + 1}`, body: body(i) })) };
}
function setup(n = 3) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r21-import-confirm-'));
  dirs.push(dir);
  const hits = { n: 0 };
  const repo = new RebirthRepository(dir, () => { hits.n += 1; });
  const { id } = repo.import(JSON.stringify(doc(n)));
  return { dir, repo, id, hits, mark: hits.n };
}
function host(pickJson: () => Promise<string | null> = async () => null) {
  return { copy: vi.fn(), pickJson, saveFile: async () => null, startDrag: vi.fn() };
}
function diskSnap(root: string): Record<string, { bytes: string; mtimeMs: number; size: number }> {
  const out: Record<string, { bytes: string; mtimeMs: number; size: number }> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const abs = path.join(dir, name);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(abs);
      else out[path.relative(root, abs).split(path.sep).join('/')] = { bytes: fs.readFileSync(abs).toString('hex'), mtimeMs: st.mtimeMs, size: st.size };
    }
  };
  walk(root);
  return out;
}

it('纯函数：没有已有目标、块数不减少、或已确认时不拦截', () => {
  const base = { oldBlocks: 2, newBlocks: 1, id: 'R1', title: '原题' };
  expect(rebirthFewerBlocksHold({ ...base, hasExisting: false })).toBeNull();
  expect(rebirthFewerBlocksHold({ ...base, hasExisting: true, newBlocks: 2 })).toBeNull();
  expect(rebirthFewerBlocksHold({ ...base, hasExisting: true, newBlocks: 3 })).toBeNull();
  expect(rebirthFewerBlocksHold({ ...base, hasExisting: true, confirmFewer: true })).toBeNull();
  expect(rebirthFewerBlocksHold({ ...base, hasExisting: true })).toEqual({ needsConfirm: true, oldBlocks: 2, newBlocks: 1, id: 'R1', title: '原题' });
  expect(rebirthFewerBlocksDialog(4, 2)).toEqual({ title: '导入内容比原文少', body: '原文 4 块 → 导入 2 块，少掉的块会被删除（导入前会先备份原文）', ok: '仍然导入', cancel: '取消' });
});

it('块数变少时返回 needsConfirm，文件、备份和索引保持原样', async () => {
  const { dir, repo, id, hits, mark } = setup(3);
  const fewer = JSON.stringify(doc(1, '更短'));
  const picked = path.join(dir, 'picked.json');
  fs.writeFileSync(picked, fewer);
  const before = diskSnap(dir);
  const hold = { needsConfirm: true, oldBlocks: 3, newBlocks: 1, id, title: '原题' };
  const pickedHold = { ...hold, pickedText: fewer };
  expect(repo.merge(id, fewer)).toEqual(hold);
  expect(repo.import(fewer, undefined, { id })).toEqual(hold);
  const api = bindRebirthMethods(repo, host(async () => picked));
  expect(await api.rebirthMerge({ id, text: fewer })).toEqual(hold);
  expect(await api.rebirthImport({ text: fewer, id })).toEqual(hold);
  expect(await api.rebirthImportJson({ text: fewer, id })).toEqual(hold);
  expect(await api.rebirthMerge({ id, pickFile: true })).toEqual(pickedHold);
  expect(await api.rebirthImportJson({ pickFile: true, id })).toEqual(pickedHold);
  expect(await api.rebirthMerge({ id, pickFile: true, confirmFewer: false })).toEqual(pickedHold);
  expect(diskSnap(dir)).toEqual(before);
  expect(hits.n).toBe(mark);
  expect(repo.backups(id)).toEqual([]);
  expect(repo.read(id).blocks).toHaveLength(3);
  expect(repo.read(id).meta.title).toBe('原题');
});

it('块数相同或更多时不确认，直接导入', async () => {
  const { repo, id } = setup(3);
  const same = JSON.stringify(doc(3, '原题', (i) => (i === 0 ? '改过的正文' : `正文${i + 1}`)));
  expect(repo.merge(id, same)).toEqual({ id });
  expect(repo.read(id).blocks).toHaveLength(3);
  expect(repo.read(id).blocks[0].body).toBe('改过的正文');
  expect(repo.backups(id)).toHaveLength(1);
  const more = setup(3);
  const api = bindRebirthMethods(more.repo, host());
  expect(await api.rebirthMerge({ id: more.id, text: JSON.stringify(doc(4, '更多')) })).toEqual({ id: more.id });
  expect(more.repo.read(more.id).blocks).toHaveLength(4);
  expect(more.repo.read(more.id).meta.title).toBe('更多');
  const fresh = await api.rebirthImportJson({ text: JSON.stringify(doc(1, '新建')) });
  expect(fresh).toEqual({ id: 'R2' });
  expect(fresh).not.toHaveProperty('needsConfirm');
  expect(more.repo.read('R2').blocks).toHaveLength(1);
  expect(more.repo.read(more.id).blocks).toHaveLength(4);
});

it('确认后块数变少仍导入，并先备份原文', async () => {
  const { dir, repo, id } = setup(3);
  const old = fs.readFileSync(repo.file(id), 'utf8');
  const fewer = JSON.stringify(doc(1, '更短'));
  expect(repo.merge(id, fewer, { confirmFewer: true })).toEqual({ id });
  expect(repo.read(id).blocks).toHaveLength(1);
  expect(repo.read(id).meta.title).toBe('更短');
  const version = repo.backups(id)[0]?.version;
  expect(version).toBeTruthy();
  expect(fs.readFileSync(path.join(dir, 'rebirth-backup', id, version!), 'utf8')).toBe(old);

  const again = setup(2);
  const oldAgain = fs.readFileSync(again.repo.file(again.id), 'utf8');
  const picked = path.join(again.dir, 'picked.json');
  fs.writeFileSync(picked, fewer);
  const api = bindRebirthMethods(again.repo, host(async () => picked));
  expect(await api.rebirthImport({ text: fewer, id: again.id, confirmFewer: true })).toEqual({ id: again.id });
  expect(again.repo.read(again.id).blocks).toHaveLength(1);
  expect(fs.readFileSync(path.join(again.dir, 'rebirth-backup', again.id, again.repo.backups(again.id)[0].version), 'utf8')).toBe(oldAgain);
  const third = setup(2);
  const oldThird = fs.readFileSync(third.repo.file(third.id), 'utf8');
  const file = path.join(third.dir, 'picked.json');
  fs.writeFileSync(file, fewer);
  const pickedApi = bindRebirthMethods(third.repo, host(async () => file));
  // review-fix：选文件这一步总会先拦下，确认后用回传的同一份文本重试
  const held = await pickedApi.rebirthImportJson({ pickFile: true, id: third.id, confirmFewer: true }) as any;
  expect(held.needsConfirm).toBe(true);
  expect(held.pickedText).toBe(fewer);
  expect(await pickedApi.rebirthImportJson({ text: held.pickedText, id: third.id, confirmFewer: true })).toEqual({ id: third.id });
  expect(third.repo.read(third.id).blocks).toHaveLength(1);
  expect(fs.readFileSync(path.join(third.dir, 'rebirth-backup', third.id, third.repo.backups(third.id)[0].version), 'utf8')).toBe(oldThird);
});

it('确认框取消不再次调用，确定后才带 confirmFewer 重试', async () => {
  const held = { needsConfirm: true as const, oldBlocks: 4, newBlocks: 2, id: 'R1', title: '原题' };
  const cancelRun = vi.fn(async () => held);
  const cancel = vi.fn(async () => false);
  expect(await confirmFewerImport(cancelRun, cancel)).toBeNull();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith(rebirthFewerBlocksDialog(4, 2));
  expect(cancelRun.mock.calls).toEqual([[false]]);

  const okRun = vi.fn(async (confirmFewer: boolean) => (confirmFewer ? { id: 'R1' } : held));
  const dialog = vi.spyOn(dialogs, 'confirm').mockResolvedValueOnce(true);
  try {
    expect(await confirmFewerImport(okRun)).toEqual({ id: 'R1' });
    expect(dialog).toHaveBeenCalledWith({ title: '导入内容比原文少', body: '原文 4 块 → 导入 2 块，少掉的块会被删除（导入前会先备份原文）', ok: '仍然导入', cancel: '取消' });
    expect(okRun.mock.calls).toEqual([[false], [true]]);
  } finally { dialog.mockRestore(); }

  const plain = vi.fn(async () => ({ id: 'R9' }));
  const unused = vi.fn(async () => true);
  expect(await confirmFewerImport(plain, unused)).toEqual({ id: 'R9' });
  expect(unused).not.toHaveBeenCalled();
  expect(plain.mock.calls).toEqual([[false]]);
  const aborted = vi.fn(async () => null);
  expect(await confirmFewerImport(aborted, unused)).toBeNull();
  expect(unused).not.toHaveBeenCalled();
});

it('选文件导入确认重试沿用已选文件内容，不再开文件框', async () => {
  const { dir, repo, id } = setup(3);
  const fewer = JSON.stringify(doc(1, '选中的那份'));
  const picked = path.join(dir, 'picked.json');
  fs.writeFileSync(picked, fewer);
  const pickJson = vi.fn(async () => picked);
  const api = bindRebirthMethods(repo, host(pickJson));
  const calls: unknown[] = [];
  const ok = vi.fn(async () => {
    // 确认框打开期间磁盘上的文件被换成另一份，重试不能读到它
    fs.writeFileSync(picked, JSON.stringify(doc(1, '偷换的另一份')));
    return true;
  });
  const r = await confirmPickedImport((text) => {
    const input = text === undefined ? { id, pickFile: true } : { id, text, confirmFewer: true };
    calls.push(input);
    return api.rebirthMerge(input) as Promise<any>;
  }, ok);
  expect(r).toEqual({ id });
  expect(pickJson).toHaveBeenCalledTimes(1);
  expect(ok).toHaveBeenCalledWith(rebirthFewerBlocksDialog(3, 1));
  expect(calls).toEqual([{ id, pickFile: true }, { id, text: fewer, confirmFewer: true }]);
  expect(repo.read(id).meta.title).toBe('选中的那份');
  expect(repo.read(id).blocks).toHaveLength(1);

  const c = setup(3);
  const p2 = path.join(c.dir, 'picked.json');
  fs.writeFileSync(p2, fewer);
  const pick2 = vi.fn(async () => p2);
  const api2 = bindRebirthMethods(c.repo, host(pick2));
  const run2 = vi.fn((text: string | undefined) => api2.rebirthMerge(text === undefined ? { id: c.id, pickFile: true } : { id: c.id, text, confirmFewer: true }) as Promise<any>);
  expect(await confirmPickedImport(run2, async () => false)).toBeNull();
  expect(run2).toHaveBeenCalledTimes(1);
  expect(pick2).toHaveBeenCalledTimes(1);
  expect(c.repo.read(c.id).blocks).toHaveLength(3);
});

it('review-fix：pickFile 同时带 confirmFewer 也不能跳过确认', async () => {
  const { dir, repo, id } = setup(3);
  const picked = path.join(dir, 'picked.json');
  fs.writeFileSync(picked, JSON.stringify(doc(1, '新选的')));
  const api = bindRebirthMethods(repo, host(async () => picked));
  const r = await api.rebirthMerge({ id, pickFile: true, confirmFewer: true }) as any;
  expect(r.needsConfirm).toBe(true);
  expect(repo.read(id).blocks).toHaveLength(3);
  const j = await api.rebirthImportJson({ id, pickFile: true, confirmFewer: true }) as any;
  expect(j.needsConfirm).toBe(true);
  expect(repo.read(id).blocks).toHaveLength(3);
});
