import type { ActionInput } from '../../../shared/actions/types';
import { AGENT_LIVE_ACTIONS, type GetContentArgs, type GetDiffArgs } from '../../../shared/agentLive/types';
import { AgentLiveError } from './errors';
import type { AgentLiveRevision } from './log';

export interface RevisionInvokeResult {
  status: 'success' | 'failed';
  result?: unknown;
  error?: { code: string; message: string };
}

export const revisionActions: ActionInput[] = [
  {
    actionId: AGENT_LIVE_ACTIONS.getContent,
    title: '读取工作资料内容',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: false,
    argsSchema: {
      type: 'object',
      required: ['materialId'],
      additionalProperties: false,
      properties: {
        materialId: { type: 'string' },
        workspaceId: { type: 'string' },
        contentHash: { type: 'string' },
        offset: { type: 'number' },
        length: { type: 'number' },
        page: { type: 'number' },
      },
    },
  },
  {
    actionId: AGENT_LIVE_ACTIONS.getDiff,
    title: '读取工作资料差异',
    category: 'agent',
    source: 'agent-live',
    bridgeInvokable: true,
    approvalRequired: false,
    argsSchema: {
      type: 'object',
      required: ['materialId', 'fromHash', 'toHash'],
      additionalProperties: false,
      properties: {
        materialId: { type: 'string' },
        workspaceId: { type: 'string' },
        fromHash: { type: 'string' },
        toHash: { type: 'string' },
      },
    },
  },
];

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function fail(err: unknown): RevisionInvokeResult {
  if (err instanceof AgentLiveError) return { status: 'failed', error: { code: err.code, message: err.message } };
  return { status: 'failed', error: { code: 'failed', message: err instanceof Error ? err.message : String(err) } };
}

export function createRevisionHandlers(api: AgentLiveRevision) {
  return {
    actions: revisionActions,
    async getContent(args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<RevisionInvokeResult> {
      const materialId = str(args?.materialId);
      if (!materialId) return { status: 'failed', error: { code: 'incomplete_request', message: 'agent.getContent 缺少 materialId' } };
      const query: GetContentArgs = { materialId };
      const workspaceId = str(args?.workspaceId);
      const contentHash = str(args?.contentHash);
      if (workspaceId) query.workspaceId = workspaceId;
      if (contentHash) query.contentHash = contentHash;
      const offset = num(args?.offset);
      const length = num(args?.length);
      const page = num(args?.page);
      if (offset !== undefined) query.offset = offset;
      if (length !== undefined) query.length = length;
      if (page !== undefined) query.page = page;
      try {
        return { status: 'success', result: await api.getContent(query, signal) };
      } catch (err) {
        return fail(err);
      }
    },
    async getDiff(args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<RevisionInvokeResult> {
      const materialId = str(args?.materialId);
      const fromHash = str(args?.fromHash);
      const toHash = str(args?.toHash);
      if (!materialId || !fromHash || !toHash) {
        return { status: 'failed', error: { code: 'incomplete_request', message: 'agent.getDiff 缺少 materialId、fromHash 或 toHash' } };
      }
      const query: GetDiffArgs = { materialId, fromHash, toHash };
      const workspaceId = str(args?.workspaceId);
      if (workspaceId) query.workspaceId = workspaceId;
      try {
        return { status: 'success', result: await api.getDiff(query, signal) };
      } catch (err) {
        return fail(err);
      }
    },
  };
}
