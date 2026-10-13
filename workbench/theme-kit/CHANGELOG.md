# 主题接口（theme-kit）变更记录

## 2.0.0（2026-10-03，第 9 轮）

主版本升级。v1 主题包（`engines.themeContract: "^1.0.0"`）**仍可加载**（兼容模式，报告里给警告），但请按 `MIGRATION-v1-to-v2.md` 升级。

### 新增
- **颜色角色**：每个颜色令牌都有一个点分语义名（`role`），例如 `surface.sunken`、`text.disabled`、`splitter.dragging`、`diff.add-bg`。完整对照表在 `TOKENS.md` 末尾。设计稿/评审用角色名，theme.json 里写令牌名。
- 新令牌（外框）：
  - `color-surface-sunken`（`surface.sunken`）：凹陷底色，用于资料列表、对比视图、编辑器装订线
  - `color-text-disabled`（`text.disabled`）：禁用文字（v1 的 `color-disabled-fg` 改名而来）
  - `color-sash-dragging`（`splitter.dragging`）：分隔条拖动中（v1 里拖动和悬停共用 `color-sash-hover`）
  - `color-diff-add-bg/fg`、`color-diff-del-bg/fg`（`diff.*`）：保存前的改动预览、冲突对比
  - `opacity-dragging`（`state.dragging-opacity`）：被拖动的标签的不透明度
- 新令牌（阅读区）：
  - **阅读专注模式** `read-focus-bg`、`read-focus-fg`、`read-focus-fs`、`read-focus-lh`、`read-focus-max-width`、`read-focus-pad-x`、`read-focus-pad-y`、`read-focus-chrome-opacity`。命令“阅读专注模式（开/关）”（F9）开启后，内置阅读器的内容根带 `data-focus="on"`，外框（顶栏、侧栏、状态栏、标签栏）按 `read-focus-chrome-opacity` 淡出，悬停时恢复。不改变任何布局和分栏尺寸。
  - `read-editor-bg`、`read-editor-caret`：txt/md 原位编辑器
  - `read-pdf-dark-filter`：PDF 深色滤镜参数（见下“行为变化”）
- **统一状态集合**：`default`、`hover`、`active`、`focus-visible`、`disabled`、`selected`、`dragging`、`drag-over`。每个组件按需取用，没有的为 `null`。
- **权威组件清单**：22 个组件，取代 v1 时期两份不一致的清单（`COMPONENTS.md` 的 15 个和组件状态表实际渲染的 9 个）。现在组件状态表逐个组件、逐个状态渲染整份清单；`theme:shots` 报告里会核对，缺格子就报错。新增的组件：`toggle`（复选开关）、`collection-row`（本工作的资料）、`toast`（提示条/横幅）、`diff`（改动对比）、`editor`（原位编辑器）、`pdf-page`（PDF 页面）、`reading-focus`（专注模式）；`tab`、`group` 现在在状态表里也有逐状态的格子。

### 改名（v1 → v2）
| v1 | v2 |
| --- | --- |
| 令牌 `color-disabled-fg` | `color-text-disabled` |
| 令牌 `read-pdf-filter` | `read-pdf-dark-filter`（含义也变了，见下） |
| 状态 `focus` | `focus-visible` |

### 行为变化
- **PDF 默认原色显示**。v1 的 `read-pdf-filter` 一旦设置就对所有 PDF 强制生效；v2 中滤镜是**每个 PDF 面板的可选设置**（工具栏“深色滤镜”按钮，状态存进该面板的阅读状态，重启后保留），主题只通过 `read-pdf-dark-filter` 提供滤镜参数，不能强制开启。
- 分隔条拖动中改用 `color-sash-dragging`。

### 不变
- 三个轴：外框样式（chromeThemes）、阅读区样式（readingThemes，即“reader”）、布局预设（layoutPresets）。用户分别选择，可以任意组合，例如“B 的外框 + A 的阅读区”。机制见 `README.md` §1。
- CSS 限制（禁止布局属性、`url()`、`@import`、改写 `--kb-*` 变量）不变。
- 截图命令不变：`node scripts/theme-shots.mjs <主题包文件夹> --out <输出>`，照常生成浅色和深色两套截图。

## 1.0.0
首个版本：105 个令牌（外框 80、阅读区 25），15 个组件 × 7 种状态。
