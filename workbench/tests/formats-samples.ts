import { zipSync } from 'fflate';
import type { FormatInput } from '../src/shared/formats/types';

const text = new TextEncoder();

export function encode(value: string): Uint8Array {
  return text.encode(value);
}

export function zipOffice(files: Record<string, string | Uint8Array>): Uint8Array {
  const packed: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(files)) packed[name] = typeof value === 'string' ? encode(value) : value;
  return zipSync(packed, { level: 0 });
}

export function inputOf(ext: string, bytes: Uint8Array, name = `sample.${ext}`): FormatInput {
  return { ext, size: bytes.byteLength, bytes, name };
}

export function contentTypes(overrides: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  ${overrides.join('\n  ')}
</Types>`;
}

export function rels(entries: { id: string; type: string; target: string; external?: boolean }[]): string {
  const tags = entries
    .map((entry) => {
      const mode = entry.external ? ` TargetMode="External"` : '';
      return `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"${mode}/>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${tags}</Relationships>`;
}

/** 中央目录里声明危险尺寸，不真的解压炸弹。 */
export function declaredZip(options: { entries: number; compressed?: number; uncompressed?: number; flags?: number }): Uint8Array {
  const compressed = options.compressed ?? 1;
  const uncompressed = options.uncompressed ?? 1;
  const flags = options.flags ?? 0;
  const name = Buffer.from('a.xml');
  const record = Buffer.alloc(46 + name.length);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(flags, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt32LE(compressed, 20);
  record.writeUInt32LE(uncompressed, 24);
  record.writeUInt16LE(name.length, 28);
  name.copy(record, 46);
  const cd = Buffer.concat(Array.from({ length: Math.min(options.entries, 1) }, () => record));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(options.entries, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(4, 16);
  return new Uint8Array(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), cd, eocd]));
}
