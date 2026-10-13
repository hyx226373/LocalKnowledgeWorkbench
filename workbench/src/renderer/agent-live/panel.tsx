import React, { useEffect, useState } from 'react';
import type { AgentMaterial } from '../../shared/agentLive/types';
import { KB_RESOURCE_MIME } from '../dnd/mime';
import { addRefs, clearSession, pinSelected, relocateMaterial, removeSelected, setPurposeSelected, setSelectedMaterial, unpinSelected } from './actions';
import { defaultChrome, parseChrome, type AgentLiveChromeState } from './collapse';
import { useAgentLive } from './context';
import { AGENT_REORDER_MIME, applyCopyDrag, nativeCopyDrag } from './dragPolicy';
import { partitionPieces, piecesFromTransfer, type DropPiece } from './dropIn';
import { formatSectionHeading, tokenBudgetHint } from './format';
import { ENTRY_LIST_CAP } from './limits';
import { MSG_DIR_REJECTED, MSG_DRAG_OUT, MSG_ENTRY_CAP, MSG_WEB_REJECTED } from './messages';
import { reorderWithinTier, splitTiers } from './order';
import { ModuleHead } from '../drawer/ModuleHead';
import { ChevronRightIcon, GripVerticalIcon } from '../ui/shellMarks';
import '../drawer/module.css';

function osPieces(data: DataTransfer): DropPiece[] {
  const pieces: DropPiece[] = [];
  const items = data.items;
  if (!items) return pieces;
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      pieces.push({ reject: 'dir' });
      continue;
    }
    const file = item.getAsFile?.();
    const path = (file as (File & { path?: string }) | null)?.path;
    if (path) pieces.push({ ref: { absPath: path, name: file?.name || path } });
  }
  return pieces;
}

export function AgentMaterialsSidebar() {
  const binding = useAgentLive();
  const [items, setItems] = useState<AgentMaterial[]>([]);
  const [chrome, setChrome] = useState<AgentLiveChromeState>(defaultChrome);
  const [over, setOver] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const workspaceId = binding?.host.workspaceId() ?? '';

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
  const { session, pinned } = splitTiers(items);
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
    const pieces = [
      ...piecesFromTransfer([...data.types], (type) => data.getData(type)),
      ...osPieces(data),
    ];
    const { refs, reject } = partitionPieces(pieces);
    if (reject === 'web') binding.host.notify(MSG_WEB_REJECTED);
    else if (reject === 'dir' || (reject === 'unknown' && !refs.length)) binding.host.notify(MSG_DIR_REJECTED);
    if (refs.length) await addRefs(binding, refs);
  };

  const dropReorder = async (tier: 'session' | 'pinned', draggedId: string, beforeId: string | null) => {
    if (!draggedId || draggedId === beforeId) return;
    const order = reorderWithinTier(items, tier, draggedId, beforeId);
    await binding.client.reorder(workspaceId, order);
  };

  return (
    <section
      className="kb-section kb-module al-materials"
      data-testid="agent-materials"
      data-collapsed={chrome.sectionCollapsed ? 'true' : 'false'}
      data-drag-over={over ? 'true' : undefined}
      onDragOver={(event) => {
        const types = [...event.dataTransfer.types];
        const incoming = types.includes(KB_RESOURCE_MIME) || types.includes('Files') || types.includes('text/uri-list') || types.includes(AGENT_REORDER_MIME);
        if (!incoming) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        setOver(false);
        if (event.dataTransfer.types.includes(AGENT_REORDER_MIME)) return;
        event.preventDefault();
        void acceptDrop(event.dataTransfer);
      }}
    >
      <ModuleHead
        title="Agent 资料"
        testId="agent-module-h"
        acts={
          <button type="button" className="kb-linkish" aria-expanded={!chrome.sectionCollapsed} data-testid="agent-materials-fold" onClick={() => patchChrome({ sectionCollapsed: !chrome.sectionCollapsed })}>
            <span className={"kb-chev" + (!chrome.sectionCollapsed ? " open" : "")} aria-hidden="true"><ChevronRightIcon width={14} height={14} /></span>
            {chrome.sectionCollapsed ? '展开' : '收起'}
          </button>
        }
      />
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
            renderActions={(material) => (
              <button type="button" className="kb-linkish" data-testid="agent-pin" onClick={() => void pinSelected(binding, material.materialId)}>
                固定
              </button>
            )}
          />
          <Zone
            tier="pinned"
            title={formatSectionHeading('固定资料', pinned)}
            collapsed={chrome.pinnedCollapsed}
            onToggle={() => patchChrome({ pinnedCollapsed: !chrome.pinnedCollapsed })}
            items={pinned}
            selected={selected}
            onSelect={select}
            empty="没有固定资料。"
            onReorder={(draggedId, beforeId) => dropReorder('pinned', draggedId, beforeId)}
            renderActions={(material) => (
              <button type="button" className="kb-linkish" data-testid="agent-unpin" onClick={() => void unpinSelected(binding, material.materialId)}>
                取消固定
              </button>
            )}
          />
        </>
      )}
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
            <MaterialRow key={material.materialId} material={material} selected={props.selected === material.materialId} onSelect={() => props.onSelect(material.materialId)} onReorder={(draggedId) => props.onReorder(draggedId, material.materialId)}>
              {props.renderActions(material)}
            </MaterialRow>
          ))}
        </div>
      )}
    </div>
  );
}

function MaterialRow(props: { material: AgentMaterial; selected: boolean; onSelect: () => void; onReorder: (draggedId: string) => void; children: React.ReactNode }) {
  const binding = useAgentLive();
  const material = props.material;
  const [draft, setDraft] = useState(material.purpose ?? '');
  const [over, setOver] = useState(false);
  useEffect(() => setDraft(material.purpose ?? ''), [material.purpose]);
  if (!binding) return null;
  const commitPurpose = () => {
    const next = draft.trim() ? draft.trim() : null;
    if (next === (material.purpose ?? null)) return;
    void setPurposeSelected(binding, next, material.materialId);
  };
  return (
    <div
      className="al-row"
      data-testid="agent-material"
      data-material-id={material.materialId}
      data-tier={material.tier === 'pinned' ? 'pinned' : 'session'}
      data-status={material.status}
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
      <span
        className="al-name"
        draggable
        title={MSG_DRAG_OUT}
        data-testid="agent-drag-out"
        onDragStart={(event) => {
          event.stopPropagation();
          applyCopyDrag(event.dataTransfer, [material.absPath]);
          binding.host.startDragCopy?.(nativeCopyDrag([material.absPath]));
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
          aria-label={`${material.name}的用途`}
          placeholder="用途"
          value={draft}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitPurpose}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
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
        <GripVerticalIcon />
      </button>
        )}
        {props.children}
        <button type="button" className="kb-linkish danger" data-testid="agent-remove" onClick={() => void removeSelected(binding, material.materialId)}>
          移除
        </button>
      </div>
    </div>
  );
}
