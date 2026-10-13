// 有 DISPLAY 时直接运行，否则用 xvfb-run 包一层。依次运行 e2e/e2e.mjs、e2e/e2e-theme.mjs、e2e/e2e-workspaces.mjs、e2e/e2e-collections.mjs、e2e/e2e-edit.mjs、e2e/e2e-lazy.mjs、e2e/e2e-adapters.mjs、e2e/e2e-robustness.mjs、
// e2e/e2e-web.mjs（能连上 developer.mozilla.org 时用真实网站）与 e2e/e2e-web.mjs 的本地夹具站点模式、
// e2e/e2e-lifecycle.mjs（插件停用/缺失/升级，第 9 轮 R6）、e2e/e2e-migration.mjs（导出/导入/修复）、e2e/e2e-apps.mjs（外部程序项目，模拟外部程序）、e2e/e2e-layout.mjs（自由窗口）、e2e/e2e-keybindings.mjs（第 11 轮琴键）
// （可用参数只跑其中一个）
import { spawnSync } from 'node:child_process';
const useXvfb = process.platform === 'linux' && (!process.env.DISPLAY || process.env.KB_E2E_XVFB === '1');
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['e2e/e2e.mjs', 'e2e/e2e-theme.mjs', 'e2e/e2e-workspaces.mjs', 'e2e/e2e-collections.mjs', 'e2e/e2e-dirview.mjs', 'e2e/e2e-edit.mjs', 'e2e/e2e-lazy.mjs', 'e2e/e2e-adapters.mjs', 'e2e/e2e-robustness.mjs', 'e2e/e2e-web.mjs', 'e2e/e2e-web.mjs#fixture', 'e2e/e2e-lifecycle.mjs', 'e2e/e2e-migration.mjs', 'e2e/e2e-apps.mjs', 'e2e/e2e-layout.mjs', 'e2e/e2e-plans.mjs', 'e2e/e2e-console-parse.mjs', 'e2e/e2e-console-open.mjs', 'e2e/e2e-keybindings.mjs'];
let code = 0;
for (const spec of files) {
  // 'file#fixture'：同一脚本以本地夹具站点模式再跑一次（不截图）
  const [f, variant] = spec.split('#');
  const env = { ...(variant === 'fixture' ? { ...process.env, KB_E2E_WEB_MODE: 'fixture', KB_E2E_WEB_SHOTS: '0' } : process.env) };
  // 父进程若带着别的 Vite 开发服务器，Electron 会把那个页面当成工作台。端到端必须用刚构建的页面。
  delete env.VITE_DEV_SERVER_URL;
  const cmd = useXvfb ? 'xvfb-run' : process.execPath;
  const args = useXvfb ? ['-a', '-s', '-screen 0 1600x1000x24', process.execPath, f] : [f];
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.status !== 0) code = r.status ?? 1;
}
process.exit(code);
