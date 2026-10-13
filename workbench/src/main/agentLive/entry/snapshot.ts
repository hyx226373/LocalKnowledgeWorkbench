import { LIVE_NAV, type AgentMaterial, type LivePanel, type LiveReading, type LiveSnapshot } from '../../../shared/agentLive/types';
import type { ContentStatus, PreparedMaterial } from './content';

export interface SnapshotMaterial extends AgentMaterial {
  tier: 'session' | 'pinned';
  contentStatus: ContentStatus;
}

export interface BuiltSnapshot extends LiveSnapshot {
  sessionMaterials: SnapshotMaterial[];
  pinnedMaterials: SnapshotMaterial[];
}

function redactPanel(panel: LivePanel, hidden: (value: string | undefined) => boolean): LivePanel {
  if (!hidden(panel.absPath) && !hidden(panel.name)) return panel;
  return {
    panelId: panel.panelId,
    materialId: panel.materialId,
    resourceId: panel.resourceId,
    name: '（已隐藏）',
    absPath: '',
  };
}

function redactReading(reading: LiveReading | null, hidden: (value: string | undefined) => boolean): LiveReading | null {
  if (!reading) return null;
  if (!hidden(reading.absPath) && !hidden(reading.name)) return reading;
  return {
    panelId: reading.panelId,
    materialId: reading.materialId,
    resourceId: reading.resourceId,
    name: '（已隐藏）',
    absPath: '',
  };
}

function toMaterial(item: PreparedMaterial): SnapshotMaterial {
  const source = item.source;
  const out: SnapshotMaterial = {
    materialId: source.materialId,
    tier: item.tier,
    resourceId: item.hidden ? null : (source.resourceId ?? null),
    sourceId: item.hidden ? null : (source.sourceId ?? null),
    relPath: item.hidden ? '' : source.relPath,
    absPath: item.hidden ? '' : source.absPath,
    name: item.hidden ? '（已隐藏）' : source.name,
    purpose: source.purpose ?? null,
    order: source.order,
    status: source.status,
    contentHash: item.hidden ? null : source.contentHash,
    contentVersion: source.contentVersion,
    readable: item.hidden ? null : item.readableRel,
    addedAt: source.addedAt,
    bytes: item.hidden ? null : (source.bytes ?? null),
    estTokens: item.hidden ? null : (source.estTokens ?? null),
    contentStatus: item.contentStatus,
  };
  if (typeof item.hasText === 'boolean') out.hasText = item.hasText;
  else if (typeof source.hasText === 'boolean') out.hasText = source.hasText;
  if (item.pages !== null && item.pages !== undefined) out.pages = item.pages;
  else if (!item.hidden && typeof source.pages === 'number') out.pages = source.pages;
  return out;
}

export function buildSnapshot(input: {
  appVersion: string;
  generatedAt: string;
  workspaceId: string;
  workspaceName: string;
  purpose?: string;
  revision: number;
  panels: LivePanel[];
  reading: LiveReading | null;
  items: PreparedMaterial[];
  hidden: (value: string | undefined) => boolean;
}): BuiltSnapshot {
  const materials = input.items.map(toMaterial);
  const sessionMaterials = materials.filter((item) => item.tier !== 'pinned');
  const pinnedMaterials = materials.filter((item) => item.tier === 'pinned');
  const sections = ['workspace'];
  if (input.purpose) sections.push('purpose');
  sections.push('panels', 'reading', 'materials', 'sessionMaterials', 'pinnedMaterials', 'nav');
  const snapshot: BuiltSnapshot = {
    schemaVersion: 1,
    appVersion: input.appVersion,
    generatedAt: input.generatedAt,
    sections,
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    revision: input.revision,
    panels: input.panels.map((panel) => redactPanel(panel, input.hidden)),
    reading: redactReading(input.reading, input.hidden),
    materials,
    sessionMaterials,
    pinnedMaterials,
    nav: { ...LIVE_NAV },
  };
  if (input.purpose) snapshot.purpose = input.purpose;
  return snapshot;
}

export function snapshotJson(snapshot: BuiltSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
