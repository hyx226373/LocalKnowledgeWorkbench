import type { AiWriteChannel, AiWriteRoot } from './service';

export function bindAiWriteMethods(get: () => AiWriteChannel): Record<string, (input?: any) => unknown> {
  return {
    aiWriteSettingsGet: () => get().getSettings(),
    aiWriteSettingsSet: (input) => get().setSettings(input),
    aiWriteSyncRoots: (input: { roots?: AiWriteRoot[] } | undefined) => {
      get().syncRoots(Array.isArray(input?.roots) ? input.roots : []);
    },
    aiWritePending: () => get().pending(),
    aiWriteApprove: (input: { planId?: string; force?: boolean } | undefined) => {
      if (!input?.planId) throw new Error('缺少计划');
      return get().approve(input.planId, input.force === true);
    },
    aiWriteReject: (input: { planId?: string } | undefined) => {
      if (!input?.planId) throw new Error('缺少计划');
      get().reject(input.planId);
    },
    aiWriteConflictResolve: (input: { id?: string; action?: string } | undefined) => {
      if (!input?.id || (input.action !== 'keep' && input.action !== 'restore')) throw new Error('无法处理这个冲突');
      get().resolveConflict(input.id, input.action);
    },
    aiWriteLinksGet: () => get().getSettings().linkItems,
    aiWriteLinksAdd: (input: { items?: { path?: string; name?: string; kind?: string }[] } | undefined) => get().addLinkItems(Array.isArray(input?.items) ? input.items : []),
    aiWriteLinksRemove: (input: { id?: string } | undefined) => {
      if (!input?.id) throw new Error('缺少链接项');
      return get().removeLinkItem(input.id);
    },
    aiWriteLinksClear: () => get().clearLinkItems(),
    aiWriteLinkStatus: () => get().linkStatus(),
    aiWriteCollect: (input: { sessionId?: string } | undefined) => get().collect(input?.sessionId),
    aiWriteApply: (input: { sessionId?: string; fileId?: string; decision?: string; landingDir?: string } | undefined) => {
      if (!input?.sessionId || !input.fileId) throw new Error('缺少改动');
      if (input.decision !== 'approve' && input.decision !== 'reject' && input.decision !== 'delete' && input.decision !== 'overwrite') throw new Error('无法处理这项改动');
      return get().apply({ sessionId: input.sessionId, fileId: input.fileId, decision: input.decision, landingDir: input.landingDir });
    },
    aiWriteSessionDiscard: (input: { sessionId?: string; confirm?: boolean } | undefined) => {
      return get().discardSession(input?.sessionId, input?.confirm === true);
    },
    aiWriteLegacyStages: () => get().listLegacyStages(),
    aiWriteLegacyStageTrash: (input: { paths?: string[] } | undefined) => {
      const paths = Array.isArray(input?.paths) ? input.paths.filter((item): item is string => typeof item === 'string') : [];
      if (!paths.length) throw new Error('没有可清理的暂存');
      return get().trashLegacyStages(paths);
    },
    aiWritePlanDrop: (input: any) => get().planDrop(input),
  };
}
