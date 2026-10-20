/** 读写 electron-builder generic provider 的 latest.yml 子集；并解析公开更新信号（yml / JSON）。 */

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

/** 检查更新用的公开信号：版本 + 下载提示（绝对 https 或相对文件名）。 */
export interface UpdateSignal {
  version: string;
  /** path / url / downloadUrl 原文，用于拼 downloadUrl。 */
  downloadHint: string;
  fileName: string;
  notes: string;
  sha512: string;
  size: number;
  blockMapSize: number | null;
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

function looksLikeJson(text: string, contentType?: string | null): boolean {
  if (contentType && /json/i.test(contentType)) return true;
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function fileNameFromHint(hint: string): string {
  const cleaned = hint.trim();
  if (/^https?:\/\//i.test(cleaned)) {
    try {
      const u = new URL(cleaned);
      return safeArtifactName(u.pathname || cleaned);
    } catch {
      return safeArtifactName(cleaned);
    }
  }
  return safeArtifactName(cleaned);
}

/** 解析公开版本信号：JSON（version + url|downloadUrl|path）或 latest.yml 子集。sha512 / size 可缺省。 */
export function parseUpdateSignal(text: string, contentType?: string | null): UpdateSignal {
  const raw = text.replace(/^\uFEFF/, '');
  if (looksLikeJson(raw, contentType)) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw.trim()) as Record<string, unknown>;
    } catch {
      throw new Error('更新信号 JSON 无法解析');
    }
    if (Array.isArray(data) || data === null || typeof data !== 'object') {
      throw new Error('更新信号 JSON 须为对象');
    }
    const version = String(data.version ?? '').trim();
    const hint = String(data.downloadUrl ?? data.url ?? data.path ?? '').trim();
    if (!version || !hint) throw new Error('更新信号 JSON 缺少 version 或下载地址（url / downloadUrl / path）');
    const notes = String(data.notes ?? data.releaseNotes ?? '').trim();
    const sha512 = String(data.sha512 ?? '').trim();
    const sizeRaw = Number(data.size);
    const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.floor(sizeRaw) : 0;
    return {
      version,
      downloadHint: hint,
      fileName: fileNameFromHint(hint),
      notes,
      sha512,
      size,
      blockMapSize: null,
    };
  }
  try {
    const latest = parseLatestYml(raw);
    const hint = (latest.path || latest.files[0]?.url || '').trim();
    const file = latest.files.find((item) => item.url === latest.path) ?? latest.files[0];
    return {
      version: latest.version,
      downloadHint: hint,
      fileName: fileNameFromHint(hint),
      notes: latest.releaseNotes?.trim() || '',
      sha512: file?.sha512 || latest.sha512 || '',
      size: file?.size && file.size > 0 ? file.size : 0,
      blockMapSize: file?.blockMapSize ?? null,
    };
  } catch (err) {
    // 宽松 yml：只要 version + path/url，不强制 sha512（简化更新只开下载链接）。
    const lines = raw.split(/\r?\n/);
    let version = '';
    let filePath = '';
    let releaseNotes = '';
    let i = 0;
    while (i < lines.length) {
      const line = lines[i] ?? '';
      if (line.startsWith('releaseNotes: |')) {
        const notes: string[] = [];
        i += 1;
        while (i < lines.length) {
          const row = lines[i] ?? '';
          if (row.startsWith('  ') || row.trim() === '') {
            notes.push(row.startsWith('  ') ? row.slice(2) : '');
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
          else if (key === 'path' || key === 'url' || key === 'downloadUrl') filePath = value;
        }
      }
      const item = /^ {2}- url:\s*(.*)$/.exec(line);
      if (item && !filePath) filePath = unquote(item[1] ?? '');
      i += 1;
    }
    if (!version || !filePath) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    return {
      version,
      downloadHint: filePath,
      fileName: fileNameFromHint(filePath),
      notes: releaseNotes,
      sha512: '',
      size: 0,
      blockMapSize: null,
    };
  }
}
