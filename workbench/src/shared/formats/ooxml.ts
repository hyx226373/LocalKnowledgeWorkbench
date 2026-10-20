import { familyFromContentTypes, familyOfExt, sniff, type OfficeFamily } from './magic';
import { MSG } from './messages';
import { externalWarning, stripExternalRels } from './rels';
import { FormatFail, type FormatInput } from './types';
import { MAX_FORMAT_BYTES } from './limits';
import { assertSafePackage, decodeXml } from './xml';
import { unzipOffice } from './zip';

export interface OfficePackage {
  files: Map<string, Uint8Array>;
  family: OfficeFamily;
  warnings: string[];
}

export function assertBudget(input: FormatInput): void {
  const size = Math.max(input.size || 0, input.bytes.byteLength);
  if (size > MAX_FORMAT_BYTES) throw new FormatFail('too-large', MSG.tooLarge);
}

export function normExt(ext: string): string {
  return ext.toLowerCase().replace(/^\./, '');
}

/**
 * 已经解开的包。没有 `[Content_Types].xml` 时返回 null，让 epub / odt / ofd 接着认。
 * 有内容类型但认不出家族时，跟以前一样是 unsupported。
 */
export function classifyOffice(files: Map<string, Uint8Array>, ext: string, warnings: string[]): OfficeFamily | null {
  const contentTypes = files.get('[Content_Types].xml');
  if (!contentTypes) return null;
  const fromXml = familyFromContentTypes(decodeXml(contentTypes));
  const fromExt = familyOfExt(normExt(ext));
  const family = fromXml ?? (fromExt === 'pdf' ? null : fromExt);
  if (!family) throw new FormatFail('unsupported-variant', MSG.unsupported);
  if (fromXml && fromExt && fromExt !== 'pdf' && fromXml !== fromExt && !warnings.includes(MSG.magicMismatch)) warnings.push(MSG.magicMismatch);
  return family;
}

/** 魔数决定家族。扩展名只在内容类型认不出时兜底，不一致就加警告。 */
export function openPackage(input: FormatInput): OfficePackage {
  assertBudget(input);
  if (sniff(input.bytes) !== 'zip') throw new FormatFail('unsupported-variant', MSG.unsupported);
  const files = unzipOffice(input.bytes);
  const dropped = stripExternalRels(files).dropped;
  assertSafePackage(files);
  const warnings: string[] = [];
  externalWarning(dropped, warnings);
  if (!files.has('[Content_Types].xml')) throw new FormatFail('corrupt', MSG.corrupt);
  const family = classifyOffice(files, input.ext, warnings);
  if (!family) throw new FormatFail('unsupported-variant', MSG.unsupported);
  return { files, family, warnings };
}
