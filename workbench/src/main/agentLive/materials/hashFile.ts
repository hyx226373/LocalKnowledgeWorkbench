import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { TEXT_SAMPLE_MAX } from './identity';

export function formatHash(hex: string): string {
  return `sha256:${hex}`;
}

export function hashHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function hashBuffer(buf: Buffer): string {
  return formatHash(createHash('sha256').update(buf).digest('hex'));
}

export async function hashFileSample(absPath: string): Promise<{ hash: string; sample: Buffer }> {
  const hash = createHash('sha256');
  const fh = await fs.promises.open(absPath, 'r');
  const chunks: Buffer[] = [];
  let sampleLen = 0;
  try {
    const buf = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
      if (sampleLen < TEXT_SAMPLE_MAX) {
        const piece = Buffer.from(buf.subarray(0, Math.min(bytesRead, TEXT_SAMPLE_MAX - sampleLen)));
        chunks.push(piece);
        sampleLen += piece.length;
      }
    }
  } finally {
    await fh.close();
  }
  return { hash: formatHash(hash.digest('hex')), sample: chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0) };
}
