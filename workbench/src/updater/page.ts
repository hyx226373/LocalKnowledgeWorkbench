/** 更新器窗口正文。不导入 electron。 */
import type { UpdaterState } from '../shared/layout';

export interface PageStatus {
  phase: string;
  phaseText: string;
  elapsedText: string;
  error: string;
  logFile: string;
}

const PHASE_TEXT: Record<string, string> = {
  idle: '空闲',
  preparing: '准备中',
  ready: '准备就绪',
  'waiting-exit': '等待工作台退出',
  switching: '正在切换版本',
  starting: '正在启动新版',
  verifying: '正在验证新版',
  done: '更新完成',
  'rolling-back': '正在恢复上一版',
  failed: '更新失败',
  cancelled: '已取消',
};

export function pageHtml(title: string): string {
  const safe = escapeHtml(title);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${safe}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #1e1e1e; color: #e8e8e8; font: 14px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  main { padding: 28px 32px 24px; }
  h1 { margin: 0 0 18px; font-size: 20px; font-weight: 600; }
  dl { display: grid; grid-template-columns: 88px 1fr; gap: 8px 12px; margin: 0; }
  dt { color: #9a9a9a; }
  dd { margin: 0; word-break: break-all; }
  #error { color: #f48771; }
  .actions { display: flex; gap: 12px; margin-top: 28px; }
  button { background: #2d2d2d; color: #e8e8e8; border: 1px solid #555; border-radius: 6px; padding: 8px 16px; font: inherit; cursor: pointer; }
  button:hover { border-color: #8a8a8a; }
  button:focus-visible { outline: 2px solid #4aa3df; outline-offset: 2px; }
</style>
</head>
<body>
<main>
  <h1>${safe}</h1>
  <dl>
    <dt>阶段</dt><dd id="phase">正在打开更新器</dd>
    <dt>耗时</dt><dd id="elapsed">0 秒</dd>
    <dt>错误</dt><dd id="error">无</dd>
    <dt>日志</dt><dd id="log">尚无日志</dd>
  </dl>
  <div class="actions">
    <button type="button" id="retry">重试</button>
    <button type="button" id="rollback">恢复上一版</button>
  </div>
</main>
<script>
window.__kbApply = function (status) {
  document.getElementById('phase').textContent = status.phaseText || status.phase || '未知';
  document.getElementById('elapsed').textContent = status.elapsedText || '0 秒';
  document.getElementById('error').textContent = status.error || '无';
  document.getElementById('log').textContent = status.logFile || '尚无日志';
  document.title = ${JSON.stringify(title)};
};
document.getElementById('retry').addEventListener('click', function () {
  location.assign('https://kb-updater.local/retry');
});
document.getElementById('rollback').addEventListener('click', function () {
  location.assign('https://kb-updater.local/rollback');
});
</script>
</body>
</html>`;
}

export function toPageStatus(state: Pick<UpdaterState, 'phase' | 'error' | 'logFile'>, elapsedMs: number): PageStatus {
  return {
    phase: state.phase,
    phaseText: PHASE_TEXT[state.phase] ?? state.phase,
    elapsedText: formatElapsed(elapsedMs),
    error: state.error ?? '',
    logFile: state.logFile ?? '',
  };
}

export function statusScript(status: PageStatus): string {
  return `window.__kbApply(${JSON.stringify(status)})`;
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0 秒';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  return `${(ms / 1000).toFixed(1)} 秒`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}
