/**
 * 应用适配器模板 · 示例：外部管理的 Notepad++（external-managed）
 *
 * 【填写】搜索 “TODO(fill)”。核心约定：
 * - Notepad++ 运行在它自己的窗口里；本面板只显示状态与控制（启动 / 切到前台 / 关闭），诚实标注。
 * - 只能经宿主进程代理启动 manifest 中声明的程序与参数模板；文件参数是 resourceId，由宿主解析为路径。
 *   适配器看不到 exe 路径、最终命令行，也无法追加参数。
 * - 恢复工作区不会自动启动程序（autoLaunchOnRestore 固定 false），必须用户点击。
 * - 为什么选 Notepad++：经典 Win32 程序，模板固定带 -multiInst，每次启动都是自己的进程、自己的顶层窗口
 *   （窗口类 "Notepad++"），进程句柄到窗口的对应关系稳定，窗口跟踪可靠。见 README。
 * - 显示方式如实声明为 external-managed「外部窗口启动」：不是内嵌窗口，面板只是状态占位。
 * - 启动前宿主只备份要打开的那个文件（D6 收紧版；manifest 可用 programs[].backup.include 声明少量附加文件），
 *   从不复制整个文件夹。备份范围内的文件内容可恢复；范围外的文件、Notepad++ 自己的配置、注册表、网络操作不可恢复。
 *   面板显示宿主返回的备份摘要（handle.backup）。
 */
import type {
  AdapterImplementation,
  AdapterInstance,
  AdapterPluginManifest,
  AdapterPluginModule,
  Disposable,
  ExternalMountTarget,
  LaunchFailure,
  ProcessHandleInfo,
  UiNode,
} from '@kb-workbench/adapter-sdk';
import { asRecord } from '@kb-workbench/adapter-sdk/policy';
import manifestJson from '../manifest.json' with { type: 'json' };

export const manifest = manifestJson as unknown as AdapterPluginManifest;
export const ADAPTER_ID = 'example.notepadpp.app'; // TODO(fill)
export const PROGRAM_NAME = 'Notepad++'; // TODO(fill)

export interface ExternalAppState {
  /** 上次启动时间（只用于显示“上次打开于”），null = 从未启动 */
  lastLaunchedAt: number | null;
}

export function restoreAppState(data: unknown, v: number): ExternalAppState | undefined {
  const r = asRecord(data);
  if (v !== 1 || !r) return undefined;
  if (!(r.lastLaunchedAt === null || (typeof r.lastLaunchedAt === 'number' && r.lastLaunchedAt > 0))) return undefined;
  return { lastLaunchedAt: r.lastLaunchedAt as number | null };
}

const FAILURE_TEXT: Record<LaunchFailure, string> = {
  'permission-denied': '没有启动权限',
  'unknown-program': '程序未在适配器中声明',
  'unknown-template': '参数模板未声明',
  'invalid-slot': '参数不合法，已拒绝',
  'resource-missing': '要打开的文件不存在',
  'resource-out-of-scope': '文件类型或位置不在允许范围',
  'not-installed': '未找到程序',
  'verification-failed': '程序校验失败（签名/哈希不符）',
  'already-running': '已在运行',
  'rate-limited': '启动过于频繁，请稍后再试',
  'spawn-failed': '启动失败',
  'backup-failed': '启动前备份失败，未启动（文件未被修改）',
  'backup-over-limit': '文件超过备份上限，且未确认“不备份也启动”，未启动',
};

/** 备份摘要（只有数量）：让用户知道哪些改动能恢复 */
export function backupLabel(h: ProcessHandleInfo | null): string | null {
  const b = h?.backup;
  if (!b) return null;
  if (b.targetUnprotected) return '本次未备份（文件超过备份上限）：外部修改不可恢复';
  return `启动前已备份 ${b.files} 个文件${b.skipped ? `（另有 ${b.skipped} 个附加文件因上限未备份）` : ''}；程序退出后被修改的文件记入操作记录，可撤销`;
}

export function statusLabel(h: ProcessHandleInfo | null): string {
  if (!h) return '未启动';
  switch (h.status) {
    case 'starting':
      return '正在启动';
    case 'running':
      return h.window.state === 'found' ? '运行中' : h.window.state === 'lost' ? '运行中（窗口未能跟踪）' : '运行中';
    case 'exited':
      return '已退出';
    case 'crashed':
      return `异常退出（代码 ${h.exitCode ?? '?'}）`;
    default:
      return '状态未知';
  }
}

export const externalAppAdapter: AdapterImplementation<ExternalAppState> = {
  id: ADAPTER_ID,
  restoreState: restoreAppState,
  open(_item, ctx): AdapterInstance<ExternalAppState> {
    let state: ExternalAppState = ctx.restoredState ?? { lastLaunchedAt: null };
    let handle: ProcessHandleInfo | null = null;
    let error: string | null = null;
    let target: ExternalMountTarget | null = null;
    const subs: Disposable[] = [];
    const profile = ctx.appProfile!;

    const render = () => {
      if (!target) return;
      const running = handle?.status === 'running' || handle?.status === 'starting';
      const children: UiNode[] = [
        { type: 'heading', text: profile.label, level: 2 },
        { type: 'stack', direction: 'row', children: [{ type: 'badge', label: '外部窗口启动', tone: 'info' }, { type: 'badge', label: statusLabel(handle), tone: running ? 'success' : 'muted' }] },
        { type: 'text', text: `${PROGRAM_NAME} 在它自己的窗口中运行；本面板只是状态占位与控制，不显示程序画面，也不是内嵌窗口。`, tone: 'muted' },
        {
          type: 'keyValue',
          rows: [
            { key: '程序', value: PROGRAM_NAME },
            { key: '上次启动', value: state.lastLaunchedAt ? new Date(state.lastLaunchedAt).toISOString() : '从未' },
          ],
        },
        {
          type: 'stack',
          direction: 'row',
          children: [
            { type: 'button', label: '启动', action: 'launch', variant: 'primary', disabled: running },
            { type: 'button', label: '切到前台', action: 'focus', disabled: !(running && handle?.window.state === 'found') },
            { type: 'button', label: '关闭', action: 'close', disabled: !running },
          ],
        },
      ];
      const bl = backupLabel(handle);
      if (bl) children.push({ type: 'text', text: bl, tone: handle?.backup?.targetUnprotected ? 'warning' : 'muted' });
      if (error) children.push({ type: 'notice', tone: 'error', title: error });
      target.render({ type: 'stack', children });
    };

    const launch = async () => {
      if (!ctx.process) return;
      // 只传应用档案里的 programId / templateId / 槽位；无法拼接任意命令行
      const r = await ctx.process.launch({ programId: profile.programId, templateId: profile.launch.templateId, slots: profile.launch.slots });
      if (r.ok) {
        handle = r.handle;
        error = null;
        state = { lastLaunchedAt: r.handle.startedAt };
        ctx.requestSave();
      } else {
        error = `${FAILURE_TEXT[r.reason]}${r.detail ? `：${r.detail}` : ''}`;
      }
      render();
    };

    return {
      mount(t) {
        if (t.kind !== 'external') throw new Error(`${PROGRAM_NAME} 适配器只能挂载到外部程序面板`);
        target = t;
        t.setTitle(profile.label);
        // 重新挂载时接回本插件仍在运行的实例（例如面板关闭后又打开）
        handle = ctx.process?.list().find((h) => h.programId === profile.programId && (h.status === 'running' || h.status === 'starting')) ?? null;
        subs.push(
          t.onAction((a) => {
            if (a === 'launch') void launch();
            else if (a === 'focus' && handle) void ctx.process?.focus(handle.launchId);
            else if (a === 'close' && handle) void ctx.process?.close(handle.launchId);
          }),
        );
        if (ctx.process)
          subs.push(
            ctx.process.onStatus((e) => {
              if (!handle || e.launchId !== handle.launchId) return;
              handle = { ...handle, status: e.status, exitCode: e.exitCode, window: e.window };
              render();
            }),
          );
        render();
      },
      getState: () => state,
      onThemeChange: () => render(),
      onPermissionDenied() {
        error = '启动权限已被撤销';
        render();
      },
      dispose() {
        // onPanelClose = leave-running（D4）：关闭面板不关闭外部程序
        subs.forEach((s) => s.dispose());
        target = null;
      },
    };
  },
};

const plugin: AdapterPluginModule = {
  manifest,
  activate(api) {
    api.adapters.register(externalAppAdapter);
  },
};
export default plugin;
