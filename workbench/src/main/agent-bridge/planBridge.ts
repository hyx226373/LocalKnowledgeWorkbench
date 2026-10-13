/**
 * 把界面批准 / 拒绝 / 冲突回写到 responses/<requestId>.json。
 * 只读计划服务。不调用批准，不第二次执行，不写 SQLite。
 */
import fs from 'node:fs';
import path from 'node:path';
import { decidePlanBridge, statusesToWrite, type WatchedPlan } from './conflict';
import { isNonTerminal, savedContentHash } from './recovery';
import type { BridgeResponse, BridgeStatus } from './types';

export interface PlanPreviewSnap {
  contentHash: string;
  items: { opId: string; summary: string; conflicts: string[] }[];
}

export interface PlanPorts {
  getPlan(planId: string): Promise<WatchedPlan | null>;
  previewPlan(planId: string): Promise<PlanPreviewSnap | null>;
}

export interface PlanBridge {
  syncOnce(): Promise<void>;
  close(): Promise<void>;
}

function writeResponse(root: string, body: BridgeResponse): void {
  const dest = path.join(root, 'responses', `${body.requestId}.json`);
  const tmp = path.join(root, 'responses', `.${body.requestId}.${process.pid}.plan.tmp`);
  const clean: BridgeResponse = { ...body };
  if (!clean.suggestedAction) delete clean.suggestedAction;
  if (!clean.error) delete clean.error;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
}

function readResponse(file: string): BridgeResponse | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeResponse;
    if (!parsed?.requestId || !parsed.status) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function startPlanBridge(opts: {
  root: string;
  ports: PlanPorts;
  pollMs?: number;
  now?: () => Date;
}): PlanBridge {
  const now = opts.now ?? (() => new Date());
  let closed = false;
  let started = false;
  let chain: Promise<void> = Promise.resolve();
  const pollMs = opts.pollMs ?? 0;
  let timer: NodeJS.Timeout | undefined;

  async function reconcile(mode: 'watch' | 'recovery'): Promise<void> {
    const dir = path.join(opts.root, 'responses');
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (closed || !name.endsWith('.json') || name.startsWith('.')) continue;
      const current = readResponse(path.join(dir, name));
      if (!current || !isNonTerminal(current.status)) continue;
      const savedHash = savedContentHash(current.result);
      let plan: WatchedPlan | null = null;
      let previewConflicts: string[] = [];
      if (current.planId) {
        plan = await opts.ports.getPlan(current.planId);
        if (plan && (plan.status === 'draft' || plan.status === 'approved')) {
          try {
            const preview = await opts.ports.previewPlan(plan.planId);
            previewConflicts = preview?.items.flatMap((item) => item.conflicts ?? []) ?? [];
            if (preview && savedHash && preview.contentHash && preview.contentHash !== savedHash) {
              plan = { ...plan, contentHash: preview.contentHash };
            }
          } catch {
            previewConflicts = [];
          }
        }
      }
      const decision = decidePlanBridge({
        mode,
        currentStatus: current.status,
        savedHash,
        plan,
        previewConflicts,
      });
      const statuses = statusesToWrite(current.status, decision);
      let cursor = current;
      for (const status of statuses) {
        const terminal = status !== 'running';
        const next: BridgeResponse = {
          ...cursor,
          requestId: current.requestId,
          status: status as BridgeStatus,
          updatedAt: now().toISOString(),
          ...(current.planId ? { planId: current.planId } : {}),
          ...(current.ignoredFields ? { ignoredFields: current.ignoredFields } : {}),
          result: terminal ? (decision.result ?? cursor.result) : cursor.result,
        };
        if (status === 'conflict' && decision.suggestedAction) next.suggestedAction = decision.suggestedAction;
        else delete next.suggestedAction;
        if (terminal && decision.error && status !== 'success' && status !== 'awaiting_approval') next.error = decision.error;
        else delete next.error;
        writeResponse(opts.root, next);
        cursor = next;
      }
    }
  }

  async function syncOnce(): Promise<void> {
    if (closed) return;
    const mode = started ? 'watch' : 'recovery';
    started = true;
    chain = chain.then(() => reconcile(mode)).catch(() => undefined);
    await chain;
  }

  if (pollMs > 0) {
    timer = setInterval(() => void syncOnce(), pollMs);
    timer.unref?.();
  }

  return {
    syncOnce,
    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      await chain.catch(() => undefined);
    },
  };
}
