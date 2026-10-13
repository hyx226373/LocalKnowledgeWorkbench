/**
 * 通用条目宿主：dockview 中所有面板都是它。面板参数只有 { itemId }；
 * 条目（WorkspaceItem）由工作区持有。宿主只做：查找适配器、还原/回写版本化状态、在不可用时显示占位。
 * 所有格式/来源相关的兼容逻辑都在适配器插件里。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { kb } from './kb';
import { adapters } from './plugin-host/registry';
import { pluginHost } from './plugin-host/host';
import { AUTO_ADAPTER, resolveItemAdapter, restoreItemState, sanitizeViewState, type ItemPanelParams, type WorkspaceItem } from './plugin-host/layoutModel';
import type { PlaceholderKind } from '../shared/adapter-sdk/types';
import { Placeholder } from './ui/Placeholder';
import { SandboxPanel } from './sandbox/SandboxPanel';
import type { AdapterTarget, PluginApi } from './plugin-host/types';
import type { FsChangeEvent, ResourceInfo } from '../shared/types';
import { externalUrlError } from '../shared/webPanel';
import { dialogs } from './ui/dialogs';
import { adapterOf } from '../shared/grants';
import { backgroundLoader, mountedViews, visibleContent } from './lazyLoad';
import { markRestoreContentReady } from './workspace-picker/restoreSignals';
import { panelManager } from './panel-manager/instance';

export interface ViewHostEnv {
  fsVersion: number;
  fsEvents?: FsChangeEvent[];
  apiFor(pluginId: string): PluginApi;
  getItem(itemId: string): WorkspaceItem | undefined;
  updateItem(itemId: string, patch: Partial<Pick<WorkspaceItem, 'adapterId' | 'state' | 'ref'>>): void;
  /** 占位动作“从工作区移除”：确认后关闭面板并删除条目 */
  removeItem(itemId: string): void;
  /** 打开插件管理（可聚焦某插件） */
  openPluginManager(focusPluginId?: string): void;
}
export const ViewHostCtx = React.createContext<ViewHostEnv>(null as unknown as ViewHostEnv);

class ViewErrorBoundary extends React.Component<{ adapterId: string; children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="kb-notice" data-testid="view-crashed">
        <h2>视图「{this.props.adapterId}」出错</h2>
        <div className="meta">{String(this.state.error.message)}</div>
        <button className="kb-button kb-button--secondary" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    );
  }
}

/**
 * 分级加载（第 9 轮 D）：面板第一次可见时才挂载内容；后台标签由 backgroundLoader 在空闲时放行。
 * 网页条目（renderer 'always'，WebSurface 需要随时跟随位置）不延后。
 */
function useArmed(props: IDockviewPanelProps<ItemPanelParams>, itemId: string, isWeb: boolean) {
  // 收起成气泡的面板（dockview 认为可见，但用户看不到）按后台标签处理；从气泡恢复时立即加载
  const shown = () => props.api.isVisible && !panelManager.isHiddenForLoad(itemId);
  const [armed, setArmed] = useState(() => isWeb || shown());
  useEffect(() => {
    if (armed) {
      backgroundLoader.markLoaded(itemId);
      return;
    }
    backgroundLoader.request(itemId, () => setArmed(true));
    const d = props.api.onDidVisibilityChange((e) => e.isVisible && shown() && setArmed(true));
    // 从气泡恢复（浮动窗口取消隐藏，dockview 的可见性不变）
    const unsub = panelManager.subscribe(() => shown() && setArmed(true));
    return () => {
      d.dispose();
      unsub();
      backgroundLoader.cancel(itemId);
    };
  }, [armed, itemId, props.api]);
  // 标签上标记 data-lazy="pending"（主题组件 tab 的说明里有这个属性）。恢复布局时面板可能还没登记到容器里，下一帧再试
  useEffect(() => {
    let raf = 0;
    let tries = 0;
    const apply = () => {
      const tab = (props.containerApi.getPanel(props.api.id) as unknown as { view?: { tab?: { element?: HTMLElement } } } | undefined)?.view?.tab?.element;
      if (!tab) {
        if (tries++ < 10) raf = requestAnimationFrame(apply);
        return;
      }
      const el = (tab.closest('.dv-tab') as HTMLElement | null) ?? tab;
      if (armed) el.removeAttribute('data-lazy');
      else el.setAttribute('data-lazy', 'pending');
    };
    apply();
    return () => cancelAnimationFrame(raf);
  }, [armed, props.api.id, props.containerApi]);
  useEffect(() => {
    if (!armed) return;
    mountedViews.add(itemId);
    return () => void mountedViews.delete(itemId);
  }, [armed, itemId]);
  useEffect(() => () => visibleContent.drop(itemId), [itemId]);
  return armed;
}

/** 没有自己报告就绪的内容（占位、沙箱、未声明 reportsReady 的适配器）：挂载后的下一帧视为就绪 */
function ReadyOnMount({ onReady }: { onReady: () => void }) {
  useEffect(() => {
    const r = requestAnimationFrame(() => onReady());
    return () => cancelAnimationFrame(r);
  }, [onReady]);
  return null;
}

function sameResource(a: ResourceInfo, b: ResourceInfo): boolean {
  return a.resourceId === b.resourceId && a.size === b.size && a.mtimeMs === b.mtimeMs && a.name === b.name && a.exists === b.exists;
}

export function ViewHost(props: IDockviewPanelProps<ItemPanelParams>) {
  const env = React.useContext(ViewHostCtx);
  const itemId = props.params.itemId;
  const [, bump] = useState(0);
  const item = env.getItem(itemId);
  const armed = useArmed(props, itemId, item?.sourceKind === 'web');
  const regVersion = useSyncExternalStore(
    (cb) => adapters.subscribe(cb),
    () => adapters.getVersion(),
  );
  const pluginsVersion = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.list(),
  );
  const [res, setRes] = useState<ResourceInfo | null | undefined>(undefined);
  const [retryN, setRetryN] = useState(0);
  /** “用内置阅读器打开（仅本次）”：不改写条目的 adapterId / state */
  const [override, setOverride] = useState<string | null>(null);
  const isFile = item?.sourceKind === 'file';
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!item || !isFile || !armed) return;
    const events = env.fsEvents ?? [];
    const affects = events.some((e) => e.resourceId === item.ref || !e.resourceId || e.relPath === '');
    if (events.length > 0 && !affects && loadedRef.current === item.ref) return;
    let alive = true;
    kb.getResource(item.ref).then((r) => {
      if (!alive) return;
      loadedRef.current = item.ref;
      setRes((prev) => (prev && r && sameResource(prev, r) ? prev : r));
    });
    return () => {
      alive = false;
    };
  }, [item?.ref, isFile, env.fsVersion, env.fsEvents, retryN, armed]);

  const target: AdapterTarget | null = !item
    ? null
    : item.sourceKind === 'file'
      ? res
        ? { sourceKind: 'file', resource: res }
        : null
      : item.sourceKind === 'web'
        ? { sourceKind: 'web', url: item.ref }
        : { sourceKind: 'app', appProfileId: item.ref };

  const resolved = useMemo(
    () =>
      item && (target || !isFile)
        ? resolveItemAdapter(item, (id) => adapters.get(id), () => (target ? adapters.best(target) : undefined), (id) => pluginHost.adapterOwnerStatus(id))
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [item?.adapterId, item?.sourceKind, res, regVersion, pluginsVersion],
  );
  /** 内置（非沙箱）阅读器中最匹配的一个，供 open-with-default 使用 */
  const builtinAlt = useMemo(() => {
    if (!target || target.sourceKind !== 'file') return undefined;
    return adapters
      .resolve(target)
      .find((a) => !a.sandbox && a.id !== item?.adapterId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res, regVersion, item?.adapterId]);

  // 'auto'（旧版布局迁移而来）解析后固化为具体适配器
  useEffect(() => {
    if (item?.adapterId === AUTO_ADAPTER && resolved?.kind === 'adapter') {
      env.updateItem(itemId, { adapterId: resolved.adapter.id });
      bump((n) => n + 1);
    }
  }, [item?.adapterId, resolved, env, itemId]);

  const overrideAdapter = override ? adapters.get(override) : undefined;
  const adapter = overrideAdapter ?? (resolved?.kind === 'adapter' ? resolved.adapter : undefined);
  // 视图状态：适配器（首次）确定时从条目还原一次；之后由视图通过 setState 回写（临时改用的内置阅读器不读写条目状态）
  const stateRef = useRef<{ adapterId: string | undefined; state: unknown }>({ adapterId: undefined, state: undefined });
  if (adapter && item && stateRef.current.adapterId !== adapter.id) {
    stateRef.current = { adapterId: adapter.id, state: overrideAdapter ? undefined : restoreItemState(item.state, adapter) };
  }
  const [, force] = useState(0);
  const setState = useCallback(
    (s: unknown) => {
      if (!adapter) return;
      stateRef.current = { ...stateRef.current, state: s };
      force((n) => n + 1);
      if (overrideAdapter) return;
      let ser: unknown = s;
      try {
        ser = adapter.serializeState ? adapter.serializeState(s) : s;
      } catch {
        return;
      }
      const { state } = sanitizeViewState(ser);
      env.updateItem(itemId, { state: state === undefined ? undefined : { v: adapter.stateSchemaVersion ?? 1, data: state } });
    },
    [adapter, overrideAdapter, env, itemId],
  );
  const onSandboxState = useCallback((envelope: { v: number; data: unknown } | null) => env.updateItem(itemId, { state: (envelope ?? undefined) as WorkspaceItem['state'] }), [env, itemId]);
  const onTitle = useCallback((t: string) => props.api.setTitle(t), [props.api]);
  // 网页面板：标签隐藏时保留 DOM（renderer 'always'），网页视图不因切换标签而重建（位置跟随见 WebSurface）
  const isWebItem = item?.sourceKind === 'web';
  useEffect(() => {
    if (isWebItem && props.api.renderer !== 'always') props.api.setRenderer('always');
  }, [isWebItem, props.api]);

  const reportReady = useCallback(() => {
    visibleContent.reportReady(itemId);
    markRestoreContentReady(itemId);
  }, [itemId]);

  if (!armed)
    return (
      <div className="kb-notice kb-lazy" data-testid="lazy-pending" data-item-id={itemId}>
        <div className="meta">切换到此标签时加载</div>
      </div>
    );
  if (!item)
    return (
      <div className="kb-notice" data-testid="item-missing">
        <h2>条目不存在</h2>
      </div>
    );

  const placeholder = (kind: PlaceholderKind, adapterId: string, detail?: string, retry?: () => void) => {
    const owner = pluginHost.adapterOwner(adapterId);
    const ownerId = owner?.manifest.id;
    // 网页条目：首页取自适配器声明；系统浏览器只接受 https（D2，主进程再查一次）
    const webDecl = item.sourceKind === 'web' && ownerId ? adapterOf(pluginHost.sandboxPlugin(ownerId)?.manifest, adapterId) : undefined;
    const home = webDecl?.web?.homeUrl;
    const extErr = item.sourceKind === 'web' ? externalUrlError(item.ref) : 'not web';
    return (
      <>
      <ReadyOnMount onReady={reportReady} />
      <Placeholder
        kind={kind}
        item={item}
        adapterId={adapterId}
        pluginName={owner?.manifest.name}
        detail={detail}
        meta={res ? `文件：${res.relPath}` : undefined}
        actions={{
          'install-plugin': () => env.openPluginManager(),
          'enable-plugin': ownerId ? () => void pluginHost.setEnabled(ownerId, true) : undefined,
          'review-permission': ownerId ? () => env.openPluginManager(ownerId) : undefined,
          'open-with-default': builtinAlt ? () => setOverride(builtinAlt.id) : undefined,
          'go-home':
            home && home !== item.ref
              ? () => {
                  env.updateItem(itemId, { ref: home, state: undefined });
                  bump((n) => n + 1);
                }
              : undefined,
          'open-in-system-browser':
            extErr === null
              ? async () => {
                  const ok = await dialogs.confirm({
                    title: '用系统浏览器打开？',
                    body: `这个地址不在适配器允许的域名内，将用系统默认浏览器打开：\n${item.ref}\n\n只有 https 地址可以这样打开。`,
                    ok: '用系统浏览器打开',
                  });
                  if (!ok) return;
                  const r = await kb.webOpenExternal(item.ref, { pluginId: ownerId, adapterId });
                  if (!r.ok) await dialogs.alert({ title: '无法打开', body: r.reason ?? '地址不被允许' });
                }
              : undefined,
          retry: () => {
            setRetryN((n) => n + 1);
            retry?.();
          },
          'remove-item': () => env.removeItem(itemId),
        }}
      />
      </>
    );
  };

  if (isFile && res === undefined) return <div className="kb-notice">加载中…</div>;
  if (!overrideAdapter) {
    // SDK §5.1：适配器 → 阶段 → 资源 → 权限 → 范围预检
    if (!resolved && !(isFile && (res === null || !res?.exists))) return <div className="kb-notice">加载中…</div>;
    if (resolved?.kind === 'placeholder') {
      const owner = pluginHost.adapterOwner(resolved.adapterId);
      const detail = resolved.detail ?? (resolved.reason === 'adapter-incompatible' ? owner?.message ?? '提供此视图的插件与当前版本不兼容' : resolved.reason === 'adapter-error' ? owner?.message ?? '激活失败' : undefined);
      return placeholder(resolved.reason, resolved.adapterId, detail);
    }
    if (isFile && (res === null || !res?.exists)) return placeholder('resource-missing', item.adapterId);
  }
  if (!adapter) return <div className="kb-notice">加载中…</div>;
  if (adapter.sandbox && !overrideAdapter)
    return (
      <div className="view-root" data-view-type={adapter.id} data-item-id={itemId}>
        <ReadyOnMount onReady={reportReady} />
        <SandboxPanel
          item={item}
          resource={res ?? null}
          adapter={adapter}
          onState={onSandboxState}
          onTitle={onTitle}
          renderPlaceholder={(kind, detail, retry) => placeholder(kind, adapter.id, detail, retry)}
        />
      </div>
    );
  const V = adapter.component;
  return (
    <ViewErrorBoundary adapterId={adapter.id}>
      <div className="view-root" data-view-type={adapter.id} data-item-id={itemId} data-override={overrideAdapter ? 'true' : undefined}>
        {overrideAdapter && (
          <div className="kb-sandbox-notice" role="status" data-testid="override-notice">
            正在用「{overrideAdapter.title}」临时打开（不改变此条目的适配器）。
            <button className="kb-button kb-button--ghost kb-button--small" onClick={() => setOverride(null)}>
              恢复
            </button>
          </div>
        )}
        {!adapter.reportsReady && <ReadyOnMount onReady={reportReady} />}
        <V
          reportReady={adapter.reportsReady ? reportReady : undefined}
          key={adapter.id + ':' + (res ? (adapter.handlesFileChanges ? res.resourceId : res.mtimeMs + ':' + res.size) : item.ref)}
          item={item}
          resource={res as ResourceInfo}
          state={stateRef.current.state}
          setState={setState}
          api={env.apiFor(adapter.owner)}
        />
      </div>
    </ViewErrorBoundary>
  );
}
