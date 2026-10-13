/**
 * 内置示例插件（随应用发布，source=builtin，可禁用）：运行时注册 'demo.csv-table' 适配器，优先级 200 > 内置文本视图（100），
 * 用于证明布局不依赖固定阅读器类型。它与内置阅读器一样在渲染进程中运行、**不请求授权**（启动时、恢复工作区时、打开 CSV 时都不弹框）；
 * manifest 中的 fs.read 声明只用于在插件管理中说明它读取什么。第三方插件请用沙箱适配器（docs/06），授权只在打开需要它的内容时询问。
 * （Windows 真机反馈：旧版 8e792ef 把它当作 source=user，首次启动就弹出权限确认框；第四轮起已改为内置，第八轮加 e2e 检查。）
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PluginModule, ViewProps } from '../../plugin-host/types';

interface CsvState {
  sortCol: number | null;
  desc: boolean;
  /** 阅读位置：纵向滚动比例 0–1（第九轮：自由窗口重启恢复每个面板的阅读位置） */
  scroll?: number;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) row.push(cell), rows.push(row);
  return rows;
}

function CsvTable({ resource, api, state, setState }: ViewProps<CsvState>) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [opens, setOpens] = useState<number | null>(null);
  const sortCol = state?.sortCol ?? null;
  const desc = state?.desc ?? false;
  const scrollRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const restored = useRef(false);
  useEffect(() => {
    api.workspace.readText(resource.resourceId).then((t) => setText(t.text), (e) => setErr(String(e?.message ?? e)));
    // 插件私有存储：统计打开次数（演示命名空间存储）
    api.storage.get<number>('opens').then((n) => {
      const v = (n ?? 0) + 1;
      setOpens(v);
      void api.storage.set('opens', v);
    });
  }, [api, resource.resourceId]);
  const rows = useMemo(() => (text == null ? [] : parseCsv(text)), [text]);
  const [head, ...body] = rows;
  const sorted = useMemo(() => {
    if (sortCol == null) return body;
    const num = body.every((r) => r[sortCol] === undefined || r[sortCol] === '' || !isNaN(Number(r[sortCol])));
    const out = [...body].sort((a, b) => (num ? Number(a[sortCol]) - Number(b[sortCol]) : String(a[sortCol]).localeCompare(String(b[sortCol]), 'zh-CN')));
    return desc ? out.reverse() : out;
  }, [body, sortCol, desc]);
  // 阅读位置：表格渲染后按比例恢复一次（面板尚未布局——例如重启时处于收起/隐藏窗口——就等它有尺寸再恢复）；之后滚动停止 250 ms 上报
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || restored.current || text == null) return;
    restored.current = true;
    const r = stateRef.current?.scroll;
    if (!(typeof r === 'number' && r > 0)) return;
    const apply = () => {
      const max = el.scrollHeight - el.clientHeight;
      if (el.clientHeight === 0 || max <= 0) return false;
      el.scrollTop = r * max;
      return true;
    };
    if (apply()) return;
    const ro = new ResizeObserver(() => apply() && ro.disconnect());
    ro.observe(el);
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const max = el.scrollHeight - el.clientHeight;
        if (el.clientHeight === 0) return;
        const s = stateRef.current;
        setState({ sortCol: s?.sortCol ?? null, desc: s?.desc ?? false, scroll: max > 0 ? +(el.scrollTop / max).toFixed(4) : 0 });
      }, 250);
    };
    el.addEventListener('scroll', on, { passive: true });
    return () => (clearTimeout(t), el.removeEventListener('scroll', on));
  }, [text, setState]);
  if (err) return <div className="kb-notice">读取失败：{err}</div>;
  if (text == null) return <div className="kb-notice">加载中…</div>;
  return (
    <div className="kb-reading reader csv" data-testid="view-csv-table" ref={scrollRef} data-sort-col={sortCol ?? ''} data-desc={desc ? '1' : '0'}>
      <div className="csv-meta">
        CSV 表格视图（插件 demo.csv-table）· {body.length} 行 × {head?.length ?? 0} 列 · 点击表头排序
        {opens != null && <span> · 本插件已打开 {opens} 次</span>}
      </div>
      <table className="kb-table">
        <thead>
          <tr>
            {head?.map((h, i) => (
              <th key={i} data-col={i} onClick={() => setState({ sortCol: i, desc: sortCol === i ? !desc : false, scroll: state?.scroll })}>
                {h}
                {sortCol === i ? (desc ? ' ▼' : ' ▲') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const plugin: PluginModule = {
  manifest: {
    id: 'demo.csv-table',
    name: 'CSV 表格视图（内置示例）',
    version: '0.1.0',
    engines: { workbench: '^0.2.0' },
    description: '把 .csv 以可排序表格打开（随应用发布的内置示例，可禁用；第三方插件请用沙箱适配器）',
    activationEvents: ['onAdapter:demo.csv-table'],
    contributes: {
      adapters: [
        { id: 'demo.csv-table', title: 'CSV 表格', sourceKinds: ['file'], displayMode: 'in-app-reader', match: { extensions: ['csv'] }, permissions: [{ id: 'read', kind: 'fs.read', scope: 'all-registered-roots', extensions: ['csv'], reason: '读取 CSV 文件并以表格显示' }], stateSchemaVersion: 1 },
      ],
    },
  },
  activate(api) {
    api.adapters.register<CsvState>({
      id: 'demo.csv-table',
      title: 'CSV 表格',
      sourceKinds: ['file'],
      displayMode: 'in-app-reader',
      stateSchemaVersion: 1,
      match: (t) => (t.sourceKind === 'file' && t.resource.kind === 'file' && t.resource.ext === 'csv' ? 200 : 0),
      component: CsvTable,
      serializeState: (s) => ({ sortCol: s.sortCol, desc: s.desc, ...(typeof s.scroll === 'number' ? { scroll: s.scroll } : {}) }),
      restoreState: (raw) => {
        const r = raw as CsvState;
        if (!r || !(typeof r.sortCol === 'number' || r.sortCol === null)) return undefined;
        const scroll = typeof r.scroll === 'number' && r.scroll >= 0 && r.scroll <= 1 ? r.scroll : undefined;
        return { sortCol: r.sortCol, desc: !!r.desc, ...(scroll !== undefined ? { scroll } : {}) };
      },
    });
  },
};
export default plugin;
