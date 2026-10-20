import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ResourceInfo } from '../../shared/types';
import { adapters, type AdapterRegistry } from '../plugin-host/registry';
import { kb } from '../kb';
import { useSidebarPrefs } from '../drawer/sidebarPrefs';

/** 与打开文件相同的匹配入口；文件信息兜底不代表存在阅读器。 */
export function hasFileReader(resource: ResourceInfo, registry: AdapterRegistry = adapters): boolean {
  return registry.resolve({ sourceKind: 'file', resource }).some((adapter) => adapter.id !== 'builtin.unsupported');
}

export async function findUnopenableFiles(
  items: readonly { resourceId: string; kind: string }[],
  getResource: (id: string) => Promise<ResourceInfo | null>,
  registry: AdapterRegistry = adapters,
): Promise<Set<string>> {
  const ids = await Promise.all(items.filter((item) => item.kind === 'file').map(async (item) => {
    try {
      const resource = await getResource(item.resourceId);
      return resource && !hasFileReader(resource, registry) ? item.resourceId : null;
    } catch { return null; }
  }));
  return new Set(ids.filter((id): id is string => id !== null));
}

/** 关闭过滤时直接返回原列表，目录始终保留。 */
export function filterReadableFiles<T extends { resourceId: string; kind: string }>(
  items: readonly T[], hidden: ReadonlySet<string>, enabled: boolean,
): readonly T[] {
  return enabled ? items.filter((item) => item.kind !== 'file' || !hidden.has(item.resourceId)) : items;
}

/** 使用完整资源信息，兼容插件按路径、扩展名或其他资源字段匹配。加载失败保留条目。 */
export function useReadableFiles<T extends { resourceId: string; kind: string }>(items: readonly T[]): readonly T[] {
  const { hideUnopenableFiles } = useSidebarPrefs();
  const version = useSyncExternalStore((fn) => adapters.subscribe(fn), () => adapters.getVersion());
  const [result, setResult] = useState<{
    items: readonly T[]; version: number; hidden: Set<string>;
  }>();
  useEffect(() => {
    let cancelled = false;
    if (!hideUnopenableFiles) return;
    void findUnopenableFiles(items, (id) => kb.getResource(id)).then((hidden) => {
      if (!cancelled) setResult({ items, version, hidden });
    });
    return () => { cancelled = true; };
  }, [items, hideUnopenableFiles, version]);
  // 新目录或插件变化时，不沿用上一次匹配结果；异步旧请求也不会覆盖新请求。
  if (!result || result.items !== items || result.version !== version) return items;
  return filterReadableFiles(items, result.hidden, hideUnopenableFiles);
}
