/**
 * 主进程为不需要批准的 catalog.* 与 source.remap.preview 登记执行体。
 * 需要批准的动作不登记执行体，能力明细保持 unavailable。
 */
import { CatalogFileError } from '../service/catalogFile';
import type { ActionInvokeResult } from '../../shared/actions/registry';
import { registerInvokeExecutor } from '../../shared/actions/registry';
import { CATALOG_INVOKE_IDS } from './catalogActions';
import type { BridgeHost } from './types';

let registered = false;

function hostOf(host: unknown): BridgeHost {
  return host as BridgeHost;
}

export function registerSourceInvokeExecutors(): void {
  if (registered) return;
  registered = true;
  for (const actionId of CATALOG_INVOKE_IDS) {
    registerInvokeExecutor(actionId, async ({ actionId: id, args, host }): Promise<ActionInvokeResult> => {
      const fn = hostOf(host).catalog;
      if (!fn) return { status: 'failed', error: { code: 'not_available', message: `编排服务未挂上：${id}` } };
      try {
        const result = await fn(id, args ?? {});
        return { status: 'success', result };
      } catch (err) {
        if (err instanceof CatalogFileError && err.code === 'conflict') {
          return {
            status: 'conflict',
            error: { code: 'conflict', message: err.message },
            result: { libraryDigest: err.libraryDigest ?? null, fileBaseDigest: err.fileBaseDigest ?? null },
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'failed', error: { code: 'catalog_failed', message } };
      }
    });
  }
  registerInvokeExecutor('source.remap.preview', async ({ actionId, args, host }): Promise<ActionInvokeResult> => {
    const sourceId = typeof args?.sourceId === 'string' ? args.sourceId.trim() : '';
    const newLocation = typeof args?.newLocation === 'string' ? args.newLocation.trim() : '';
    if (!sourceId || !newLocation) {
      return { status: 'failed', error: { code: 'incomplete_request', message: 'source.remap.preview 需要 sourceId 与 newLocation' } };
    }
    const fn = hostOf(host).previewRemap;
    if (!fn) return { status: 'failed', error: { code: 'not_available', message: '重映射预览未挂上' } };
    try {
      const preview = fn(sourceId, newLocation);
      return { status: 'success', result: { actionId, commandId: actionId, diskMove: false, wroteMounts: false, preview } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failed', error: { code: 'remap_preview_failed', message } };
    }
  });
}
