import { expect, it } from 'vitest';
import { WorkbenchContentScope, serializeContentScope, setContentArea } from '../src/main/backend/contentScope';
import { defaultContentIndexScope, DEFAULT_CONTENT_INDEX_MAX_BYTES } from '../src/shared/contentIndexScope';
import type { WorkbenchService } from '../src/main/service/WorkbenchService';

function fixture() {
  const state = {
    open: [] as string[], refs: [] as { id: string }[],
    resources: [
      { id: 'open', root_id: 'r', rel_path: 'open.md', kind: 'file' },
      { id: 'material', root_id: 'r', rel_path: 'material.ts', kind: 'file' },
      { id: 'repo', root_id: 'r', rel_path: 'repo/note.txt', kind: 'file' },
      { id: 'workbench', root_id: 'r', rel_path: 'workbench.md', kind: 'file' },
      { id: 'outside', root_id: 'r', rel_path: 'outside.md', kind: 'file' },
      { id: 'folder', root_id: 'r', rel_path: 'repo', kind: 'dir' },
      { id: 'nearby', root_id: 'r', rel_path: 'repo-old/no.md', kind: 'file' },
      { id: 'pdf', root_id: 'r', rel_path: 'report.pdf', kind: 'file' },
    ],
  };
  const svc = {
    db: { prepare: (sql: string) => ({ all: () => sql.includes('FROM resources') ? state.resources
      : sql.includes('workspace_items') ? state.open.map((ref) => ({ ref })) : [{ json: JSON.stringify(state.refs) }] }) },
    getLayout: () => null, getCurrentWorkspaceId: () => 'ws',
    listRoots: () => [{ id: 'r', kind: 'folder', path: '/docs' }], emit: () => true,
  } as unknown as WorkbenchService;
  return { state, svc, source: new WorkbenchContentScope(svc) };
}

it('四类区域合并，其他文本只登记文件名，范围是可序列化数据', () => {
  const { state, svc, source } = fixture();
  state.open = ['open'];
  state.refs = [{ id: 'workbench' }];
  setContentArea(svc, 'agent-materials', { resourceIds: ['material'] });
  setContentArea(svc, 'agent-repository', { paths: ['/docs/repo'] });
  const scope = source.snapshot().get('r')!;
  expect(scope.includeRelPaths).toEqual(['material.ts', 'open.md', 'repo/note.txt', 'workbench.md']);
  expect(scope.includeRelPaths).not.toContain('outside.md');
  expect(scope.includeRelPaths).not.toContain('repo-old/no.md');
  expect(scope.includeExts).toEqual(expect.arrayContaining(['md', 'txt', 'ts']));
  expect(scope.includePrefixes).not.toEqual([]);
  expect(JSON.parse(JSON.stringify(scope))).toEqual(scope);
});

it('打开即加入；关闭在本进程保留；重启只恢复当前打开的文件', () => {
  const { state, source, svc } = fixture();
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual([]);
  state.open = ['open'];
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual(['open.md']);
  state.open = [];
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual(['open.md']);
  expect(new WorkbenchContentScope(svc).snapshot().get('r')!.includeRelPaths).toEqual([]);
});

it('Agent 资料、仓库和工作台资料移出后不再纳入正文；其他区域引用仍有效', () => {
  const { state, source, svc } = fixture();
  setContentArea(svc, 'agent-materials', { resourceIds: ['material'] });
  setContentArea(svc, 'agent-repository', { paths: ['/docs/repo'] });
  state.refs = [{ id: 'workbench' }, { id: 'material' }];
  source.snapshot();
  setContentArea(svc, 'agent-materials', {});
  expect(source.snapshot().get('r')!.includeRelPaths).toContain('material.ts');
  setContentArea(svc, 'agent-repository', {});
  state.refs = [];
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual([]);
});

it('工作台目录递归纳入文本；PDF 仍需配置；排除规则优先', () => {
  const { state, source, svc } = fixture();
  state.refs = [{ id: 'folder' }, { id: 'pdf' }];
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual(['repo/note.txt']);
  svc.getLayout = () => ({ v: 1, extraExtensions: ['pdf'], excludePrefixes: ['repo'] });
  expect(source.snapshot().get('r')!.includeRelPaths).toEqual(['report.pdf']);
});

it('超过 1MB 的文件仍在范围内，但传给 indexer 的读取上限不超过 1MB', () => {
  const config = { ...defaultContentIndexScope(), maxBytes: 9 * 1024 * 1024 };
  expect(serializeContentScope(config, ['large.txt'])).toMatchObject({
    maxBytes: DEFAULT_CONTENT_INDEX_MAX_BYTES, includeRelPaths: ['large.txt'],
  });
});
