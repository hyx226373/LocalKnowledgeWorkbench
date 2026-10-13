/**
 * 逐站授权的渲染进程侧（第 11 轮 A，SDK 修订 10）：“允许访问 <host>？”对话框、本会话拒绝的主机、授权缓存刷新。
 * 真正的检查在主进程（webPanels / pluginHost.webAccess）；这里只决定何时询问、显示占位。
 */
import React from 'react';
import { kb } from '../kb';
import { pluginHost } from '../plugin-host/host';
import { dialogs } from '../ui/dialogs';
import { findGrant } from '../../shared/grants';
import { isAskPerSite, isHostAllowed } from '../../shared/adapter-sdk/policy';
import type { AdapterContribution, NetPermission } from '../../shared/adapter-sdk/types';
import { netDecl } from '../../shared/webPanel';

export type SiteStatus = 'granted' | 'prompt' | 'session-denied' | 'revoked';

const deniedThisSession = new Set<string>();
const inflight = new Map<string, Promise<boolean>>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => {
  version++;
  listeners.forEach((l) => l());
};

/** 逐站授权声明（只有内置适配器会有） */
export function perSiteDecl(decl: Pick<AdapterContribution, 'permissions'> | undefined): NetPermission | undefined {
  const n = netDecl(decl);
  return n && isAskPerSite(n) ? n : undefined;
}

export const siteAccess = {
  subscribe(cb: () => void) {
    listeners.add(cb);
    return () => void listeners.delete(cb);
  },
  getVersion: () => version,

  /** 当前允许的主机：声明 domains ∪ 已批准的 grantedHosts（插件级记录有效时） */
  allowedHosts(pluginId: string, adapterId: string, n: NetPermission): string[] {
    const decision = pluginHost.decision(pluginId, adapterId, n);
    const g = findGrant(pluginHost.grantsOf(pluginId), pluginId, adapterId, n.id);
    return [...new Set([...(n.domains ?? []), ...(decision === 'granted' ? (g?.grantedHosts ?? []) : [])])];
  },

  status(pluginId: string, adapterId: string, n: NetPermission, host: string): SiteStatus {
    if (pluginHost.decision(pluginId, adapterId, n) === 'denied') return 'revoked';
    if (isHostAllowed(host, this.allowedHosts(pluginId, adapterId, n))) return 'granted';
    if (deniedThisSession.has(`${pluginId}|${host}`)) return 'session-denied';
    return 'prompt';
  },

  forgetDenial(pluginId: string, host: string) {
    if (deniedThisSession.delete(`${pluginId}|${host}`)) bump();
  },

  /**
   * 询问用户是否允许访问 host（同一主机同时只弹一次）。允许 → 主进程写入 grantedHosts 并刷新已打开面板；
   * 拒绝 → 记入本会话拒绝列表（不写盘；重启后再次打开时重新询问）。
   */
  ask(o: { pluginId: string; pluginName: string; adapterId: string; host: string; url: string; purpose?: 'page' | 'resource' | 'file' }): Promise<boolean> {
    const key = `${o.pluginId}|${o.host}`;
    const cur = inflight.get(key);
    if (cur) return cur;
    const p = (async () => {
      const allow = await siteDialog(o);
      if (allow) {
        const g = await kb.webGrantSite(o.pluginId, o.adapterId, o.host);
        deniedThisSession.delete(key);
        pluginHost.applyGrant(g);
      } else deniedThisSession.add(key);
      bump();
      return allow;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  },

  async revokeSite(pluginId: string, adapterId: string, host: string) {
    pluginHost.applyGrant(await kb.webRevokeSite(pluginId, adapterId, host));
    bump();
  },
};

function SiteBody({ o, done }: { o: { pluginName: string; host: string; url: string; purpose?: string }; done: (v: boolean) => void }) {
  const insecure = /^http:\/\//i.test(o.url);
  return (
    <>
      <div className="kb-dialog-body kb-perm-body" data-testid="site-dialog-body" data-host={o.host}>
        <div className="kb-perm-lead">
          允许「<b>{o.pluginName}</b>」访问 <b data-testid="site-host">{o.host}</b>？
        </div>
        <dl className="kb-perm-facts">
          <dt>{o.purpose === 'resource' ? '用途' : '地址'}</dt>
          <dd>
            {o.purpose === 'resource' ? '加载当前网页需要的图片、样式或脚本' : <code>{o.url.length > 160 ? o.url.slice(0, 160) + '…' : o.url}</code>}
          </dd>
          <dt>范围</dt>
          <dd>只允许这一个网站（{o.host}）；其他网站打开时会再次询问。不允许 IP 地址、端口、本地文件。</dd>
          {insecure && (
            <>
              <dt>注意</dt>
              <dd data-testid="site-insecure">这是不加密的 http 连接，内容可能被网络中的他人查看或篡改。</dd>
            </>
          )}
          <dt>来源</dt>
          <dd>随应用内置的网页适配器 · 网站数据存放在独立分区，不与其他插件共享</dd>
        </dl>
        <div className="meta">可以随时在“插件管理”中撤销已允许的网站。拒绝后本次运行期间不再询问，面板显示占位，可改用系统浏览器打开。</div>
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" data-testid="site-deny" onClick={() => done(false)}>
          拒绝
        </button>
        <button className="kb-button" data-testid="site-allow" onClick={() => done(true)}>
          允许访问 {o.host}
        </button>
      </div>
    </>
  );
}

/** 授权对话框不用 data-testid="dialog"（e2e 的通用自动确认不会替用户点“允许”） */
export function siteDialog(o: { pluginName: string; host: string; url: string; purpose?: string }): Promise<boolean> {
  return dialogs.custom<boolean>({ title: '允许访问网站？', testid: 'site-dialog', cancelValue: false, render: (done) => <SiteBody o={o} done={done} /> });
}
