import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeArtifactName } from './latestYml';

/** 更新源：本地目录、file URL、UNC，或 http(s)。不写死云端账号。 */

export type FeedTarget =
  | { kind: 'dir'; dir: string; latestFile: string }
  | { kind: 'http'; baseUrl: string; latestUrl: string };

export function defaultFeedDir(localAppData: string): string {
  return path.join(localAppData, 'LocalKnowledgeWorkbench-update-feed');
}

export function resolveFeed(input: string): FeedTarget {
  const raw = input.trim();
  if (!raw) throw new Error('没有配置更新源');
  if (/^https?:\/\//i.test(raw)) {
    const base = raw.endsWith('/') ? raw : `${raw}/`;
    return { kind: 'http', baseUrl: base, latestUrl: `${base}latest.yml` };
  }
  const dir = path.resolve(raw.startsWith('file:') ? fileURLToPath(raw) : raw);
  return { kind: 'dir', dir, latestFile: path.join(dir, 'latest.yml') };
}

export function artifactSource(feed: FeedTarget, fileName: string): string {
  const base = safeArtifactName(fileName);
  if (feed.kind === 'http') return feed.baseUrl + encodeURIComponent(base);
  return path.join(feed.dir, base);
}
