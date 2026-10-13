import { describe, expect, it } from 'vitest';
import type { ResourceChange, ResourceSnapshot } from '@kb/identity-watch';
import { mergeQueued } from '../src/session.ts';

function snap(relPath: string): ResourceSnapshot {
  return {
    id: 'res',
    rootId: 'root',
    relPath,
    displaced: false,
    kind: 'file',
    size: 1,
    mtimeMs: 1,
    contentHash: null,
    fsFileId: null,
    missing: 0,
  };
}

function change(type: ResourceChange['type'], rel: string | null, beforeRel = 'a.md'): ResourceChange {
  return {
    type,
    resourceId: 'res',
    before: type === 'create' ? null : snap(beforeRel),
    after: rel ? snap(rel) : null,
  };
}

describe('mergeQueued', () => {
  it('delete 压过尚未执行的 modify，纯改名不升级成 upsert', () => {
    const modified = mergeQueued(undefined, change('modify', 'a.md'));
    expect(modified).toEqual({ resourceId: 'res', op: 'upsert', relPath: 'a.md' });
    const deleted = mergeQueued(modified, change('delete', null));
    expect(deleted).toEqual({ resourceId: 'res', op: 'delete', relPath: 'a.md' });

    const moved = mergeQueued(undefined, change('rename-move', '归档/新笔记.md', 'a.md'));
    expect(moved).toEqual({ resourceId: 'res', op: 'relocate', relPath: '归档/新笔记.md' });
    const movedAfterEdit = mergeQueued(modified, change('rename-move', '归档/新笔记.md', 'a.md'));
    expect(movedAfterEdit?.op).toBe('upsert');
    expect(movedAfterEdit?.relPath).toBe('归档/新笔记.md');
  });
});
