/**
 * 插件管理（H3 撤销 / H7 卸载 / D7 开发者模式安装）。
 * 第三方插件只有一种来源：开启开发者模式后从本地文件夹安装（未签名，无市场）。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { pluginHost, type PluginRecord } from '../plugin-host/host';
import { describePermission, displayModeLabel } from '../../shared/adapter-sdk/policy';
import { findGrant, grantDecision } from '../../shared/grants';
import type { AdapterPluginDto, AuditEntry, AuditKind, PluginProcessInfo } from '../../shared/pluginIpc';
import type { Root } from '../../shared/types';
import { KbToggle } from '../settings/KbToggle';
import { PluginEnableSwitch } from '../settings/PluginEnableSwitch';
import { dialogs } from './dialogs';
import { fmtBytes } from './adapterDialogs';
import { siteAccess } from '../web-resources/siteAccess'; // r11-A 逐站授权：撤销已允许的网站
import { isAskPerSite } from '../../shared/adapter-sdk/policy';

function PermRows({ d, roots }: { d: AdapterPluginDto; roots: Root[] }) {
  if (!d.manifest) return null;
  return (
    <>
      {d.manifest.contributes.adapters.map((a) => (
        <div key={a.id} className="kb-pm-adapter" data-testid={`pm-adapter-${a.id}`}>
          <div>
            <b>{a.title}</b> <span className="meta">{a.id} · {displayModeLabel(a)}</span>
          </div>
          {a.permissions.length === 0 && <div className="meta">不需要任何权限</div>}
          {a.permissions.map((p) => {
            const { decision } = grantDecision(d.grants, d.id, a.id, p);
            const g = findGrant(d.grants, d.id, a.id, p.id);
            const changed = !!g && g.decision === 'granted' && decision === 'prompt';
            const rootsText =
              decision === 'granted' && p.kind === 'fs.read' && g?.rootIds
                ? g.rootIds === 'all'
                  ? '全部文件夹'
                  : g.rootIds.map((id) => roots.find((r) => r.id === id)?.name ?? '(已移除的文件夹)').join('、') || '（未选择文件夹）'
                : '';
            const tid = `${a.id}-${p.id}`;
            return (
              <div key={p.id} className="kb-pm-perm" data-testid={`pm-perm-${tid}`} data-decision={decision}>
                <div>
                  <span className="kb-badge" data-status={decision === 'granted' ? 'active' : decision === 'denied' ? 'denied' : 'disabled'}>
                    {decision === 'granted' ? '已允许' : decision === 'denied' ? (g?.declHash === '*' ? '已撤销' : '已拒绝') : changed ? '声明已变化，需重新询问' : '尚未询问'}
                  </span>{' '}
                  {p.reason}
                  {p.optional && <span className="meta">（可选）</span>}
                </div>
                <div className="meta">
                  {describePermission(p).join('；')}
                  {rootsText && <> · 已允许：{rootsText}</>}
                </div>
                {p.kind === 'net' && isAskPerSite(p) && (
                  <div className="kb-pm-sites" data-testid={`pm-sites-${tid}`}>
                    {(g?.grantedHosts ?? []).length === 0 ? (
                      <span className="meta">尚未允许任何网站（首次访问时逐站询问）</span>
                    ) : (
                      (g?.grantedHosts ?? []).map((h) => (
                        <span key={h} className="kb-pm-site" data-host={h}>
                          {h}{' '}
                          <button className="kb-button kb-button--secondary kb-button--small" data-testid={`site-revoke-${h}`} onClick={() => void siteAccess.revokeSite(d.id, a.id, h)}>
                            撤销
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                )}
                <div className="kb-pm-actions">
                  {decision === 'granted' && (
                    <button className="kb-button kb-button--secondary kb-button--small" data-testid={`perm-revoke-${tid}`} onClick={() => void pluginHost.revoke(d.id, a.id, p.id)}>
                      撤销
                    </button>
                  )}
                  <button className="kb-button kb-button--secondary kb-button--small" data-testid={`perm-change-${tid}`} onClick={() => void pluginHost.ensurePermission(d.id, a, p, true)}>
                    {decision === 'granted' && p.kind === 'fs.read' && p.scope === 'ask-per-root' ? '更改文件夹…' : decision === 'granted' ? '重新询问…' : '改为允许…'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

const AUDIT_TEXT: Record<AuditKind, string> = {
  denied: '拒绝访问',
  grant: '授权变更',
  'plan-submitted': '提交批量计划',
  'plan-blocked': '计划被拦截',
  'plan-approved': '计划已批准',
  'plan-failed': '计划执行失败',
  'plan-rejected': '计划被拒绝',
  watchdog: '看门狗停止',
  timeout: '调用超时',
  'web-blocked': '网页访问被拦截',
  'web-external': '用系统浏览器打开',
  'app-launch': '启动外部程序',
  'app-blocked': '拒绝启动外部程序',
  'app-exit': '外部程序退出',
};
const AUDIT_TONE: Partial<Record<AuditKind, string>> = { denied: 'denied', 'plan-blocked': 'denied', 'plan-failed': 'denied', watchdog: 'error', timeout: 'error', 'plan-approved': 'active', 'web-blocked': 'denied' };
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 审计记录：授权拒绝、越界读取、批量计划、看门狗（主进程 plugin_audit 表，每插件最多 500 条） */
function AuditLog({ pluginId, refresh }: { pluginId: string; refresh: number }) {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [filter, setFilter] = useState<'all' | 'problems'>('all');
  useEffect(() => {
    let alive = true;
    void kb.listPluginAudit(pluginId, 200).then((r) => alive && setRows(r));
    return () => {
      alive = false;
    };
  }, [pluginId, refresh]);
  const shown = (rows ?? []).filter((r) => filter === 'all' || AUDIT_TONE[r.kind] === 'denied' || AUDIT_TONE[r.kind] === 'error');
  const problems = (rows ?? []).filter((r) => AUDIT_TONE[r.kind] === 'denied' || AUDIT_TONE[r.kind] === 'error').length;
  return (
    <details className="kb-pm-audit" data-testid={`pm-audit-${pluginId}`}>
      <summary>
        审计记录（{rows?.length ?? '…'} 条{problems ? `，其中拒绝/异常 ${problems} 条` : ''}）
      </summary>
      <div className="kb-pm-audit-tools">
        <KbToggle testId={`pm-audit-filter-${pluginId}`} checked={filter === 'problems'} onChange={(next) => setFilter(next ? 'problems' : 'all')}>
          只看拒绝与异常
        </KbToggle>
      </div>
      {rows && rows.length === 0 && <div className="meta">暂无记录。</div>}
      <ul className="kb-pm-audit-list">
        {shown.map((r) => (
          <li key={r.id} data-testid="audit-row" data-kind={r.kind}>
            <span className="meta kb-pm-audit-time">{fmtTime(r.lastAt)}</span>{' '}
            <span className="kb-badge" data-status={AUDIT_TONE[r.kind] ?? 'disabled'}>
              {AUDIT_TEXT[r.kind] ?? r.kind}
            </span>{' '}
            <span className="kb-pm-audit-detail">{r.detail}</span>
            {r.count > 1 && <span className="meta"> ×{r.count}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function PluginManager({ focus, onClose, onUninstall, embedded = false }: { focus?: string; onClose(): void; onUninstall(d: AdapterPluginDto): Promise<void>; embedded?: boolean }) {
  const list = useSyncExternalStore(
    (cb) => pluginHost.subscribe(cb),
    () => pluginHost.list(),
  );
  const [dev, setDev] = useState(false);
  const [devBusy, setDevBusy] = useState(false);
  const devWriting = useRef(false);
  const [roots, setRoots] = useState<Root[]>([]);
  const [busy, setBusy] = useState(false);
  const [procs, setProcs] = useState<PluginProcessInfo[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // 进程与审计每 2 秒刷新一次（管理窗口打开期间）
    const f = () => {
      void kb.pluginProcesses().then(setProcs, () => undefined);
      setTick((n) => n + 1);
    };
    f();
    const iv = setInterval(f, 2000);
    return () => clearInterval(iv);
  }, []);
  useEffect(() => {
    void kb.getDevMode().then(setDev);
    void kb.listRoots().then(setRoots);
    void pluginHost.reloadSandboxed();
  }, []);
  useEffect(() => {
    if (focus) document.querySelector(`[data-testid="pm-plugin-${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus, list]);
  const sandboxed = pluginHost.sandboxPlugins();
  const builtin = list.filter((r) => r.kind !== 'sandbox');
  const install = async () => {
    setBusy(true);
    try {
      const d = await kb.installAdapterPluginFromFolder();
      if (!d) return;
      await pluginHost.reloadSandboxed();
      if (d.errors.length) await dialogs.alert({ title: '插件已复制，但不兼容', body: d.errors.slice(0, 8).join('\n') });
    } catch (e) {
      await dialogs.alert({ title: '安装失败', body: String((e as Error).message ?? e).replace(/^Error invoking remote method 'kb': (Error: )?/, '') });
    } finally {
      setBusy(false);
    }
  };
  const row = (r: PluginRecord) => {
    const id = r.manifest?.id;
    if (!id) return null;
    return (
      <div className="kb-plugin-row" key={id} data-testid={`pm-builtin-${id}`} data-status={r.status} title={r.message ?? ''}>
        <span className="name">
          {r.manifest?.name}{' '}
          <span className="faint">
            {r.kind === 'theme' ? '主题包 ' : ''}
            {r.manifest?.version}
          </span>
        </span>
        <PluginEnableSwitch
          pluginId={id}
          name={r.manifest?.name}
          status={r.status}
          canDisable={r.canDisable}
          message={r.message}
          testId={`pm-toggle-${id}`}
        />
      </div>
    );
  };
  return (
    <div className={embedded ? 'kb-settings-embed' : 'kb-dialog-backdrop kb-pm-backdrop'} onMouseDown={embedded ? undefined : onClose}>
      <div className={embedded ? 'kb-plugin-manager' : 'kb-dialog kb-dialog--wide kb-plugin-manager'} role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : true} aria-label="插件管理" data-testid="plugin-manager" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => !embedded && e.key === 'Escape' && onClose()}>
        <div className="kb-dialog-title">插件管理</div>
        <div className="kb-dialog-body kb-pm-body">
          <section>
            <h3>第三方适配器插件</h3>
            <KbToggle
              testId="dev-mode-toggle"
              checked={dev}
              busy={devBusy}
              disabled={devBusy}
              onChange={(next) => {
                if (devWriting.current) return;
                const prev = dev;
                devWriting.current = true;
                setDev(next);
                setDevBusy(true);
                void kb.setDevMode(next).then(
                  () => kb.getDevMode().then(setDev, () => undefined),
                  () => setDev(prev),
                ).finally(() => {
                  devWriting.current = false;
                  setDevBusy(false);
                });
              }}
            >
              开发者模式：允许从本地文件夹安装未签名的插件
            </KbToggle>
            <div>
              <button className="kb-button" data-testid="dev-install" disabled={!dev || busy} onClick={() => void install()}>
                安装本地插件文件夹（开发者模式）…
              </button>
            </div>
            <div className="meta">插件在隔离的沙箱中运行：只能通过授权读取你允许的文件夹，不能联网，不能改动应用界面。</div>
            {sandboxed.filter((d) => d.source !== 'builtin').length === 0 && <div className="meta">尚未安装第三方插件。</div>}
            {sandboxed.map((d) => {
              const rec = pluginHost.get(d.id);
              const status = rec?.status ?? 'disabled';
              return (
                <div key={d.id} className={'kb-pm-plugin' + (focus === d.id ? ' focused' : '')} data-testid={`pm-plugin-${d.id}`} data-status={status}>
                  <div className="kb-pm-head">
                    <span className="name">
                      <b>{d.name}</b> <span className="faint">{d.version}</span> <span className="meta">{d.id} · {d.source === 'builtin' ? '随应用内置' : '开发者模式本地安装（未签名）'}</span>
                    </span>
                    <PluginEnableSwitch
                      pluginId={d.id}
                      name={d.name}
                      status={status}
                      canDisable={rec?.canDisable ?? !d.errors.length}
                      message={rec?.message ?? (d.errors.length ? d.errors.join('；') : undefined)}
                      testId={`pm-toggle-${d.id}`}
                    />
                    {d.source !== 'builtin' && (
                      <button className="kb-button kb-button--danger kb-button--small" data-testid={`pm-uninstall-${d.id}`} onClick={() => void onUninstall(d)}>
                        卸载…
                      </button>
                    )}
                  </div>
                  {d.errors.map((e, i) => (
                    <div key={i} className="kb-plan-conflict">
                      {e}
                    </div>
                  ))}
                  <div className="meta">
                    插件存储：{d.storageKeys} 项，{fmtBytes(d.storageBytes)}
                  </div>
                  {(() => {
                    const pr = procs.find((x) => x.pluginId === d.id);
                    return (
                      <div className="meta" data-testid={`pm-proc-${d.id}`} data-isolated={pr ? String(pr.isolated) : ''}>
                        {pr
                          ? `运行中：${pr.frames} 个面板 · ${pr.isolated ? '独立进程' : '与主窗口同一进程（无法单独停止）'}（pid ${pr.pids.join(', ')}）· 内存 ${(pr.workingSetKB / 1024).toFixed(0)} MB`
                          : '未运行'}
                      </div>
                    );
                  })()}
                  <PermRows d={d} roots={roots} />
                  <AuditLog pluginId={d.id} refresh={tick} />
                </div>
              );
            })}
          </section>
          <section>
            <h3>内置插件与主题包</h3>
            {builtin.map(row)}
          </section>
        </div>
        {!embedded && (
          <div className="kb-dialog-actions">
            <button className="kb-button" data-testid="pm-close" onClick={onClose}>
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
