import { openAiWriteApproval } from '../aiWrite/approval';
import { AiWriteLinkArea } from '../aiWrite/linkArea';
import { copyLink } from '../rebirth/client';
import { Repository } from '../rebirth/Repository';
import React, { useEffect, useState } from 'react';
import type { AgentMaterial } from '../../shared/agentLive/types';
import type { DirEntry } from '../../shared/types';
import { isKbDrag } from '../dnd/drag';
import { KB_RESOURCE_MIME } from '../dnd/mime';
import type { DragPayload } from '../dnd/types';
import { kb } from '../kb';
import { LoadingLabel } from '../ui/LoadingLabel';
import { addFromDisk, addRefsMaybeDir, clearSession, relocateMaterial, removeSelected, setPurposeSelected, setSelectedMaterial } from './actions';
import { defaultChrome, parseChrome, type AgentLiveChromeState } from './collapse';
import { useAgentLive } from './context';
import { AGENT_REORDER_MIME, applyCopyDrag, nativeCopyDrag } from './dragPolicy';
import { nativeSessionClaimsFiles } from '../nativeDrag/session';
import { dragAgentMaterial, nativeFileDragAvailable } from '../nativeDrag/start';
import { osDropPieces, partitionPieces, piecesFromTransfer } from './dropIn';
import { formatSectionHeading, isDirMaterial, tokenBudgetHint } from './format';
import { ENTRY_LIST_CAP } from './limits';
import { MSG_DIR_REJECTED, MSG_DRAG_OUT, MSG_ENTRY_CAP, MSG_WEB_REJECTED } from './messages';
import { reorderWithinTier, splitTiers } from './order';
import { getSidebarPrefs } from '../drawer/sidebarPrefs';
import { ModuleHead } from '../drawer/ModuleHead';
import { useCommitDocTab } from '../dnd/docTabDrop';
import { handleDocTabDragOver, handleDocTabDrop, hasDocTabMime } from '../dnd/docTabDrag';
import { ChevronRightIcon, GripVerticalIcon, TreeGlyph } from '../ui/shellMarks';
import type { CtxPlaybookState } from '../../shared/ctxPlaybook';
import { PlaybookBar, PlaybookPlaceFields } from './playbookBar';

import '../drawer/module.css';

export function AgentMaterialsSidebar() {
  const binding = useAgentLive();
  const [items, setItems] = useState<AgentMaterial[]>([]);
  const [chrome, setChrome] = useState<AgentLiveChromeState>(defaultChrome);
  const [over, setOver] = useState(false);
  // r24-A：子元素（Agent 仓库）自己接住 drop 时，这里收不到 drop/dragleave，高亮会卡住。拖拽一结束就清掉。
  const sectionRef = React.useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!over) return;
    const clear = () => { setOver(false); sectionRef.current?.removeAttribute('data-drop-active'); };
    window.addEventListener('dragend', clear, true);
    window.addEventListener('drop', clear, true);
    return () => { window.removeEventListener('dragend', clear, true); window.removeEventListener('drop', clear, true); };
  }, [over]);
  const [selected, setSelected] = useState<string | null>(null);
  const [playbook, setPlaybook] = useState<CtxPlaybookState | null>(null);
  const workspaceId = binding?.host.workspaceId() ?? '';
  const commitTab = useCommitDocTab(workspaceId);

  useEffect(() => {
    if (!binding) return;
    let stop = false;
    void binding.client.list(workspaceId).then((rows) => {
      if (!stop) setItems(rows);
    });
    const unsub = binding.client.subscribe?.(workspaceId, () => {
      void binding.client.list(workspaceId).then((rows) => {
        if (!stop) setItems(rows);
      });
    });
    return () => {
      stop = true;
      unsub?.();
    };
  }, [binding, workspaceId]);

  useEffect(() => {
    if (!binding?.host.loadChrome) return;
    let stop = false;
    void binding.host.loadChrome(workspaceId).then((raw) => {
      if (!stop) setChrome(parseChrome(raw));
    });
    return () => {
      stop = true;
    };
  }, [binding, workspaceId]);

  if (!binding) return null;
  const { session } = splitTiers(items);
  const hint = tokenBudgetHint(items);

  const patchChrome = (patch: Partial<AgentLiveChromeState>) => {
    setChrome((prev) => {
      const next = { ...prev, ...patch };
      void binding.host.saveChrome?.(workspaceId, next);
      return next;
    });
  };

  const select = (materialId: string) => {
    setSelected(materialId);
    setSelectedMaterial(materialId);
  };

  const acceptDrop = async (data: DataTransfer) => {
    const types = [...data.types];
    const pieces = [
      ...piecesFromTransfer(types, (type) => data.getData(type), data),
      ...(nativeSessionClaimsFiles(types) ? [] : osDropPieces(data)),
    ];
    const { refs, reject } = partitionPieces(pieces);
    if (reject === 'web') binding.host.notify(MSG_WEB_REJECTED);
    else if (reject === 'dir' && !refs.length) binding.host.notify(MSG_DIR_REJECTED);
    else if (reject === 'unknown' && !refs.length) binding.host.notify(MSG_DIR_REJECTED);
    if (!refs.length) return;
    const hasDir = pieces.some((piece) => piece.kind === 'dir' && piece.ref);
    await addRefsMaybeDir(binding, refs, { asDir: hasDir });
  };

  const dropReorder = async (tier: 'session' | 'pinned', draggedId: string, beforeId: string | null) => {
    if (!draggedId || draggedId === beforeId) return;
    const order = reorderWithinTier(items, tier, draggedId, beforeId);
    await binding.client.reorder(workspaceId, order);
  };

  return (
    <section
      ref={sectionRef}
      className="kb-section kb-module al-materials"
      data-testid="agent-materials"
      data-collapsed={chrome.sectionCollapsed ? 'true' : 'false'}
      data-drag-over={over ? 'true' : undefined}
      onDragEnter={(event) => {
        if (!hasDocTabMime(event.dataTransfer.types)) return;
        event.preventDefault();
      }}
      onDragOver={(event) => {
        if (handleDocTabDragOver(event)) {
          setOver(true);
          return;
        }
        const types = [...event.dataTransfer.types];
        const incoming = isKbDrag(event.dataTransfer) || types.includes(KB_RESOURCE_MIME) || types.includes('Files') || types.includes('text/uri-list') || types.includes(AGENT_REORDER_MIME) || nativeSessionClaimsFiles(types);
        if (!incoming) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        if (hasDocTabMime(event.dataTransfer.types)) event.currentTarget.removeAttribute('data-drop-active');
        setOver(false);
      }}
      onDrop={(event) => {
        const hit = handleDocTabDrop(event);
        if (hit.claimed) {
          setOver(false);
          if (hit.payload) void commitTab('agent', hit.payload);
          return;
        }
        setOver(false);
        if (event.dataTransfer.types.includes(AGENT_REORDER_MIME)) return;
        event.preventDefault();
        void acceptDrop(event.dataTransfer);
      }}
    >
      <button type="button" className="kb-linkish" data-testid="ai-write-open-approval" onClick={() => void openAiWriteApproval().catch(e => binding.host.notify(String(e.message || e)))}>写入批准</button>
      <AiWriteLinkArea />
      <button type="button" className="kb-linkish" title="只包含链接区里的文件夹和文件" onClick={() => void copyLink('root').then(() => binding.host.notify('已复制')).catch(e => binding.host.notify(String(e.message || e)))}>根目录和 AI 资料导入链接</button>
      <ModuleHead
        title="Agent 资料"
        testId="agent-module-h"
        acts={
          <>
            <button type="button" className="kb-linkish" data-testid="agent-add-from-disk" onClick={() => void addFromDisk(binding)}>
              选择文件加入
            </button>
            <button type="button" className="kb-linkish" aria-expanded={!chrome.sectionCollapsed} data-testid="agent-materials-fold" onClick={() => patchChrome({ sectionCollapsed: !chrome.sectionCollapsed })}>
              <span className={"kb-chev" + (!chrome.sectionCollapsed ? " open" : "")} aria-hidden="true"><ChevronRightIcon width={14} height={14} /></span>
              {chrome.sectionCollapsed ? '展开' : '收起'}
            </button>
          </>
        }
      />
      <PlaybookBar workspaceId={workspaceId} materials={items} onState={setPlaybook} />
      {chrome.sectionCollapsed ? null : (
        <>
          {hint && (
            <p className="al-hint" data-tone="warning" data-testid="agent-token-hint">
              {hint}
            </p>
          )}
          {items.length > ENTRY_LIST_CAP && <p className="al-hint">{MSG_ENTRY_CAP}</p>}
          <Zone
            tier="session"
            title={formatSectionHeading('本轮资料', session)}
            collapsed={chrome.sessionCollapsed}
            onToggle={() => patchChrome({ sessionCollapsed: !chrome.sessionCollapsed })}
            items={session}
            selected={selected}
            onSelect={select}
            empty="还没有本轮资料。"
            extra={
              <button type="button" className="kb-linkish" data-testid="agent-clear-session" onClick={() => void clearSession(binding)}>
                清空本轮资料
              </button>
            }
            onReorder={(draggedId, beforeId) => dropReorder('session', draggedId, beforeId)}
            renderActions={() => null}
            playbook={playbook}
          />
        </>
      )}
      <Repository />
    </section>
  );
}

function Zone(props: {
  tier: 'session' | 'pinned';
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  items: AgentMaterial[];
  selected: string | null;
  onSelect: (id: string) => void;
  empty: string;
  extra?: React.ReactNode;
  onReorder: (draggedId: string, beforeId: string | null) => void;
  renderActions: (material: AgentMaterial) => React.ReactNode;
  playbook?: CtxPlaybookState | null;
}) {
  return (
    <div className="al-zone" data-testid={`agent-zone-${props.tier}`} data-collapsed={props.collapsed ? 'true' : 'false'}>
      <div className="kb-group-label al-zone-title">
        <button type="button" className="al-fold" aria-expanded={!props.collapsed} onClick={props.onToggle}>
          <span className={"kb-chev" + (!props.collapsed ? " open" : "")} aria-hidden="true"><ChevronRightIcon width={14} height={14} /></span>
          <span data-testid={`agent-heading-${props.tier}`}>{props.title}</span>
        </button>
        {props.extra}
      </div>
      {props.collapsed ? null : props.items.length === 0 ? (
        <p className="al-empty kb-module-empty">{props.empty}</p>
      ) : (
        <div
          onDragOver={(event) => {
            if (![...event.dataTransfer.types].includes(AGENT_REORDER_MIME)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            const draggedId = event.dataTransfer.getData(AGENT_REORDER_MIME);
            if (!draggedId) return;
            event.preventDefault();
            event.stopPropagation();
            props.onReorder(draggedId, null);
          }}
        >
          {props.items.map((material) => (
            <MaterialRow key={material.materialId} material={material} selected={props.selected === material.materialId} onSelect={() => props.onSelect(material.materialId)} onReorder={(draggedId) => props.onReorder(draggedId, material.materialId)} playbook={props.playbook}>
              {props.renderActions(material)}
            </MaterialRow>
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialRow(props: { material: AgentMaterial; selected: boolean; onSelect: () => void; onReorder: (draggedId: string) => void; children: React.ReactNode; playbook?: CtxPlaybookState | null }) {
  const binding = useAgentLive();
  const material = props.material;
  const dir = isDirMaterial(material);
  const [draft, setDraft] = useState(material.purpose ?? '');
  const [over, setOver] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => setDraft(material.purpose ?? ''), [material.purpose]);
  if (!binding) return null;
  const why = props.playbook?.enabled === true;
  const commitPurpose = () => {
    const next = draft.trim() ? draft.trim() : null;
    if (next === (material.purpose ?? null)) return;
    void setPurposeSelected(binding, next, material.materialId);
  };
  return (
    <>
      <div
        className="al-row"
        data-testid="agent-material"
        data-material-id={material.materialId}
        data-tier={material.tier === 'pinned' ? 'pinned' : 'session'}
        data-status={material.status}
        data-kind={dir ? 'dir' : 'file'}
        data-expanded={dir && open ? 'true' : undefined}
        data-drag-over={over ? 'true' : undefined}
        aria-selected={props.selected ? 'true' : undefined}
        onClick={props.onSelect}
        onDragOver={(event) => {
          if (![...event.dataTransfer.types].includes(AGENT_REORDER_MIME)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          const draggedId = event.dataTransfer.getData(AGENT_REORDER_MIME);
          if (!draggedId) return;
          event.preventDefault();
          event.stopPropagation();
          setOver(false);
          props.onReorder(draggedId);
        }}
      >
        <input type="checkbox" checked aria-label={`本轮资料：${material.name}`} onClick={event => event.stopPropagation()} onChange={() => void removeSelected(binding, material.materialId)} />
        <button
          type="button"
          className="al-grip"
          draggable
          title="拖动排序"
          aria-label="拖动排序"
          data-testid="agent-reorder-grip"
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(AGENT_REORDER_MIME, material.materialId);
          }}
        >
          <GripVerticalIcon />
        </button>
        {dir ? (
          <button
            type="button"
            className="al-dir-chev"
            data-testid="agent-dir-expand"
            aria-expanded={open}
            title={open ? '收起子项' : '展开子项'}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen((v) => !v);
            }}
          >
            <span className={'kb-chev' + (open ? ' open' : '')} aria-hidden="true">
              <ChevronRightIcon width={14} height={14} />
            </span>
          </button>
        ) : (
          <span className="al-dir-chev al-dir-chev--empty" aria-hidden="true" />
        )}
        <span
          className="al-name"
          draggable
          title={MSG_DRAG_OUT}
          data-testid="agent-drag-out"
          onDragStart={(event) => {
            event.stopPropagation();
            const kbPayload: DragPayload = {
              v: 1,
              items: [{
                resourceId: material.resourceId || '',
                sourceKind: 'file',
                entry: dir ? 'dir-entry' : 'file',
                from: { kind: 'agent-materials' },
                name: material.name,
                absPath: material.absPath,
                relPath: material.relPath,
              }],
            };
            try {
              event.dataTransfer.setData(KB_RESOURCE_MIME, JSON.stringify(kbPayload));
            } catch {}
            if (dir || !material.absPath) {
              applyCopyDrag(event.dataTransfer, [material.absPath]);
              return;
            }
            dragAgentMaterial({
              event,
              mode: getSidebarPrefs().dragOutMode,
              absPath: material.absPath,
              native: nativeFileDragAvailable(),
              writeCopy: (transfer) => applyCopyDrag(transfer, [material.absPath]),
              sendNative: (files) => binding.host.startDragCopy?.(nativeCopyDrag(files)),
            });
          }}
        >
          {material.name}
        </span>
        <span className="al-path" title={material.absPath}>
          {material.absPath}
        </span>
        <div className="al-meta">
          <input
            className="kb-input al-purpose"
            data-testid="agent-purpose"
            aria-label={`${material.name}：${why ? '为什么' : '用途'}`}
            placeholder={why ? '为什么' : '用途'}
            value={draft}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitPurpose}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          {why && props.playbook ? <PlaybookPlaceFields material={material} playbook={props.playbook} /> : null}
          {material.status === 'missing' && (
            <span className="kb-badge" data-status="error">
              失效
            </span>
          )}
          {material.status === 'unreadable' && (
            <span className="kb-badge" data-status="error">
              无法读取
            </span>
          )}
          {material.status !== 'ok' && (
            <button type="button" className="kb-button kb-button--secondary kb-button--small" data-testid="agent-relocate" onClick={() => void relocateMaterial(binding, material.materialId)}>
              重新定位
            </button>
          )}
          {props.children}
          <button type="button" className="kb-linkish danger" data-testid="agent-remove" onClick={() => void removeSelected(binding, material.materialId)}>
            移除
          </button>
        </div>
      </div>
      {dir && open ? <MaterialDirChildren material={material} /> : null}
    </>
  );
}

/** 侧栏文件夹展开：懒加载一层 listDir，不写进 AgentMaterial schema。 */
function MaterialDirChildren({ material }: { material: AgentMaterial }) {
  const rootId = material.sourceId;
  const relPath = material.relPath || '';
  const absPath = material.absPath || '';
  const [items, setItems] = useState<DirEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!rootId && !absPath) {
      setItems([]);
      setErr(null);
      return;
    }
    let stop = false;
    setItems(null);
    setErr(null);
    const req = rootId ? kb.listDir(rootId, relPath) : kb.listDirAbs(absPath);
    void req.then(
      (rows) => {
        if (!stop) {
          setItems(rows);
          setErr(null);
        }
      },
      (error) => {
        if (!stop) setErr(String((error as { message?: string })?.message ?? error));
      },
    );
    return () => {
      stop = true;
    };
  }, [rootId, relPath, absPath]);
  if (!rootId && !absPath) {
    return (
      <div className="al-dir-kids" data-testid="agent-dir-children" data-empty="no-root">
        无来源根，无法列出子项
      </div>
    );
  }
  if (err) {
    return (
      <div className="al-dir-kids al-dir-err" data-testid="agent-dir-children">
        无法读取：{err}
      </div>
    );
  }
  if (!items) return <div className="al-dir-kids"><LoadingLabel testId="agent-dir-loading" /></div>;
  if (!items.length) {
    return (
      <div className="al-dir-kids" data-testid="agent-dir-children" data-count={0}>
        （空）
      </div>
    );
  }
  return (
    <div className="al-dir-kids" data-testid="agent-dir-children" data-count={items.length}>
      {items.map((entry) => (
        <div
          key={entry.resourceId || entry.relPath || entry.name}
          className="al-dir-kid"
          data-kind={entry.kind}
          data-resource-id={entry.resourceId || undefined}
        >
          <TreeGlyph kind={entry.kind === 'dir' ? 'dir' : 'file'} ext={entry.ext} />
          <span className="name">{entry.name}</span>
        </div>
      ))}
    </div>
  );
}
