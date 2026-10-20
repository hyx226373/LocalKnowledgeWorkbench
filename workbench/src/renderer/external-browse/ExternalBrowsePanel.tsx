/**
 * 主窗口内容区里的外链标签。地址栏、后退、刷新、用系统浏览器打开。
 * 网页本身是主进程的 WebContentsView，盖在占位元素上，不另开系统窗口。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { browseTabTitle as titleOf } from '../../shared/externalBrowse';
import { webSlotCovered } from '../sandbox/WebSurface';
import type { WebBounds } from '../../shared/webPanel';

function slotBounds(el: HTMLElement | null): { bounds: WebBounds | null; covered: boolean } {
  if (!el || !el.isConnected) return { bounds: null, covered: false };
  const r = el.getBoundingClientRect();
  const visible = r.width >= 2 && r.height >= 2 && (el.checkVisibility?.({ visibilityProperty: true } as never) ?? true);
  if (!visible) return { bounds: null, covered: false };
  const covered = webSlotCovered(el, r);
  if (covered) return { bounds: null, covered: true };
  const x = Math.round(r.left);
  const y = Math.round(r.top);
  const right = Math.min(Math.round(r.right), window.innerWidth);
  const bottom = Math.min(Math.round(r.bottom), window.innerHeight);
  let b: WebBounds = { x: Math.max(0, x), y: Math.max(0, y), width: right - Math.max(0, x), height: bottom - Math.max(0, y) };
  if (el.closest('.dv-resize-container')) {
    const edge = 8;
    b = { x: b.x + edge, y: b.y, width: Math.max(0, b.width - edge * 2), height: Math.max(0, b.height - edge) };
  }
  if (b.width < 2 || b.height < 2) return { bounds: null, covered: false };
  return { bounds: b, covered: false };
}

export function ExternalBrowsePanel(props: IDockviewPanelProps<{ browseId?: string; url?: string }>) {
  const browseId = String(props.params.browseId ?? props.api.id);
  const initialUrl = String(props.params.url ?? '');
  const slotRef = useRef<HTMLDivElement>(null);
  const editing = useRef(false);
  const [draft, setDraft] = useState(initialUrl);
  const [url, setUrl] = useState(initialUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [covered, setCovered] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void kb.extBrowseCreate(browseId, initialUrl).then((r) => {
      if (!alive) {
        void kb.extBrowseDestroy(browseId);
        return;
      }
      if (!r?.ok) setNotice(r?.reason || '无法打开');
    }).catch((err: unknown) => {
      if (alive) setNotice(String((err as Error)?.message ?? err));
    });
    return () => {
      alive = false;
      void kb.extBrowseDestroy(browseId);
    };
  }, [browseId, initialUrl]);

  useEffect(() => {
    return kb.onExtBrowse((ev) => {
      if (ev.type === 'open') return;
      if (ev.viewId !== browseId) return;
      if (ev.type === 'nav') {
        setUrl(ev.url);
        if (!editing.current) setDraft(ev.url);
        setCanGoBack(ev.canGoBack);
        if (ev.title) props.api.setTitle(ev.title.slice(0, 80));
        else props.api.setTitle(titleOf(ev.url));
        setNotice('');
      } else if (ev.type === 'load') {
        setLoading(ev.state === 'loading');
        if (ev.state === 'failed' && ev.error) setNotice(ev.error);
      } else if (ev.type === 'blocked') {
        setNotice(ev.reason);
      }
    });
  }, [browseId, props.api]);

  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const next = slotBounds(slotRef.current);
      const key = next.bounds ? `${next.bounds.x},${next.bounds.y},${next.bounds.width},${next.bounds.height}` : 'hidden';
      if (key !== last) {
        last = key;
        kb.sendWebBounds(browseId, next.bounds);
      }
      setCovered((prev) => (prev === next.covered ? prev : next.covered));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      kb.sendWebBounds(browseId, null);
    };
  }, [browseId]);

  useEffect(() => {
    if (!covered) return;
    let alive = true;
    void kb.extBrowseSnapshot(browseId).then((s) => {
      if (alive && s) setShot(s);
    }).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [covered, browseId]);

  const go = (next: string) => {
    setNotice('');
    void kb.extBrowseNavigate(browseId, next).then((r) => {
      if (!r?.ok) setNotice(r?.reason || '无法打开');
      else if (r.url) {
        setDraft(r.url);
        setUrl(r.url);
      }
    }).catch((err: unknown) => setNotice(String((err as Error)?.message ?? err)));
  };

  const openSystem = () => {
    const target = url || draft;
    if (!target) return;
    void dialogs.confirm({
      title: '用系统浏览器打开？',
      body: `将用系统默认浏览器打开：\n${target}`,
      ok: '用系统浏览器打开',
      cancel: '取消',
    }).then((ok) => {
      if (!ok) return;
      return kb.extBrowseOpenSystem(browseId);
    }).then((r) => {
      if (r && r.ok === false) void dialogs.alert({ title: '无法打开', body: r.reason ?? '地址不被允许' });
    }).catch((err: unknown) => {
      void dialogs.alert({ title: '无法打开', body: String((err as Error)?.message ?? err) });
    });
  };

  const insecure = /^http:\/\//i.test(url) || (!/^https?:\/\//i.test(url) && url.includes(':'));
  return (
    <div className="kb-web kb-ext-browse" data-testid="ext-browse" data-view-id={browseId} data-url={url}>
      <div className="kb-web-bar" data-testid="ext-browse-toolbar">
        <button type="button" className="kb-button kb-button--ghost kb-button--small" title="后退" aria-label="后退" disabled={!canGoBack} data-testid="ext-browse-back" onClick={() => void kb.extBrowseBack(browseId)}>
          ←
        </button>
        <button type="button" className="kb-button kb-button--ghost kb-button--small" title="刷新" aria-label="刷新" data-testid="ext-browse-reload" onClick={() => void kb.extBrowseReload(browseId)}>
          ⟳
        </button>
        <form className="kb-web-address kb-ext-address" onSubmit={(e) => { e.preventDefault(); go(draft); }}>
          {loading && <span className="kb-web-spinner" aria-hidden="true" />}
          {insecure && url && (
            <span className="kb-web-insecure" data-testid="ext-browse-insecure" title="不是 https，或不是网页地址">
              不安全
            </span>
          )}
          <input
            data-testid="ext-browse-address"
            aria-label="地址"
            value={draft}
            spellCheck={false}
            placeholder="输入网址"
            onFocus={() => { editing.current = true; }}
            onBlur={() => { editing.current = false; setDraft(url || draft); }}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
        <button type="button" className="kb-button kb-button--small" data-testid="ext-browse-open-system" onClick={openSystem}>
          用系统浏览器打开
        </button>
      </div>
      {notice && (
        <div className="kb-web-banner" role="status" data-testid="ext-browse-notice">
          <span>{notice}</span>
          <button type="button" className="kb-button kb-button--ghost kb-button--small" onClick={() => setNotice('')}>关闭</button>
        </div>
      )}
      <div className="kb-web-slot" ref={slotRef} data-testid="ext-browse-slot">
        {covered && (shot
          ? <img className="kb-web-shot" src={shot} alt="" data-testid="ext-browse-shot" />
          : <div className="kb-web-hidden meta">外链页面被菜单或对话框挡住时暂时隐藏</div>)}
      </div>
    </div>
  );
}
