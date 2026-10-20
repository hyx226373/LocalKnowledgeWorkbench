import React, { useEffect, useState } from 'react';
import type { AgentMaterial } from '../../shared/agentLive/types';
import {
  DELIVERY_LABEL,
  MOUNT_LABEL,
  PLAYBOOK_DELIVERIES,
  PLAYBOOK_MOUNTS,
  builtinPresets,
  estimatePlaybookUse,
  unassignedCount,
  type CtxPlaybookPatch,
  type CtxPlaybookState,
  type PlaybookDelivery,
  type PlaybookMount,
} from '../../shared/ctxPlaybook';
import type { KbApi } from '../../shared/types';
import { useAgentLive } from './context';

function playbookApi(): Partial<KbApi> | null {
  if (typeof window === 'undefined' || !window.kb) return null;
  return window.kb;
}

export function PlaybookBar(props: { workspaceId: string; materials: AgentMaterial[]; onState: (state: CtxPlaybookState | null) => void }) {
  const binding = useAgentLive();
  const [state, setState] = useState<CtxPlaybookState | null>(null);
  const [hidden, setHidden] = useState(false);
  const onState = props.onState;
  const workspaceId = props.workspaceId;

  useEffect(() => {
    if (!workspaceId) return;
    let stop = false;
    const load = () => {
      const api = playbookApi();
      if (typeof api?.agentLivePlaybookGet !== 'function') {
        if (!stop) {
          setHidden(true);
          onState(null);
        }
        return;
      }
      void api.agentLivePlaybookGet(workspaceId).then((next) => {
        if (stop) return;
        setHidden(false);
        setState(next);
        onState(next);
      }).catch(() => {
        if (stop) return;
        setHidden(true);
        setState(null);
        onState(null);
      });
    };
    load();
    const unsub = binding?.client.subscribe?.(workspaceId, load);
    return () => {
      stop = true;
      unsub?.();
    };
  }, [workspaceId, binding, onState]);

  if (hidden || !state) return null;

  const patch = (next: CtxPlaybookPatch) => {
    const api = playbookApi();
    if (typeof api?.agentLivePlaybookSet !== 'function') return;
    void api.agentLivePlaybookSet(workspaceId, next).then((saved) => {
      setState(saved);
      onState(saved);
    }).catch((err: unknown) => {
      binding?.host.notify(err instanceof Error ? err.message : String(err));
    });
  };

  const guess = () => {
    const api = playbookApi();
    if (typeof api?.agentLivePlaybookGuess !== 'function') return;
    void api.agentLivePlaybookGuess(workspaceId).catch((err: unknown) => {
      binding?.host.notify(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <PlaybookBarView
      state={state}
      materials={props.materials}
      onPatch={patch}
      onGuess={guess}
    />
  );
}

export function PlaybookBarView(props: {
  state: CtxPlaybookState;
  materials: readonly AgentMaterial[];
  onPatch: (patch: CtxPlaybookPatch) => void;
  onGuess: () => void;
}) {
  const { state } = props;
  const [draft, setDraft] = useState(state.mission);
  useEffect(() => setDraft(state.mission), [state.mission]);
  const presets = builtinPresets();
  const known = presets.some((row) => row.id === state.templateId);
  if (!state.enabled) {
    return (
      <div className="al-playbook" data-testid="ctx-playbook">
        <label className="al-playbook-toggle">
          <input
            type="checkbox"
            data-testid="ctx-playbook-toggle"
            checked={false}
            onChange={(event) => props.onPatch({ enabled: event.target.checked })}
          />
          上下文剧本
        </label>
      </div>
    );
  }
  const { used } = estimatePlaybookUse(state, props.materials);
  const open = unassignedCount(state, props.materials);
  const prompt = presets.find((row) => row.id === state.templateId)?.missionPrompt ?? '一句话目标、不做什么、做成什么样。';
  return (
    <div className="al-playbook" data-testid="ctx-playbook">
      <label className="al-playbook-toggle">
        <input
          type="checkbox"
          data-testid="ctx-playbook-toggle"
          checked
          onChange={(event) => props.onPatch({ enabled: event.target.checked })}
        />
        上下文剧本
      </label>
      <label>
        模板
        <select
          data-testid="ctx-playbook-template"
          value={state.templateId}
          onChange={(event) => props.onPatch({ templateId: event.target.value })}
        >
          {!known ? <option value={state.templateId}>{state.templateId}</option> : null}
          {presets.map((row) => (
            <option key={row.id} value={row.id}>{row.name}</option>
          ))}
        </select>
      </label>
      <input
        className="kb-input"
        data-testid="ctx-playbook-mission"
        aria-label="任务"
        placeholder={prompt}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== state.mission) props.onPatch({ mission: draft });
        }}
      />
      <span data-testid="ctx-playbook-budget">约 {used}/{state.budgetTokens}</span>
      <span className="al-hint" data-tone="warning" data-testid="ctx-playbook-unassigned">未分槽 {open} 份，不进粘贴</span>
      <button type="button" className="kb-linkish" data-testid="ctx-playbook-guess" onClick={props.onGuess}>按猜测放入</button>
    </div>
  );
}

export function PlaybookPlaceFields(props: { material: AgentMaterial; playbook: CtxPlaybookState }) {
  const binding = useAgentLive();
  const material = props.material;
  const state = props.playbook;
  const slot = state.slots.find((row) => row.id === material.slotId);
  const mount = material.mount ?? slot?.mount ?? '';
  const delivery = material.delivery ?? slot?.delivery ?? '';
  const workspaceId = binding?.host.workspaceId() ?? '';

  const place = (patch: { slotId?: string | null; mount?: PlaybookMount | null; delivery?: PlaybookDelivery | null }) => {
    const api = playbookApi();
    if (!binding || typeof api?.agentLiveMaterialPlace !== 'function') return;
    void api.agentLiveMaterialPlace(workspaceId, material.materialId, patch).catch((err: unknown) => {
      binding.host.notify(err instanceof Error ? err.message : String(err));
    });
  };

  const manual = mount === 'manual';
  const attached = state.manualIds.includes(material.materialId);

  return (
    <span className="al-playbook-place">
      <select
        data-testid="ctx-playbook-slot"
        aria-label={`${material.name}：槽`}
        value={material.slotId ?? ''}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => place({ slotId: event.target.value || null })}
      >
        <option value="">未分槽</option>
        {state.slots.map((row) => (
          <option key={row.id} value={row.id}>{row.name}</option>
        ))}
      </select>
      <select
        data-testid="ctx-playbook-mount"
        aria-label={`${material.name}：挂载`}
        value={mount}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => place({ mount: (event.target.value || null) as PlaybookMount | null })}
      >
        <option value="">跟槽</option>
        {PLAYBOOK_MOUNTS.map((id) => (
          <option key={id} value={id}>{MOUNT_LABEL[id]}</option>
        ))}
      </select>
      <select
        data-testid="ctx-playbook-delivery"
        aria-label={`${material.name}：给法`}
        value={delivery}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => place({ delivery: (event.target.value || null) as PlaybookDelivery | null })}
      >
        <option value="">跟槽</option>
        {PLAYBOOK_DELIVERIES.map((id) => (
          <option key={id} value={id}>{DELIVERY_LABEL[id]}</option>
        ))}
      </select>
      {manual ? (
        <label onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            data-testid="ctx-playbook-manual"
            checked={attached}
            onChange={(event) => {
              const api = playbookApi();
              if (typeof api?.agentLivePlaybookSet !== 'function') return;
              const ids = event.target.checked
                ? [...state.manualIds, material.materialId]
                : state.manualIds.filter((id) => id !== material.materialId);
              void api.agentLivePlaybookSet(workspaceId, { manualIds: ids }).catch((err: unknown) => {
                binding?.host.notify(err instanceof Error ? err.message : String(err));
              });
            }}
          />
          本次附上
        </label>
      ) : null}
    </span>
  );
}
