/** 读写 electron-builder generic provider 的 latest.yml 子集。 */

export interface LatestFile {
  url: string;
  sha512: string;
  size: number;
  blockMapSize?: number;
}

export interface LatestYml {
  version: string;
  files: LatestFile[];
  path: string;
  sha512: string;
  releaseDate?: string;
  releaseNotes?: string;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if ((text.startsWith("'") && text.endsWith("'") && text.length >= 2) || (text.startsWith('"') && text.endsWith('"') && text.length >= 2)) {
    return text.slice(1, -1);
  }
  return text;
}

export function parseLatestYml(text: string): LatestYml {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let version = '';
  let filePath = '';
  let sha512 = '';
  let releaseDate: string | undefined;
  let releaseNotes: string | undefined;
  const files: LatestFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.startsWith('releaseNotes: |')) {
      const notes: string[] = [];
      i += 1;
      while (i < lines.length) {
        const row = lines[i] ?? '';
        if (row.startsWith('  ')) {
          notes.push(row.slice(2));
          i += 1;
          continue;
        }
        if (row.trim() === '') {
          notes.push('');
          i += 1;
          continue;
        }
        break;
      }
      releaseNotes = notes.join('\n').replace(/\n+$/, '');
      continue;
    }
    if (!line.startsWith(' ') && line.trim()) {
      const top = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
      if (top) {
        const key = top[1];
        const value = unquote(top[2] ?? '');
        if (key === 'version') version = value;
        else if (key === 'path') filePath = value;
        else if (key === 'sha512') sha512 = value;
        else if (key === 'releaseDate') releaseDate = value;
        i += 1;
        continue;
      }
    }
    const item = /^ {2}- url:\s*(.*)$/.exec(line);
    if (item) {
      const file: LatestFile = { url: unquote(item[1] ?? ''), sha512: '', size: 0 };
      i += 1;
      while (i < lines.length && /^ {4}\S/.test(lines[i] ?? '')) {
        const field = /^ {4}([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[i] ?? '');
        if (field) {
          const key = field[1];
          const value = unquote(field[2] ?? '');
          if (key === 'url') file.url = value;
          else if (key === 'sha512') file.sha512 = value;
          else if (key === 'size') file.size = Number(value);
          else if (key === 'blockMapSize') file.blockMapSize = Number(value);
        }
        i += 1;
      }
      files.push(file);
      continue;
    }
    i += 1;
  }
  if (!version || !filePath || !sha512) throw new Error('latest.yml 缺少 version、path 或 sha512');
  if (files.length === 0) files.push({ url: filePath, sha512, size: 0 });
  const primary = files.find((file) => file.url === filePath) ?? files[0];
  if (!primary?.sha512) primary.sha512 = sha512;
  return { version, files, path: filePath, sha512: primary?.sha512 || sha512, releaseDate, releaseNotes };
}

export function safeArtifactName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  if (!base || base === '.' || base === '..' || base.includes('..') || /[<>:"|?*]/.test(base)) {
    throw new Error('安装包文件名不合法');
  }
  return base;
}
