/**
 * 文本 / Markdown 原位编辑的服务层（第 9 轮 C）。只做“文本语义”（编码、换行、BOM、差异、冲突判定），
 * 落盘、备份、op_log、撤销全部交给 FileOpsBackend（../backend/fileOps.ts，将来换成 @kb/fileops + @kb/plan）。
 */
import iconv from 'iconv-lite';
import { diffLines } from '../../shared/textDiff';
import type { SaveOutcome, SavePreview, TextEncodingName, TextSnapshot, UndoOutcome } from '../../shared/textEdit';
export type { SaveOutcome, SavePreview, TextEncodingName, TextSnapshot, UndoOutcome };
import type { FileOpsBackend, FileStat } from '../backend/fileOps';

export const EDIT_MAX_BYTES = 4 * 1024 * 1024;

export function decodeForEdit(buf: Buffer): { text: string; encoding: TextEncodingName; encodingUncertain?: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    // UTF-8 失败后尝试 GB18030；若往返不一致则标记 uncertain，禁止静默按错误编码写回
    const text = iconv.decode(buf, 'gb18030');
    const ok = iconv.encode(text, 'gb18030').equals(buf);
    return { text, encoding: 'gb18030', encodingUncertain: !ok };
  }
}

/** 解码后再按原编码编码能否得到原字节（GBK 文件里有无效字节时为 false：保存会改写这些字节，只能阅读） */
export function roundTrips(buf: Buffer, text: string, encoding: TextEncodingName): boolean {
  if (encoding !== 'gb18030') return true;
  return iconv.encode(text, 'gb18030').equals(buf);
}

export function encodeForSave(text: string, encoding: TextEncodingName, eol: 'lf' | 'crlf'): Buffer {
  const body = eol === 'crlf' ? text.replace(/\r?\n/g, '\r\n') : text;
  if (encoding === 'utf-8') return Buffer.from(body, 'utf8');
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]);
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(body, 'utf-16be')]);
  // GB18030 是 GBK 的超集：GBK 文件里原有的字符按原字节写回；新输入的 GBK 之外的字符（如部分 emoji）用 GB18030 四字节编码，不会变成问号
  if (encoding === 'gb18030') return iconv.encode(body, 'gb18030');
  throw new Error(`不支持以 ${encoding} 编码保存`);
}

const norm = (s: string) => s.replace(/\r\n?/g, '\n');

export class TextEditService {
  constructor(private fileOps: FileOpsBackend) {}

  open(resourceId: string): TextSnapshot {
    const { bytes, stat, truncated } = this.fileOps.readBytes(resourceId, EDIT_MAX_BYTES);
    return this.snapshot(bytes, stat, truncated);
  }

  private snapshot(bytes: Buffer, stat: FileStat, truncated: boolean): TextSnapshot {
    const decoded = decodeForEdit(bytes);
    const { text, encoding } = decoded;
    const crlf = (text.match(/\r\n/g)?.length ?? 0) > 0 && (text.match(/\r\n/g)!.length >= (text.match(/(?<!\r)\n/g)?.length ?? 0));
    let readOnlyReason: string | undefined;
    if (truncated) readOnlyReason = `文件超过 ${EDIT_MAX_BYTES / 1024 / 1024} MB，只能阅读`;
    else if (decoded.encodingUncertain || !roundTrips(bytes, text, encoding))
      readOnlyReason = '编码无法可靠识别或往返不一致（GBK/GB18030）：保存会改写文件字节。请另存为 UTF-8 或选择正确编码后再编辑（未静默替换原文件）';
    else if (text.includes('\u0000')) readOnlyReason = '文件含二进制内容，只能阅读';
    return {
      resourceId: stat.resourceId,
      relPath: stat.relPath,
      text: norm(text),
      hash: stat.hash,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      encoding,
      eol: crlf ? 'crlf' : 'lf',
      editable: !readOnlyReason,
      ...(readOnlyReason ? { readOnlyReason } : {}),
    };
  }

  stat(resourceId: string): { hash: string; mtimeMs: number; size: number } {
    const s = this.fileOps.stat(resourceId);
    return { hash: s.hash, mtimeMs: s.mtimeMs, size: s.size };
  }

  /** 保存前预览：与磁盘当前内容的差异；磁盘内容已不是 baseHash 时 conflict=true */
  previewSave(resourceId: string, text: string, baseHash: string): SavePreview {
    const disk = this.open(resourceId);
    const diff = diffLines(disk.text, norm(text));
    const conflict = disk.hash !== baseHash;
    return {
      resourceId,
      relPath: disk.relPath,
      diff,
      conflict,
      disk,
      summary: conflict
        ? `「${disk.relPath}」在你打开后已被修改（外部软件或其他面板）`
        : diff.identical
          ? '没有改动'
          : `「${disk.relPath}」：+${diff.added} 行，-${diff.removed} 行；保存前原内容会备份，可撤销到上一版`,
    };
  }

  /**
   * 保存。baseHash = 打开（或上次保存/重新载入）时的内容哈希。
   * 用户在冲突中选了“保留我的”时，界面以当时看到的外部版本哈希作为 baseHash 再调一次——外部版本先进备份库，可撤销。
   */
  save(resourceId: string, text: string, baseHash: string, actor = 'user'): SaveOutcome {
    const disk = this.open(resourceId);
    if (!disk.editable) throw new Error(disk.readOnlyReason ?? '该文件不可编辑');
    if (disk.hash !== baseHash) return { status: 'conflict', disk, diff: diffLines(disk.text, norm(text)) };
    if (disk.text === norm(text)) return { status: 'unchanged', snapshot: disk };
    const bytes = encodeForSave(norm(text), disk.encoding, disk.eol);
    const r = this.fileOps.writeBytes(resourceId, bytes, { expectedHash: baseHash, actor, meta: { via: 'text-edit' } });
    if (!r.ok) {
      const now = this.open(resourceId);
      return { status: 'conflict', disk: now, diff: diffLines(now.text, norm(text)) };
    }
    return { status: 'saved', opId: r.opId, snapshot: this.open(resourceId) };
  }

  history(resourceId: string) {
    return this.fileOps.history(resourceId);
  }

  /** 撤销到上一版：撤销该文件最近一次未撤销的保存 */
  undoLastSave(resourceId: string, force = false, actor = 'user'): UndoOutcome {
    const last = this.fileOps.history(resourceId).find((h) => !h.undone);
    if (!last) return { status: 'nothing' };
    const r = this.fileOps.undoWrite(last.opId, { force, actor });
    if (!r.ok) return r.reason === 'nothing' ? { status: 'nothing' } : { status: r.reason, detail: r.detail };
    return { status: 'undone', opId: r.opId, snapshot: this.open(resourceId) };
  }
}
