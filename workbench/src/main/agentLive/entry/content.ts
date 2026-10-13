import fs from 'node:fs';
import path from 'node:path';
import type { AgentMaterial, ContentMeta, ContentVersionMeta } from '../../../shared/agentLive/types';
import { atomicWriteFile, readJson } from './atomic';
import { bodyKind, hashHex, isPdf, isSecretPath } from './text';

export interface IndexedExcerpt {
  text?: string;
  pageTexts?: string[];
  pages?: number | null;
}

export type ContentStatus = 'ready' | 'generating' | 'pending' | 'missing' | 'unreadable' | 'no-text' | 'failed' | 'hidden';

export interface PreparedMaterial {
  source: AgentMaterial;
  tier: 'session' | 'pinned';
  contentStatus: ContentStatus;
  readableRel: string | null;
  readableLabel: string;
  pages: number | null;
  hasText: boolean | undefined;
  hidden: boolean;
}

export function excerptOf(excerpt: IndexedExcerpt | null | undefined): { text: string; pages: number | null } | null {
  if (!excerpt) return null;
  if (excerpt.pageTexts?.length) {
    const text = excerpt.pageTexts.join('\f');
    if (!text) return null;
    const pages = typeof excerpt.pages === 'number' && excerpt.pages >= 0 ? excerpt.pages : excerpt.pageTexts.length;
    return { text, pages };
  }
  if (typeof excerpt.text === 'string' && excerpt.text.length > 0) {
    const pages = typeof excerpt.pages === 'number' && excerpt.pages >= 0 ? excerpt.pages : null;
    return { text: excerpt.text, pages };
  }
  return null;
}

export function contentRel(materialId: string, contentHash: string | null): string | null {
  const hex = hashHex(contentHash);
  if (!hex) return null;
  return `content/${materialId}/${hex}.txt`;
}

export function contentAbs(wsDir: string, materialId: string, contentHash: string | null): string | null {
  const hex = hashHex(contentHash);
  if (!hex) return null;
  return path.join(wsDir, 'content', materialId, `${hex}.txt`);
}

function metaPath(wsDir: string, materialId: string): string {
  return path.join(wsDir, 'content', materialId, 'meta.json');
}

function labelFor(status: ContentStatus, rel: string | null): string {
  if (status === 'hidden') return '已隐藏';
  if (status === 'missing') return '失效，条目保留';
  if (status === 'unreadable') return '不可读';
  if (status === 'no-text') return '无可读文本';
  if (status === 'failed') return '内容提取失败';
  if (status === 'ready' && rel) return rel;
  return '内容生成中';
}

function withVersion(prev: ContentMeta, materialId: string, contentHash: string, hex: string, storedAt: string, extra: ContentMeta): ContentMeta {
  const versions: ContentVersionMeta[] = (prev.versions ?? []).filter((item) => hashHex(item.contentHash) !== hex);
  versions.push({ contentHash, file: `${hex}.txt`, storedAt });
  return {
    ...prev,
    ...extra,
    materialId,
    versions,
  };
}

export interface ContentIO {
  wsDir: string;
  nowIso: string;
  readIndexedText?: (material: AgentMaterial) => IndexedExcerpt | null | Promise<IndexedExcerpt | null>;
  scheduleExtract?: (material: AgentMaterial, hex: string) => void;
  inFlight?: (materialId: string, hex: string) => boolean;
}

export async function prepareMaterial(material: AgentMaterial, io: ContentIO): Promise<PreparedMaterial> {
  const tier: 'session' | 'pinned' = material.tier === 'pinned' ? 'pinned' : 'session';
  const base = {
    source: material,
    tier,
    pages: isPdf(material.absPath) && typeof material.pages === 'number' ? material.pages : null,
    hasText: material.hasText,
  };
  if (isSecretPath(material.absPath) || isSecretPath(material.name) || isSecretPath(material.relPath)) {
    return { ...base, contentStatus: 'hidden', readableRel: null, readableLabel: '已隐藏', hasText: false, hidden: true, pages: null };
  }
  if (material.status === 'missing') {
    return { ...base, contentStatus: 'missing', readableRel: null, readableLabel: labelFor('missing', null), hidden: false };
  }
  if (material.status === 'unreadable') {
    return { ...base, contentStatus: 'unreadable', readableRel: null, readableLabel: labelFor('unreadable', null), hidden: false };
  }
  const hex = hashHex(material.contentHash);
  const rel = hex ? contentRel(material.materialId, material.contentHash) : null;
  const abs = hex ? contentAbs(io.wsDir, material.materialId, material.contentHash) : null;
  if (!hex || !abs || !rel) {
    return { ...base, contentStatus: 'pending', readableRel: null, readableLabel: '内容生成中', hidden: false };
  }
  const meta = readJson<ContentMeta>(metaPath(io.wsDir, material.materialId)) ?? {};
  if (fs.existsSync(abs)) {
    const has = (meta.versions ?? []).some((item) => hashHex(item.contentHash) === hex);
    if (!has || meta.status === 'generating' || meta.noText === true || meta.extractFailed === true) {
      const canonical = material.contentHash!.startsWith('sha256:') ? material.contentHash! : `sha256:${hex}`;
      const next = withVersion(meta, material.materialId, canonical, hex, io.nowIso, { status: 'ready' });
      delete next.extractFailed;
      delete next.failedHash;
      delete next.noText;
      delete next.noTextHash;
      await atomicWriteFile(metaPath(io.wsDir, material.materialId), `${JSON.stringify(next)}\n`);
    }
    return {
      ...base,
      contentStatus: 'ready',
      readableRel: rel,
      readableLabel: rel,
      hasText: material.hasText ?? true,
      pages: pageCount(material, meta, base.pages),
      hidden: false,
    };
  }
  if (meta.noText === true && meta.noTextHash === hex) {
    return { ...base, contentStatus: 'no-text', readableRel: null, readableLabel: '无可读文本', hasText: false, hidden: false };
  }
  if (meta.extractFailed === true && meta.failedHash === hex) {
    return { ...base, contentStatus: 'failed', readableRel: null, readableLabel: '内容提取失败', hasText: false, hidden: false };
  }
  if (io.inFlight?.(material.materialId, hex)) {
    return { ...base, contentStatus: 'generating', readableRel: null, readableLabel: '内容生成中', hidden: false };
  }
  const kind = bodyKind(material.absPath || material.name);
  if (kind === 'no-text') {
    return { ...base, contentStatus: 'no-text', readableRel: null, readableLabel: '无可读文本', hasText: false, hidden: false };
  }
  if (kind === 'extract' && io.readIndexedText) {
    let excerpt: IndexedExcerpt | null = null;
    try {
      excerpt = await io.readIndexedText(material);
    } catch {
      excerpt = null;
    }
    const text = excerptOf(excerpt);
    if (text) {
      await writeReady(io.wsDir, material, hex, text.text, io.nowIso, text.pages);
      return {
        ...base,
        contentStatus: 'ready',
        readableRel: rel,
        readableLabel: rel,
        hasText: true,
        pages: isPdf(material.absPath) ? (text.pages ?? base.pages) : base.pages,
        hidden: false,
      };
    }
  }
  if (io.scheduleExtract) {
    await atomicWriteFile(
      metaPath(io.wsDir, material.materialId),
      `${JSON.stringify({ ...meta, materialId: material.materialId, status: 'generating' })}\n`,
    );
    io.scheduleExtract(material, hex);
    return { ...base, contentStatus: 'generating', readableRel: null, readableLabel: '内容生成中', hidden: false };
  }
  return { ...base, contentStatus: 'generating', readableRel: null, readableLabel: '内容生成中', hidden: false };
}

function pageCount(material: AgentMaterial, meta: ContentMeta, fallback: number | null): number | null {
  if (!isPdf(material.absPath)) return null;
  if (typeof material.pages === 'number') return material.pages;
  if (typeof meta.pages === 'number') return meta.pages;
  return fallback;
}

async function writeReady(
  wsDir: string,
  material: AgentMaterial,
  hex: string,
  text: string,
  storedAt: string,
  pages: number | null,
): Promise<void> {
  const abs = contentAbs(wsDir, material.materialId, material.contentHash);
  if (!abs) return;
  await atomicWriteFile(abs, text);
  const prev = readJson<ContentMeta>(metaPath(wsDir, material.materialId)) ?? {};
  const canonical = material.contentHash!.startsWith('sha256:') ? material.contentHash! : `sha256:${hex}`;
  const extra: ContentMeta = { status: 'ready' };
  if (isPdf(material.absPath) && pages !== null) extra.pages = pages;
  delete prev.extractFailed;
  delete prev.failedHash;
  delete prev.noText;
  delete prev.noTextHash;
  const next = withVersion(prev, material.materialId, canonical, hex, storedAt, extra);
  await atomicWriteFile(metaPath(wsDir, material.materialId), `${JSON.stringify(next)}\n`);
}

export async function finishExtract(
  wsDir: string,
  material: AgentMaterial,
  hex: string,
  excerpt: IndexedExcerpt | null,
  storedAt: string,
  failed: boolean,
): Promise<void> {
  const prev = readJson<ContentMeta>(metaPath(wsDir, material.materialId)) ?? {};
  const text = excerptOf(excerpt);
  if (!failed && text) {
    await writeReady(wsDir, material, hex, text.text, storedAt, text.pages);
    return;
  }
  const next: ContentMeta = {
    ...prev,
    materialId: material.materialId,
    status: failed ? 'missing' : 'ready',
    ...(failed ? { extractFailed: true, failedHash: hex } : { noText: true, noTextHash: hex }),
  };
  await atomicWriteFile(metaPath(wsDir, material.materialId), `${JSON.stringify(next)}\n`);
}
