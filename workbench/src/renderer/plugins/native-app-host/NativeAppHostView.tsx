/**
 * Blank native-app-host panel: select window, title/status/preview, enter/exit interaction, detach.
 * No hover-enter; first click consumes into interacting; Escape exits.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdapterProps } from '../../plugin-host/types';
import type { NativeHostCandidate } from '../../../shared/nativeAppHost';
import { NATIVE_APP_HOST_VIEW_TYPE } from '../../../shared/nativeAppHost';
import { EXIT_INTERACTION_KEY } from './constants';
import { getHostClient } from './hostClient';
import {
  applyHover,
  interactionAfterLayoutChrome,
  reduceInteraction,
  shouldConsumeFirstClick,
  type InteractionMode,
} from './interaction';
import {
  LAYOUT_EVENTS,
  appliesToPanel,
  emptyLayoutUiState,
  reduceLayoutUiForPanel,
  requestActivate,
  shouldRequestPanelFocus,
  subscribeLayoutEvents,
  type LayoutUiState,
} from './layoutEvents';
import { defaultConfirm, proposeAttach, proposeDetach } from './proposeAttach';
import {
  emptyViewState,
  isPendingActivation,
  type NativeAppHostViewState,
} from './persistView';
import { toPersistPayload } from '../../../shared/nativeAppHost';
import {
  hostPanelLayoutSync,
  nativeVisibleAttr,
  placeholderBlocksPointer,
  resolveDisplays,
} from './chrome';
import {
  removeNativePanel,
  restingShouldShow,
  upsertNativePanel,
} from './panelRegistry';

export function NativeAppHostView(props: AdapterProps<NativeAppHostViewState>) {
  const { state, setState, item, reportReady } = props;
  const panelId = item.itemId;
  const client = useMemo(() => getHostClient(), []);

  const view = state ?? emptyViewState();
  const [candidates, setCandidates] = useState<NativeHostCandidate[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [layoutUi, setLayoutUi] = useState<LayoutUiState>(emptyLayoutUiState());
  const [statusMsg, setStatusMsg] = useState<string>('');

  const interaction: InteractionMode = view.interaction;
  const bound = !!view.bindingId;

  useEffect(() => {
    reportReady?.();
  }, [reportReady]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const rootRef = useRef<HTMLDivElement | null>(null);

  // the user 03: respond to layout.chromeVisibilityChanged (contentOnly true→false → exit interacting).
  // Do NOT emit exit CustomEvent / requestActivate on this path.
  useEffect(() => {
    return subscribeLayoutEvents((ev) => {
      setLayoutUi((s) => {
        const next = reduceLayoutUiForPanel(s, ev, panelId);
        if (
          ev.name === LAYOUT_EVENTS.chromeVisibilityChanged &&
          appliesToPanel(ev, panelId)
        ) {
          const nextIx = interactionAfterLayoutChrome(
            viewRef.current.interaction,
            s.contentOnly,
            next.contentOnly,
          );
          if (nextIx !== viewRef.current.interaction) {
            const cur = viewRef.current;
            queueMicrotask(() => {
              setState({
                ...cur,
                viewType: NATIVE_APP_HOST_VIEW_TYPE,
                interaction: nextIx,
              });
              setStatusMsg('退出只看内容 · 已退出托管交互');
            });
          }
        }
        return next;
      });
    });
  }, [panelId, setState]);

  // Binding state: only query / display this panelId (P-1).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const st = await client.getState({ panelId });
      if (cancelled || !st.ok) return;
      const snap = st.snapshot;
      if (snap.panelId && snap.panelId !== panelId) return;
      if (snap.bindingId && snap.state === 'attached') {
        // Keep UI label in sync; do not overwrite local interaction machine aggressively.
        setStatusMsg((m) => m || `绑定 ${snap.bindingId}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, panelId, view.bindingId]);

  // Global Escape while this panel is mounted — exit interacting (01 §4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== EXIT_INTERACTION_KEY) return;
      if (view.interaction !== 'interacting') return;
      e.preventDefault();
      setState({
        ...view,
        interaction: reduceInteraction(view.interaction, { type: 'exit' }),
      });
      setStatusMsg('已退出交互态');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [view, setState]);

  // L2: write data-scale-factor from non-empty displays (never silent scale=1).
  useEffect(() => {
    const bounds = layoutUi.contentBounds;
    hostPanelLayoutSync({
      panelId,
      bounds,
      displays: layoutUi.displays.length > 0 ? layoutUi.displays : undefined,
      root: rootRef.current,
    });
  }, [panelId, layoutUi.contentBounds, layoutUi.displays, layoutUi.contentBoundsScale]);

  // Publish __kbNativePanels so layout LayoutHost can setVisible(true) after attach.
  useEffect(() => {
    const b = layoutUi.contentBounds ?? { x: 0, y: 0, w: 0, h: 0 };
    const shouldShow = restingShouldShow({ bound, occluded: layoutUi.occluded });
    upsertNativePanel({
      id: panelId,
      layout: { x: b.x, y: b.y, w: b.w, h: b.h },
      attached: bound,
      shouldShow,
    });
  }, [panelId, bound, layoutUi.contentBounds, layoutUi.occluded]);

  useEffect(() => {
    return () => {
      removeNativePanel(panelId);
    };
  }, [panelId]);

  const patch = useCallback(
    (partial: Partial<NativeAppHostViewState>) => {
      setState({ ...view, viewType: NATIVE_APP_HOST_VIEW_TYPE, ...partial });
    },
    [setState, view],
  );

  const onList = async () => {
    setBusy(true);
    setListError(null);
    try {
      const res = await client.list();
      if (!res.ok) {
        setListError(res.message);
        setCandidates([]);
        return;
      }
      setCandidates(res.candidates);
      setStatusMsg(`候选 ${res.candidates.length} 个`);
    } finally {
      setBusy(false);
    }
  };

  const onSelectCandidate = async (c: NativeHostCandidate) => {
    setBusy(true);
    try {
      const result = await proposeAttach({
        client,
        panelId,
        candidate: c,
        confirm: defaultConfirm,
      });
      if (!result.ok && result.cancelled) {
        setStatusMsg('已取消接入');
        return;
      }
      if (!result.ok) {
        setStatusMsg(result.error.message);
        return;
      }
      const persist = toPersistPayload({
        hostPath: result.response.identity.path,
        titleHint: c.title,
        layout: layoutUi.contentBounds ?? { x: 0, y: 0, w: 0, h: 0 },
        attachPolicy: 'reselect-on-restore',
      });
      patch({
        bindingId: result.response.bindingId,
        interaction: 'attached',
        activation: 'pending',
        titleHint: c.title,
        hostPath: result.response.identity.path,
        persist,
        needsReselect: false,
      });
      setStatusMsg(`已接入（待激活）：${c.title}`);
    } finally {
      setBusy(false);
    }
  };

  const onEnter = () => {
    if (view.interaction === 'idle') return;
    patch({
      interaction: reduceInteraction(view.interaction, { type: 'enter' }),
      activation: 'active',
    });
    requestActivate(panelId, 'user-enter');
    setStatusMsg('已进入交互态');
  };

  const onExit = () => {
    patch({ interaction: reduceInteraction(view.interaction, { type: 'exit' }) });
    setStatusMsg('已退出交互态');
  };

  const onDetach = async () => {
    if (!view.bindingId) return;
    setBusy(true);
    try {
      const result = await proposeDetach({
        client,
        bindingId: view.bindingId,
        titleHint: view.titleHint,
        confirm: defaultConfirm,
      });
      if (!result.ok && result.cancelled) {
        setStatusMsg('已取消释放');
        return;
      }
      if (!result.ok) {
        setStatusMsg(result.error?.message ?? '释放失败');
        return;
      }
      patch({
        bindingId: null,
        interaction: 'idle',
        activation: 'pending',
        needsReselect: !!view.hostPath,
      });
      setStatusMsg('已释放 · 待激活');
    } finally {
      setBusy(false);
    }
  };

  const onContentClick = (e: React.MouseEvent) => {
    if (shouldConsumeFirstClick(interaction)) {
      e.preventDefault();
      e.stopPropagation();
      patch({
        interaction: reduceInteraction(interaction, { type: 'first-click' }),
        activation: 'active',
      });
      requestActivate(panelId, 'user-enter');
      setStatusMsg('首击已消费 · 进入交互态');
    }
  };

  /** N-1: panel-focus only when focus enters from outside (not intra-panel moves). */
  const onPanelFocus = (e: React.FocusEvent<HTMLDivElement>) => {
    if (
      !shouldRequestPanelFocus({
        bound,
        container: e.currentTarget,
        relatedTarget: e.relatedTarget,
      })
    ) {
      return;
    }
    requestActivate(panelId, 'panel-focus');
  };

  const onContentMouseEnter = () => {
    // Explicit no-op path: hover must not change interaction (guard + assert in tests).
    const next = applyHover(interaction);
    if (next !== interaction) {
      patch({ interaction: next });
    }
  };

  const pending = isPendingActivation(view);
  const nativeVisible = nativeVisibleAttr({ bound, occluded: layoutUi.occluded }) === 'true';
  const placeholderBlocks = placeholderBlocksPointer({ nativeVisible });
  const bindLabel = bound
    ? `已绑定 · ${view.titleHint || view.hostPath}${pending ? ' · 待激活' : ''}`
    : view.needsReselect || pending
      ? `待激活${view.hostPath ? `（须重新选窗：${view.hostPath}）` : ''}`
      : '未绑定 · 待激活';

  return (
    <div
      ref={rootRef}
      className="kb-native-app-host"
      data-testid="view-native-app-host"
      data-view-type={NATIVE_APP_HOST_VIEW_TYPE}
      data-panel-id={panelId}
      data-interaction={interaction}
      data-activation={view.activation}
      data-native-visible={nativeVisible ? 'true' : 'false'}
      tabIndex={0}
      onFocus={onPanelFocus}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 120 }}
    >
      <div
        className="kb-native-app-host__toolbar"
        data-testid="native-app-host-toolbar"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 8, borderBottom: '1px solid var(--kb-border, #444)' }}
      >
        <button type="button" className="kb-button" disabled={busy} onClick={() => void onList()} data-testid="nah-select-window">
          选窗
        </button>
        <button type="button" className="kb-button" disabled={!bound || interaction === 'interacting'} onClick={onEnter} data-testid="nah-enter">
          进入交互
        </button>
        <button type="button" className="kb-button" disabled={interaction !== 'interacting'} onClick={onExit} data-testid="nah-exit">
          退出交互
        </button>
        <button type="button" className="kb-button" disabled={!bound || busy} onClick={() => void onDetach()} data-testid="nah-detach">
          释放
        </button>
      </div>

      <div style={{ padding: '6px 8px', fontSize: 12, opacity: 0.9 }} data-testid="nah-status">
        <div>
          <strong>标题</strong>：{view.titleHint || '（空白容器）'}
        </div>
        <div>
          <strong>状态</strong>：{bindLabel} · 交互={interaction}
          {layoutUi.occluded ? ' · 遮挡中' : ''}
          {layoutUi.contentOnly ? ' · 只看内容' : ''}
          {layoutUi.editMode ? ` · 布局编辑${layoutUi.dirty ? '（未保存）' : ''}` : ''}
        </div>
        {layoutUi.contentBounds && (
          <div data-testid="nah-content-bounds">
            内容区：{layoutUi.contentBounds.w}×{layoutUi.contentBounds.h} @ ({layoutUi.contentBounds.x},{layoutUi.contentBounds.y})
          </div>
        )}
        {statusMsg && <div>{statusMsg}</div>}
        {listError && <div style={{ color: 'salmon' }}>{listError}</div>}
        {(view.needsReselect || pending) && (
          <div data-testid="nah-pending-activation">
            待激活：恢复后不自动接入/激活；请选窗确认后再进入交互。
            {view.needsReselect ? '（reselect-on-restore）' : ''}
          </div>
        )}
      </div>

      {candidates.length > 0 && (
        <div data-testid="nah-candidates" style={{ padding: 8, maxHeight: 160, overflow: 'auto', borderBottom: '1px solid var(--kb-border, #444)' }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>候选预览（确认后才 attach）</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {candidates.map((c) => (
              <li key={c.hwnd} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  className="kb-button"
                  disabled={busy}
                  data-testid={`nah-candidate-${c.hwnd}`}
                  onClick={() => void onSelectCandidate(c)}
                >
                  {c.title} — {c.path}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="kb-native-app-host__content"
        data-testid="nah-content"
        onClick={onContentClick}
        onMouseEnter={onContentMouseEnter}
        data-placeholder-blocks={placeholderBlocks ? 'true' : 'false'}
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: interaction === 'interacting' ? 'rgba(40,80,40,0.25)' : 'rgba(0,0,0,0.08)',
          cursor: bound ? 'pointer' : 'default',
          userSelect: 'none',
          // HOST-REPORT-0031 ②: after attach + not occluded, do not steal hits from native content
          pointerEvents: placeholderBlocks ? 'auto' : 'none',
        }}
      >
        {bound ? (
          <span style={{ opacity: 0.7 }}>
            {interaction === 'interacting' ? '交互中（编辑键交原应用）' : '已接入 · 点击进入交互（首击消费）'}
          </span>
        ) : (
          <span style={{ opacity: 0.55 }}>空白托管容器 · 点「选窗」枚举并确认接入</span>
        )}
      </div>
    </div>
  );
}
