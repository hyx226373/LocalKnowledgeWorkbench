# 组件、状态与可用选择器（自动生成，勿手改）

主题接口 **2.0.0**。这是**唯一权威的组件清单**（22 个组件）：组件状态表（`npm run theme:shots` 生成的 states-light.png / states-dark.png）逐个组件、逐个状态渲染这里列出的全部格子；视觉组按本表交付，不再各自维护清单。

统一状态集合：

- `default`：默认外观
- `hover`：鼠标悬停（:hover）
- `active`：按下（:active）或“当前激活”（例如激活分组）
- `focus-visible`：键盘焦点（:focus-visible；v1 名为 focus）
- `disabled`：不可用（:disabled / [aria-disabled="true"]）
- `selected`：选中/当前项（[aria-selected="true"]、当前标签、勾选）
- `dragging`：自身正被拖动（v2 新增：[data-dragging="true"]）
- `drag-over`：作为拖放目标、有东西拖到上方

“—”表示该组件没有这个状态。标 **v2** 的组件是主题接口 2.0 新增的。

主题 CSS 的每条规则都必须以下表中的**钩子类**开头（可以接后代、伪类、属性选择器），宿主会自动加上作用域前缀。

| 组件 | 轴 | 钩子类 | default | hover | active | focus-visible | disabled | selected | dragging | drag-over |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 按钮（主/次/幽灵） | 外框 | `.kb-button, .kb-button--secondary, .kb-button--ghost` | `.kb-button` | `:hover` | `:active` | `:focus-visible` | `:disabled` | `[aria-pressed="true"]（开关按钮按下，例如 PDF“深色滤镜”、编辑器“预览”）` | — | — |
| 输入框/下拉框/多行文本 | 外框 | `.kb-input, .kb-select, .kb-textarea` | `.kb-input` | `:hover` | — | `:focus-visible` | `:disabled` | — | — | — |
| 复选开关 **v2** | 外框 | `.kb-toggle` | `.kb-toggle` | `:hover` | — | `.kb-toggle input:focus-visible` | `[aria-disabled="true"]` | `.kb-toggle input:checked（勾选）` | — | — |
| 标签页（dockview）<br><small>未加载的后台标签：.dv-tab [data-lazy="pending"]（冷启动分级加载，切到它时才加载内容）</small> | 外框 | `.kb-dock .dv-tab` | `.dv-tab` | `:hover` | `:active` | `:focus-visible` | — | `.dv-active-tab（所在分组激活时外层有 .dv-active-group）` | `.dv-tab[data-dragging="true"]（正被拖动的标签）` | `.kb-dock .dv-drop-target-selection（拖到分组上方时出现的覆盖层，颜色来自 --kb-color-drag-over）` |
| 分栏分组（可做成卡片） | 外框 | `.kb-dock .dv-groupview, .kb-dock .dv-tabs-and-actions-container` | `.dv-groupview` | — | `.dv-active-group（当前激活分组）` | — | — | — | — | `.kb-dock .dv-drop-target-selection` |
| 目录树行/收藏行<br><small>被忽略的项（显示被忽略的项时）：.kb-tree-row.ignored</small> | 外框 | `.kb-tree-row` | `.kb-tree-row` | `:hover` | `:active` | `:focus-visible` | `[aria-disabled="true"]（文件已不在原处）` | `[aria-selected="true"]（当前激活标签对应的文件）` | — | `[data-drag-over="true"]（预留）` |
| 工作资料行（侧栏“本工作的资料”） **v2**<br><small>已打开为标签：[data-open="true"]</small> | 外框 | `.kb-collection, .kb-collection-row` | `.kb-collection-row` | `:hover` | `:active` | `:focus-visible` | `[aria-disabled="true"]（原文件已不在原处）` | `[aria-selected="true"]（当前激活标签）` | — | — |
| 分隔条（侧栏 + 分栏） | 外框 | `.kb-sash, .kb-dock .dv-sash` | `.kb-sash` | `:hover` | `:active` | — | `.dv-sash.dv-disabled` | — | `[data-dragging="true"]（侧栏分隔条拖动中；分栏分隔条拖动中为 .dv-sash:active）` | — |
| 搜索结果行 | 外框 | `.kb-search-results, .kb-search-hit` | `.kb-search-hit` | `:hover` | `:active` | — | — | `[aria-selected="true"]（键盘选中）` | — | — |
| 菜单项（工作区切换、外观、命令面板） | 外框 | `.kb-popover, .kb-menu-item, .kb-menu-group-title` | `.kb-menu-item` | `:hover` | `:active` | `:focus-visible` | `[aria-disabled="true"]` | `[aria-selected="true"]（当前工作区/选中命令）` | — | — |
| 插件侧栏行 | 外框 | `.kb-plugin-row, .kb-badge` | `.kb-plugin-row` | `:hover` | — | — | `[data-status="disabled"] / [data-status="error"\|"incompatible"\|"denied"]` | — | — | — |
| 状态栏<br><small>状态：.kb-status-item[data-state="idle"\|"scanning"\|"error"]</small> | 外框 | `.kb-statusbar, .kb-status-item` | `.kb-status-item` | `.kb-status-item button:hover` | — | — | — | — | — | — |
| 对话框 | 外框 | `.kb-dialog-backdrop, .kb-dialog, .kb-dialog-title, .kb-dialog-body, .kb-dialog-actions` | `.kb-dialog` | — | — | `.kb-dialog:focus-within` | — | — | — | — |
| 提示条与横幅（保存成功、冲突、只读工作区） **v2**<br><small>语气：[data-tone="info"\|"success"\|"warning"\|"danger"]</small> | 外框 | `.kb-toast, .kb-banner` | `.kb-toast / .kb-banner` | — | — | — | — | — | — | — |
| 侧栏区块/顶栏 | 外框 | `.kb-sidebar, .kb-section, .kb-section-title, .kb-topbar` | `.kb-section` | — | — | — | — | — | — | — |
| 视图工具栏（PDF 页码/缩放/深色滤镜、编辑器 编辑/预览/保存）<br><small>其中的按钮使用 button 组件的全部状态</small> | 外框 | `.kb-view-toolbar` | `.kb-view-toolbar` | — | — | — | — | — | — | — |
| 空状态/占位/错误提示 | 外框 | `.kb-notice, .kb-watermark` | `.kb-notice` | — | — | — | — | — | — | — |
| 改动对比（保存前预览、冲突对比） **v2** | 外框 | `.kb-diff, .kb-diff-line` | `.kb-diff-line[data-kind="ctx"]` | — | — | — | — | `.kb-diff-line[data-kind="add"] / [data-kind="del"]（新增/删除行，颜色来自 diff.* 角色）` | — | — |
| 阅读区（所有视图的内容根） | 阅读区 | `.kb-reading, .kb-reading .kb-md, .kb-reading pre, .kb-table` | `.kb-reading` | — | — | — | — | `.kb-reading ::selection` | — | — |
| 文本/Markdown 原位编辑器 **v2**<br><small>有未保存修改：.kb-editor[data-dirty="true"]；冲突：.kb-editor[data-conflict="true"]</small> | 阅读区 | `.kb-editor, .kb-editor-text` | `.kb-editor-text` | — | — | `:focus-visible` | `[readonly]（只读：冲突待处理时）` | `::selection` | — | — |
| PDF 页面 **v2** | 阅读区 | `.kb-pdf-page` | `.kb-pdf-page（原色，不加滤镜）` | — | — | — | — | `.kb-reading[data-dark-filter="on"] .kb-pdf-page（用户在该 PDF 面板开启了深色滤镜，应用 --kb-read-pdf-dark-filter）` | — | — |
| 阅读专注模式 **v2** | 阅读区 | `.kb-reading[data-focus="on"]` | `.kb-reading[data-focus="on"]（使用 read-focus-* 令牌）` | — | — | — | — | — | — | — |

## CSS 规则

- 只允许：令牌赋值（在 theme.json 中）+ 以钩子类开头的受限 CSS。
- 禁止的属性（会改变布局）：`position`、`display`、`float`、`clear`、`flex`、`flex-basis`、`flex-direction`、`flex-flow`、`flex-grow`、`flex-shrink`、`flex-wrap`、`order`、`grid`、`grid-area`、`grid-auto-columns`、`grid-auto-flow`、`grid-auto-rows`、`grid-column`、`grid-row`、`grid-template`、`grid-template-areas`、`grid-template-columns`、`grid-template-rows`、`width`、`height`、`min-width`、`min-height`、`max-width`、`max-height`、`top`、`right`、`bottom`、`left`、`inset`、`z-index`、`overflow`、`overflow-x`、`overflow-y`、`visibility`、`columns`、`column-count`、`column-width`、`margin`、`margin-top`、`margin-right`、`margin-bottom`、`margin-left`、`transform`、`translate`、`scale`、`rotate`、`content`、`pointer-events`、`contain`、`zoom`、`aspect-ratio`、`resize`、`direction`、`writing-mode`。
- 允许的 @规则：`@media (prefers-reduced-motion: reduce)`、`@media (prefers-contrast: more)`；其余 @规则（含 @import、@font-face）一律拒绝。
- 禁止的值：`url(`、`expression(`、`@import`、`javascript:`（不能加载外部资源）。
- 不能定义或改写 `--kb-*` 变量（令牌只能在 theme.json 中设置）；不能选择 `html`、`body`、`*`、`#id`。
- 外框 CSS 不能选择阅读区钩子（`.kb-reading`、`.kb-md`、`.kb-pdf-page` …），反之亦然。
- 改变分栏排列的需求一律写成**布局预设 JSON**（见 template/layouts/example.json），不属于主题。
