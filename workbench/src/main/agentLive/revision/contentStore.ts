import fs from 'node:fs';
import path from 'node:path';
import type { ContentMeta, ContentVersionMeta } from '../../../shared/agentLive/types';
import { assertSafeId } from './errors';
import { atomicWriteFile, readJson } from './fsio';
import { formatHash, hashHex } from './hash';

const KEEP = 3;

function metaPath(wsDir: string, materialId: string): string {
  return path.join(wsDir, 'content', materialId, 'meta.json');
}

export function readContentMeta(wsDir: string, materialId: string): ContentMeta {
  return readJson<ContentMeta>(metaPath(wsDir, materialId)) ?? {};
}

export function contentFileAbs(wsDir: string, materialId: string, contentHash: string): string | null {
  const hex = hashHex(contentHash);
  if (!hex) return null;
  assertSafeId(materialId, 'materialId');
  return path.join(wsDir, 'content', materialId, `${hex}.txt`);
}

export async function storeTextVersion(
  wsDir: string,
  materialId: string,
  contentHash: string,
  text: string,
  storedAt: string,
): Promise<string> {
  assertSafeId(materialId, 'materialId');
  const hex = hashHex(contentHash);
  if (!hex) throw new Error('contentHash 不是 sha256');
  const canonical = formatHash(hex);
  const dir = path.join(wsDir, 'content', materialId);
  await fs.promises.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, `${hex}.txt`), text);
  const prev = readContentMeta(wsDir, materialId);
  const versions: ContentVersionMeta[] = (prev.versions ?? []).filter((item) => hashHex(item.contentHash) !== hex);
  versions.push({ contentHash: canonical, file: `${hex}.txt`, storedAt });
  while (versions.length > KEEP) {
    const old = versions.shift();
    if (old?.file) await fs.promises.rm(path.join(dir, old.file), { force: true });
  }
  const next: ContentMeta = {
    ...prev,
    materialId,
    status: prev.status === 'generating' ? 'ready' : (prev.status ?? 'ready'),
    versions,
  };
  await atomicWriteFile(metaPath(wsDir, materialId), JSON.stringify(next));
  return `content/${materialId}/${hex}.txt`;
}

export function readStoredText(wsDir: string, materialId: string, contentHash: string): string | null {
  const file = contentFileAbs(wsDir, materialId, contentHash);
  if (!file || !fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}
