/** 同名不覆盖：在扩展名前插入「 (2)」「 (3)」… */

export function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 2;
  let next = `${stem} (${n})${ext}`;
  while (taken.has(next)) {
    n += 1;
    next = `${stem} (${n})${ext}`;
  }
  return next;
}

export function parentRel(relPath: string): string {
  const i = relPath.lastIndexOf('/');
  return i >= 0 ? relPath.slice(0, i) : '';
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function isInside(dirRel: string, parentRelPath: string): boolean {
  if (!parentRelPath) return false;
  return dirRel === parentRelPath || dirRel.startsWith(parentRelPath + '/');
}
