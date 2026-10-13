import path from 'node:path';
import type { WorkbenchService } from '../service/WorkbenchService';
import { exportPackage } from '../migration/exporter';
import { createBackup, importPackage, listBackups, loadPackage, restoreBackup, suggestMappings, type RootMappings } from '../migration/importer';
import { listMissing, relocateResource, rootStatuses } from '../migration/repair';

/** 迁移包的数据库操作。窗口和对话框留在主进程，经这些方法调用。 */
export function migrationMethods(svc: WorkbenchService, onRootsReplaced: () => Promise<void>, version: string) {
  return {
    'migration.info': () => ({
      dataDir: svc.dataDir,
      platform: process.platform,
      version,
      roots: rootStatuses(svc),
      backups: listBackups(svc),
    }),
    'migration.exportTo': async (file: string) => {
      if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择导出位置');
      const saved = await exportPackage(svc, file, { appVersion: version });
      return { file: saved.file, bytes: saved.bytes, manifest: saved.manifest };
    },
    'migration.inspect': (file: string, baseDirs?: string[]) => {
      const { manifest } = loadPackage(String(file));
      return { manifest, suggestions: suggestMappings(manifest, Array.isArray(baseDirs) ? baseDirs.map(String) : []) };
    },
    'migration.suggest': (file: string, baseDir: string) => suggestMappings(loadPackage(String(file)).manifest, [String(baseDir)]),
    'migration.importPackage': async (file: string, mappings: RootMappings) => {
      const imported = await importPackage(svc, String(file), mappings && typeof mappings === 'object' ? mappings : {}, { waitForScan: true });
      await onRootsReplaced();
      return imported;
    },
    'migration.roots': () => rootStatuses(svc),
    'migration.remapRoot': async (rootId: string, folder: string) => {
      svc.remapRoot(String(rootId), String(folder));
      await onRootsReplaced();
      return rootStatuses(svc);
    },
    'migration.listMissing': () => listMissing(svc),
    'migration.relocate': (resourceId: string, folder: string) => relocateResource(svc, String(resourceId), String(folder)),
    'migration.listBackups': () => listBackups(svc),
    'migration.backupNow': () => createBackup(svc, 'manual'),
    'migration.restoreBackup': async (dir: string) => {
      const found = listBackups(svc).find((row) => row.dir === dir);
      if (!found) throw new Error('备份不存在');
      restoreBackup(svc, found.dir);
      await Promise.all(svc.listRoots().map((root) => svc.scanRoot(root.id)));
      await onRootsReplaced();
      return true;
    },
    'migration.rootsReplaced': () => onRootsReplaced(),
  };
}
