import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function hashHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const hex = value.trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function formatHash(hex: string): string {
  return `sha256:${hex}`;
}

export function hashBuffer(buf: Buffer): string {
  return formatHash(createHash('sha256').update(buf).digest('hex'));
}

export function hashFile(file: string): string {
  return hashBuffer(fs.readFileSync(file));
}

export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = hashHex(a);
  const right = hashHex(b);
  return !!left && left === right;
}

export function isSecretPath(filePath: string | undefined): boolean {
  if (!filePath) return false;
  const base = filePath.split(/[/\\]/).pop()?.toLowerCase() ?? '';
  return base === 'agent-token.json';
}
