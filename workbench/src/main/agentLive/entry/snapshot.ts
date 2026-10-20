import type { WriteChannelSnapshot } from '../../../shared/aiWriteChannel';
import type { PlaybookSnapshot } from '../../../shared/ctxPlaybook';
import { normalizeSkillSnapshot, type SkillSnapshotEntry } from '../../../shared/skillLibrary';
import type { AttentionSignal } from '../../../shared/agentMarks';
import { LIVE_NAV, type AgentMaterial, type LivePanel, type LiveReading, type LiveSnapshot } from '../../../shared/agentLive/types';
import type { ContentStatus, PreparedMaterial } from './content';
import type { LibraryTreeSnapshot } from './libraryTree';

export interface SnapshotMaterial extends AgentMaterial {
  tier: 'session' | 'pinned';
  contentStatus: ContentStatus;
}

export interface BuiltSnapshot extends LiveSnapshot {
  sessionMaterials: SnapshotMaterial[];
  pinnedMaterials: SnapshotMaterial[];
  /** 资料根目录文件名树。schemaVersion 仍是 1，只追加这个字段。 */
  libraryTree?: LibraryTreeSnapshot;
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
  if (source.slotId) out.slotId = source.slotId;
  if (source.mount) out.mount = source.mount;
  if (source.delivery) out.delivery = source.delivery;
  if (source.summary) out.summary = source.summary;
  if (source.relations?.length) out.relations = source.relations.map((row) => ({ type: row.type, targetId: row.targetId }));
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
  libraryTree?: LibraryTreeSnapshot;
  /** 特别关注。空数组不写入，避免改已有快照的 sections。 */
  attention?: AttentionSignal[];
  /** AI 写入通道。缺省不写入，避免改已有快照的 sections。 */
  writeChannel?: WriteChannelSnapshot;
  /** 仅为 true 时写入。缺省不改已有快照。 */
  skillDistill?: boolean;
  /** 非空才写入，并且排在 writeChannel 之后。条目不含路径。 */
  skills?: readonly SkillSnapshotEntry[];
  /** 仅开启时写入，排在 skills 之后。不含路径。 */
  playbook?: PlaybookSnapshot;
}): BuiltSnapshot {
  const materials = input.items.map(toMaterial);
  const sessionMaterials = materials.filter((item) => item.tier !== 'pinned');
  const pinnedMaterials = materials.filter((item) => item.tier === 'pinned');
  const sections = ['workspace'];
  if (input.purpose) sections.push('purpose');
  sections.push('panels', 'reading', 'materials', 'sessionMaterials', 'pinnedMaterials', 'nav');
  if (input.libraryTree) sections.push('libraryTree');
  const attention = (input.attention ?? []).filter((mark) => (mark.absPath || mark.rebirth) && mark.text);
  if (attention.length) sections.push('attention');
  const writeChannel = input.writeChannel?.folders?.length || input.writeChannel?.defaultTier ? input.writeChannel : undefined;
  if (writeChannel) sections.push('writeChannel');
  const skills = normalizeSkillSnapshot(input.skills);
  if (skills.length) sections.push('skills');
  if (input.playbook?.enabled) sections.push('playbook');
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
    ...(input.libraryTree ? { libraryTree: input.libraryTree } : {}),
    ...(attention.length ? { attention } : {}),
    ...(writeChannel ? { writeChannel } : {}),
    ...(input.skillDistill === true ? { skillDistill: true } : {}),
    ...(skills.length ? { skills } : {}),
    ...(input.playbook?.enabled ? { playbook: input.playbook } : {}),
  };
  if (input.purpose) snapshot.purpose = input.purpose;
  return snapshot;
}

export function snapshotJson(snapshot: BuiltSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
