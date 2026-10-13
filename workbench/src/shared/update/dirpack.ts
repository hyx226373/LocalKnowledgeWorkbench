/** 目录包清单。只读 dirpack.json，不改 latest.yml。 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DIRPACK_FILE, parseDirpack, type DirPackManifest } from '../layout';
import { safeArtifactName } from './latestYml';

export async function loadDirpack(feedDir: string): Promise<DirPackManifest> {
  const text = await fs.readFile(path.join(feedDir, DIRPACK_FILE), 'utf8');
  return parseDirpack(text);
}

/** 用清单里的文件名拼本地包路径。拒绝目录穿越。 */
export function dirpackSource(feedDir: string, manifest: DirPackManifest): string {
  return path.join(feedDir, safeArtifactName(manifest.file));
}
