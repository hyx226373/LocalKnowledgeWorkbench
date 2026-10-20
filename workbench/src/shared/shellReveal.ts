/**
 * 用默认程序打开前的根内校验。
 * 在资源管理器中显示仍走已有 showInFolder（resolveResourcePath → shell.showItemInFolder）。
 */
import { isPathInsideRoot, type PathLib } from './nativeDragPolicy';

export function guardShellPath(abs: string, roots: readonly string[], pathLib: PathLib, caseInsensitive: boolean): string {
  const target = abs.trim();
  if (!target) throw new Error('路径为空');
  const ok = roots.some((root) => {
    const base = root.trim();
    return !!base && isPathInsideRoot(target, base, pathLib, caseInsensitive);
  });
  if (!ok) throw new Error('路径超出已登记的根目录');
  return target;
}

/** 先确认绝对路径落在已登记根内，再交给 shell.openPath。错误字符串视为失败。 */
export async function openInsideRoots(
  abs: string,
  roots: readonly string[],
  deps: {
    pathLib: PathLib;
    caseInsensitive: boolean;
    openPath(target: string): Promise<string | void> | string | void;
  },
): Promise<void> {
  const target = guardShellPath(abs, roots, deps.pathLib, deps.caseInsensitive);
  const error = await deps.openPath(target);
  if (typeof error === 'string' && error.trim()) throw new Error(error);
}
