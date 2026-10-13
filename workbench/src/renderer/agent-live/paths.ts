/** 去重用的路径键：NFC、反斜杠、大小写不敏感、去掉末尾分隔符。盘符根保留结尾斜杠。 */
export function pathKey(absPath: string): string {
  let s = absPath.normalize('NFC').replace(/\//g, '\\');
  s = s.replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(s)) s += '\\';
  return s.toLowerCase();
}

export function baseName(absPath: string): string {
  const s = absPath.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return (i >= 0 ? s.slice(i + 1) : s) || absPath;
}

export function joinRoot(rootPath: string, relPath: string): string {
  const root = rootPath.replace(/[\\/]+$/, '');
  const rel = relPath.replace(/\//g, '\\').replace(/^[\\/]+/, '');
  if (!rel) return root;
  return `${root}\\${rel}`;
}

export function fileUriToPath(uri: string): string | null {
  const raw = uri.trim();
  if (!raw || raw === '#') return null;
  if (!/^file:/i.test(raw)) return null;
  let path = raw.replace(/^file:\/\//i, '');
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
  return path.replace(/\//g, '\\');
}
