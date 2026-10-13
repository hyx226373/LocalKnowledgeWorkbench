/**
 * 文件适配器模板 · 示例：JSON 查看器
 *
 * 运行约束：不要长时间同步占用事件循环（宿主约 3 s 无心跳即终止插件进程）。
 * 大文件的解析/遍历要分段（本模板限制 10 MB、每层最多显示 200 项）。
 *
 * 【填写】搜索 “TODO(fill)” 逐项替换。核心约定：
 * - 只通过 ctx.files 读取（参数是 resourceId，拿不到绝对路径）。
 * - UI 用声明式 UiNode 渲染（宿主用 textContent 绘制，天然防 XSS，自动跟随主题令牌）。
 * - 状态（getState）只放“看到哪里”，绝不放文件正文；结构变化时提升 stateSchemaVersion 并在 restoreState 中迁移；
 *   迁移失败用 migrateOrPreserve 原样保留旧数据（legacy 字段）并提示，不丢数据。
 */
import type {
  AdapterImplementation,
  AdapterInstance,
  AdapterPluginModule,
  AdapterPluginManifest,
  MountTarget,
  PluginStorage,
  UiNode,
  UiTreeNode,
  PreservedLegacyState,
} from '@kb-workbench/adapter-sdk';
import { asRecord, migrateOrPreserve } from '@kb-workbench/adapter-sdk/policy';
import manifestJson from '../manifest.json' with { type: 'json' };

export const manifest = manifestJson as unknown as AdapterPluginManifest;
export const ADAPTER_ID = 'example.json-viewer.reader'; // TODO(fill): 与 manifest 一致

// ───────────── 状态 ─────────────

/** TODO(fill): 你的状态结构（小、无秘密、无正文） */
export interface JsonViewerState {
  /** 展开的节点路径，如 "$"、"$.items"、"$.items[0]" */
  expanded: string[];
  showTypes: boolean;
  /** 升级时迁移失败、原样保留下来的旧状态（不丢数据；用户可在面板里丢弃） */
  legacy?: PreservedLegacyState;
}
export const MAX_EXPANDED = 300;
export const STATE_VERSION = 2; // 与 manifest stateSchemaVersion 一致
const DEFAULT_STATE: JsonViewerState = { expanded: ['$'], showTypes: false };

/** 迁移步骤：键 = 起始版本。v1: { open: string[] }  →  v2: { expanded: string[], showTypes: boolean } */
export const STATE_MIGRATIONS: Record<number, (d: any) => unknown> = {
  1: (d) => {
    const r = asRecord(d);
    return r ? { expanded: r.open, showTypes: false } : undefined;
  },
};

function validState(x: unknown): JsonViewerState | null {
  const r = asRecord(x);
  if (!r) return null;
  const exp = r.expanded;
  if (!Array.isArray(exp) || !exp.every((v) => typeof v === 'string' && v.length <= 512)) return null;
  if (typeof r.showTypes !== 'boolean') return null;
  const legacy = asRecord(r.legacy);
  const keep = legacy && typeof legacy.v === 'number' && typeof legacy.error === 'string' && 'data' in legacy ? { legacy: { v: legacy.v, data: legacy.data!, error: legacy.error } } : {};
  return { expanded: (exp as string[]).slice(0, MAX_EXPANDED), showTypes: r.showTypes, ...keep };
}

/**
 * 校验 + 迁移（宿主在打开时调用；升级后 fromVersion < STATE_VERSION）。
 * **迁移失败不丢数据**：用 SDK migrateOrPreserve，失败时返回默认状态 + legacy（旧数据原样），保存时一并写回，面板提示。
 * 只有完全无法识别的输入才返回 undefined（宿主重置）。
 */
export function restoreJsonViewerState(data: unknown, fromVersion: number): JsonViewerState | undefined {
  const fresh = (): JsonViewerState => ({ expanded: [...DEFAULT_STATE.expanded], showTypes: DEFAULT_STATE.showTypes });
  const { state, preserved } = migrateOrPreserve<unknown>(data, fromVersion, STATE_VERSION, STATE_MIGRATIONS, fresh);
  const ok = validState(state);
  if (preserved) return { ...fresh(), legacy: preserved };
  if (ok) return ok;
  // 迁移“成功”但结果不合法（或同版本数据被改坏）：同样保留原数据
  return { ...fresh(), legacy: { v: fromVersion, data: (data ?? null) as PreservedLegacyState['data'], error: '状态格式无法识别' } };
}

// ───────────── 纯渲染逻辑（便于单测） ─────────────

const MAX_CHILDREN = 200;

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}
function preview(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).length}}`;
  const s = JSON.stringify(v);
  return s.length > 80 ? s.slice(0, 77) + '…' : s;
}
function childPath(parent: string, key: string | number): string {
  return typeof key === 'number' ? `${parent}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

export function buildTree(value: unknown, state: JsonViewerState, path = '$', label = '$'): UiTreeNode {
  const expanded = state.expanded.includes(path);
  const node: UiTreeNode = { id: path, label, detail: state.showTypes ? `${typeOf(value)} ${preview(value)}` : preview(value), expanded };
  if (value && typeof value === 'object') {
    const entries: Array<[string | number, unknown]> = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
    if (expanded) {
      node.children = entries.slice(0, MAX_CHILDREN).map(([k, v]) => buildTree(v, state, childPath(path, k), String(k)));
      if (entries.length > MAX_CHILDREN) node.children.push({ id: `${path}#more`, label: `…还有 ${entries.length - MAX_CHILDREN} 项` });
    } else {
      node.children = [];
    }
  }
  return node;
}

// ───────────── 适配器实现 ─────────────

/** 插件私有存储（activate 时注入）。这里存“新打开文件时是否显示类型”的偏好，用于演示卸载时保留/删除数据。 */
let storage: PluginStorage | null = null;
export const PREFS_KEY = 'prefs';

export const jsonViewerAdapter: AdapterImplementation<JsonViewerState> = {
  id: ADAPTER_ID,
  restoreState: restoreJsonViewerState,
  async open(item, ctx): Promise<AdapterInstance<JsonViewerState>> {
    const prefs = asRecord(await storage?.get(PREFS_KEY));
    let state: JsonViewerState = ctx.restoredState ?? { expanded: [...DEFAULT_STATE.expanded], showTypes: prefs?.showTypes === true };
    let target: Extract<MountTarget, { kind: 'reader' }> | null = null;
    let parsed: { ok: true; value: unknown } | { ok: false; error: string; read?: boolean } | null = null;
    let truncated = false;
    let denied: string | null = null;
    const subs: Array<{ dispose(): void }> = [];

    const render = () => {
      if (!target) return;
      if (denied) {
        target.render({ type: 'notice', tone: 'error', title: '无法读取文件', message: denied });
        return;
      }
      if (!parsed) {
        target.render({ type: 'text', text: '正在读取…', tone: 'muted' });
        return;
      }
      if (!parsed.ok) {
        target.render({ type: 'notice', tone: 'error', title: parsed.read ? '读取失败' : 'JSON 解析失败', message: parsed.error, actions: [{ label: '重新读取', action: 'reload' }] });
        return;
      }
      const toolbar: UiNode = {
        type: 'stack',
        direction: 'row',
        children: [
          { type: 'button', label: state.showTypes ? '隐藏类型' : '显示类型', action: 'toggle-types', variant: 'ghost' },
          { type: 'button', label: '全部折叠', action: 'collapse-all', variant: 'ghost' },
        ],
      };
      const children: UiNode[] = [toolbar];
      if (state.legacy)
        children.push({
          type: 'notice',
          tone: 'warning',
          title: '旧版本的视图状态无法迁移，已原样保留（没有丢失）',
          message: `来自状态版本 v${state.legacy.v}：${state.legacy.error}。当前显示默认视图；修复后的新版本插件会再次尝试迁移。`,
          actions: [{ label: '丢弃旧状态', action: 'discard-legacy' }],
        });
      if (truncated) children.push({ type: 'notice', tone: 'warning', title: '文件过大，只显示了前一部分' });
      children.push({ type: 'tree', nodes: [buildTree(parsed.value, state)], toggleAction: 'toggle' });
      target.render({ type: 'stack', children });
    };

    const load = async () => {
      if (!ctx.files) {
        denied = '未获得读取权限';
        return render();
      }
      try {
        const res = await ctx.files.readText(item.ref, { maxBytes: 10 * 1024 * 1024 });
        truncated = res.truncated;
        try {
          parsed = { ok: true, value: JSON.parse(res.text) };
        } catch (e) {
          parsed = { ok: false, error: truncated ? '文件超过 10 MB 被截断，无法完整解析' : (e as Error).message };
        }
      } catch (e) {
        // 宿主调用可能以 code 失败：timeout（约 15 s 无回应）、out-of-scope、resource-missing……不要无限重试，交给用户点“重新读取”
        const code = (e as { code?: string }).code;
        parsed = { ok: false, read: true, error: code === 'timeout' ? '读取超时，请稍后重试' : (e as Error).message };
      }
      render();
    };

    const setState = (s: JsonViewerState) => {
      state = { expanded: s.expanded.slice(0, MAX_EXPANDED), showTypes: s.showTypes, ...(s.legacy ? { legacy: s.legacy } : {}) };
      ctx.requestSave();
      render();
    };

    return {
      async mount(t) {
        if (t.kind !== 'reader') throw new Error('JSON 查看器只能挂载到阅读器面板');
        target = t;
        if (ctx.files) {
          const st = await ctx.files.stat(item.ref);
          t.setTitle(st.name);
        }
        subs.push(
          t.onAction((action, payload) => {
            if (action === 'toggle' && typeof payload === 'string') {
              const has = state.expanded.includes(payload);
              setState({ ...state, expanded: has ? state.expanded.filter((p) => p !== payload) : [...state.expanded, payload] });
            } else if (action === 'toggle-types') {
              setState({ ...state, showTypes: !state.showTypes });
              void storage?.set(PREFS_KEY, { showTypes: state.showTypes });
            } else if (action === 'collapse-all') {
              setState({ ...state, expanded: ['$'] });
            } else if (action === 'reload') {
              void load();
            } else if (action === 'discard-legacy') {
              setState({ expanded: state.expanded, showTypes: state.showTypes });
            }
          }),
        );
        if (ctx.files) subs.push(ctx.files.onDidChange((e) => e.resourceId === item.ref && e.change === 'modified' && void load()));
        await load();
      },
      getState: () => state,
      onThemeChange() {
        // UiNode 只引用主题令牌，无需处理；自绘 DOM 的阅读器在这里刷新颜色。状态不变。
        render();
      },
      onPermissionDenied(d) {
        denied = `读取权限已被拒绝或撤销（${d.reason}）`;
        render();
      },
      dispose() {
        subs.forEach((s) => s.dispose());
        target = null;
      },
    };
  },
};

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    storage = api.storage;
    api.adapters.register(jsonViewerAdapter);
  },
  deactivate() {
    storage = null;
  },
};
export default plugin;
