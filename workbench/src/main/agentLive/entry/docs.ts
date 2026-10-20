import type { WriteChannelSnapshot } from '../../../shared/aiWriteChannel';
import { renderPlaybookEntry, type PlaybookEntryBlock } from '../../../shared/ctxPlaybook';
import { SKILL_DISTILL_ENTRY_LINE } from '../../../shared/skillDistill';
import { WRITE_TIER_META } from '../../../shared/aiWriteChannel';
import type { AttentionSignal } from '../../../shared/agentMarks';
import { AGENT_LIVE_ACTIONS, LIVE_NAV, type LivePanel, type LiveReading } from '../../../shared/agentLive/types';
import { AGREEMENT, CURSOR_HINT, LIBRARY_READ_NOTE, STABILITY, UNTRUSTED, architectureMarkdown, guideMarkdown } from './templates';
import { oneLine } from './text';
import { formatTotal, tokenWarning, type TotalItem } from './tokens';

export const ENTRY_LIST_LIMIT = 50;
export const ENTRY_PANEL_LIMIT = 20;

export interface EntryDocItem extends TotalItem {
  materialId: string;
  name: string;
  absPath: string;
  purpose: string | null;
  status: string;
  readableLabel: string;
  tier: 'session' | 'pinned';
  /** 文件夹节点：目录概览，不假装读过正文 */
  dirOverview?: string;
  /** shallow child count; omit when unknown */
  fileCount?: number;
}


export interface EntryPanelView {
  name: string;
  absPath: string;
  panelId?: string;
  materialId?: string | null;
  resourceId?: string | null;
}

export interface EntryReadingView {
  name: string;
  absPath: string;
  panelId?: string;
  materialId?: string | null;
  resourceId?: string | null;
}

export interface EntryDoc {
  revision: number;
  generatedAt: string;
  workspaceId: string;
  workspaceName: string;
  purpose?: string;
  panels: EntryPanelView[];
  reading: EntryReadingView | null;
  sessionShown: EntryDocItem[];
  pinnedShown: EntryDocItem[];
  sessionAll: EntryDocItem[];
  pinnedAll: EntryDocItem[];
  omitted: number;
  pathStyle: 'workspace' | 'current';
  /** 特别关注。空则不渲染这一节。 */
  attention?: AttentionSignal[];
  /** AI 写入通道。空则不渲染第 7 节。 */
  writeChannel?: WriteChannelSnapshot;
  /** 蒸馏开启时在第 7 节末尾加一行。缺省不改原文。 */
  skillDistill?: boolean;
  /** 上下文剧本。缺省不写第 8 节，第 1–7 节字节不变。 */
  playbook?: PlaybookEntryBlock;
  /** 没有正文搜索时为 none。缺省不渲染，不改旧字段含义。 */
  contentSearch?: 'none';
}

export interface EntryTreeNode {
  name: string;
  relPath?: string;
  /** 资料根下的本机真实绝对路径。没有则这一行不标路径。 */
  path?: string;
  children?: EntryTreeNode[];
  kind?: 'dir' | 'file';
  /** 这一层列不完：超过深度，或条目预算在这里用尽。 */
  truncated?: boolean;
}

export interface StructureNote {
  truncatedReason?: string;
  errors?: { path: string; message: string }[];
}

export interface EntryRelation {
  label: string;
  members: string[];
}

export interface ManifestAction {
  name: string;
  description?: string;
  availability?: string;
  approvalRequired?: boolean;
}

const LIVE_ACTIONS: { id: string; approval: boolean }[] = [
  { id: AGENT_LIVE_ACTIONS.copyBridgeLink, approval: false },
  { id: AGENT_LIVE_ACTIONS.copyWorkspaceLink, approval: false },
  { id: AGENT_LIVE_ACTIONS.materialsAdd, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsRemove, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsReorder, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsSetPurpose, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsAddCurrent, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsAddSelection, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsPin, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsUnpin, approval: true },
  { id: AGENT_LIVE_ACTIONS.materialsClearSession, approval: true },
  { id: AGENT_LIVE_ACTIONS.getContent, approval: false },
  { id: AGENT_LIVE_ACTIONS.getDiff, approval: false },
];


function idSuffix(ids: { panelId?: string; materialId?: string | null; resourceId?: string | null }): string {
  const parts: string[] = [];
  if (ids.panelId) parts.push('panelId:' + oneLine(ids.panelId));
  if (ids.materialId) parts.push('materialId:' + oneLine(ids.materialId));
  if (ids.resourceId) parts.push('resourceId:' + oneLine(ids.resourceId));
  return parts.length ? (' · ' + parts.join(' · ')) : '';
}

function itemLine(item: EntryDocItem): string {
  const name = oneLine(item.name) || '未命名';
  const where = item.absPath ? oneLine(item.absPath) : '（无真实路径）';
  const purpose = item.purpose ? oneLine(item.purpose) : '未填写';
  if (item.dirOverview) {
    const count = typeof item.fileCount === 'number' ? ` · fileCount:${item.fileCount}` : '';
    return `- ${name} · ${where} · 用途：${purpose} · ${oneLine(item.status) || 'ok'} · 目录概览：${oneLine(item.dirOverview)}${count}`;
  }
  return `- ${name} · ${where} · 用途：${purpose} · ${oneLine(item.status) || 'ok'} · ${oneLine(item.readableLabel) || '内容生成中'}`;
}

function attentionBlock(marks: AttentionSignal[] | undefined): string[] {
  if (!marks?.length) return [];
  const lines = ['### 特别关注', ''];
  for (const mark of marks) {
    const where = mark.rebirth ? `R${mark.rebirth.no} · ${oneLine(mark.rebirth.title)} · B${mark.rebirth.blockIdx}` : oneLine(mark.absPath) || '（无路径）';
    const quote = oneLine(mark.text, 500);
    lines.push(`- ${where} · 行 ${mark.startLine}-${mark.endLine} · 偏移 ${mark.startOffset}-${mark.endOffset} · 原文：${quote}`);
  }
  return lines;
}

function sectionItems(title: string, shown: EntryDocItem[], all: EntryDocItem[]): string[] {
  const lines = [`### ${title}`, '', formatTotal(all), ''];
  if (!all.length) lines.push('（空）');
  else if (!shown.length) lines.push('（这一区的项都超出了入口的 50 项，见 snapshot.json）');
  else for (const item of shown) lines.push(itemLine(item));
  return lines;
}

/** 0.7 的六块，顺序固定。第一行是给 agent 对 marker 的版本注释。 */
export function renderEntry(doc: EntryDoc): string {
  const prefix = doc.pathStyle === 'current' ? `../ws/${doc.workspaceId}/` : '';
  const protocol = doc.pathStyle === 'current' ? '../../AGENT_START_HERE.md' : '../../../AGENT_START_HERE.md';
  const lines: string[] = [
    `<!-- kb-live schemaVersion=1 revision=${doc.revision} generatedAt=${doc.generatedAt} -->`,
    '',
    '# 现场入口',
    '',
    `权威数据是 snapshot.json 和 changes/。本文件只是渲染。冲突时以 marker.json 的 revision 和 json 为准。${STABILITY}`,
    '',
    '## 1. 工作区',
    '',
    `- 名称：${oneLine(doc.workspaceName) || doc.workspaceId}`,
    `- 用途：${doc.purpose ? oneLine(doc.purpose) : '未填写'}`,
    `- id：${doc.workspaceId}`,
  ];
  if (doc.contentSearch === 'none') lines.push('- 搜索：本软件只按文件名搜索（contentSearch: none）');
  lines.push(
    '',
    '## 2. 已打开的资料',
    '',
  );
  const panels = doc.panels.slice(0, ENTRY_PANEL_LIMIT);
  if (!doc.panels.length) lines.push('（没有已打开的资料）');
  else {
    for (const panel of panels) {
      const name = oneLine(panel.name) || '未命名';
      const where = panel.absPath ? oneLine(panel.absPath) : '（无真实路径）';
      lines.push(`- ${name} · ${where}${idSuffix(panel)}`);
    }
    if (doc.panels.length > ENTRY_PANEL_LIMIT) {
      lines.push(`另有 ${doc.panels.length - ENTRY_PANEL_LIMIT} 个面板只在 snapshot.json。`);
    }
  }
  lines.push('');
  if (!doc.reading) lines.push('当前阅读：无');
  else {
    const name = oneLine(doc.reading.name) || '未命名';
    const where = doc.reading.absPath ? oneLine(doc.reading.absPath) : '（无真实路径）';
    lines.push(`当前阅读：${name} · ${where}${idSuffix(doc.reading)}`);
  }
  lines.push('', '## 3. 工作资料', '');
  lines.push(...sectionItems('本轮资料', doc.sessionShown, doc.sessionAll));
  lines.push('');
  if(doc.pinnedAll.length) lines.push(...sectionItems('固定资料', doc.pinnedShown, doc.pinnedAll));
  const attention = attentionBlock(doc.attention);
  if (attention.length) lines.push('', ...attention);
  if (doc.omitted > 0) {
    lines.push('', `入口只列出前 ${ENTRY_LIST_LIMIT} 项。另有 ${doc.omitted} 项只在 snapshot.json。`);
  }
  const warn = tokenWarning([doc.sessionAll, doc.pinnedAll]);
  if (warn) lines.push('', warn);
  if (doc.sessionAll.length + doc.pinnedAll.length === 0) {
    lines.push('', '清单为空。仅了解基本现场和导航。');
  }
  lines.push(
    '',
    '## 4. 导航',
    '',
    `- 资料结构：${prefix}nav/structure.md`,
    `- 关联关系：${prefix}nav/relations.md`,
    `- 应用功能：${prefix}nav/actions.md`,
    `- 使用说明：${prefix}nav/guide.md`,
    `- 架构说明：${prefix}nav/architecture.md`,
    `- 请求协议：${protocol}`,
    '',
    LIBRARY_READ_NOTE,
    '',
    '## 5. 版本',
    '',
    `- revision：${doc.revision}`,
    `- 生成时间：${doc.generatedAt}`,
  );
  if (doc.pathStyle === 'current') {
    lines.push(
      '- 本目录 marker：marker.json',
      `- 工作区 marker：../ws/${doc.workspaceId}/marker.json`,
      `- 工作区变更索引：../ws/${doc.workspaceId}/changes/index.json`,
      `- 工作区快照：../ws/${doc.workspaceId}/snapshot.json`,
      '- 切换记录：changes/index.json',
    );
  } else {
    lines.push('- marker：marker.json', '- 变更索引：changes/index.json', '- 快照：snapshot.json');
  }
  lines.push('', '## 6. 接入约定', '', AGREEMENT, '', UNTRUSTED, '', CURSOR_HINT, '');
  const channel = writeChannelBlock(doc.writeChannel);
  if (doc.skillDistill === true) {
    if (!channel.length) channel.push('## 7. AI 写入通道', '');
    channel.push(SKILL_DISTILL_ENTRY_LINE);
  }
  if (channel.length) lines.push('', ...channel);
  if (doc.playbook) lines.push('', renderPlaybookEntry(doc.playbook));
  return lines.join('\n');
}

function writeChannelBlock(channel: WriteChannelSnapshot | undefined): string[] {
  if (!channel || (!channel.folders.length && !channel.defaultTier)) return [];
  const lines = ['## 7. AI 写入通道', '', `- 默认档位：${WRITE_TIER_META[channel.defaultTier].label}`];
  if (!channel.folders.length) lines.push('（链接区还没有文件夹或文件）');
  for (const folder of channel.folders) {
    const where = folder.tier === 'high' || !folder.absPath ? folder.virtualPath : `${folder.virtualPath} · ${oneLine(folder.absPath)}`;
    const kind = folder.kind === 'file' ? '文件' : '文件夹';
    lines.push(`- ${oneLine(folder.name) || folder.id} · ${WRITE_TIER_META[folder.tier].label} · ${WRITE_TIER_META[folder.tier].backup} · ${kind} · ${where}`);
  }
  if (channel.inboxPath) lines.push(`- 收件箱：${oneLine(channel.inboxPath)}`);
  return lines;
}

function cell(value: string): string {
  return oneLine(value, 180).replace(/\|/g, '/');
}

export function actionsMarkdown(actions: ManifestAction[], manifestFound: boolean, manifestBroken = false): string {
  const lines = ['# 应用功能', ''];
  if (!manifestFound) {
    lines.push('桥目录里还没有 manifest.json。下面先列出本功能冻结的 ActionId。manifest 放到桥根之后，这段改从 capabilityDetails 生成。');
  } else if (manifestBroken) {
    lines.push('manifest.json 这一轮没有解析成功。下一版会再读，不要把它当成损坏。下面仍列出冻结的 ActionId。');
  } else if (!actions.length) {
    lines.push('已读到 manifest.json，但 capabilityDetails 是空的。批准只在界面。');
  } else {
    lines.push('下面由 agent-bridge/manifest.json 的 capabilityDetails 生成。availability 不是 available 的项不要当成已经能用。批准只在界面。');
    lines.push('', '| 名称 | 说明 | 可用性 | 要批准 |', '| --- | --- | --- | --- |');
    for (const action of actions) {
      lines.push(
        `| ${cell(action.name)} | ${cell(action.description ?? '')} | ${cell(action.availability ?? '')} | ${action.approvalRequired ? '是' : '否'} |`,
      );
    }
  }
  lines.push(
    '',
    '## 现场资料的 ActionId',
    '',
    '界面上直接执行。经文件桥调用清单操作时要批准。取正文和取差异是只读，不要批准。',
    '',
    '| ActionId | 桥调用要批准 |',
    '| --- | --- |',
  );
  for (const action of LIVE_ACTIONS) lines.push(`| ${action.id} | ${action.approval ? '是' : '否'} |`);
  lines.push('');
  return lines.join('\n');
}

function treeDir(node: EntryTreeNode): boolean {
  if (node.kind === 'dir') return true;
  if (node.kind === 'file') return false;
  return Boolean(node.children?.length);
}

function byTreeName(a: EntryTreeNode, b: EntryTreeNode): number {
  const dir = Number(treeDir(b)) - Number(treeDir(a));
  if (dir) return dir;
  return (a.name || '').localeCompare(b.name || '', 'zh-CN', { numeric: true });
}

function reasonLabel(reason: string): string {
  if (reason === 'depth') return '超过深度限制';
  if (reason === 'entries') return '超过条目限制';
  if (reason === 'depth+entries') return '超过深度限制、超过条目限制';
  return oneLine(reason) || '已截断';
}

function treeLine(node: EntryTreeNode, depth: number): string {
  const pad = '  '.repeat(Math.min(depth, 8));
  const name = oneLine(node.name) || '未命名';
  const mark = node.truncated ? ' （已截断）' : '';
  const where = node.path ? oneLine(node.path) : '';
  const title = where && treeDir(node) ? `${name}/${mark}` : `${name}${mark}`;
  return where ? `${pad}- ${title} · ${where}` : `${pad}- ${title}`;
}

export function structureMarkdown(
  nodes: EntryTreeNode[] | undefined,
  materials: { name: string; relPath: string }[],
  note?: StructureNote,
): string {
  const lines = [
    '# 资料结构',
    '',
    '生成时没有读取正文。',
    '',
  ];
  if (nodes === undefined) {
    lines.push('这次没有交来资料树快照。工作资料的路径见下面和 snapshot.json。');
  } else {
    if (note?.truncatedReason) lines.push(`资料树已截断：${reasonLabel(note.truncatedReason)}。`, '');
    lines.push(LIBRARY_READ_NOTE, '');
    if (!nodes.length) {
      lines.push('资料根目录里没有可列出的条目。');
    } else {
      let count = 0;
      let truncated = false;
      const walk = (list: EntryTreeNode[], depth: number): void => {
        const ordered = [...list].sort(byTreeName);
        for (const node of ordered) {
          if (count >= 500) {
            truncated = true;
            return;
          }
          count += 1;
          lines.push(treeLine(node, depth));
          if (node.children?.length && depth < 8) walk(node.children, depth + 1);
          if (truncated) return;
        }
      };
      walk(nodes, 0);
      if (truncated) lines.push('快照节点较多，这里只列了前 500 个。');
    }
    if (note?.errors?.length) {
      lines.push('', '以下目录读取失败，已跳过：');
      for (const err of note.errors.slice(0, 20)) {
        lines.push(`- ${oneLine(err.path) || '.'} · ${oneLine(err.message) || 'read-failed'}`);
      }
      if (note.errors.length > 20) lines.push(`另有 ${note.errors.length - 20} 个只在 snapshot.json。`);
    }
  }
  lines.push('', '## 工作资料路径', '');
  if (!materials.length) lines.push('（没有工作资料）');
  else {
    for (const material of materials) {
      lines.push(`- ${oneLine(material.name) || '未命名'} · ${oneLine(material.relPath) || '（无相对路径）'}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export interface RelationMaterial {
  name: string;
  relPath: string;
  absPath: string;
  tier: 'session' | 'pinned';
  materialId: string;
  resourceId: string | null;
}

function parentOf(rel: string): string {
  const norm = rel.replace(/\\/g, '/').replace(/\/+$/, '');
  const at = norm.lastIndexOf('/');
  return at <= 0 ? '（顶层）' : norm.slice(0, at);
}

export function relationsMarkdown(
  materials: RelationMaterial[],
  panels: LivePanel[],
  extra: EntryRelation[] | undefined,
): string {
  const lines = [
    '# 关联关系',
    '',
    '关联只从本轮工作资料、固定资料、已打开面板，以及调用方交来的关系推导。这里不扫描资料库。',
    '',
    '## 同一目录',
    '',
  ];
  const groups = new Map<string, string[]>();
  for (const material of materials) {
    const key = parentOf(material.relPath || material.absPath);
    const list = groups.get(key) ?? [];
    list.push(oneLine(material.name) || material.materialId);
    groups.set(key, list);
  }
  if (!groups.size) lines.push('（没有工作资料）');
  else {
    for (const [dir, names] of groups) {
      lines.push(`- ${oneLine(dir)}`);
      for (const name of names) lines.push(`  - ${name}`);
    }
  }
  lines.push('', '## 打开的面板指向', '');
  if (!panels.length) lines.push('（没有已打开的面板）');
  else {
    for (const panel of panels) {
      const hit = materials.find(
        (material) =>
          (panel.materialId && material.materialId === panel.materialId) ||
          (panel.resourceId && material.resourceId === panel.resourceId) ||
          (panel.absPath && material.absPath === panel.absPath),
      );
      const name = oneLine(panel.name) || panel.panelId;
      lines.push(`- ${oneLine(panel.panelId)} · ${name}${hit ? ` → ${oneLine(hit.name) || hit.materialId}` : ''}`);
    }
  }
  lines.push('', '## 两区', '');
  const session = materials.filter((material) => material.tier !== 'pinned').map((material) => oneLine(material.name) || material.materialId);
  const pinned = materials.filter((material) => material.tier === 'pinned').map((material) => oneLine(material.name) || material.materialId);
  lines.push(`- 本轮资料：${session.length ? session.join('、') : '（空）'}`);
  lines.push(`- 固定资料：${pinned.length ? pinned.join('、') : '（空）'}`);
  if (extra?.length) {
    lines.push('', '## 调用方交来的关系', '');
    for (const relation of extra) {
      lines.push(`- ${oneLine(relation.label) || '未命名'}`);
      for (const member of relation.members) lines.push(`  - ${oneLine(member)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export function navFiles(input: {
  nodes: EntryTreeNode[] | undefined;
  materials: RelationMaterial[];
  panels: LivePanel[];
  extra: EntryRelation[] | undefined;
  actions: ManifestAction[];
  manifestFound: boolean;
  manifestBroken?: boolean;
  treeNote?: StructureNote;
}): Record<(typeof LIVE_NAV)[keyof typeof LIVE_NAV], string> {
  return {
    [LIVE_NAV.structure]: structureMarkdown(input.nodes, input.materials, input.treeNote),
    [LIVE_NAV.relations]: relationsMarkdown(input.materials, input.panels, input.extra),
    [LIVE_NAV.actions]: actionsMarkdown(input.actions, input.manifestFound, input.manifestBroken),
    [LIVE_NAV.guide]: guideMarkdown(),
    [LIVE_NAV.architecture]: architectureMarkdown(),
  };
}

export function displayPanels(panels: LivePanel[]): EntryPanelView[] {
  return panels.map((panel) => ({
    name: panel.name || panel.panelId,
    absPath: panel.absPath || '',
    panelId: panel.panelId,
    ...(panel.materialId != null && panel.materialId !== '' ? { materialId: panel.materialId } : {}),
    ...(panel.resourceId != null && panel.resourceId !== '' ? { resourceId: panel.resourceId } : {}),
  }));
}

export function displayReading(reading: LiveReading | null): EntryReadingView | null {
  if (!reading) return null;
  if (!reading.name && !reading.absPath && !reading.materialId && !reading.resourceId && !reading.panelId) return null;
  return {
    name: reading.name || reading.materialId || reading.resourceId || reading.panelId || '未命名',
    absPath: reading.absPath || '',
    ...(reading.panelId ? { panelId: reading.panelId } : {}),
    ...(reading.materialId != null && reading.materialId !== '' ? { materialId: reading.materialId } : {}),
    ...(reading.resourceId != null && reading.resourceId !== '' ? { resourceId: reading.resourceId } : {}),
  };
}
