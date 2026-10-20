import fs from 'node:fs';
import path from 'node:path';
import type { WriteChannelSnapshot } from '../../../shared/aiWriteChannel';
import { isPlaybookDelivery, isPlaybookMount, isPlaybookRelation, type PlaybookEntryBlock, type PlaybookRelation, type PlaybookSnapshot } from '../../../shared/ctxPlaybook';
import { normalizeSkillSnapshot, type SkillSnapshotEntry } from '../../../shared/skillLibrary';
import type { AttentionSignal } from '../../../shared/agentMarks';
import type { AgentMaterial, LiveEntryWriter, LivePanel, LiveReading } from '../../../shared/agentLive/types';
import { atomicWriteFile, promoteCurrentEntry, promoteEntryFiles, readJson } from './atomic';
import { contentAbs, finishExtract, prepareMaterial, type IndexedExcerpt, type PreparedMaterial } from './content';
import {
  ENTRY_LIST_LIMIT,
  displayPanels,
  displayReading,
  navFiles,
  renderEntry,
  type EntryDoc,
  type EntryDocItem,
  type EntryRelation,
  type EntryTreeNode,
  type ManifestAction,
  type StructureNote,
} from './docs';
import type { LibraryTreeNode, LibraryTreeSnapshot } from './libraryTree';
import { buildSnapshot, snapshotJson } from './snapshot';
import { isContentBodyIndexEnabled } from '../../../shared/contentIndexScope';
import { EntryError, assertSafeId, isSecretPath, oneLine } from './text';

export interface EntryScene {
  workspaceName?: string;
  purpose?: string;
  panels?: LivePanel[];
  reading?: LiveReading | null;
  materials?: AgentMaterial[];
  /** 调用方交来的资料树。入口写入器不为此遍历磁盘。 */
  structure?: EntryTreeNode[];
  /** 资料根目录快照。原样追加进 snapshot.json，schemaVersion 保持 1。 */
  libraryTree?: LibraryTreeSnapshot;
  /** 特别关注。空则快照和入口都不写这一段。 */
  attention?: AttentionSignal[];
  /** AI 写入通道。空则快照和入口都不写这一段。高档去掉绝对路径。 */
  writeChannel?: WriteChannelSnapshot;
  /** 仅为 true 时写入快照和 ENTRY。 */
  skillDistill?: boolean;
  /** 已就绪 skill。空则不写入。调用方不要带路径。 */
  skills?: SkillSnapshotEntry[];
  /** 仅开启时由调用方放入。快照和 ENTRY 都用它，不含路径。 */
  playbook?: { snapshot: PlaybookSnapshot; entry: PlaybookEntryBlock };
  relations?: EntryRelation[];
}

export interface LiveEntryOptions {
  bridgeRoot: string;
  appVersion?: string;
  now?: () => Date;
  loadScene: (workspaceId: string, rev: number) => EntryScene | null | Promise<EntryScene | null>;
  /** 点查索引里已经提取的正文。没有就返回 null。禁止扫库。 */
  readIndexedText?: (material: AgentMaterial) => IndexedExcerpt | null | Promise<IndexedExcerpt | null>;
  /** 后台提取。render 不等它结束。 */
  extractText?: (material: AgentMaterial) => Promise<IndexedExcerpt | null>;
  /**
   * 一批正文落地后调用，由集成组再发一个版本。
   * 组 4 对哈希没变的 content.changed 不会升版，所以这里不要只发这种事件。
   */
  onContentReady?: (workspaceId: string, materialIds: string[]) => void;
  /** 为 true 时另外写 live/current/ENTRY.md，链接改成从 current 出发。 */
  isCurrent?: (workspaceId: string) => boolean;
  trace?: (step: string) => void;
}

export interface LiveEntryController extends LiveEntryWriter {
  /** 上次入口还在就立刻返回，并在后台 render。没有缓存时这次就写完。 */
  startup(workspaceId: string, rev: number): Promise<'cached' | 'rendered'>;
  cached(workspaceId: string): boolean;
  /** 等当前渲染和已经排上的正文提取。不等组 4 的防抖。 */
  whenIdle(): Promise<void>;
  entryPath(workspaceId: string): string;
  snapshotPath(workspaceId: string): string;
}

const STATUS = new Set(['ok', 'missing', 'unreadable']);

function normalizeMaterial(raw: AgentMaterial): AgentMaterial | null {
  if (!raw || typeof raw.materialId !== 'string' || typeof raw.absPath !== 'string') return null;
  try {
    assertSafeId(raw.materialId, 'materialId');
  } catch {
    return null;
  }
  const status = STATUS.has(raw.status) ? raw.status : 'ok';
  return {
    materialId: raw.materialId,
    resourceId: raw.resourceId ?? null,
    sourceId: raw.sourceId ?? null,
    relPath: typeof raw.relPath === 'string' ? raw.relPath : '',
    absPath: raw.absPath,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : path.basename(raw.absPath),
    purpose: typeof raw.purpose === 'string' ? raw.purpose : null,
    order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
    status,
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : null,
    contentVersion: typeof raw.contentVersion === 'number' && Number.isFinite(raw.contentVersion) ? raw.contentVersion : 0,
    readable: typeof raw.readable === 'string' ? raw.readable : null,
    addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : '',
    tier: raw.tier === 'pinned' ? 'pinned' : 'session',
    bytes: typeof raw.bytes === 'number' && Number.isFinite(raw.bytes) ? raw.bytes : null,
    estTokens: typeof raw.estTokens === 'number' && Number.isFinite(raw.estTokens) ? raw.estTokens : null,
    ...(typeof raw.hasText === 'boolean' ? { hasText: raw.hasText } : {}),
    ...(typeof raw.pages === 'number' && Number.isFinite(raw.pages) ? { pages: raw.pages } : {}),
    ...placeFields(raw),
  };
}

function placeFields(raw: AgentMaterial): Pick<AgentMaterial, 'slotId' | 'mount' | 'delivery' | 'summary' | 'relations'> {
  const out: Pick<AgentMaterial, 'slotId' | 'mount' | 'delivery' | 'summary' | 'relations'> = {};
  if (typeof raw.slotId === 'string' && raw.slotId.trim()) out.slotId = raw.slotId.trim();
  if (isPlaybookMount(raw.mount)) out.mount = raw.mount;
  if (isPlaybookDelivery(raw.delivery)) out.delivery = raw.delivery;
  if (typeof raw.summary === 'string' && raw.summary.trim()) out.summary = raw.summary.trim();
  if (Array.isArray(raw.relations)) {
    const relations: PlaybookRelation[] = [];
    for (const row of raw.relations) {
      if (!row || !isPlaybookRelation(row.type) || typeof row.targetId !== 'string' || !row.targetId.trim()) continue;
      relations.push({ type: row.type, targetId: row.targetId.trim() });
    }
    if (relations.length) out.relations = relations;
  }
  return out;
}

function byOrder(a: PreparedMaterial, b: PreparedMaterial): number {
  const delta = a.source.order - b.source.order;
  if (delta) return delta;
  return a.source.materialId < b.source.materialId ? -1 : a.source.materialId > b.source.materialId ? 1 : 0;
}

function directoryOverview(absPath: string): { text: string; fileCount: number } | undefined {
  try {
    const st = fs.statSync(absPath);
    if (!st.isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  try {
    const names = fs.readdirSync(absPath);
    const fileCount = names.length;
    const sample = names.slice(0, 8).join(', ');
    const more = fileCount > 8 ? ` 等共 ${fileCount} 项` : `（${fileCount} 项）`;
    const text = sample ? `${sample}${more}` : '空目录';
    return { text, fileCount };
  } catch {
    return { text: '未知', fileCount: -1 };
  }
}

function toDocItem(item: PreparedMaterial): EntryDocItem {
  const absPath = item.hidden ? '' : item.source.absPath;
  const overview = absPath ? directoryOverview(absPath) : undefined;
  return {
    materialId: item.source.materialId,
    name: item.hidden ? '（已隐藏）' : item.source.name,
    absPath,
    purpose: item.hidden ? null : item.source.purpose,
    status: item.source.status,
    readableLabel: overview ? '目录概览' : item.readableLabel,
    tier: item.tier,
    bytes: item.hidden ? null : (item.source.bytes ?? null),
    estTokens: item.hidden ? null : (item.source.estTokens ?? null),
    ...(overview ? { dirOverview: overview.text } : {}),
    ...(overview && overview.fileCount >= 0 ? { fileCount: overview.fileCount } : {}),
  };
}

function scrubPanels(panels: LivePanel[]): LivePanel[] {
  return panels.map((panel) =>
    isSecretPath(panel.absPath) || isSecretPath(panel.name) ? { ...panel, name: '（已隐藏）', absPath: '' } : panel,
  );
}

function scrubTree(nodes: EntryTreeNode[] | undefined): EntryTreeNode[] | undefined {
  if (!nodes) return undefined;
  const out: EntryTreeNode[] = [];
  for (const node of nodes) {
    if (isSecretPath(node.name) || isSecretPath(node.relPath) || isSecretPath(node.path)) continue;
    out.push({ ...node, ...(node.children ? { children: scrubTree(node.children) } : {}) });
  }
  return out;
}

function scrubLibraryNodes(nodes: LibraryTreeNode[]): LibraryTreeNode[] {
  const out: LibraryTreeNode[] = [];
  for (const node of nodes) {
    if (isSecretPath(node.name) || isSecretPath(node.relPath) || isSecretPath(node.path)) continue;
    out.push({ ...node, ...(node.children ? { children: scrubLibraryNodes(node.children) } : {}) });
  }
  return out;
}

function scrubWriteChannel(channel: WriteChannelSnapshot | undefined): WriteChannelSnapshot | undefined {
  if (!channel) return undefined;
  const inboxPath = channel.inboxPath?.trim();
  return {
    defaultTier: channel.defaultTier,
    folders: channel.folders.map((folder) => {
      if (folder.tier === 'high' || isSecretPath(folder.absPath)) {
        return { id: folder.id, name: folder.name, tier: folder.tier, virtualPath: folder.virtualPath, ...(folder.kind ? { kind: folder.kind } : {}) };
      }
      return folder;
    }),
    ...(inboxPath && !isSecretPath(inboxPath) ? { inboxPath } : {}),
  };
}

function scrubSkills(skills: SkillSnapshotEntry[] | undefined): SkillSnapshotEntry[] | undefined {
  const out = normalizeSkillSnapshot(skills);
  return out.length ? out : undefined;
}

function scrubAttention(marks: AttentionSignal[] | undefined): AttentionSignal[] | undefined {
  if (!marks?.length) return undefined;
  const out = marks.filter((mark) => mark && !isSecretPath(mark.absPath) && mark.text);
  return out.length ? out : undefined;
}

function scrubLibrary(tree: LibraryTreeSnapshot | undefined): LibraryTreeSnapshot | undefined {
  if (!tree) return undefined;
  return { ...tree, roots: scrubLibraryNodes(tree.roots) };
}

function treeNoteOf(tree: LibraryTreeSnapshot | undefined): StructureNote | undefined {
  if (!tree?.truncatedReason && !tree?.errors?.length) return undefined;
  return {
    ...(tree.truncatedReason ? { truncatedReason: tree.truncatedReason } : {}),
    ...(tree.errors?.length ? { errors: tree.errors } : {}),
  };
}

function buildDoc(
  workspaceId: string,
  revision: number,
  generatedAt: string,
  scene: EntryScene,
  items: PreparedMaterial[],
  pathStyle: EntryDoc['pathStyle'],
): EntryDoc {
  const session = items.filter((item) => item.tier !== 'pinned').sort(byOrder);
  const pinned = items.filter((item) => item.tier === 'pinned').sort(byOrder);
  const shown = [...session, ...pinned].slice(0, ENTRY_LIST_LIMIT);
  const shownIds = new Set(shown.map((item) => item.source.materialId));
  const panels = (Array.isArray(scene.panels) ? scene.panels : []).map((panel) => {
    if (isSecretPath(panel.absPath) || isSecretPath(panel.name)) {
      return { ...panel, name: '（已隐藏）', absPath: '' };
    }
    return panel;
  });
  const reading = scene.reading ?? null;
  const safeReading =
    reading && (isSecretPath(reading.absPath) || isSecretPath(reading.name))
      ? { ...reading, name: '（已隐藏）', absPath: '' }
      : reading;
  return {
    revision,
    generatedAt,
    workspaceId,
    workspaceName: oneLine(scene.workspaceName, 200) || workspaceId,
    ...(scene.purpose?.trim() ? { purpose: scene.purpose.trim() } : {}),
    panels: displayPanels(panels),
    reading: displayReading(safeReading),
    sessionShown: session.filter((item) => shownIds.has(item.source.materialId)).map(toDocItem),
    pinnedShown: pinned.filter((item) => shownIds.has(item.source.materialId)).map(toDocItem),
    sessionAll: session.map(toDocItem),
    pinnedAll: pinned.map(toDocItem),
    omitted: session.length + pinned.length - shown.length,
    pathStyle,
    ...(scene.attention?.length ? { attention: scene.attention } : {}),
    ...(scene.writeChannel ? { writeChannel: scene.writeChannel } : {}),
    ...(scene.skillDistill === true ? { skillDistill: true as const } : {}),
    ...(scene.playbook?.snapshot.enabled ? { playbook: scene.playbook.entry } : {}),
    ...(isContentBodyIndexEnabled() ? {} : { contentSearch: 'none' as const }),
  };
}

function readManifest(file: string): { found: boolean; broken: boolean; actions: ManifestAction[] } {
  if (!fs.existsSync(file)) return { found: false, broken: false, actions: [] };
  const parsed = readJson<{ capabilityDetails?: unknown }>(file);
  if (!parsed) return { found: true, broken: true, actions: [] };
  if (!Array.isArray(parsed.capabilityDetails)) return { found: true, broken: false, actions: [] };
  const actions: ManifestAction[] = [];
  for (const row of parsed.capabilityDetails) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (typeof record.name !== 'string' || !record.name.trim()) continue;
    actions.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      availability: typeof record.availability === 'string' ? record.availability : '',
      approvalRequired: record.approvalRequired === true,
    });
  }
  return { found: true, broken: false, actions };
}

export function createLiveEntryWriter(opts: LiveEntryOptions): LiveEntryController {
  return new EntryWriter(opts);
}

class EntryWriter implements LiveEntryController {
  private readonly bridgeRoot: string;
  private readonly appVersion: string;
  private readonly now: () => Date;
  private readonly opts: LiveEntryOptions;
  private tail: Promise<void> = Promise.resolve();
  private extractChain: Promise<void> = Promise.resolve();
  private readonly pending = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private extractLeft = 0;
  private pendingReady = new Map<string, string[]>();
  private closed = false;

  constructor(opts: LiveEntryOptions) {
    this.opts = opts;
    this.bridgeRoot = path.resolve(opts.bridgeRoot);
    this.appVersion = opts.appVersion?.trim() || '0.2.0';
    this.now = opts.now ?? (() => new Date());
  }

  render(workspaceId: string, rev: number): Promise<void> {
    this.assertOpen();
    assertSafeId(workspaceId, 'workspaceId');
    if (!Number.isInteger(rev) || rev < 0) throw new EntryError('bad_rev', 'revision 不是非负整数');
    this.pending.set(workspaceId, rev);
    const run = this.tail.then(() => this.drain(workspaceId));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async startup(workspaceId: string, rev: number): Promise<'cached' | 'rendered'> {
    this.assertOpen();
    assertSafeId(workspaceId, 'workspaceId');
    if (this.cached(workspaceId)) {
      void this.render(workspaceId, rev).catch(() => {
        this.opts.trace?.('startup-render-failed');
      });
      return 'cached';
    }
    await this.render(workspaceId, rev);
    return 'rendered';
  }

  cached(workspaceId: string): boolean {
    try {
      assertSafeId(workspaceId, 'workspaceId');
    } catch {
      return false;
    }
    const entry = this.entryPath(workspaceId);
    const snapshot = this.snapshotPath(workspaceId);
    if (!fs.existsSync(entry) || !fs.existsSync(snapshot)) return false;
    let fd: number | null = null;
    try {
      fd = fs.openSync(entry, 'r');
      const buf = Buffer.alloc(64);
      const n = fs.readSync(fd, buf, 0, 64, 0);
      return buf.subarray(0, n).toString('utf8').startsWith('<!-- kb-live schemaVersion=1 ');
    } catch {
      return false;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  async whenIdle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const tail = this.tail;
      const extracts = this.extractChain;
      await tail;
      await extracts;
      if (this.tail === tail && this.extractChain === extracts && this.extractLeft === 0 && this.pending.size === 0) return;
    }
  }

  entryPath(workspaceId: string): string {
    return path.join(this.wsDir(workspaceId), 'ENTRY.md');
  }

  snapshotPath(workspaceId: string): string {
    return path.join(this.wsDir(workspaceId), 'snapshot.json');
  }

  private assertOpen(): void {
    if (this.closed) throw new EntryError('closed', '入口写入器已关闭');
  }

  private wsDir(workspaceId: string): string {
    return path.join(this.bridgeRoot, 'live', 'ws', workspaceId);
  }

  private currentDir(): string {
    return path.join(this.bridgeRoot, 'live', 'current');
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async drain(workspaceId: string): Promise<void> {
    while (this.pending.has(workspaceId)) {
      const rev = this.pending.get(workspaceId)!;
      this.pending.delete(workspaceId);
      try {
        await this.renderOnce(workspaceId, rev);
      } catch (err) {
        if (this.pending.has(workspaceId)) continue;
        throw err;
      }
    }
  }

  private async renderOnce(workspaceId: string, rev: number): Promise<void> {
    const wsDir = this.wsDir(workspaceId);
    promoteEntryFiles(wsDir);
    if (this.opts.isCurrent?.(workspaceId)) promoteCurrentEntry(this.currentDir());
    const loaded = await this.opts.loadScene(workspaceId, rev);
    const scene: EntryScene = loaded ?? {};
    const panels = scrubPanels(Array.isArray(scene.panels) ? scene.panels : []);
    const libraryTree = scrubLibrary(scene.libraryTree);
    const attention = scrubAttention(scene.attention);
    const writeChannel = scrubWriteChannel(scene.writeChannel);
    const skills = scrubSkills(scene.skills);
    const skillDistill = scene.skillDistill === true;
    const safeScene: EntryScene = {
      ...scene,
      panels,
      structure: scrubTree(scene.structure),
      ...(libraryTree ? { libraryTree } : { libraryTree: undefined }),
      ...(attention ? { attention } : { attention: undefined }),
      ...(writeChannel ? { writeChannel } : { writeChannel: undefined }),
      ...(skillDistill ? { skillDistill: true } : { skillDistill: undefined }),
      ...(skills ? { skills } : { skills: undefined }),
    };
    const materials = (Array.isArray(scene.materials) ? scene.materials : [])
      .map((item) => normalizeMaterial(item))
      .filter((item): item is AgentMaterial => item !== null);
    const generatedAt = this.nowIso();
    const prepared: PreparedMaterial[] = [];
    for (const material of materials) {
      prepared.push(
        await prepareMaterial(material, {
          wsDir,
          nowIso: generatedAt,
          readIndexedText: this.opts.readIndexedText,
          inFlight: (materialId, hex) => this.inFlight.has(this.flightKey(workspaceId, materialId, hex)),
          scheduleExtract: this.opts.extractText
            ? (item, hex) => this.enqueueExtract(workspaceId, item, hex)
            : undefined,
        }),
      );
    }
    this.opts.trace?.('content');
    const manifest = readManifest(path.join(this.bridgeRoot, 'manifest.json'));
    const visible = prepared.filter((item) => !item.hidden);
    const nav = navFiles({
      nodes: safeScene.structure,
      treeNote: treeNoteOf(safeScene.libraryTree),
      materials: visible.map((item) => ({
        name: item.source.name,
        relPath: item.source.relPath,
        absPath: item.source.absPath,
        tier: item.tier,
        materialId: item.source.materialId,
        resourceId: item.source.resourceId,
      })),
      panels,
      extra: scene.relations,
      actions: manifest.actions,
      manifestFound: manifest.found,
      manifestBroken: manifest.broken,
    });
    for (const [rel, text] of Object.entries(nav)) {
      await atomicWriteFile(path.join(wsDir, rel), text.endsWith('\n') ? text : `${text}\n`);
    }
    this.opts.trace?.('nav');
    const snapshot = buildSnapshot({
      appVersion: this.appVersion,
      generatedAt,
      workspaceId,
      workspaceName: oneLine(scene.workspaceName, 200) || workspaceId,
      ...(scene.purpose?.trim() ? { purpose: scene.purpose.trim() } : {}),
      revision: rev,
      panels,
      reading: scene.reading ?? null,
      items: prepared,
      hidden: (value) => isSecretPath(value),
      ...(safeScene.libraryTree ? { libraryTree: safeScene.libraryTree } : {}),
      ...(safeScene.attention?.length ? { attention: safeScene.attention } : {}),
      ...(safeScene.writeChannel ? { writeChannel: safeScene.writeChannel } : {}),
      ...(safeScene.skillDistill ? { skillDistill: true } : {}),
      ...(safeScene.skills?.length ? { skills: safeScene.skills } : {}),
      ...(safeScene.playbook?.snapshot.enabled ? { playbook: safeScene.playbook.snapshot } : {}),
    });
    await atomicWriteFile(this.snapshotPath(workspaceId), snapshotJson(snapshot));
    this.opts.trace?.('snapshot');
    const entry = renderEntry(buildDoc(workspaceId, rev, generatedAt, safeScene, prepared, 'workspace'));
    await atomicWriteFile(this.entryPath(workspaceId), entry);
    this.opts.trace?.('entry');
    if (this.opts.isCurrent?.(workspaceId)) {
      const current = renderEntry(buildDoc(workspaceId, rev, generatedAt, safeScene, prepared, 'current'));
      await atomicWriteFile(path.join(this.currentDir(), 'ENTRY.md'), current);
      this.opts.trace?.('current-entry');
    }
  }

  private flightKey(workspaceId: string, materialId: string, hex: string): string {
    return `${workspaceId}\0${materialId}\0${hex}`;
  }

  private enqueueExtract(workspaceId: string, material: AgentMaterial, hex: string): void {
    const key = this.flightKey(workspaceId, material.materialId, hex);
    if (this.inFlight.has(key) || !this.opts.extractText) return;
    this.inFlight.add(key);
    this.extractLeft += 1;
    const extract = this.opts.extractText;
    this.extractChain = this.extractChain.then(async () => {
      try {
        if (this.closed) return;
        let excerpt: IndexedExcerpt | null = null;
        let failed = false;
        try {
          excerpt = await extract(material);
        } catch {
          failed = true;
        }
        const abs = contentAbs(this.wsDir(workspaceId), material.materialId, material.contentHash);
        if (abs && fs.existsSync(abs) && !failed) {
          this.noteReady(workspaceId, material.materialId);
          return;
        }
        await finishExtract(this.wsDir(workspaceId), material, hex, excerpt, this.nowIso(), failed);
        this.noteReady(workspaceId, material.materialId);
      } finally {
        this.inFlight.delete(key);
        this.extractLeft -= 1;
        if (this.extractLeft === 0) this.flushReady();
      }
    });
  }

  private noteReady(workspaceId: string, materialId: string): void {
    const list = this.pendingReady.get(workspaceId) ?? [];
    if (!list.includes(materialId)) list.push(materialId);
    this.pendingReady.set(workspaceId, list);
  }

  private flushReady(): void {
    if (this.extractLeft > 0) return;
    const batch = this.pendingReady;
    this.pendingReady = new Map();
    for (const [workspaceId, ids] of batch) {
      if (!ids.length) continue;
      try {
        this.opts.onContentReady?.(workspaceId, ids);
      } catch {
        /* 回调失败不回滚已经写好的正文 */
      }
    }
  }
}
