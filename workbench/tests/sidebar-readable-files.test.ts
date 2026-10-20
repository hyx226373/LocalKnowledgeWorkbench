import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/kb', () => ({ kb: {} }));
vi.mock('../src/shared/actions/install', () => ({ installActionPackages() {} }));
import { AdapterRegistry } from '../src/renderer/plugin-host/registry';
import type { AdapterContribution } from '../src/renderer/plugin-host/types';
import type { ResourceInfo } from '../src/shared/types';
import { hasFileReader, findUnopenableFiles, filterReadableFiles } from '../src/renderer/dir-view/readableFiles';
import { parseSidebarPrefs } from '../src/renderer/drawer/sidebarPrefs';
const file: ResourceInfo = { resourceId: 'f', rootId: 'r', relPath: 'f.custom', name: 'f.custom', kind: 'file', size: 1, mtimeMs: 0, ext: 'custom', readerType: 'unsupported', exists: true };
function adapter(id: string, match: AdapterContribution['match'], sourceKinds: AdapterContribution['sourceKinds'] = ['file']) {
  return { id, match, sourceKinds, displayMode: 'in-app-reader', title: id, component: () => null } as AdapterContribution;
}
describe('隐藏无法打开的文件', () => {
  it('默认启用，关闭偏好可往返', () => {
    expect(parseSidebarPrefs(null).hideUnopenableFiles).toBe(true);
    expect(parseSidebarPrefs(JSON.parse(JSON.stringify({ hideUnopenableFiles: false }))).hideUnopenableFiles).toBe(false);
  });
  it('忽略文件信息兜底，当前插件注册和卸载立即改变匹配结果', () => {
    const registry = new AdapterRegistry();
    registry.register('builtin', adapter('builtin.unsupported', () => 1));
    expect(hasFileReader(file, registry)).toBe(false);
    const plugin = registry.register('plugin', adapter('custom', (target) => target.sourceKind === 'file' && target.resource.ext === 'custom' ? 10 : 0));
    expect(hasFileReader(file, registry)).toBe(true);
    plugin.dispose();
    expect(hasFileReader(file, registry)).toBe(false);
  });
  it('内置阅读器可匹配，web 适配器和抛错插件不能让文件可打开', () => {
    const registry = new AdapterRegistry();
    registry.register('web', adapter('web', () => 100, ['web']));
    registry.register('broken', adapter('broken', () => { throw Error('match'); }));
    expect(hasFileReader(file, registry)).toBe(false);
    registry.register('builtin', adapter('builtin.text', () => 20));
    expect(hasFileReader(file, registry)).toBe(true);
  });
  it('保持目录和读取失败项，使用完整资源信息而非扩展名白名单', async () => {
    const registry = new AdapterRegistry();
    registry.register('plugin', adapter('path-reader', (target) => target.sourceKind === 'file' && target.resource.relPath === 'special' ? 10 : 0));
    const getResource = vi.fn(async (id: string) => {
      if (id === 'error') throw Error('offline');
      return { ...file, resourceId: id, relPath: id };
    });
    expect(await findUnopenableFiles([{ resourceId: 'dir', kind: 'dir' }, { resourceId: 'special', kind: 'file' }, { resourceId: 'f', kind: 'file' }, { resourceId: 'error', kind: 'file' }], getResource, registry)).toEqual(new Set(['f']));
    expect(getResource).not.toHaveBeenCalledWith('dir');
  });
});

it('关闭过滤原样显示，开启只隐藏不可读文件且不更改输入', () => {
  const items = [{ resourceId: 'hidden', kind: 'file' }, { resourceId: 'dir', kind: 'dir' }, { resourceId: 'readable', kind: 'file' }];
  const hidden = new Set(['hidden', 'dir']);
  expect(filterReadableFiles(items, hidden, false)).toBe(items);
  expect(filterReadableFiles(items, hidden, true)).toEqual(items.slice(1));
  expect(items).toHaveLength(3);
});
