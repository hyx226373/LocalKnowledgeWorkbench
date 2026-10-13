/**
 * 沙箱 iframe ⇄ 宿主（渲染进程）的 postMessage 协议（H4）。
 * - 宿主只接受 event.source === 该面板 iframe.contentWindow 的消息，并按白名单逐字段校验；
 * - 插件身份由宿主按面板所属插件确定，消息中的任何“身份”字段都被忽略；
 * - UiNode 在宿主侧重新构造（只保留已知字段、限制深度/数量/长度），渲染只用 textContent（React 文本节点）。
 */
import type { JsonValue, UiNode, UiTone, UiTreeNode } from './adapter-sdk/types';

export const FRAME_MSG = 'kb-frame';

/**
 * 健壮性参数（T13）：
 * - 心跳：宿主每 HEARTBEAT_MS 发 ping，运行时回 pong；连续 BUSY_MS 没有回应 → 判定“卡死”（事件循环被占满），
 *   宿主杀掉该插件的渲染进程（插件 iframe 是独立进程，见 docs/06 §5.2）并显示 adapter-error 占位。
 * - 逐次调用超时：插件 → 宿主的每个 RPC 最多 RPC_TIMEOUT_MS；宿主 → 插件的生命周期调用（activate/open+mount）最多 LIFECYCLE_TIMEOUT_MS。
 * - 消息洪泛：1 秒内超过 FLOOD_MAX_PER_SEC 条消息 → 按卡死处理。
 */
export const HEARTBEAT_MS = 500;
export const BUSY_MS = 3000;
export const RPC_TIMEOUT_MS = 15000;
export const LIFECYCLE_TIMEOUT_MS = 10000;
export const FLOOD_MAX_PER_SEC = 400;
export const HOST_MSG = 'kb-host';

export type FrameToHost =
  | { type: 'ready' }
  | { type: 'pong'; seq: number }
  | { type: 'activated' }
  | { type: 'activate-error'; message: string }
  /** reset：状态无法恢复（宿主保留原状态，见 items.ts preserved）；recovered：插件新版本成功恢复了之前保留的旧状态 */
  | { type: 'opened'; reset: boolean; recovered?: boolean }
  | { type: 'open-error'; message: string }
  | { type: 'render'; node: unknown }
  | { type: 'set-title'; title: string }
  | { type: 'state'; data: unknown }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'rpc'; id: number; method: RpcMethod; params: Record<string, unknown> }
  /** r11-B：iframe 内按下的已绑定组合键 */
  | { type: 'shortcut'; accelerator: string };

export const RPC_METHODS = ['files.stat', 'files.readText', 'files.readBytes', 'files.requestFileops', 'storage.get', 'storage.set', 'storage.delete', 'storage.keys', 'permissions.request',
  // 网页面板（H9）：只作用于本面板的 WebContentsView，域名由主进程再查一次
  'web.navigate', 'web.back', 'web.forward', 'web.reload', 'web.getScroll', 'web.setScroll', 'web.clearSessionData',
  // 外部程序（H10）：只作用于本条目的应用档案，主进程再按授权、声明与应用档案检查
  'process.detect', 'process.launch', 'process.focus', 'process.close', 'process.list'] as const;
export type RpcMethod = (typeof RPC_METHODS)[number];

export const FRAME_TYPES = ['ready', 'pong', 'activated', 'activate-error', 'opened', 'open-error', 'render', 'set-title', 'state', 'log', 'rpc', 'shortcut'] as const;

/** 校验来自 iframe 的消息外形；不合法返回 null（宿主直接丢弃） */
export function parseFrameMessage(data: unknown): FrameToHost | null {
  if (!data || typeof data !== 'object') return null;
  const m = data as Record<string, unknown>;
  if (m.kb !== FRAME_MSG || typeof m.type !== 'string' || !(FRAME_TYPES as readonly string[]).includes(m.type)) return null;
  switch (m.type) {
    case 'ready':
    case 'activated':
      return { type: m.type };
    case 'activate-error':
    case 'open-error':
      return { type: m.type, message: String(m.message ?? '').slice(0, 2000) };
    case 'opened':
      return { type: 'opened', reset: m.reset === true, recovered: m.recovered === true };
    case 'pong':
      return Number.isInteger(m.seq) ? { type: 'pong', seq: m.seq as number } : null;
    case 'render':
      return { type: 'render', node: m.node };
    case 'set-title':
      return typeof m.title === 'string' ? { type: 'set-title', title: m.title.slice(0, 200) } : null;
    case 'state':
      return { type: 'state', data: m.data };
    case 'log':
      return { type: 'log', level: m.level === 'warn' || m.level === 'error' ? m.level : 'info', message: String(m.message ?? '').slice(0, 4000) };
    case 'rpc':
      if (!Number.isInteger(m.id) || typeof m.method !== 'string' || !(RPC_METHODS as readonly string[]).includes(m.method)) return null;
      return { type: 'rpc', id: m.id as number, method: m.method as RpcMethod, params: m.params && typeof m.params === 'object' && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {} };
    case 'shortcut':
      return typeof m.accelerator === 'string' && m.accelerator.length > 0 && m.accelerator.length < 64
        ? { type: 'shortcut', accelerator: m.accelerator }
        : null;
  }
  return null;
}

// ---------------- UiNode 校验（宿主侧重新构造） ----------------

const TONES = ['normal', 'muted', 'info', 'success', 'warning', 'danger'] as const;
const MAX_DEPTH = 32;
const MAX_NODES = 5000;
const MAX_TEXT = 20000;

export class UiNodeError extends Error {}

function str(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max);
}
function payloadOf(v: unknown): JsonValue | undefined {
  if (v === undefined) return undefined;
  try {
    const s = JSON.stringify(v);
    if (s === undefined || s.length > 4096) return undefined;
    return JSON.parse(s) as JsonValue;
  } catch {
    return undefined;
  }
}

/** 返回只含已知字段的新树；未知节点类型变成一条“不支持的节点”提示（不会把任何字段当 HTML） */
export function sanitizeUiNode(raw: unknown): UiNode {
  let count = 0;
  const walk = (n: unknown, depth: number): UiNode => {
    if (++count > MAX_NODES) throw new UiNodeError(`节点过多（上限 ${MAX_NODES}）`);
    if (depth > MAX_DEPTH) throw new UiNodeError(`嵌套过深（上限 ${MAX_DEPTH}）`);
    const o = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
    const tone = (TONES as readonly string[]).includes(o.tone as string) ? (o.tone as UiTone) : undefined;
    switch (o.type) {
      case 'text':
        return { type: 'text', text: str(o.text), ...(tone ? { tone } : {}), ...(o.mono === true ? { mono: true } : {}) };
      case 'heading':
        return { type: 'heading', text: str(o.text, 500), level: o.level === 1 || o.level === 3 ? o.level : 2 };
      case 'code':
        return { type: 'code', text: str(o.text, 200000), ...(typeof o.language === 'string' ? { language: o.language.slice(0, 40) } : {}) };
      case 'badge':
        return { type: 'badge', label: str(o.label, 200), ...(tone ? { tone } : {}) };
      case 'button':
        return {
          type: 'button',
          label: str(o.label, 200),
          action: str(o.action, 200),
          ...(payloadOf(o.payload) !== undefined ? { payload: payloadOf(o.payload) } : {}),
          ...(o.disabled === true ? { disabled: true } : {}),
          variant: o.variant === 'primary' || o.variant === 'ghost' ? o.variant : 'secondary',
        };
      case 'stack':
        return { type: 'stack', direction: o.direction === 'row' ? 'row' : 'column', children: Array.isArray(o.children) ? o.children.map((c) => walk(c, depth + 1)) : [] };
      case 'keyValue':
        return { type: 'keyValue', rows: Array.isArray(o.rows) ? o.rows.slice(0, 2000).map((r) => ({ key: str((r as Record<string, unknown>)?.key, 500), value: str((r as Record<string, unknown>)?.value) })) : [] };
      case 'tree': {
        const tw = (t: unknown, d: number): UiTreeNode => {
          if (++count > MAX_NODES) throw new UiNodeError(`节点过多（上限 ${MAX_NODES}）`);
          if (d > MAX_DEPTH * 4) throw new UiNodeError('树嵌套过深');
          const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
          return {
            id: str(x.id, 1024),
            label: str(x.label, 2000),
            ...(x.detail !== undefined ? { detail: str(x.detail, 2000) } : {}),
            ...(x.expanded === true ? { expanded: true } : {}),
            ...(Array.isArray(x.children) ? { children: x.children.map((c) => tw(c, d + 1)) } : {}),
          };
        };
        return { type: 'tree', nodes: Array.isArray(o.nodes) ? o.nodes.map((t) => tw(t, depth + 1)) : [], toggleAction: str(o.toggleAction, 200) };
      }
      case 'notice':
        return {
          type: 'notice',
          tone: o.tone === 'warning' || o.tone === 'error' ? o.tone : 'info',
          title: str(o.title, 500),
          ...(o.message !== undefined ? { message: str(o.message) } : {}),
          ...(Array.isArray(o.actions) ? { actions: o.actions.slice(0, 10).map((a) => ({ label: str((a as Record<string, unknown>)?.label, 200), action: str((a as Record<string, unknown>)?.action, 200), ...(payloadOf((a as Record<string, unknown>)?.payload) !== undefined ? { payload: payloadOf((a as Record<string, unknown>)?.payload) } : {}) })) } : {}),
        };
      default:
        return { type: 'notice', tone: 'warning', title: '不支持的界面节点', message: `类型 ${str(o.type, 40) || '（缺失）'} 已被宿主忽略` };
    }
  };
  return walk(raw, 0);
}
