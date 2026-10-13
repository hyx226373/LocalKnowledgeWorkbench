/**
 * 不需要批准的 catalog.* 接到现有编排服务。
 * 不写 root_mounts，不移动文件，不重扫，不改配对规则。
 * catalog.delete 不在这里（要界面批准，桥上不执行）。
 */
import { randomUUID } from 'node:crypto';
import { CatalogFileError } from '../service/catalogFile';
import { CATALOGS_KEY, makeCatalogSet, parseCatalogs } from '../../shared/catalog';

export interface CatalogBridgeSvc {
  currentCatalogId(): string;
  getCurrentWorkspaceId(): string;
  getLayout(key: string): unknown | null;
  setLayout(key: string, value: unknown): void;
  emit?(event: string, payload?: unknown): void;
  listVirtualFolders(): { folderId: string }[];
  switchCatalog(workspaceId: string, catalogId: string): { workspaceId: string; catalogId: string };
  createVirtualFolder(parentId: string | null, name: string): { folderId: string; name: string };
  renameVirtualFolder(folderId: string, name: string): { folderId: string; name: string };
  deleteVirtualFolder(folderId: string): { parentId: string | null };
  moveVirtualFolder(folderId: string, newParentId: string | null, sort: number): { folderId: string };
  removeVfolderMembership(resourceId: string, folderId: string | null): string[];
  addCatalogRef(catalogId: string, folderId: string | null, resourceId: string): { diskMove: false; catalogId: string; folderId: string | null; resourceId: string };
  exportCatalog(catalogId?: string): unknown;
  importCatalog(raw: unknown): unknown;
  previewRemap(rootId: string, newPath: string): unknown;
}

export const CATALOG_INVOKE_IDS = [
  'catalog.create',
  'catalog.rename',
  'catalog.switch',
  'catalog.folder.create',
  'catalog.folder.rename',
  'catalog.folder.delete',
  'catalog.folder.move',
  'catalog.ref.add',
  'catalog.ref.remove',
  'catalog.export',
  'catalog.import',
] as const;

function reqStr(v: unknown, label: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Error(`${label} 无效`);
  return s;
}

function nameOf(v: unknown, label: string): string {
  const name = reqStr(v, label);
  if (name.length > 80 || /[\\/]/.test(name) || /^[A-Za-z]:/.test(name)) throw new Error(`${label} 无效`);
  return name;
}

function folderIdOf(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error('folderId 无效');
  const id = v.trim();
  if (!id) return null;
  if (id.length > 80 || /[\\/]/.test(id)) throw new Error('folderId 无效');
  return id;
}

function assertCurrent(svc: CatalogBridgeSvc, catalogId: string): void {
  if (svc.currentCatalogId() !== catalogId) throw new Error('仅当前编排可调');
}

function done(actionId: string, extra: object) {
  return { actionId, commandId: actionId, diskMove: false as const, ...extra };
}

function readSets(svc: CatalogBridgeSvc): { raw: { v?: unknown; sets?: unknown[] }; sets: unknown[] } {
  svc.listVirtualFolders();
  const raw = svc.getLayout(CATALOGS_KEY);
  if (!raw || typeof raw !== 'object') throw new Error('编排库尚未就绪');
  if (!parseCatalogs(raw)) throw new Error('库内编排无法解析');
  const sets = Array.isArray((raw as { sets?: unknown }).sets) ? (raw as { sets: unknown[] }).sets.slice() : [];
  return { raw: raw as { v?: unknown; sets?: unknown[] }, sets };
}

function writeSets(svc: CatalogBridgeSvc, raw: object, sets: unknown[]): void {
  svc.setLayout(CATALOGS_KEY, { ...raw, v: 1, sets });
  svc.emit?.('vfolders-change');
}

function createCatalog(svc: CatalogBridgeSvc, args: Record<string, unknown>, actionId: string) {
  const name = nameOf(args.name, '名称');
  const { raw, sets } = readSets(svc);
  const set = makeCatalogSet({ id: randomUUID(), name, revision: 1, virtualRootName: name, folders: [], refs: [] });
  sets.push(set);
  writeSets(svc, raw, sets);
  return done(actionId, { catalogId: set.id, name: set.name, virtualRootName: set.virtualRootName });
}

function renameCatalog(svc: CatalogBridgeSvc, args: Record<string, unknown>, actionId: string) {
  const catalogId = reqStr(args.catalogId, 'catalogId');
  const name = nameOf(args.name, '名称');
  const { raw, sets } = readSets(svc);
  const doc = parseCatalogs(raw);
  const prev = doc?.sets.find((s) => s.id === catalogId);
  const idx = sets.findIndex((s) => s && typeof s === 'object' && (s as { id?: unknown }).id === catalogId);
  if (!prev || idx < 0) throw new Error(`编排不存在: ${catalogId}`);
  const next = makeCatalogSet({ ...prev, name, revision: prev.revision + 1 });
  sets[idx] = next;
  writeSets(svc, raw, sets);
  return done(actionId, { catalogId, name: next.name });
}

export function runCatalog(svc: CatalogBridgeSvc, actionId: string, args: Record<string, unknown>): unknown {
  switch (actionId) {
    case 'catalog.create':
      return createCatalog(svc, args, actionId);
    case 'catalog.rename':
      return renameCatalog(svc, args, actionId);
    case 'catalog.switch': {
      const workspaceId = reqStr(args.workspaceId, 'workspaceId');
      const catalogId = reqStr(args.catalogId, 'catalogId');
      if (workspaceId !== svc.getCurrentWorkspaceId()) throw new Error('catalog.switch 仅当前工作区可调');
      const switched = svc.switchCatalog(workspaceId, catalogId);
      return done(actionId, switched);
    }
    case 'catalog.folder.create': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      assertCurrent(svc, catalogId);
      const folder = svc.createVirtualFolder(folderIdOf(args.parentId), nameOf(args.name, '名称'));
      return done(actionId, { catalogId, folder });
    }
    case 'catalog.folder.rename': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      assertCurrent(svc, catalogId);
      const folder = svc.renameVirtualFolder(reqStr(args.folderId, 'folderId'), nameOf(args.name, '名称'));
      return done(actionId, { catalogId, folder });
    }
    case 'catalog.folder.delete': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      assertCurrent(svc, catalogId);
      const removed = svc.deleteVirtualFolder(reqStr(args.folderId, 'folderId'));
      return done(actionId, { catalogId, ...removed });
    }
    case 'catalog.folder.move': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      assertCurrent(svc, catalogId);
      if (typeof args.sort !== 'number' || !Number.isFinite(args.sort)) throw new Error('sort 无效');
      const folder = svc.moveVirtualFolder(reqStr(args.folderId, 'folderId'), folderIdOf(args.parentId), args.sort);
      return done(actionId, { catalogId, folder });
    }
    case 'catalog.ref.add':
      return done(actionId, svc.addCatalogRef(reqStr(args.catalogId, 'catalogId'), folderIdOf(args.folderId), reqStr(args.resourceId, 'resourceId')));
    case 'catalog.ref.remove': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      assertCurrent(svc, catalogId);
      const resourceId = reqStr(args.resourceId, 'resourceId');
      const folderId = folderIdOf(args.folderId);
      svc.removeVfolderMembership(resourceId, folderId);
      return done(actionId, { catalogId, folderId, resourceId });
    }
    case 'catalog.export': {
      const catalogId = reqStr(args.catalogId, 'catalogId');
      return done(actionId, { file: svc.exportCatalog(catalogId) });
    }
    case 'catalog.import': {
      if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('content 无效');
      const baseDigest = reqStr(args.baseDigest, 'baseDigest');
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.content);
      } catch {
        throw new Error('content 不是合法 JSON');
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('content 必须是编排文件对象');
      const file = parsed as { baseDigest?: unknown };
      if (file.baseDigest != null && file.baseDigest !== baseDigest) {
        throw new CatalogFileError('baseDigest 与文件不符', 'conflict', { fileBaseDigest: String(file.baseDigest) });
      }
      file.baseDigest = baseDigest;
      return done(actionId, { imported: svc.importCatalog(file) });
    }
    default:
      throw new Error(`没有这个编排动作：${actionId}`);
  }
}

export function attachCatalogHost(svc: object): {
  catalog?: (actionId: string, args: Record<string, unknown>) => unknown;
  previewRemap?: (sourceId: string, newLocation: string) => unknown;
} {
  const s = svc as Partial<CatalogBridgeSvc>;
  const out: {
    catalog?: (actionId: string, args: Record<string, unknown>) => unknown;
    previewRemap?: (sourceId: string, newLocation: string) => unknown;
  } = {};
  if (typeof s.currentCatalogId === 'function' && typeof s.addCatalogRef === 'function' && typeof s.switchCatalog === 'function' && typeof s.getLayout === 'function') {
    out.catalog = (actionId, args) => runCatalog(s as CatalogBridgeSvc, actionId, args ?? {});
  }
  if (typeof s.previewRemap === 'function') {
    out.previewRemap = (sourceId, newLocation) => s.previewRemap!(sourceId, newLocation);
  }
  return out;
}
