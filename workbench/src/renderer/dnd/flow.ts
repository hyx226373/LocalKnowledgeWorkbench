import { MENU_REMOVE_FOLDER, MENU_REMOVE_WORKSPACE, WILL_MOVE_FILE } from './copy';
import { joinRel, uniqueName } from './names';
import { ROOT_ORDER_KEY, rootOrderValue } from './rootOrder';
import type { AgentRefDrop, CopyReviewOp, DropDecision, MoveOp } from './types';

export interface ProposedMove {
  kind: 'move';
  resourceId: string;
  toRelPath: string;
  toRootId?: string;
}

export interface PlanEcho {
  planId: string;
  contentHash: string;
  ops: { opId: string }[];
}

export interface MoveDialogModel {
  title: string;
  body: string;
  lines: string[];
  crossRoot: boolean;
  nameClash: boolean;
  count: number;
  totalBytes: number;
}

export interface FlowPorts {
  propose(title: string, ops: ProposedMove[]): Promise<PlanEcho>;
  approve(planId: string, opIds: string[], contentHash: string): Promise<void>;
  getLayout(key: string): Promise<unknown>;
  setLayout(key: string, value: unknown): Promise<void>;
  addWorkspaceRefs(workspaceId: string, resourceIds: string[]): Promise<void>;
  removeWorkspaceRef(workspaceId: string, resourceId: string): Promise<void>;
  open(resourceId: string, place: 'tab' | 'left' | 'right' | 'up' | 'down' | 'float'): Promise<void>;
  confirmMove(model: MoveDialogModel): Promise<'move' | 'rename' | 'cancel'>;
  confirm(title: string, body: string, ok: string): Promise<boolean>;
  alert(title: string, body: string): Promise<void>;
  /** 同名探测。渲染进程只读，不写盘。 */
  childNames?(rootId: string, relPath: string): Promise<string[]>;
  closePanels?(resourceId: string): Promise<void>;
  isDirty?(resourceId: string): boolean;
  otherWorkspaceNames?(resourceId: string): Promise<string[]>;
  /** E 未合入时可以没有 */
  dualDbCheck?(): Promise<unknown>;
  /** C 的归类 IPC。不要用 setLayout 写 library.vfolderRefs。 */
  listMembership?(resourceId: string): Promise<string[]>;
  setMembership?(resourceId: string, folderIds: string[]): Promise<unknown>;
  removeMembership?(resourceId: string, folderId: string | null): Promise<unknown>;
  planDrop?(ops: CopyReviewOp[]): Promise<unknown>;
  agentRepoMove?(to: string): Promise<unknown>;
  reorderMaterials?(workspaceId: string, ids: string[]): Promise<unknown>;
  addCategory?(categoryId: string, workspaceId: string): Promise<unknown>;
  addAgentRefs?(workspaceId: string, refs: AgentRefDrop[]): Promise<unknown>;
  linkPaths?(workspaceId: string, paths: string[]): Promise<unknown>;
  openReadonly?(path: string): Promise<unknown>;
}

export type FlowResult = { status: 'done' | 'cancel' | 'rejected'; message: string };

function uniqIds(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => !!id))];
}

function withRenames(ops: MoveOp[], taken: Set<string>): MoveOp[] {
  const used = new Set(taken);
  return ops.map((op) => {
    const name = uniqueName(used, op.name);
    used.add(name);
    const dir = op.toRelPath.includes('/') ? op.toRelPath.slice(0, op.toRelPath.lastIndexOf('/')) : '';
    return { ...op, name, toRelPath: joinRel(dir, name) };
  });
}

export function moveDialogModel(ops: MoveOp[], crossRoot: boolean, nameClash: boolean, refNote: string): MoveDialogModel {
  const totalBytes = ops.reduce((n, o) => n + (o.size || 0), 0);
  const lines = ops.map((o) => `${o.fromRelPath || o.name} → ${o.toRelPath}${o.fromRootId !== o.toRootId ? '（跨根）' : ''}`);
  return {
    title: WILL_MOVE_FILE,
    body: [`${WILL_MOVE_FILE}。确认后才会执行，可在操作记录里撤销。`, crossRoot ? '这次移动跨过不同的根。' : '', refNote, '同名不覆盖。', nameClash ? '目标里已有同名，可以改名为 (2) 再移动，或取消。' : '']
      .filter(Boolean)
      .join('\n'),
    lines,
    crossRoot,
    nameClash,
    count: ops.length,
    totalBytes,
  };
}

export async function performDrop(decision: DropDecision, ports: FlowPorts): Promise<FlowResult> {
  const a = decision.action;
  if (a.type === 'reject') {
    return { status: 'rejected', message: a.reason };
  }
  try {
  if (a.type === 'open') {
    const place = a.place === 'center' || a.place === 'tab' ? 'tab' : a.place;
    for (const id of a.resourceIds) await ports.open(id, place);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'add-ref') {
    await ports.addWorkspaceRefs(a.workspaceId, a.resourceIds);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'reorder-roots') {
    await ports.setLayout(ROOT_ORDER_KEY, rootOrderValue(a.ids));
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'classify-add' || a.type === 'classify-shift') {
    if (!ports.setMembership) throw new Error('没有自建目录归类接口');
    for (let i = 0; i < a.resourceIds.length; i++) {
      const id = a.resourceIds[i];
      const current = ports.listMembership ? await ports.listMembership(id) : [];
      let next: string[];
      if (a.type === 'classify-add') next = a.alsoRemoveOtherFolders ? [a.folderId] : uniqIds([...current, a.folderId]);
      else if (a.copy) next = uniqIds([...current, a.folderId]);
      else next = uniqIds([...current.filter((f) => f !== a.sourceFolderIds[i]), a.folderId]);
      await ports.setMembership(id, next);
    }
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'copy-review') {
    if (ports.planDrop) await ports.planDrop(a.ops);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'agent-repo-move') {
    if (ports.agentRepoMove) await ports.agentRepoMove(a.to);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'reorder-materials') {
    if (ports.reorderMaterials) await ports.reorderMaterials(a.workspaceId, a.ids);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'add-category') {
    if (ports.addCategory) await ports.addCategory(a.categoryId, a.workspaceId);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'add-agent') {
    if (ports.addAgentRefs) await ports.addAgentRefs(a.workspaceId, a.refs);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'link-paths') {
    if (ports.linkPaths) await ports.linkPaths(a.workspaceId, a.paths);
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'open-readonly') {
    if (ports.openReadonly) {
      for (const p of a.paths) await ports.openReadonly(p);
    }
    return { status: 'done', message: decision.hint };
  }
  if (a.type === 'move') {
    let ops = a.ops;
    if (ops.length) {
      const names = new Set(ports.childNames ? await ports.childNames(ops[0].toRootId, parentOf(ops[0].toRelPath)) : []);
      if (batchClashes(ops, names)) {
        const choice = await ports.confirmMove(moveDialogModel(ops, a.crossRoot, true, await refNote(ports, ops)));
        if (choice !== 'rename') return { status: 'cancel', message: '目标已有同名，未覆盖' };
        ops = withRenames(ops, names);
      }
    }
    const note = await refNote(ports, ops);
    const proposed = await ports.propose(
      WILL_MOVE_FILE,
      ops.map((o: MoveOp) => ({
        kind: 'move' as const,
        resourceId: o.resourceId,
        toRelPath: o.toRelPath,
        ...(o.toRootId !== o.fromRootId ? { toRootId: o.toRootId } : {}),
      })),
    );
    const model = moveDialogModel(ops, ops.some((o: MoveOp) => o.fromRootId !== o.toRootId), false, note);
    const go = await ports.confirmMove(model);
    if (go !== 'move') return { status: 'cancel', message: '已取消，未批准计划' };
    try {
      await ports.approve(proposed.planId, proposed.ops.map((o: { opId: string }) => o.opId), proposed.contentHash);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await ports.alert('移动没有完成', message);
      return { status: 'rejected', message };
    }
    if (ports.dualDbCheck) {
      try {
        await ports.dualDbCheck();
      } catch {
        /* E 未合入或检查失败：不回滚已批准的移动，由 REPORT 标待补 */
      }
    }
    return { status: 'done', message: `${WILL_MOVE_FILE}：${ops.length} 项` };
  }
  return { status: 'done', message: decision.hint };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await ports.alert('没有完成', message);
    return { status: 'rejected', message };
  }
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

/** 目标里已有同名，或这一批里自己重名。 */
function batchClashes(ops: MoveOp[], existing: Set<string>): boolean {
  const seen = new Set(existing);
  for (const o of ops) {
    if (seen.has(o.name)) return true;
    seen.add(o.name);
  }
  return false;
}

async function refNote(ports: FlowPorts, ops: MoveOp[]): Promise<string> {
  const bits: string[] = [];
  if (ports.otherWorkspaceNames) {
    const names = new Set<string>();
    for (const o of ops) for (const n of await ports.otherWorkspaceNames(o.resourceId)) names.add(n);
    if (names.size) bits.push(`仍被这些工作区引用（引用跟着 resourceId，面板不关闭）：${[...names].join('、')}`);
  }
  bits.push('全局自建目录里的归类按 resourceId 保留。已打开的面板不关闭。');
  return bits.join('\n');
}

export async function removeFromFolderFlow(ports: FlowPorts, folderId: string | null, resourceId: string, name: string): Promise<FlowResult> {
  const ok = await ports.confirm(
    `${MENU_REMOVE_FOLDER}「${name}」？`,
    '只解除它在这个自建目录里的归类。不关闭已打开的面板，不删除、不移动原文件。其他自建目录和各工作区里的引用都保留。',
    MENU_REMOVE_FOLDER,
  );
  if (!ok) return { status: 'cancel', message: '已取消' };
  if (!ports.removeMembership) throw new Error('没有自建目录归类接口');
  await ports.removeMembership(resourceId, folderId ? folderId : null);
  return { status: 'done', message: MENU_REMOVE_FOLDER };
}

export async function removeFromWorkspaceFlow(
  ports: FlowPorts,
  workspaceId: string,
  resourceId: string,
  name: string,
): Promise<FlowResult> {
  const others = ports.otherWorkspaceNames ? await ports.otherWorkspaceNames(resourceId) : [];
  const dirty = ports.isDirty?.(resourceId) ?? false;
  const ok = await ports.confirm(
    `${MENU_REMOVE_WORKSPACE}「${name}」？`,
    [
      '只从当前工作区移除。会关闭本工作区里已打开的面板。',
      '不删除、不移动原文件。其他工作区的引用和全局自建目录归类都保留。',
      others.length ? `其他工作区仍引用它：${others.join('、')}。` : '',
      dirty ? '这个文件有未保存的修改。关闭面板后修改留在草稿里，不会写入文件。' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    MENU_REMOVE_WORKSPACE,
  );
  if (!ok) return { status: 'cancel', message: '已取消' };
  await ports.removeWorkspaceRef(workspaceId, resourceId);
  if (ports.closePanels) await ports.closePanels(resourceId);
  return { status: 'done', message: MENU_REMOVE_WORKSPACE };
}
