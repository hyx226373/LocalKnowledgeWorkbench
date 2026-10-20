import path from 'node:path';
import type { ContentScope } from '@kb/indexer';
import type { WorkbenchService } from '../service/WorkbenchService';
import { DEFAULT_CONTENT_INDEX_MAX_BYTES, contentExtensionAllowed, decideContentIndex, readContentIndexScope, type ContentIndexScope } from '../../shared/contentIndexScope';

export type ContentArea = 'agent-materials' | 'agent-repository';
type Area = { resourceIds?: string[]; paths?: string[] };
const areas = new WeakMap<WorkbenchService, Map<ContentArea, Area>>();
/** Transient inputs: never persist absolute paths in layout. */
export function setContentArea(svc: WorkbenchService, area: ContentArea, value: Area): void {
  let map = areas.get(svc);
  if (!map) { map = new Map(); areas.set(svc, map); }
  if (JSON.stringify(map.get(area)) === JSON.stringify(value)) return;
  map.set(area, value);
  svc.emit('content-scope-changed');
}

export const INDEX_TEXT_EXTENSIONS = 'md markdown txt log json csv tsv xml yaml yml ini toml js ts tsx jsx py java c h cpp cs go rs sh ps1 bat css html htm sql tex'.split(' ');
/** Include paths are explicit, so an empty selection must not mean "all files". */
export function serializeContentScope(config: ContentIndexScope, relPaths?: string[]): ContentScope {
  return {
    includeExts: [...new Set([...INDEX_TEXT_EXTENSIONS, ...config.extraExtensions])],
    includePrefixes: relPaths === undefined ? config.includePrefixes : ['\u0000no-content-area'],
    excludePrefixes: config.excludePrefixes,
    ...(relPaths === undefined ? {} : { includeRelPaths: [...new Set(relPaths.filter((rel) => decideContentIndex(rel, config).index))].sort() }),
    maxBytes: Math.min(config.maxBytes, DEFAULT_CONTENT_INDEX_MAX_BYTES),
  };
}

type Resource = { id: string; root_id: string; rel_path: string; kind: string };
/** 主屏幕关掉的文件，正文是否保留到下次启动（当前规格：保留）。改成 false 则关掉即只按文件名可搜。 */
export const RETAIN_CLOSED_TABS_UNTIL_RESTART = true;
/** Per-process opened set deliberately retains closed tabs until the next startup. */
export class WorkbenchContentScope {
  private opened = new Set<string>();
  constructor(private svc: WorkbenchService) {}
  snapshot(): Map<string, ContentScope> {
    const db = this.svc.db;
    const config = readContentIndexScope((key) => this.svc.getLayout(key));
    const resources = db.prepare('SELECT id, root_id, rel_path, kind FROM resources WHERE missing_since IS NULL AND out_of_scope=0').all() as Resource[];
    const roots = this.svc.listRoots();
    const selected = new Set<string>();
    const ws = this.svc.getCurrentWorkspaceId();
    const items = db.prepare("SELECT ref FROM workspace_items WHERE workspace_id=? AND source_kind='file'").all(ws) as { ref: string }[];
    if (!RETAIN_CLOSED_TABS_UNTIL_RESTART) this.opened.clear();
    for (const row of items) this.opened.add(row.ref);
    for (const id of this.opened) selected.add(id);
    const refs = db.prepare("SELECT json FROM layout WHERE key LIKE 'workspace.refs:%'").all() as { json: string }[];
    for (const row of refs) {
      try { for (const ref of JSON.parse(row.json)) if (typeof ref?.id === 'string') selected.add(ref.id); } catch { /* malformed layout */ }
    }
    const areaPaths: string[] = [];
    for (const area of areas.get(this.svc)?.values() ?? []) {
      for (const id of area.resourceIds ?? []) selected.add(id);
      areaPaths.push(...(area.paths ?? []));
    }
    const selectedRows = resources.filter((row) => selected.has(row.id));
    const result = new Map<string, ContentScope>();
    for (const root of roots) {
      const under = (target: string, parent: string) => {
        const rel = path.relative(parent, target);
        return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
      };
      const rels = resources.filter((row) => {
        if (row.root_id !== root.id || row.kind !== 'file') return false;
        if (!contentExtensionAllowed(path.extname(root.kind === 'file' ? root.path : row.rel_path), config)) return false;
        if (selected.has(row.id)) return true;
        if (selectedRows.some((folder) => folder.kind === 'dir' && folder.root_id === row.root_id && (folder.rel_path === '' || row.rel_path.startsWith(folder.rel_path + '/')))) return true;
        const abs = root.kind === 'file' ? root.path : path.join(root.path, row.rel_path);
        return areaPaths.some((p) => under(abs, p));
      }).map((row) => root.kind === 'file' ? path.basename(root.path) : row.rel_path);
      result.set(root.id, serializeContentScope(config, rels));
    }
    return result;
  }
}
