# 本地知识工作台（Local Knowledge Workbench）— 第九轮

Windows 桌面应用（Electron + TypeScript + React + Vite + dockview + better-sqlite3）。把已有文件夹注册为“根”，收藏、浏览、搜索、多标签分栏阅读；原文件留在原处，元数据存放在应用数据目录。

文档：
- [docs/01-产品规格.md](docs/01-产品规格.md)
- [docs/02-技术方案.md](docs/02-技术方案.md)（含数据模型、风险、Agent 接口草案）
- [docs/03-任务清单.md](docs/03-任务清单.md)
- [docs/04-视觉方向.md](docs/04-视觉方向.md)（三套视觉方向与截图）
- [docs/05-主题接口.md](docs/05-主题接口.md)（外框/阅读区/布局预设三轴、令牌、组件状态、受限 CSS）
- [docs/06-适配器宿主.md](docs/06-适配器宿主.md)（第三方沙箱适配器插件：安装、授权、沙箱协议、批量计划接口）
- [docs/07-打包与发布.md](docs/07-打包与发布.md)（Windows 打包、数据目录、fuses）
- [docs/08-后端接入与统一操作.md](docs/08-后端接入与统一操作.md)（第九轮：后端适配层；界面与 agent 共用同一操作入口）
- [docs/09-接口请求.md](docs/09-接口请求.md)（第九轮：给磐石组/迁移组/适配器组的接口请求）
- [docs/10-日常工作流（资料·编辑·分级加载）.md](docs/10-日常工作流（资料·编辑·分级加载）.md)（第九轮：本工作的资料、原地编辑、分级加载）
- [docs/11-自由窗口布局.md](docs/11-自由窗口布局.md)（第九轮验证切片：自由窗口 + 吸附分屏、dockview 能力核对、面板管理层 API、插件视图窗口声明草案）
- [docs/12-数据迁移.md](docs/12-数据迁移.md)（第九轮：迁移包导出/导入、根目录重映射、缺失文件重新定位、备份与回退；原编号 10，为避免与日常工作流重号改为 12）
- [theme-kit/README.md](theme-kit/README.md)（主题外包开发包 v2，含 Windows 步骤；[迁移说明](theme-kit/MIGRATION-v1-to-v2.md)、[CHANGELOG](theme-kit/CHANGELOG.md)）
- [verify/VERIFY.md](verify/VERIFY.md)（本轮验证记录与截图）

## 环境

- Node.js ≥ 20（构建工具）；Electron 44（自带 Node 24）。
- better-sqlite3 13 自带 N-API 预编译二进制（含 win32-x64），**安装时无需编译**：
  ```bash
  npm ci --ignore-scripts      # 跳过 better-sqlite3 的 node-gyp 回退编译
  node node_modules/electron/install.js   # 下载 Electron 二进制（--ignore-scripts 会跳过它）
  ```
  （Windows 上直接 `npm ci` 也可以；若 node-gyp 报错，用上面两步。）

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 构建主进程 → 启动 Vite dev server → 启动 Electron（主进程改动需重启） |
| `npm run build` | 生产构建到 `out/` |
| `npm start` | 运行 `out/` 中的生产构建 |
| `npm test` | vitest 单元/集成测试（用 Electron 自带 Node 运行，保证原生模块一致） |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm run sample` | 生成样例根 `/workspace/kb-sample`（需要 Python3 + Pillow） |
| `npm run e2e` | 构建并用 Playwright `_electron` 依次运行 `e2e/e2e.mjs`、`e2e-theme`、`e2e-workspaces`、`e2e-collections`、`e2e-edit`、`e2e-lazy`、`e2e-adapters`、`e2e-robustness`、`e2e-web`（先真实 developer.mozilla.org，再本地夹具站点模式）、`e2e-lifecycle`（插件停用/缺失/升级）、`e2e-migration`（导出/导入/修复）、`e2e-apps`（外部程序项目，模拟外部程序）（无 DISPLAY 时自动用 xvfb-run；`KB_E2E_XVFB=1` 强制使用；默认使用 `../kb-adapter-sdk`，`KB_ADAPTER_SDK_DIR=<目录>` 可另行指定 SDK 来源） |
| `node scripts/measure-startup.mjs` | 冷启动三项指标：窗口显示、可交互、可见内容加载完 |
| `npm run theme:shots -- <主题包文件夹或内置 id> [--out 目录]` | 渲染功能基准界面与组件状态表（浅色+深色）并输出校验报告 |
| `npm run plugin:build -- <插件源码目录> --out <输出目录>` | 把第三方适配器插件打成可安装文件夹（单文件 ES 模块 + manifest），SDK 包名解析到内置副本 |
| `npm run theme:kit` | 由主题接口重新生成 `theme-kit/` 的 TOKENS/COMPONENTS/schema |
| `npm run dist:win` | 打包 Windows x64 **NSIS 安装包**（`release/LocalKnowledgeWorkbench-<版本>-win-x64-setup.exe`）与 **portable**（`…-win-x64-portable.exe`），另有 `release/win-unpacked/` |
| `npm run dist:win-portable` / `npm run dist:win-zip` | 只打 portable / zip |
| `npm run icon` | 重新生成占位图标 `build/icon.png`、`build/icon.ico`（见 `build/README.md`） |

Windows 打包说明（详见 docs/07）：
- 本地没有代码签名证书时用 `KB_WIN_UNSIGNED=1 npm run dist:win`（PowerShell：`$env:KB_WIN_UNSIGNED=1; npm run dist:win`），只跳过签名（`signExecutable=false`），图标和版本信息照常写入。发布构建不设它，用 `CSC_LINK`/`CSC_KEY_PASSWORD` 提供证书。
- 安装包：非一键安装、按用户安装（不需要管理员）、可选择安装目录、创建桌面与开始菜单快捷方式「本地知识工作台」。卸载时询问是否删除用户数据，默认保留（`build/installer.nsh`）。
- 在 Linux 上交叉打包 NSIS 需要 wine（`apt install wine wine64`）；portable/zip 不需要。
- 图标是占位图标（`build/README.md`）。

环境变量 `KB_USER_DATA=<目录>` 可指定应用数据目录（测试/便携使用）；`KB_THEME_DIRS=<目录>[;<目录>]` 加载开发中的主题包。默认位置：Windows `%LOCALAPPDATA%\LocalKnowledgeWorkbench`（第八轮起；旧版本的 `%APPDATA%\LocalKnowledgeWorkbench` 会在首次启动时一次性迁移过来，见 docs/07 §2）；Linux `~/.config/LocalKnowledgeWorkbench`。

## 目录结构

```
src/shared/types.ts              渲染进程与主进程共享的数据契约（也是未来 Agent API 契约）
src/main/service/
  WorkbenchService.ts            唯一服务层（根/资源/收藏/布局/搜索/操作记录与撤销/备份）
  db.ts                          SQLite 表结构与迁移
  indexer.ts                     扫描、事件应用、资源身份识别（纯 Node）
  indexRunner.ts                 worker 执行器（进度/取消）
  paths.ts                       路径规范化与越界校验、kbfile URL 解析
  watcher.ts                     chokidar 监听
src/main/indexWorker.ts          worker_threads 入口
src/main/index.ts                Electron 主进程：窗口、IPC 白名单、kbfile:// 与 kbplugin:// 协议
src/main/service/pluginHost.ts   第三方适配器插件：安装、授权、files.*、kbfile 令牌、存储、卸载、批量计划
src/main/service/plan.ts         批量计划引擎接口与桩实现（第三方插件用）
src/main/service/textEdit.ts     原地编辑服务（编码/BOM/换行保留、冲突检测、保存历史与撤销）
src/main/backend/                后端适配层：plan / fileOps / search / sync 与统一操作入口 operations.ts
src/renderer/lazyLoad.ts         分级加载（后台预载、可见内容追踪）
src/shared/adapter-sdk/          SDK types/policy 副本（kb-adapter-sdk 050df08）
src/plugin-runtime/runtime.ts    沙箱 iframe 内的宿主运行时
src/renderer/sandbox/            沙箱面板与 UiNode 渲染
src/renderer/ui/                 占位、授权/计划/卸载对话框、插件管理
src/preload/index.ts             contextBridge → window.kb
src/renderer/App.tsx             应用框架（侧栏/搜索/命令面板/状态栏/dockview）
src/renderer/ViewHost.tsx        条目宿主（dockview 通用面板）：按 itemId 找条目与适配器，不可用时占位
src/renderer/plugin-host/        插件宿主：types（扩展点与 PluginApi）、registry、host、manifest、semver、layoutModel
src/renderer/plugins/            builtin-readers（file 适配器：md/pdf/text/image/unsupported）、demo-csv-table（演示插件）
src/renderer/theme/              主题接口校验、主题包加载、外观应用
src/shared/theme-contract.json   主题接口单一来源（v2：122 个令牌、22 个组件、CSS 规则）
themes/                          内置主题包 study / pro / bright（占位，各含浅色与深色）
theme-kit/                       主题外包开发包
src/renderer/styles.css          只引用 --kb-* 设计令牌的组件样式
tests/                           vitest（服务层、工作区、插件宿主、主题接口、路径校验、worker）
e2e/e2e*.mjs                     Playwright 端到端脚本（fixtures/plugins：恶意与笔记测试插件）；e2e/packaged-fuses-smoke.mjs 打包产物冒烟 + fuses 验证（npm run smoke:packaged）
scripts/                         构建/测试/样例脚本
verify/                          验证截图与结果
```

## 写一个文件适配器（宿主 API 0.2）

```ts
const plugin: PluginModule = {
  manifest: { id: 'my.json-tree', name: 'JSON 树', version: '0.1.0', engines: { workbench: '^0.2.0' },
    contributes: { adapters: [{ id: 'my.json-tree', sourceKinds: ['file'], displayMode: 'in-app-reader', permissions: ['fs:roots'], stateSchemaVersion: 1 }] } },
  activate(api) {
    api.adapters.register<{ expanded: string[] }>({
      id: 'my.json-tree', title: 'JSON 树', sourceKinds: ['file'], displayMode: 'in-app-reader', stateSchemaVersion: 1,
      match: (t) => (t.sourceKind === 'file' && t.resource.ext === 'json' ? 200 : 0), // 内置文本视图是 100
      component: ({ resource, api, state, setState }) => null, // 用 api.workspace.readText(resource.resourceId)
    });
  },
};
```
以上是**内置**插件的写法（随应用编译，在渲染进程运行），权限用 SDK 结构化声明，例如 `permissions: [{ id: 'read', kind: 'fs.read', scope: 'ask-per-root', extensions: ['json'], reason: '…' }]`。

**第三方**插件用 `kb-adapter-sdk` 的 `AdapterPluginManifest` 与 `ReaderAdapter` 写，`npm run plugin:build` 打包后在“插件管理 → 开发者模式 → 安装本地插件文件夹”安装，运行在沙箱 iframe 中（见 docs/06）。

## 第九轮新增

- **主题工具包 v2**（契约 2.0.0）：122 个令牌（带角色）、统一状态集、22 个组件权威清单、`read-focus-*` 与 F9 专注模式；PDF 暗色滤镜改为面板级开关；v1 包以兼容模式加载。
- **本工作的资料**：文件树行上 ⊕ 加入当前工作区，侧栏“本工作的资料”可一键全部打开、移除需确认；随导出/导入携带。
- **原地编辑**：文本/Markdown 预览·编辑·分栏；保存前显示差异；外部修改冲突时可“保留我的 / 采用外部的 / 对比后再决定”；保留编码、BOM、换行；可撤销上次保存；GBK、UTF-16BE、>4 MB、二进制只读。
- **分级加载**：冷启动只挂载可见面板，隐藏标签切到时才加载，空闲后按 `settings.backgroundLoadDelayMs`（默认 4000，-1 关闭）后台预载；网页面板不参与。
- **后端接入准备**：`src/main/backend/`（plan / fileOps / search / sync 适配层，OperationService 统一操作入口：agent 只能提出计划，只有界面能批准，批准后自动执行），契约测试 `tests/backend-contract.test.ts`；尚未接 IPC。

## 已知限制（本轮）

- 第九轮：全部只在 Linux 验证，**未在 Windows 真机运行**；真实 @kb/plan / @kb/fileops / searchGrouped / createSync 未接入（适配层与 mock 契约测试已就位，见 docs/08、docs/09）；应用里没有 agent 入口；标签标题无“未保存”标记。

- 第三方插件只能开发者模式本地安装，无 `.kbplugin` 包、签名、商店（D7）；无懒激活；沙箱只支持 UiNode 界面（无自绘 DOM）；有心跳看门狗与调用超时、审计记录，但没有 CPU/内存配额；批量计划执行用桩引擎（非事务）。
- 工作区条目中 **file** 与 **web** 可用（web：H9 网页面板，见 docs/06 §11；用 SDK 的 web-adapter 模板开发者模式安装后，命令面板“打开网页面板：…”）；app 只有类型、校验与“暂不可用”占位（P3，H10–H13 未做）。
- 网页面板：工作台浮层（菜单、对话框）与网页相交时网页被临时换成截图（原生视图无法与 DOM 混排）；恢复滚动后真实网站晚加载的内容仍可能推动位置；坐标按 100% 页面缩放计算。
- 三套主题包是占位实现，等待外包定稿。
- 搜索仅文件名/路径；正文搜索（txt/md/有文本层的 PDF）未实现（03 T1）。
- 文件删除/移动与撤销只在服务层，UI 未接入（文本保存与撤销已接入）；Agent 接口只有主进程内的统一操作入口，未开放。
- 全部自动化验证在 Linux 上完成；Windows 真机只测过旧版 8e792ef。本轮针对该反馈的修复（安装包、%LOCALAPPDATA% 数据目录与迁移、卸载询问、fuses、中文菜单）在 Linux 上交叉构建并做了静态检查（fuses 读数、PE 图标/版本资源、asar 完整性资源），**未在 Windows 上运行**；NSIS 卸载询问、快捷方式名、Roaming→Local 迁移需在 Windows 真机复验（见 docs/07）。
- exe 的“文件说明”（FileDescription）与任务管理器中的进程名仍是 LocalKnowledgeWorkbench；快捷方式、窗口标题、卸载项显示「本地知识工作台」。
- 图标是占位图（`build/README.md`）；安装包未签名（`KB_WIN_UNSIGNED=1`）。
- 正式构建保留 fuse `GrantFileProtocolExtraPrivileges`（渲染进程走 file://）；打了 fuses 的产物不能用 Playwright 控制，打包冒烟用 `npm run smoke:packaged`（进程级检查）。
