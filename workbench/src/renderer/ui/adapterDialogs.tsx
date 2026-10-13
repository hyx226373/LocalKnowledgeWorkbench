/**
 * 第三方适配器插件相关对话框（H3 授权 / H7 卸载 / H8 批量计划）。
 * 授权对话框故意不用 data-testid="dialog"（e2e 的通用自动确认不会替用户点“允许”）。
 */
import React, { useState } from 'react';
import { dialogs } from './dialogs';
import { displayModeLabel } from '../../shared/adapter-sdk/policy';
import type { ArgTemplate, PermissionPromptAnswer, ProcessLaunchPermission, SlotValue } from '../../shared/adapter-sdk/types';
import type { AdapterPermissionPrompt } from '../plugin-host/host';
import type { PlanPreviewDto, UninstallInfo, UninstallOptionsDto } from '../../shared/pluginIpc';

const KIND_TEXT: Record<string, string> = {
  'fs.read': '读取文件',
  'fileops.write': '修改文件（每次都要你批准计划）',
  net: '访问网络',
  'process.spawn': '启动本机程序',
  'process.launch': '启动外部程序（在它自己的窗口中运行）',
  'web.inject': '向网页注入脚本',
};

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function PermissionBody({ req, done }: { req: AdapterPermissionPrompt; done: (v: PermissionPromptAnswer) => void }) {
  const p = req.permission;
  const perRoot = p.kind === 'fs.read' && p.scope === 'ask-per-root';
  const [sel, setSel] = useState<Set<string>>(() => new Set(req.preselectRootIds?.length ? req.preselectRootIds : req.suggestRootId ? [req.suggestRootId] : req.roots.length === 1 ? [req.roots[0].id] : []));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <>
      <div className="kb-dialog-body kb-perm-body">
        <div className="kb-perm-lead">
          插件「<b>{req.pluginName}</b>」的适配器「{req.adapterTitle}」请求：<b>{KIND_TEXT[p.kind] ?? p.kind}</b>
        </div>
        <dl className="kb-perm-facts">
          <dt>显示方式</dt>
          <dd>{displayModeLabel({ displayMode: req.displayMode, permissions: [p] })}</dd>
          <dt>理由</dt>
          <dd data-testid="perm-reason">{p.reason}</dd>
          <dt>范围</dt>
          <dd>
            <ul className="kb-perm-scope" data-testid="perm-scope">
              {req.scopeLines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </dd>
          <dt>来源</dt>
          <dd>开发者模式安装的本地插件（未签名）· {req.pluginId}</dd>
        </dl>
        {perRoot && (
          <fieldset className="kb-perm-roots">
            <legend>只允许读取以下文件夹中的文件：</legend>
            {req.roots.map((r) => (
              <label key={r.id} className="kb-check">
                <input type="checkbox" data-testid={`perm-root-${r.id}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                <span>{r.name}</span>
                {r.id === req.suggestRootId && <span className="meta">（当前文件所在）</span>}
              </label>
            ))}
            {!req.roots.length && <div className="meta">还没有注册任何文件夹。</div>}
          </fieldset>
        )}
        <div className="meta">可以随时在“插件管理”中撤销。拒绝后相关面板显示占位，其余工作区不受影响。</div>
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" data-testid="perm-deny" onClick={() => done('deny')}>
          拒绝
        </button>
        <button className="kb-button" data-testid="perm-allow" disabled={perRoot && sel.size === 0} onClick={() => done(perRoot ? { grant: true, rootIds: [...sel] } : 'grant')}>
          {perRoot ? `允许读取所选 ${sel.size} 个文件夹` : '允许'}
        </button>
      </div>
    </>
  );
}

export function askPermissionDialog(req: AdapterPermissionPrompt): Promise<PermissionPromptAnswer> {
  return dialogs.custom<PermissionPromptAnswer>({
    title: '插件请求权限',
    testid: 'perm-dialog',
    cancelValue: 'deny',
    render: (done) => <PermissionBody req={req} done={done} />,
  });
}

const OP_TEXT = { write: '写入', move: '移动', trash: '移到回收站' } as const;

function PlanBody({ plan, done }: { plan: PlanPreviewDto; done: (ok: boolean) => void }) {
  return (
    <>
      <div className="kb-dialog-body">
        <div>
          插件「<b>{plan.pluginName}</b>」请求执行批量修改：<b>{plan.title}</b>
        </div>
        <ol className="kb-plan-steps" data-testid="plan-steps">
          {plan.steps.map((s, i) => (
            <li key={i} data-conflict={s.conflicts.length ? 'true' : 'false'}>
              <span className="kb-badge">{OP_TEXT[s.op]}</span> {s.rootName}/{s.relPath}
              {s.toRelPath && <> → {s.toRelPath}</>}
              <span className="meta"> · {s.summary}</span>
              {s.conflicts.map((c, j) => (
                <div key={j} className="kb-plan-conflict" role="alert">
                  冲突：{c}
                </div>
              ))}
            </li>
          ))}
        </ol>
        <div className="meta">
          所有修改记入操作日志（操作者：插件 {plan.pluginId}）。执行引擎：{plan.engine}
          {plan.blocked ? ' · 存在冲突，不能批准' : ''}
        </div>
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" data-testid="plan-reject" onClick={() => done(false)}>
          拒绝
        </button>
        <button className="kb-button" data-testid="plan-approve" disabled={plan.blocked} onClick={() => done(true)}>
          批准并执行 {plan.steps.length} 步
        </button>
      </div>
    </>
  );
}

export function planDialog(plan: PlanPreviewDto): Promise<boolean> {
  return dialogs.custom<boolean>({ title: '批准批量修改', testid: 'plan-dialog', cancelValue: false, wide: true, render: (done) => <PlanBody plan={plan} done={done} /> });
}

function UninstallBody({ name, info, done }: { name: string; info: UninstallInfo; done: (v: UninstallOptionsDto | null) => void }) {
  const [keepData, setKeep] = useState(true);
  const [removeItems, setRemove] = useState(false);
  return (
    <>
      <div className="kb-dialog-body kb-uninstall-body">
        <div>将删除插件「{name}」的程序文件。它的数据如何处理？</div>
        <label className="kb-check">
          <input type="radio" name="kb-uninstall-data" data-testid="uninstall-keep" checked={keepData} onChange={() => setKeep(true)} />
          <span>保留数据（重新安装后恢复）</span>
        </label>
        <label className="kb-check">
          <input type="radio" name="kb-uninstall-data" data-testid="uninstall-delete" checked={!keepData} onChange={() => setKeep(false)} />
          <span>删除数据</span>
        </label>
        <ul className="kb-uninstall-facts" data-testid="uninstall-facts">
          <li>插件存储：{info.storageKeys} 项，{fmtBytes(info.storageBytes)}</li>
          <li>授权记录：{info.grants} 条</li>
          <li>审计记录：{info.auditEntries} 条</li>
          <li>网站数据：{info.siteDataBytes === null ? '无（该插件没有网页面板）' : fmtBytes(info.siteDataBytes)}</li>
        </ul>
        <label className="kb-check">
          <input type="checkbox" data-testid="uninstall-remove-items" checked={removeItems} onChange={(e) => setRemove(e.target.checked)} />
          <span>
            同时从工作区移除由它显示的 {info.items} 个条目（涉及 {info.workspaces} 个工作区）
          </span>
        </label>
        <div className="meta">默认保留这些条目，显示为“缺少适配器”占位；重新安装后自动恢复到原来的状态。</div>
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" data-testid="uninstall-cancel" onClick={() => done(null)}>
          取消
        </button>
        <button className="kb-button kb-button--danger" data-testid="uninstall-confirm" onClick={() => done({ keepData, removeItems })}>
          卸载
        </button>
      </div>
    </>
  );
}

export function uninstallDialog(name: string, info: UninstallInfo): Promise<UninstallOptionsDto | null> {
  return dialogs.custom<UninstallOptionsDto | null>({ title: `卸载插件「${name}」`, testid: 'uninstall-dialog', cancelValue: null, render: (done) => <UninstallBody name={name} info={info} done={done} /> });
}

// ---------------------------------------------------------------- 新建外部程序项目（应用档案 H11）

export interface AppProfileChoice {
  programId: string;
  label: string;
  launch: { templateId: string; slots: Record<string, SlotValue> };
}
export interface AppResourceOption {
  resourceId: string;
  label: string;
  ext: string;
}

function AppProfileBody(p: { title: string; perm: ProcessLaunchPermission; resources: AppResourceOption[]; preset?: string; done: (v: AppProfileChoice | null) => void }) {
  const templates = p.perm.programs.flatMap((g) => g.argTemplates.map((t) => ({ g, t })));
  const [ti, setTi] = useState(() => Math.max(0, templates.findIndex(({ t }) => Object.values(t.slots ?? {}).some((s) => s.type === 'resource'))));
  const cur = templates[ti];
  const slots = Object.entries(cur?.t.slots ?? {});
  const fits = (ext: string, t: ArgTemplate, name: string) => {
    const s = t.slots?.[name];
    return s?.type === 'resource' && (!s.extensions?.length || s.extensions.includes(ext.toLowerCase().replace(/^\./, '')));
  };
  const [vals, setVals] = useState<Record<string, string>>({});
  const valueOf = (name: string): string => {
    if (vals[name] !== undefined) return vals[name];
    const s = cur?.t.slots?.[name];
    if (!s) return '';
    if (s.type === 'resource') {
      const ok = p.resources.filter((r) => fits(r.ext, cur.t, name));
      return (ok.find((r) => r.resourceId === p.preset) ?? ok[0])?.resourceId ?? '';
    }
    if (s.type === 'enum') return s.values[0] ?? '';
    return String(s.min);
  };
  const built = (): { slots: Record<string, SlotValue>; error?: string } => {
    const out: Record<string, SlotValue> = {};
    for (const [name, s] of slots) {
      const v = valueOf(name);
      if (s.type === 'resource') {
        if (!v) return { slots: out, error: '没有符合扩展名要求的文件：请先在文件树中打开或选中要用的文件' };
        out[name] = { type: 'resource', resourceId: v };
      } else if (s.type === 'enum') out[name] = { type: 'enum', value: v };
      else {
        const n = Number(v);
        if (!Number.isInteger(n) || n < s.min || n > s.max) return { slots: out, error: `「${name}」必须是 ${s.min}–${s.max} 的整数` };
        out[name] = { type: 'int', value: n };
      }
    }
    return { slots: out };
  };
  const b = built();
  const fileLabel = slots.map(([n, s]) => (s.type === 'resource' ? p.resources.find((r) => r.resourceId === valueOf(n))?.label : undefined)).find(Boolean);
  const [label, setLabel] = useState<string | null>(null);
  const labelValue = label ?? `${cur?.g.displayName ?? p.title}${fileLabel ? `：${fileLabel}` : ''}`;
  return (
    <>
      <div className="kb-dialog-body kb-perm-body" data-testid="app-profile-dialog">
        <p className="meta">程序在它自己的窗口中运行，工作台只负责启动和显示状态（显示方式：外部窗口启动）。只能选择适配器声明的程序和参数模板；启动前会备份要打开的文件，程序退出后被修改的文件记入操作记录，可撤销。</p>
        <label className="kb-field">
          <span>启动方式</span>
          <select data-testid="app-profile-template" value={ti} onChange={(e) => (setTi(Number(e.target.value)), setVals({}))}>
            {templates.map(({ g, t }, i) => (
              <option key={`${g.programId}/${t.id}`} value={i}>
                {g.displayName} · {t.label}
              </option>
            ))}
          </select>
        </label>
        {slots.map(([name, s]) => (
          <label className="kb-field" key={name}>
            <span>{s.type === 'resource' ? '文件' : name}</span>
            {s.type === 'resource' ? (
              <select data-testid={`app-profile-slot-${name}`} value={valueOf(name)} onChange={(e) => setVals((v) => ({ ...v, [name]: e.target.value }))}>
                {p.resources
                  .filter((r) => fits(r.ext, cur.t, name))
                  .map((r) => (
                    <option key={r.resourceId} value={r.resourceId}>
                      {r.label}
                    </option>
                  ))}
              </select>
            ) : s.type === 'enum' ? (
              <select data-testid={`app-profile-slot-${name}`} value={valueOf(name)} onChange={(e) => setVals((v) => ({ ...v, [name]: e.target.value }))}>
                {s.values.map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            ) : (
              <input data-testid={`app-profile-slot-${name}`} type="number" min={s.min} max={s.max} value={valueOf(name)} onChange={(e) => setVals((v) => ({ ...v, [name]: e.target.value }))} />
            )}
          </label>
        ))}
        <label className="kb-field">
          <span>项目名称</span>
          <input data-testid="app-profile-label" value={labelValue} maxLength={80} onChange={(e) => setLabel(e.target.value)} />
        </label>
        {b.error && <div className="kb-sandbox-notice" role="alert">{b.error}</div>}
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary" data-testid="app-profile-cancel" onClick={() => p.done(null)}>
          取消
        </button>
        <button
          className="kb-button"
          data-testid="app-profile-create"
          disabled={!!b.error || !cur}
          onClick={() => p.done({ programId: cur.g.programId, label: labelValue.trim() || cur.g.displayName, launch: { templateId: cur.t.id, slots: b.slots } })}
        >
          新建项目
        </button>
      </div>
    </>
  );
}

/** 新建外部程序项目：选声明里的启动方式与文件（资源 id），不接受任何路径或命令行文本 */
export function appProfileDialog(title: string, perm: ProcessLaunchPermission, resources: AppResourceOption[], preset?: string): Promise<AppProfileChoice | null> {
  return dialogs.custom<AppProfileChoice | null>({ title: `新建外部程序项目：${title}`, cancelValue: null, testid: 'app-profile', render: (done) => <AppProfileBody title={title} perm={perm} resources={resources} preset={preset} done={done} /> });
}
