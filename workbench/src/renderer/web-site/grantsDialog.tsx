/**
 * 网页外部资源授权。查看和撤销都在这个对话框里，写的是应用数据目录里的配置，不是资料文件。
 */
import React, { useEffect, useRef, useState } from 'react';
import { kb } from '../kb';
import { KbToggle } from '../settings/KbToggle';
import { dialogs } from '../ui/dialogs';
import { GLOBAL_NEVER_BLOCK_WARNING, type WebSiteApplyRequest, type WebSiteGrantRow } from '../../shared/webSiteGrant';
import { noteExternalBrowsePrefs } from '../external-browse/openTab';

interface Listed {
  file: string;
  globalNeverBlock: boolean;
  allowOpenExternal?: boolean;
  trustInsecureLinks?: boolean;
  sites: WebSiteGrantRow[];
}

const DECISION: Record<WebSiteGrantRow['decision'], string> = {
  allow: '允许',
  deny: '拒绝',
  'never-block': '从不拦截',
};

const SOURCE: Record<WebSiteGrantRow['source'], string> = {
  manual: '手动选择',
  'allow-all': '一键全部允许',
};

export function openWebSiteGrants(): Promise<void> {
  return dialogs.custom<void>({
    title: '网页外部资源授权',
    testid: 'web-site-grants',
    wide: true,
    cancelValue: undefined,
    render: (done) => <WebSiteGrantsBody done={() => done(undefined)} />,
  });
}

export function WebSiteGrantsBody({ done, embedded = false }: { done?: () => void; embedded?: boolean }) {
  const [listed, setListed] = useState<Listed | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const reload = () => {
    void kb.webSiteList().then((next) => {
      setListed(next);
      noteExternalBrowsePrefs(next);
    }).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  };
  useEffect(reload, []);
  const apply = (req: WebSiteApplyRequest) => {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    void kb.webSiteApply(req)
      .then(() => kb.webSiteList())
      .then((next) => {
        setListed(next);
        noteExternalBrowsePrefs(next);
      })
      .catch((err: unknown) => {
        setError(String((err as Error)?.message ?? err));
      })
      .finally(() => {
        writing.current = false;
        setBusy(false);
      });
  };
  const turnGlobal = (enabled: boolean) => apply({ actionId: 'web.neverBlock', global: true, enabled });
  return (
    <>
      <div className="kb-dialog-body" data-testid="web-site-grants-body">
        <p className="kb-set-banner kb-set-banner--info" data-testid="web-site-global-warning">{GLOBAL_NEVER_BLOCK_WARNING}。关掉之后会重新按网站询问。</p>
        <section className="kb-set-card kb-set-card--list">
          <KbToggle testId="web-site-global-toggle" checked={listed?.globalNeverBlock === true} busy={busy} disabled={busy || listed === null} onChange={turnGlobal}>
            从不拦截外部资源（全部网页面板）
          </KbToggle>
          <div data-testid="ext-browse-settings">
            <KbToggle testId="ext-browse-allow" checked={listed ? listed.allowOpenExternal !== false : false} busy={busy} disabled={busy || listed === null} onChange={(enabled) => apply({ actionId: 'web.allowOpenExternal', enabled })}>
              允许打开外链（应用内标签打开）
            </KbToggle>
            <p className="meta">默认开启。关闭时，外链仍按原来的方式拦截，不在应用内打开。</p>
            <KbToggle testId="ext-browse-trust" checked={listed?.trustInsecureLinks === true} busy={busy} disabled={busy || listed === null} onChange={(enabled) => apply({ actionId: 'web.trustInsecureLinks', enabled })}>
              信任不安全链接
            </KbToggle>
            <p className="meta">默认关闭。打开后，file:// 等非 http 链接也在应用内打开。javascript: 始终拒绝。</p>
          </div>
        </section>
        <p className="meta kb-set-chip" data-testid="web-site-grant-file">
          配置文件（不在资料里）：{listed?.file ?? '…'}
        </p>
        {error && <p data-testid="web-site-grants-error">{error}</p>}
        <ul className="kb-web-grant-list kb-set-table" data-testid="web-site-grant-list">
          {(listed?.sites ?? []).length === 0 && <li className="meta">还没有保存的网站授权。</li>}
          {(listed?.sites ?? []).map((row) => (
            <li key={row.site} data-testid={`web-site-saved-${row.site}`} data-decision={row.decision} data-source={row.source} data-persistence={row.persistence}>
              <span>
                {row.site} · {DECISION[row.decision]}
                {row.persistence === 'session' ? '（本次）' : ''} · {SOURCE[row.source]}
              </span>
              <button className="kb-button kb-button--ghost kb-button--small" data-testid={`web-site-revoke-${row.site}`} onClick={() => void kb.webSiteApply({ actionId: 'web.revokeSite', site: row.site }).then(reload)}>
                撤销
              </button>
            </li>
          ))}
        </ul>
      </div>
      {!embedded && (
        <div className="kb-dialog-actions">
          <button className="kb-button" data-testid="web-site-grants-close" onClick={done}>
            关闭
          </button>
        </div>
      )}
    </>
  );
}
