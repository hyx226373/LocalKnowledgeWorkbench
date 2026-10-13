/** 把一批资料 ID 的解析切成小段。一段超过预算就让出事件循环。 */

export interface ResolveBatchError {
  relPath: string;
  error: string;
}

export async function resolveIdsSliced(args: {
  rootId: string;
  relPaths: string[];
  resolveOne: (rootId: string, relPath: string) => string;
  resolveMany?: (rootId: string, relPaths: string[]) => string[];
  budgetMs?: number;
}): Promise<{ ids: string[]; errors: ResolveBatchError[] }> {
  const budget = args.budgetMs ?? 8;
  const ids: string[] = [];
  const errors: ResolveBatchError[] = [];
  let sliceStart = performance.now();
  const yieldIfNeeded = async (spent: number): Promise<void> => {
    if (spent >= budget || performance.now() - sliceStart >= budget) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = performance.now();
    }
  };
  const take = (part: string[], got: string[]) => {
    if (got.length !== part.length) throw new Error('resolveResourceIds 长度不一致');
    for (let j = 0; j < part.length; j += 1) {
      const id = got[j];
      if (typeof id !== 'string' || !id) {
        ids.push('');
        errors.push({ relPath: part[j] ?? '', error: 'resolveResourceIds 返回了空 ID' });
      } else ids.push(id);
    }
  };
  if (args.resolveMany) {
    const batch = args.resolveMany;
    for (let i = 0; i < args.relPaths.length; i += 200) {
      const part = args.relPaths.slice(i, i + 200);
      const t = performance.now();
      try {
        take(part, batch(args.rootId, part));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const relPath of part) {
          ids.push('');
          errors.push({ relPath, error: message });
        }
      }
      await yieldIfNeeded(performance.now() - t);
    }
    return { ids, errors };
  }
  for (const relPath of args.relPaths) {
    const t = performance.now();
    try {
      const id = args.resolveOne(args.rootId, relPath);
      if (typeof id !== 'string' || !id) throw new Error('resolveResourceId 返回了空 ID');
      ids.push(id);
    } catch (err) {
      ids.push('');
      errors.push({ relPath, error: err instanceof Error ? err.message : String(err) });
    }
    await yieldIfNeeded(performance.now() - t);
  }
  return { ids, errors };
}
