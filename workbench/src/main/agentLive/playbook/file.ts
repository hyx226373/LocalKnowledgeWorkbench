/**
 * <bridge>/live/ws/<workspaceId>/playbook.json。
 * 缺文件等于关。坏 JSON 不覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  applyPlaybookPatch,
  disabledPlaybook,
  isPlaybookDelivery,
  isPlaybookMount,
  type CtxPlaybookPatch,
  type CtxPlaybookState,
  type PlaybookMode,
  type PlaybookSlot,
  type BuiltinPreset,
  type PlaybookTrace,
} from '../../../shared/ctxPlaybook';
import { assertWorkspaceId } from '../materials/errors';
import { atomicWriteSync } from '../materials/persist';

const KNOWN = new Set(['enabled', 'mode', 'templateId', 'mission', 'budgetTokens', 'slots', 'traces', 'manualIds']);

export function playbookFile(bridgeRoot: string, workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(path.resolve(bridgeRoot), 'live', 'ws', workspaceId, 'playbook.json');
}

export type PlaybookRead =
  | { ok: true; state: CtxPlaybookState; raw: Record<string, unknown> }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'invalid' };

function asMode(value: unknown): PlaybookMode {
  return value === 'custom' || value === 'authored' || value === 'preset' ? value : 'preset';
}

function parseSlots(value: unknown): PlaybookSlot[] | null {
  if (!Array.isArray(value)) return null;
  const out: PlaybookSlot[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const rec = row as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    if (!/^[A-Za-z][A-Za-z0-9-]{0,40}$/.test(id) || !name) return null;
    if (!isPlaybookMount(rec.mount) || !isPlaybookDelivery(rec.delivery)) return null;
    const order = typeof rec.order === 'number' && Number.isFinite(rec.order) ? rec.order : out.length;
    const prompt = typeof rec.prompt === 'string' ? rec.prompt : '';
    out.push({
      id,
      name,
      mount: rec.mount,
      delivery: rec.delivery,
      prompt,
      ...(rec.required === true ? { required: true } : {}),
      order,
    });
  }
  return out;
}

function parseTraces(value: unknown): PlaybookTrace[] {
  if (!Array.isArray(value)) return [];
  const out: PlaybookTrace[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const rec = row as Record<string, unknown>;
    const item = {
      id: typeof rec.id === 'string' ? rec.id : '',
      req: typeof rec.req === 'string' ? rec.req : '',
      materialId: typeof rec.materialId === 'string' ? rec.materialId : '',
      check: typeof rec.check === 'string' ? rec.check : '',
    };
    if (!item.id && !item.req && !item.materialId && !item.check) continue;
    out.push(item);
  }
  return out;
}

function parseManual(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of value) {
    if (typeof id !== 'string') continue;
    const clean = id.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

export function normalizePlaybook(raw: unknown): CtxPlaybookState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const slots = parseSlots(rec.slots);
  if (!slots?.length) return null;
  const templateId = typeof rec.templateId === 'string' && rec.templateId.trim() ? rec.templateId.trim() : 'code-change';
  const mission = typeof rec.mission === 'string' ? rec.mission : '';
  const budget = typeof rec.budgetTokens === 'number' && Number.isFinite(rec.budgetTokens) ? Math.round(rec.budgetTokens) : 8000;
  return {
    enabled: rec.enabled === true,
    mode: asMode(rec.mode),
    templateId,
    mission,
    budgetTokens: budget >= 1 && budget <= 1_000_000 ? budget : 8000,
    slots,
    traces: parseTraces(rec.traces),
    manualIds: parseManual(rec.manualIds),
  };
}

export function readPlaybook(file: string): PlaybookRead {
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  let rawText = '';
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const state = normalizePlaybook(parsed);
  if (!state || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'invalid' };
  return { ok: true, state, raw: parsed as Record<string, unknown> };
}

export function writePlaybook(file: string, state: CtxPlaybookState, raw: Record<string, unknown> = {}): void {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (KNOWN.has(key) || key === 'schemaVersion') continue;
    extras[key] = value;
  }
  const body = {
    ...extras,
    enabled: state.enabled === true,
    mode: state.mode,
    templateId: state.templateId,
    mission: state.mission,
    budgetTokens: state.budgetTokens,
    slots: state.slots,
    traces: state.traces,
    manualIds: state.manualIds,
  };
  atomicWriteSync(file, `${JSON.stringify(body, null, 2)}\n`);
}

export function savedPlaybook(
  file: string,
  patch: CtxPlaybookPatch,
  catalog?: readonly BuiltinPreset[],
): { state: CtxPlaybookState; removedSlotIds: string[] } {
  const loaded = readPlaybook(file);
  if (!loaded.ok && loaded.reason === 'invalid') throw new Error('剧本文件无法读取，未覆盖');
  const current = loaded.ok ? loaded.state : null;
  const raw = loaded.ok ? loaded.raw : {};
  const next = applyPlaybookPatch(current, patch, catalog);
  writePlaybook(file, next.state, raw);
  return next;
}

export function viewPlaybook(file: string): CtxPlaybookState {
  const loaded = readPlaybook(file);
  if (!loaded.ok) return disabledPlaybook();
  return loaded.state;
}
