/**
 * 组件状态表：把主题接口列出的每个组件 × 状态都渲染出来，供 theme:shots 截图。
 * 悬停/按下/焦点等伪类由截图脚本通过 CDP 强制（元素上带 data-force-state）；直接在应用里打开时这些格子显示默认外观。
 */
import React, { useEffect, useRef } from 'react';
import { DockviewReact, themeDark, type DockviewReadyEvent, type IDockviewPanelProps } from 'dockview-react';
import { COMPONENTS, STATES, TOKENS, THEME_CONTRACT_VERSION } from '../theme/contract';
/** 组件状态表中有渲染器的组件 id（单元测试与 theme:shots 用它核对“权威清单全部渲染”） */
export const RENDERED_COMPONENT_IDS = () => Object.keys(RENDER);
import { HOST_API_VERSION } from '../plugin-host/types';
import '../settings/kb-toggle.css';
import { BubbleCloseIcon, StarIcon, TreeGlyph } from './shellMarks';

type Cell = React.ReactNode | null;
const F = (s: string) => ({ 'data-force-state': s === 'focus-visible' ? 'focus' : s }) as Record<string, string>;
const PSEUDO = ['hover', 'active', 'focus-visible'];

function Btn({ v, st }: { v: '' | 'secondary' | 'ghost'; st: string }) {
  const cls = 'kb-button' + (v ? ` kb-button--${v}` : '');
  const p: Record<string, unknown> = {};
  if (PSEUDO.includes(st)) Object.assign(p, F(st));
  if (st === 'selected') p['aria-pressed'] = 'true';
  return (
    <button className={cls} disabled={st === 'disabled'} {...p}>
      {v === '' ? '主按钮' : v === 'secondary' ? '次按钮' : '幽灵'}
    </button>
  );
}
const btnCell = (st: string) =>
  ['default', 'hover', 'active', 'focus-visible', 'disabled', 'selected'].includes(st) ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
      <Btn v="" st={st} />
      <Btn v="secondary" st={st} />
      <Btn v="ghost" st={st} />
    </div>
  ) : null;

const inputCell = (st: string) =>
  ['default', 'hover', 'focus-visible', 'disabled'].includes(st) ? (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <input className="kb-input" defaultValue="输入框" disabled={st === 'disabled'} {...(st !== 'default' && st !== 'disabled' ? F(st) : {})} />
      <select className="kb-select" disabled={st === 'disabled'} {...(st !== 'default' && st !== 'disabled' ? F(st) : {})}>
        <option>下拉框</option>
      </select>
      <textarea className="kb-textarea" rows={2} defaultValue="多行文本" disabled={st === 'disabled'} {...(st !== 'default' && st !== 'disabled' ? F(st) : {})} />
    </div>
  ) : null;

function TreeRow({ st, label = '读书笔记.md' }: { st: string; label?: string }) {
  const p: Record<string, unknown> = { tabIndex: 0 };
  if (PSEUDO.includes(st)) Object.assign(p, F(st));
  if (st === 'selected') p['aria-selected'] = 'true';
  if (st === 'disabled') p['aria-disabled'] = 'true';
  if (st === 'drag-over') p['data-drag-over'] = 'true';
  return (
    <div className="kb-sidebar" style={{ width: 200, padding: '4px 0' }}>
      <div className="kb-tree-row" {...p}>
        <span className="kb-chev" aria-hidden="true" />
        <TreeGlyph kind="file" ext="md" />
        <span className="name">{label}</span>
        <span className="act on"><StarIcon filled /></span>
      </div>
    </div>
  );
}

function Menu({ st }: { st: string }) {
  const p: Record<string, unknown> = { tabIndex: 0 };
  if (PSEUDO.includes(st)) Object.assign(p, F(st));
  if (st === 'selected') p['aria-selected'] = 'true';
  if (st === 'disabled') p['aria-disabled'] = 'true';
  return (
    <div className="kb-popover" style={{ width: 200, padding: '4px 0' }}>
      <div className="kb-menu-group-title">项目</div>
      <div className="kb-menu-item" {...p}>
        <span className="name">读文献</span>
        <span className="kbd">Ctrl+1</span>
      </div>
    </div>
  );
}

function Hit({ st }: { st: string }) {
  const p: Record<string, unknown> = {};
  if (['hover', 'active'].includes(st)) Object.assign(p, F(st));
  if (st === 'selected') p['aria-selected'] = 'true';
  return (
    <div className="kb-popover kb-search-results" style={{ position: 'static', width: 220 }}>
      <div className="kb-search-hit" {...p}>
        <div>讲义.pdf</div>
        <div className="p">kb-sample / 资料/论文/讲义.pdf</div>
      </div>
    </div>
  );
}

function Sash({ st }: { st: string }) {
  const p: Record<string, unknown> = {};
  if (st === 'hover') Object.assign(p, F('hover'));
  if (st === 'active') Object.assign(p, F('active'));
  if (st === 'dragging') p['data-dragging'] = 'true';
  return (
    <div style={{ display: 'flex', height: 70, width: 120, border: '1px solid var(--kb-color-border)' }}>
      <div className="kb-sidebar" style={{ width: 56 }} />
      <div className="kb-sash" {...p} />
      <div style={{ flex: 1, background: 'var(--kb-color-surface)' }} />
    </div>
  );
}

function PluginRow({ st }: { st: string }) {
  const status = st === 'disabled' ? 'disabled' : 'active';
  return (
    <div className="kb-sidebar" style={{ width: 230, padding: '4px 0' }}>
      <div className="kb-plugin-row" data-status={status} {...(st === 'hover' ? F('hover') : {})}>
        <span className="name">
          CSV 表格视图 <span className="faint">0.1.0</span>
        </span>
        <label className="kb-toggle" aria-disabled={st === 'disabled' ? 'true' : undefined}>
          <input type="checkbox" role="switch" checked={status === 'active'} readOnly disabled={st === 'disabled'} aria-label="CSV 表格视图启用" />
          <span className="kb-toggle-track" aria-hidden="true">
            <span className="kb-toggle-thumb" />
          </span>
        </label>
      </div>
      {st === 'disabled' &&
        (['error', 'incompatible', 'denied'] as const).map((s) => (
          <div key={s} className="kb-plugin-row" data-status={s}>
            <span className="name">示例插件</span>
            <span className="kb-plugin-status" data-status={s}>
              {{ error: '出错', incompatible: '不兼容', denied: '未授权' }[s]}
            </span>
          </div>
        ))}
    </div>
  );
}

function Status({ st }: { st: string }) {
  if (st !== 'default' && st !== 'hover') return null;
  return (
    <div className="kb-statusbar" style={{ width: 300, gap: 10 }}>
      <span className="kb-status-item" data-state="idle">
        <span className="dot" />
        已索引 9 个文件 <button {...(st === 'hover' ? F('hover') : {})}>⟳</button>
      </span>
      <span className="kb-status-item" data-state="scanning">
        <span className="dot" />
        扫描中
      </span>
      <span className="kb-status-item" data-state="error">
        <span className="dot" />
        错误
      </span>
    </div>
  );
}

function DialogSample({ st }: { st: string }) {
  if (st !== 'default' && st !== 'focus-visible') return null;
  return (
    <div className="kb-dialog" style={{ width: 260 }}>
      <div className="kb-dialog-title">新建工作区</div>
      <div className="kb-dialog-body">
        <label>
          名称
          <input className="kb-input" defaultValue="读文献" {...(st === 'focus-visible' ? F('focus') : {})} />
        </label>
      </div>
      <div className="kb-dialog-actions">
        <button className="kb-button kb-button--secondary">取消</button>
        <button className="kb-button">确定</button>
      </div>
    </div>
  );
}

const Dummy = (p: IDockviewPanelProps<{ text: string }>) => <div className="kb-notice" style={{ padding: 8, lineHeight: 1.4 }}>{p.params.text}</div>;

/** 真实 dockview：标签（默认/悬停/焦点/选中）、分组、分栏条（强制悬停） */
function MiniDock({ height = 150 }: { height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const onReady = (e: DockviewReadyEvent) => {
    e.api.addPanel({ id: 'a', component: 'd', title: '默认', params: { text: '分组（激活）' } });
    e.api.addPanel({ id: 'b', component: 'd', title: '悬停', params: { text: '' } });
    e.api.addPanel({ id: 'c', component: 'd', title: '焦点', params: { text: '' } });
    e.api.addPanel({ id: 's', component: 'd', title: '选中', params: { text: '分组（激活）：当前标签“选中”' } });
    e.api.addPanel({ id: 'r', component: 'd', title: '右侧分组', params: { text: '非激活分组；中间分栏条被强制为悬停' }, position: { referencePanel: 's', direction: 'right' } });
    e.api.getPanel('s')?.api.setActive();
  };
  useEffect(() => {
    const t = setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      const tabs = [...root.querySelectorAll<HTMLElement>('.dv-tab')];
      const byText = (s: string) => tabs.find((t) => t.textContent?.includes(s));
      byText('悬停')?.setAttribute('data-force-state', 'hover');
      byText('焦点')?.setAttribute('data-force-state', 'focus');
      root.querySelector<HTMLElement>('.dv-sash')?.setAttribute('data-force-state', 'hover');
    }, 300);
    return () => clearTimeout(t);
  }, []);
  return (
    <div ref={ref} className="kb-dock" style={{ height, width: 560, position: 'relative' }}>
      <DockviewReact components={{ d: Dummy }} onReady={onReady} theme={{ ...themeDark, name: 'kb', gap: 0 }} />
    </div>
  );
}

function DropPreview() {
  return (
    <div className="kb-dock" style={{ width: 200 }}>
      <div className="dockview-theme-dark" style={{ position: 'relative', height: 90, background: 'var(--kb-color-surface)' }}>
        <div className="dv-drop-target" style={{ position: 'absolute', inset: 0 }}>
          <div className="dv-drop-target-dropzone" style={{ position: 'absolute', left: '50%', top: 0, width: '50%', height: '100%' }}>
            <div className="dv-drop-target-selection" />
          </div>
        </div>
      </div>
      <div className="cap">dockview 拖放覆盖层（静态再现）</div>
    </div>
  );
}

function ReadingSample() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div className="kb-reading" style={{ width: 520, height: 330, border: '1px solid var(--kb-color-border)' }}>
        <article className="kb-md">
          <h1>一级标题</h1>
          <p>
            正文段落：本地知识工作台把已有文件夹注册为根，<a href="#x">这是链接</a>，<mark>搜索命中高亮</mark>，<code>行内代码</code>。
          </p>
          <blockquote>引用块：原文件保持原位。</blockquote>
          <h2>二级标题</h2>
          <table>
            <thead>
              <tr>
                <th>格式</th>
                <th>支持</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Markdown</td>
                <td>是</td>
              </tr>
            </tbody>
          </table>
          <pre>
            <code>const hello = '你好';</code>
          </pre>
        </article>
      </div>
      <div className="kb-reading pdf" style={{ width: 200, height: 330, border: '1px solid var(--kb-color-border)' }}>
        <div className="kb-view-toolbar">
          <span className="pdf-pageno">第 1 / 3 页</span>
        </div>
        <div className="kb-pdf-page" style={{ width: 150, height: 200, marginTop: 8 }}>
          <div style={{ padding: 10, color: '#222', fontSize: 11 }}>PDF 页面（示意）</div>
        </div>
      </div>
      <div className="kb-reading csv" style={{ width: 220, height: 330, border: '1px solid var(--kb-color-border)' }}>
        <div className="csv-meta">CSV 表格</div>
        <table className="kb-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>数量</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>苹果</td>
              <td>3</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Toggle({ st }: { st: string }) {
  const p: Record<string, unknown> = {};
  if (st === 'hover') Object.assign(p, F('hover'));
  return (
    <label className="kb-toggle" aria-disabled={st === 'disabled' ? 'true' : undefined} {...p}>
      <input type="checkbox" defaultChecked={st === 'selected'} disabled={st === 'disabled'} {...(st === 'focus-visible' ? F('focus') : {})} />
      显示被忽略的项
    </label>
  );
}

/** dockview 标签/分组的静态再现（与真实 dockview 使用同一组类名与令牌） */
function DockTabs({ st }: { st: string }) {
  const p: Record<string, unknown> = { tabIndex: 0 };
  if (PSEUDO.includes(st)) Object.assign(p, F(st));
  if (st === 'dragging') p['data-dragging'] = 'true';
  const cls = 'dv-tab' + (st === 'selected' ? ' dv-active-tab' : ' dv-inactive-tab');
  return (
    <div className="kb-dock" style={{ width: 170 }}>
      <div className="dockview-theme-dark" style={{ position: 'relative' }}>
        <div className={'dv-groupview' + (st === 'selected' ? ' dv-active-group' : ' dv-inactive-group')} style={{ height: 'auto' }}>
          <div className="dv-tabs-and-actions-container" style={{ display: 'flex' }}>
            <div className={cls} {...p} style={{ display: 'flex', alignItems: 'center', padding: '0 10px' }}>
              <div className="dv-default-tab">读书笔记.md</div>
            </div>
          </div>
          {st === 'drag-over' && (
            <div style={{ position: 'relative', height: 40 }}>
              <div className="dv-drop-target-selection" style={{ position: 'absolute', inset: 0 }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function DockGroup({ st }: { st: string }) {
  return (
    <div className="kb-dock" style={{ width: 170 }}>
      <div className="dockview-theme-dark" style={{ position: 'relative' }}>
        <div className={'dv-groupview' + (st === 'active' ? ' dv-active-group' : ' dv-inactive-group')} style={{ height: 70, position: 'relative' }}>
          <div className="dv-tabs-and-actions-container" style={{ display: 'flex' }}>
            <div className={'dv-tab ' + (st === 'active' ? 'dv-active-tab' : 'dv-inactive-tab')} style={{ padding: '0 10px', display: 'flex', alignItems: 'center' }}>
              讲义.pdf
            </div>
          </div>
          {st === 'drag-over' && <div className="dv-drop-target-selection" style={{ position: 'absolute', inset: 0 }} />}
        </div>
      </div>
    </div>
  );
}

function CollectionRow({ st }: { st: string }) {
  const p: Record<string, unknown> = { tabIndex: 0 };
  if (PSEUDO.includes(st)) Object.assign(p, F(st));
  if (st === 'selected') p['aria-selected'] = 'true';
  if (st === 'disabled') p['aria-disabled'] = 'true';
  return (
    <div className="kb-sidebar" style={{ width: 220, padding: '4px 0' }}>
      <div className="kb-collection">
        <div className="kb-collection-row" data-open={st === 'selected' ? 'true' : undefined} {...p}>
          <TreeGlyph kind="file" ext="pdf" />
          <span className="name">讲义.pdf</span>
          <span className="p">论文库</span>
          <span className="act"><BubbleCloseIcon /></span>
        </div>
      </div>
    </div>
  );
}

function Toast() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 260 }}>
      {(['info', 'success', 'warning', 'danger'] as const).map((t) => (
        <div key={t} className="kb-toast" data-tone={t} style={{ position: 'static' }}>
          {{ info: '已导出工作区', success: '已保存（可撤销）', warning: '文件已被外部修改', danger: '保存失败' }[t]}
        </div>
      ))}
      <div className="kb-banner" data-tone="warning">
        <span className="grow">横幅：工作区只读</span>
      </div>
    </div>
  );
}

function SectionSample() {
  return (
    <div style={{ width: 240 }}>
      <div className="kb-topbar" style={{ height: 'var(--kb-size-topbar)' }}>
        <span className="title">本地知识工作台</span>
      </div>
      <div className="kb-sidebar" style={{ height: 70 }}>
        <section className="kb-section">
          <h3 className="kb-section-title">收藏</h3>
        </section>
      </div>
    </div>
  );
}

function ToolbarSample() {
  return (
    <div className="kb-view-toolbar" style={{ position: 'static', width: 300 }}>
      <span className="pdf-pageno">第 1 / 3 页</span>
      <button className="kb-button kb-button--secondary">−</button>
      <button className="kb-button kb-button--secondary" aria-pressed="true">
        深色滤镜
      </button>
    </div>
  );
}

function NoticeSample() {
  return (
    <div className="kb-notice" style={{ width: 220, height: 110, padding: 12, lineHeight: 1.6 }}>
      <div>暂不支持在应用内阅读此格式</div>
      <div className="meta">内置支持：文本、Markdown、图片、PDF</div>
    </div>
  );
}

function DiffSample({ st }: { st: string }) {
  const lines: [string, string][] = st === 'default' ? [['ctx', '第一章 绪论'], ['ctx', '本章介绍研究背景。']] : [['ctx', '第一章 绪论'], ['del', '本章介绍背景。'], ['add', '本章介绍研究背景与问题。']];
  return (
    <div className="kb-diff" style={{ width: 260 }}>
      {lines.map(([k, t], i) => (
        <div key={i} className="kb-diff-line" data-kind={k}>
          <span className="sign">{k === 'add' ? '+' : k === 'del' ? '−' : ' '}</span>
          <span>{t}</span>
        </div>
      ))}
    </div>
  );
}

function ReadingCell({ st }: { st: string }) {
  return (
    <div className="kb-reading" style={{ width: 240, height: 120, border: '1px solid var(--kb-color-border)' }}>
      <article className="kb-md" style={{ padding: 10 }}>
        <p style={{ margin: 0 }}>
          {st === 'selected' ? '选区示例：' : ''}正文段落，<a href="#x">链接</a>，<code>代码</code>。
        </p>
      </article>
    </div>
  );
}

function EditorCell({ st }: { st: string }) {
  const p: Record<string, unknown> = {};
  if (st === 'focus-visible') Object.assign(p, F('focus'));
  return (
    <div className="kb-editor" data-dirty={st === 'default' ? 'true' : undefined} style={{ width: 240, height: 120, border: '1px solid var(--kb-color-border)' }}>
      <div className="kb-editor-body">
        <textarea className="kb-editor-text" readOnly={st === 'disabled'} defaultValue={'# 第一章\n正文……'} data-select-all={st === 'selected' ? '1' : undefined} {...p} />
      </div>
    </div>
  );
}

function PdfCell({ st }: { st: string }) {
  return (
    <div className="kb-reading pdf" data-dark-filter={st === 'selected' ? 'on' : undefined} style={{ width: 160, height: 150, border: '1px solid var(--kb-color-border)' }}>
      <div className="kb-pdf-page" style={{ width: 110, height: 120 }}>
        <div style={{ padding: 8, color: '#222', fontSize: 11, background: '#fff', height: '100%' }}>
          <b style={{ color: '#c00' }}>PDF 页面</b>
          <div>{st === 'selected' ? '深色滤镜开启' : '原色（默认）'}</div>
        </div>
      </div>
    </div>
  );
}

function FocusCell() {
  return (
    <div className="kb-reading" data-focus="on" style={{ width: 260, height: 130, border: '1px solid var(--kb-color-border)' }}>
      <article className="kb-md" style={{ paddingTop: 12, paddingBottom: 12 }}>
        <p style={{ margin: 0 }}>专注模式：更宽松的字号与行距，外框淡出。</p>
      </article>
    </div>
  );
}

const RENDER: Record<string, (st: string) => Cell> = {
  toggle: (st) => <Toggle st={st} />,
  tab: (st) => <DockTabs st={st} />,
  group: (st) => <DockGroup st={st} />,
  'collection-row': (st) => <CollectionRow st={st} />,
  toast: () => <Toast />,
  section: () => <SectionSample />,
  'view-toolbar': () => <ToolbarSample />,
  notice: () => <NoticeSample />,
  diff: (st) => <DiffSample st={st} />,
  reading: (st) => <ReadingCell st={st} />,
  editor: (st) => <EditorCell st={st} />,
  'pdf-page': (st) => <PdfCell st={st} />,
  'reading-focus': () => <FocusCell />,
  button: btnCell,
  input: inputCell,
  'tree-row': (st) => <TreeRow st={st} />,
  splitter: (st) => (['default', 'hover', 'active', 'dragging'].includes(st) ? <Sash st={st} /> : st === 'disabled' ? <div className="kb-notice" style={{ padding: 6 }}>分栏锁定时</div> : null),
  'search-result': (st) => (['default', 'hover', 'active', 'selected'].includes(st) ? <Hit st={st} /> : null),
  'menu-item': (st) => (st === 'drag-over' || st === 'dragging' ? null : <Menu st={st} />),
  'plugin-row': (st) => (['default', 'hover', 'disabled'].includes(st) ? <PluginRow st={st} /> : null),
  statusbar: (st) => <Status st={st} />,
  dialog: (st) => <DialogSample st={st} />,
};

export function StatesSheet({ chrome, reading, scheme }: { chrome: string; reading: string; scheme: string }) {
  useEffect(() => {
    document.documentElement.classList.add('kb-sheet-mode');
    return () => document.documentElement.classList.remove('kb-sheet-mode');
  }, []);
  // 权威清单中的每个组件都必须有渲染器（缺失会在 theme:shots 报告中列为错误）
  const rows = COMPONENTS;
  useEffect(() => {
    // 编辑器“选区”格子：选中文字
    document.querySelectorAll<HTMLTextAreaElement>('textarea[data-select-all]').forEach((t) => t.setSelectionRange(0, 6));
  }, []);
  return (
    <div className="states-sheet" data-testid="states-sheet">
      <h1>组件状态表</h1>
      <div className="sub">
        外框样式 <b>{chrome}</b> · 阅读区样式 <b>{reading}</b> · {scheme === 'dark' ? '深色' : '浅色'} · 主题接口 {THEME_CONTRACT_VERSION} · 宿主 API {HOST_API_VERSION} ·
        “—”表示该组件没有此状态
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th />
            {STATES.map((s) => (
              <th key={s}>{s}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} data-component={c.id} data-rendered={RENDER[c.id] ? '1' : '0'}>
              <td className="rowhead">
                {c.name}
                <code>{c.hook}</code>
              </td>
              {STATES.map((s) => {
                const sel = c.states[s];
                const node = sel && RENDER[c.id] ? RENDER[c.id](s) : null;
                return node ? (
                  <td key={s} data-state={s}>
                    {node}
                    <div className="cap">{sel!.split('（')[0]}</div>
                  </td>
                ) : (
                  <td key={s} className="na" data-missing={sel ? `${c.id}/${s}` : undefined}>
                    —
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <section>
        <h2>标签页 / 分组 / 分栏条（真实 dockview）与拖放目标</h2>
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
          <MiniDock />
          <DropPreview />
        </div>
      </section>
      <section>
        <h2>阅读区（Markdown / PDF / CSV）</h2>
        <ReadingSample />
      </section>
      <section>
        <h2>颜色角色 / 令牌</h2>
        <div className="swatches">
          {TOKENS.filter((t) => t.group === 'color' || t.group === 'focus').filter((t) => !/fs|lh|width|pad|opacity|filter|shadow/.test(t.name)).map((t) => (
            <div className="sw" key={t.name}>
              <i style={{ background: `var(--kb-${t.name})` }} />
              {t.role ?? t.name}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
