/**
 * r12-P3b：改筛选后只重扫该来源。收紧保留 ID，放宽写回同一个 ID。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchAction } from '../src/main/service/actionDispatch';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';
import { VFOLDER_REFS_KEY } from '../src/main/service/workspaceRefs';
import { OUT_OF_SCOPE_MESSAGE, OutOfScopeError } from '../src/shared/sourceFilter';
import { makeService, tmpDir, waitFor, write } from './helpers';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function track(svc: WorkbenchService) {
  cleanups.push(() => svc.close());
  return svc;
}

async function settle(svc: WorkbenchService, rootId: string) {
  await waitFor(() => {
    const s = svc.getIndexStatus().find((x) => x.rootId === rootId);
    return !!s && s.state === 'idle' && s.lastScanAt != null;
  });
}

function filterJson(svc: WorkbenchService, rootId: string) {
  return (svc.db.prepare('SELECT filter_json FROM roots WHERE id=?').get(rootId) as { filter_json: string }).filter_json;
}

function resourceRow(svc: WorkbenchService, id: string) {
  return svc.db.prepare('SELECT id, rel_path, kind, ext, out_of_scope, missing_since FROM resources WHERE id=?').get(id) as {
    id: string;
    rel_path: string;
    kind: string;
    ext: string;
    out_of_scope: number;
    missing_since: number | null;
  };
}

function ftsIds(svc: WorkbenchService, rootId: string) {
  return (svc.db.prepare('SELECT resource_id, rel_path FROM resources_fts WHERE root_id=? ORDER BY rel_path, resource_id').all(rootId) as {
    resource_id: string;
    rel_path: string;
  }[]);
}

function sourceSnap(svc: WorkbenchService, rootId: string) {
  return {
    filter: filterJson(svc, rootId),
    rows: svc.db.prepare('SELECT id, rel_path, kind, ext, out_of_scope, missing_since FROM resources WHERE root_id=? ORDER BY rel_path').all(rootId),
    fts: ftsIds(svc, rootId),
  };
}

describe('改筛选后重扫', () => {
  it('收紧保留原 ID 并退出 FTS，放宽后同一个 ID 回到索引，且只动目标来源', async () => {
    const dirA = tmpDir('kbrescan-a-');
    const dirB = tmpDir('kbrescan-b-');
    const svc = track((await makeService()).svc);
    const rootA = svc.addRoot(dirA, '甲');
    const rootB = svc.addRoot(dirB, '乙');
    await settle(svc, rootA.id);
    await settle(svc, rootB.id);

    write(path.join(dirA, 'a.md'), '# a');
    write(path.join(dirA, 'b.txt'), 'BEE_SECRET');
    write(path.join(dirA, 'Upper.MD'), '# U');
    write(path.join(dirA, 'sub', 'n.md'), '# n');
    write(path.join(dirA, 'sub', 'n.txt'), 'nested');
    fs.mkdirSync(path.join(dirA, 'skip.txt'));
    write(path.join(dirB, 'keep.md'), '# k');
    write(path.join(dirB, 'keep.txt'), 'keep');
    expect(await svc.scanRoot(rootA.id)).toMatchObject({ cancelled: false });
    expect(await svc.scanRoot(rootB.id)).toMatchObject({ cancelled: false });

    const txtId = svc.resourceIdFor(rootA.id, 'b.txt');
    const mdId = svc.resourceIdFor(rootA.id, 'a.md');
    const upperId = svc.resourceIdFor(rootA.id, 'Upper.MD');
    const nestedTxtId = svc.resourceIdFor(rootA.id, 'sub/n.txt');
    const dirId = svc.resourceIdFor(rootA.id, 'skip.txt');
    const beforeTxt = resourceRow(svc, txtId);
    expect(beforeTxt).toMatchObject({ id: txtId, rel_path: 'b.txt', out_of_scope: 0, missing_since: null });
    expect(svc.readText(txtId).text).toBe('BEE_SECRET');
    expect(ftsIds(svc, rootA.id).some((row) => row.resource_id === txtId)).toBe(true);
    expect(svc.search('b.txt').map((hit) => hit.resourceId)).toContain(txtId);

    svc.addFavorite(txtId, '留着');
    const folder = svc.createVirtualFolder(null, '摘录');
    expect(svc.setVfolderMembership(txtId, [folder.folderId])).toEqual([folder.folderId]);
    const ws = svc.createWorkspace('现场', '');
    svc.addWorkspaceRefs(ws.id, [txtId]);
    const favCount = () => (svc.db.prepare('SELECT COUNT(*) AS c FROM favorites').get() as { c: number }).c;
    const refsJson = () => JSON.stringify(svc.getLayout(VFOLDER_REFS_KEY));
    const wsCount = () => svc.listWorkspaceRefs(ws.id).length;
    const favBefore = favCount();
    const refsBefore = refsJson();
    const wsBefore = wsCount();
    const otherBefore = sourceSnap(svc, rootB.id);
    expect(otherBefore.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel_path: 'keep.txt', out_of_scope: 0, missing_since: null }),
        expect.objectContaining({ rel_path: 'keep.md', out_of_scope: 0 }),
      ]),
    );

    const tightened = svc.setSourceFilter(rootA.id, ['.MD', 'md', 'MD']);
    expect(tightened).toEqual({ sourceId: rootA.id, extensions: ['md'] });
    expect(filterJson(svc, rootA.id)).toBe('{"extensions":["md"]}');

    const excluded = resourceRow(svc, txtId);
    expect(excluded).toEqual({ ...beforeTxt, out_of_scope: 1 });
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').all(rootA.id, 'b.txt')).toEqual([{ id: txtId }]);
    expect(ftsIds(svc, rootA.id).some((row) => row.resource_id === txtId)).toBe(false);
    expect(svc.search('b.txt').map((hit) => hit.resourceId)).not.toContain(txtId);
    expect(svc.listDir(rootA.id, '').map((entry) => entry.name)).not.toContain('b.txt');
    expect(svc.listDir(rootA.id, '').map((entry) => entry.name)).toEqual(expect.arrayContaining(['a.md', 'Upper.MD', 'sub', 'skip.txt']));
    expect(() => svc.getResource(txtId)).toThrow(OutOfScopeError);
    try {
      svc.readText(txtId);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(OutOfScopeError);
      expect((err as Error).message).toBe(OUT_OF_SCOPE_MESSAGE);
      expect((err as Error).message).not.toContain('BEE_SECRET');
    }
    expect(resourceRow(svc, nestedTxtId)).toMatchObject({ id: nestedTxtId, out_of_scope: 1, missing_since: null });
    expect(resourceRow(svc, mdId)).toMatchObject({ id: mdId, out_of_scope: 0, missing_since: null });
    expect(resourceRow(svc, upperId)).toMatchObject({ id: upperId, out_of_scope: 0 });
    expect(resourceRow(svc, dirId)).toMatchObject({ id: dirId, kind: 'dir', out_of_scope: 0, missing_since: null });
    expect(svc.readText(mdId).text).toBe('# a');
    expect(favCount()).toBe(favBefore);
    expect(svc.db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE resource_id=?').get(txtId)).toEqual({ c: 1 });
    expect(refsJson()).toBe(refsBefore);
    expect(svc.listVfolderMembership(txtId)).toEqual([folder.folderId]);
    expect(wsCount()).toBe(wsBefore);
    expect(sourceSnap(svc, rootB.id)).toEqual(otherBefore);

    write(path.join(dirA, 'c.txt'), 'cee');
    write(path.join(dirA, 'fresh.md'), '# fresh');
    write(path.join(dirA, 'node_modules', 'hidden.md'), '# hidden');
    await svc.applyFsEvents(rootA.id, [
      { type: 'add', relPath: 'c.txt' },
      { type: 'add', relPath: 'fresh.md' },
    ]);
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootA.id, 'c.txt')).toBeUndefined();
    expect(ftsIds(svc, rootA.id).some((row) => row.rel_path === 'c.txt')).toBe(false);
    const fresh = svc.db.prepare('SELECT id, out_of_scope FROM resources WHERE root_id=? AND rel_path=?').get(rootA.id, 'fresh.md') as
      | { id: string; out_of_scope: number }
      | undefined;
    expect(fresh?.out_of_scope).toBe(0);
    const freshId = fresh?.id ?? '';
    expect(freshId).not.toBe('');
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootA.id, 'node_modules/hidden.md')).toBeUndefined();
    expect(sourceSnap(svc, rootB.id)).toEqual(otherBefore);
    expect(resourceRow(svc, txtId)).toEqual(excluded);

    const widened = svc.setSourceFilter(rootA.id, []);
    expect(widened.extensions).toEqual([]);
    expect(filterJson(svc, rootA.id)).toBe('{"extensions":[]}');
    expect(resourceRow(svc, txtId)).toEqual(beforeTxt);
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').all(rootA.id, 'b.txt')).toEqual([{ id: txtId }]);
    expect(ftsIds(svc, rootA.id).some((row) => row.resource_id === txtId && row.rel_path === 'b.txt')).toBe(true);
    expect(svc.search('b.txt').map((hit) => hit.resourceId)).toContain(txtId);
    expect(svc.getResource(txtId)?.resourceId).toBe(txtId);
    expect(svc.readText(txtId).text).toBe('BEE_SECRET');
    expect(svc.listDir(rootA.id, '').map((entry) => entry.name)).toContain('b.txt');
    expect(resourceRow(svc, nestedTxtId)).toMatchObject({ id: nestedTxtId, out_of_scope: 0, missing_since: null });
    const createdTxt = svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootA.id, 'c.txt') as { id: string } | undefined;
    expect(createdTxt?.id).toBeTruthy();
    expect(createdTxt?.id).not.toBe(txtId);
    expect(svc.db.prepare('SELECT id FROM resources WHERE root_id=? AND rel_path=?').get(rootA.id, 'node_modules/hidden.md')).toBeUndefined();
    expect(resourceRow(svc, freshId).id).toBe(freshId);
    expect(favCount()).toBe(favBefore);
    expect(refsJson()).toBe(refsBefore);
    expect(wsCount()).toBe(wsBefore);
    expect(resourceRow(svc, txtId).missing_since).toBe(beforeTxt.missing_since);
    expect(sourceSnap(svc, rootB.id)).toEqual(otherBefore);
  });

  it('单文件来源不按扩展名排除，误标也会清掉', async () => {
    const dir = tmpDir('kbrescan-file-');
    const file = path.join(dir, 'solo.txt');
    write(file, 'solo-body');
    const svc = track((await makeService()).svc);
    const src = svc.addFileSource(file, 'solo.txt');
    svc.db.prepare('UPDATE resources SET out_of_scope=1 WHERE id=?').run(src.resourceId);
    const result = svc.setSourceFilter(src.id, ['md']);
    expect(result.extensions).toEqual(['md']);
    expect(filterJson(svc, src.id)).toBe('{"extensions":["md"]}');
    expect(resourceRow(svc, src.resourceId)).toMatchObject({
      id: src.resourceId,
      rel_path: '',
      out_of_scope: 0,
      missing_since: null,
    });
    expect(svc.readText(src.resourceId).text).toBe('solo-body');
    expect(svc.db.prepare('SELECT COUNT(*) AS c FROM resources WHERE root_id=?').get(src.id)).toEqual({ c: 1 });
  });
});

describe('source.filter.set 未批准', () => {
  it('未批准不改 filter_json 也不重扫；其它 ActionId 不假装成功', async () => {
    const dir = tmpDir('kbrescan-gate-');
    const svc = track((await makeService()).svc);
    const root = svc.addRoot(dir, '闸');
    await settle(svc, root.id);
    write(path.join(dir, 'a.md'), '# a');
    write(path.join(dir, 'b.txt'), 'bee');
    expect(await svc.scanRoot(root.id)).toMatchObject({ cancelled: false });
    const txtId = svc.resourceIdFor(root.id, 'b.txt');
    const before = sourceSnap(svc, root.id);
    const rowBefore = resourceRow(svc, txtId);
    expect(before.filter).toBe('{"extensions":[]}');

    const denied = dispatchAction(svc, {
      actionId: 'source.filter.set',
      args: { sourceId: root.id, extensions: ['.MD'] },
    });
    expect(denied.status).toBe('awaiting_approval');
    expect(denied.error?.code).toBe('approval_required');
    const deniedAgain = dispatchAction(svc, {
      actionId: 'source.filter.set',
      args: { sourceId: root.id, extensions: ['md'] },
      approved: false,
    });
    expect(deniedAgain.status).toBe('awaiting_approval');
    expect(sourceSnap(svc, root.id)).toEqual(before);
    expect(resourceRow(svc, txtId)).toEqual(rowBefore);
    expect(svc.readText(txtId).text).toBe('bee');

    const other = dispatchAction(svc, { actionId: 'catalog.ref.add', args: { resourceId: txtId }, approved: true });
    expect(other.status).toBe('unhandled');
    expect(other.error?.code).toBe('unhandled');
    expect(sourceSnap(svc, root.id)).toEqual(before);

    const bad = dispatchAction(svc, {
      actionId: 'source.filter.set',
      args: { sourceId: root.id, extensions: 'md' },
      approved: true,
    });
    expect(bad.status).toBe('failed');
    expect(bad.error?.code).toBe('invalid_args');
    expect(sourceSnap(svc, root.id)).toEqual(before);

    const ok = dispatchAction(svc, {
      actionId: 'source.filter.set',
      args: { sourceId: root.id, extensions: ['.MD', 'md'] },
      approved: true,
    });
    expect(ok.status).toBe('success');
    expect(ok.result).toEqual({ sourceId: root.id, extensions: ['md'] });
    expect(filterJson(svc, root.id)).toBe('{"extensions":["md"]}');
    expect(resourceRow(svc, txtId)).toMatchObject({ id: txtId, out_of_scope: 1, missing_since: null });
    expect(ftsIds(svc, root.id).some((row) => row.resource_id === txtId)).toBe(false);
    expect(svc.search('b.txt').map((hit) => hit.resourceId)).not.toContain(txtId);
  });
});
