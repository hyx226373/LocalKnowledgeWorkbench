# 主题令牌（自动生成，勿手改）

主题接口版本 **2.0.0**；宿主 API **0.2.0**。共 **122** 个令牌：外框 87 个、阅读区 35 个。

- 在 `theme.json` 里写令牌名（不带 `--kb-` 前缀）；CSS 中写作 `var(--kb-<名称>)`。
- 外框样式（chromeThemes）只能设置外框令牌；阅读区样式（readingThemes）只能设置 `read-*` 令牌。
- 没有设置的令牌使用下表默认值（浅色 / 深色各一套）。
- 尺寸类令牌（`size-*`、`row-inset`、`dock-gap`、`shell-inset`）只影响外观，不会改变工作区里保存的分栏比例。
- **颜色角色**（v2）：每个颜色令牌都有一个点分语义名（`surface.sunken`、`text.disabled`、`splitter.dragging` …）。设计稿与评审用角色名沟通，theme.json 里写令牌名；两者一一对应（见文末“颜色角色”表）。
- 标 **v2** 的是主题接口 2.0 新增的令牌。改名的令牌见 `MIGRATION-v1-to-v2.md`。

## 外框令牌（chromeThemes）


### typography

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `font-ui` | — | 界面字体（菜单、树、按钮、标签） | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` |
| `font-mono` | — | 界面等宽字体（快捷键、路径） | `"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace` | `"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace` |
| `font-ui-accent` | — | 强调字体（标签标题、状态栏、页码；可设为等宽或衬线） | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` |
| `fs-xs` | — | 最小字号（徽标、区块小标题） | `11px` | `11px` |
| `fs-sm` | — | 小字号（按钮、标签、次要信息） | `12px` | `12px` |
| `fs-md` | — | 界面正文字号 | `13px` | `13px` |
| `fs-lg` | — | 较大字号（对话框标题） | `15px` | `15px` |
| `fs-xl` | — | 最大字号（空状态标题） | `20px` | `20px` |
| `fw-strong` | — | 强调字重 | `600` | `600` |
| `ls-caps` | — | 区块小标题字距 | `.08em` | `.08em` |

### spacing

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `space-1` | — | 间距阶梯第 1 级 | `2px` | `2px` |
| `space-2` | — | 间距阶梯第 2 级 | `4px` | `4px` |
| `space-3` | — | 间距阶梯第 3 级 | `8px` | `8px` |
| `space-4` | — | 间距阶梯第 4 级 | `12px` | `12px` |
| `space-5` | — | 间距阶梯第 5 级 | `16px` | `16px` |
| `space-6` | — | 间距阶梯第 6 级 | `24px` | `24px` |

### size

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `size-row` | — | 树行/菜单项/搜索结果行高 | `24px` | `24px` |
| `size-control` | — | 按钮、输入框高度 | `26px` | `26px` |
| `size-topbar` | — | 顶栏高度 | `40px` | `40px` |
| `size-statusbar` | — | 状态栏高度 | `22px` | `22px` |
| `size-tab` | — | 标签栏高度 | `35px` | `35px` |
| `size-sash` | — | 侧栏分隔条可见宽度 | `4px` | `4px` |
| `row-inset` | — | 行（树/菜单）左右内缩，配合圆角做“胶囊”行 | `0px` | `0px` |
| `dock-gap` | — | 分栏卡片之间的视觉间隙（纯视觉，不改变保存的分栏尺寸） | `0px` | `0px` |
| `shell-inset` | — | 外框四周留白（侧栏/分栏区与窗口边缘的距离） | `0px` | `0px` |

### radius

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `radius-sm` | — | 小圆角（行、徽标、代码） | `3px` | `3px` |
| `radius-md` | — | 中圆角（按钮、输入框、弹层） | `4px` | `4px` |
| `radius-lg` | — | 大圆角（卡片、对话框、分组） | `6px` | `6px` |
| `radius-pill` | — | 胶囊圆角 | `999px` | `999px` |

### elevation

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `shadow-1` | — | 一级阴影（卡片、分组） | `none` | `none` |
| `shadow-2` | — | 二级阴影（弹层、搜索结果） | `0 4px 16px rgba(16,24,40,.18)` | `0 4px 16px rgba(0,0,0,.5)` |
| `shadow-3` | — | 三级阴影（对话框） | `0 16px 48px rgba(16,24,40,.24)` | `0 16px 48px rgba(0,0,0,.6)` |

### motion

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `motion-fast` | — | 快速过渡时长（悬停） | `80ms` | `80ms` |
| `motion-normal` | — | 常规过渡时长（展开、弹层） | `160ms` | `160ms` |
| `motion-ease` | — | 缓动曲线 | `cubic-bezier(.2,0,0,1)` | `cubic-bezier(.2,0,0,1)` |

### state

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `opacity-dragging` **v2** | `state.dragging-opacity` | 被拖动元素（标签、分隔条）的不透明度 | `.6` | `.6` |

### color

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `color-bg` | `surface.base` | 应用底色（窗口最底层） | `#f3f3f3` | `#181818` |
| `color-chrome` | `surface.chrome` | 外框底色（顶栏、侧栏） | `#f8f8f8` | `#1f1f1f` |
| `color-chrome-alt` | `surface.chrome-alt` | 次级外框色（区块头、次级按钮） | `#ececec` | `#252526` |
| `color-surface` | `surface.panel` | 分组/面板底色 | `#ffffff` | `#1e1e1e` |
| `color-surface-raised` | `surface.raised` | 浮层底色（弹层、对话框、工具栏、提示条） | `#ffffff` | `#252526` |
| `color-surface-sunken` **v2** | `surface.sunken` | 凹陷底色（编辑器装订线、对比视图、资料列表、代码框外框） | `#f0f0f0` | `#161616` |
| `color-border` | `border.default` | 常规边框/分隔线 | `#e5e5e5` | `#2b2b2b` |
| `color-border-strong` | `border.strong` | 强调边框（输入框悬停、对话框） | `#c8c8c8` | `#454545` |
| `color-text` | `text.primary` | 主文字 | `#1f1f1f` | `#cccccc` |
| `color-text-muted` | `text.muted` | 次要文字 | `#616161` | `#9d9d9d` |
| `color-text-faint` | `text.faint` | 弱文字（占位、空状态） | `#9e9e9e` | `#6b6b6b` |
| `color-text-disabled` **v2** | `text.disabled` | 禁用文字（v1 的 color-disabled-fg 改名） | `#a6a6a6` | `#5a5a5a` |
| `color-accent` | `accent.default` | 强调色（主按钮、焦点、激活指示） | `#005fb8` | `#0078d4` |
| `color-accent-fg` | `accent.on` | 强调色上的文字 | `#ffffff` | `#ffffff` |
| `color-accent-soft` | `accent.soft` | 强调色浅底（标签、提示） | `#e6f0fa` | `#0f2e4a` |
| `color-hover` | `state.hover` | 悬停底色 | `rgba(0,0,0,.05)` | `rgba(255,255,255,.06)` |
| `color-active` | `state.active` | 按下底色 | `rgba(0,0,0,.09)` | `rgba(255,255,255,.1)` |
| `color-selected` | `state.selected` | 选中底色（当前文件、选中结果） | `#dbe8f7` | `#04395e` |
| `color-selected-fg` | `state.selected-fg` | 选中文字 | `#1f1f1f` | `#ffffff` |
| `color-focus-ring` | `state.focus-ring` | 键盘焦点环（focus-visible） | `#005fb8` | `#2f8fe0` |
| `color-disabled-bg` | `state.disabled-bg` | 禁用底色 | `#f0f0f0` | `#2a2a2a` |
| `color-drag-over` | `state.drag-over` | 拖放目标高亮 | `rgba(0,95,184,.16)` | `rgba(0,120,212,.22)` |
| `color-overlay` | `surface.overlay` | 对话框/命令面板遮罩 | `rgba(0,0,0,.25)` | `rgba(0,0,0,.45)` |
| `color-fav` | `icon.favorite` | 收藏星标 | `#c48a1a` | `#e2c08d` |
| `color-danger` | `feedback.danger` | 危险/错误 | `#c4314b` | `#f48771` |
| `color-success` | `feedback.success` | 成功/启用 | `#2d8a4e` | `#4ec27a` |
| `color-warning` | `feedback.warning` | 警告/扫描中/冲突 | `#b97a00` | `#f5a524` |
| `color-status-bg` | `statusbar.bg` | 状态栏底色 | `#007acc` | `#007acc` |
| `color-status-fg` | `statusbar.fg` | 状态栏文字 | `#ffffff` | `#ffffff` |
| `color-tab-bg` | `tab.bg` | 标签栏/未激活标签底色 | `#f3f3f3` | `#1f1f1f` |
| `color-tab-fg` | `tab.fg` | 未激活标签文字 | `#6f6f6f` | `#8b8b8b` |
| `color-tab-active-bg` | `tab.selected-bg` | 激活标签底色 | `#ffffff` | `#1e1e1e` |
| `color-tab-active-fg` | `tab.selected-fg` | 激活标签文字 | `#1f1f1f` | `#ffffff` |
| `color-tab-indicator` | `tab.indicator` | 激活标签指示条（transparent 表示不显示） | `transparent` | `transparent` |
| `color-sash` | `splitter.default` | 分隔条颜色 | `#e5e5e5` | `#2b2b2b` |
| `color-sash-hover` | `splitter.hover` | 分隔条悬停颜色 | `#005fb8` | `#0078d4` |
| `color-sash-dragging` **v2** | `splitter.dragging` | 分隔条拖动中颜色 | `#004c93` | `#3794ff` |
| `color-input-bg` | `input.bg` | 输入框底色 | `#ffffff` | `#313131` |
| `color-input-border` | `input.border` | 输入框边框 | `#cecece` | `#3c3c3c` |
| `color-scrollbar` | `scrollbar.thumb` | 滚动条滑块 | `rgba(0,0,0,.2)` | `rgba(255,255,255,.18)` |
| `color-diff-add-bg` **v2** | `diff.add-bg` | 对比视图：新增行底色 | `#e6ffec` | `rgba(46,160,67,.18)` |
| `color-diff-add-fg` **v2** | `diff.add-fg` | 对比视图：新增行文字 | `#116329` | `#7ee787` |
| `color-diff-del-bg` **v2** | `diff.del-bg` | 对比视图：删除行底色 | `#ffebe9` | `rgba(248,81,73,.18)` |
| `color-diff-del-fg` **v2** | `diff.del-fg` | 对比视图：删除行文字 | `#82071e` | `#ffa198` |
| `color-icon-folder` | `icon.folder` | 文件夹图标 | `#c09553` | `#c09553` |
| `color-icon-root` | `icon.root` | 根目录图标 | `#005fb8` | `#3794ff` |
| `color-icon-file` | `icon.file` | 普通文件图标 | `#7a7a7a` | `#9d9d9d` |
| `color-icon-md` | `icon.md` | Markdown 图标 | `#3b82f6` | `#519aba` |
| `color-icon-pdf` | `icon.pdf` | PDF 图标 | `#e5484d` | `#e5484d` |
| `color-icon-image` | `icon.image` | 图片图标 | `#30a46c` | `#4ec27a` |
| `color-icon-csv` | `icon.csv` | 表格图标 | `#12a594` | `#2ec4b6` |

## 阅读区令牌（readingThemes）


### typography

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `read-font` | — | 正文字体 | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` |
| `read-font-heading` | — | 标题字体 | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` | `"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif` |
| `read-font-mono` | — | 代码/纯文本字体 | `"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace` | `"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace` |
| `read-fs` | — | 正文字号 | `15px` | `15px` |
| `read-fs-code` | — | 代码/纯文本字号 | `13px` | `13px` |
| `read-lh` | — | 正文行高 | `1.75` | `1.75` |

### layout

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `read-max-width` | — | Markdown 正文最大宽度（100% 表示铺满） | `880px` | `880px` |
| `read-pad-x` | — | 正文左右内边距 | `32px` | `32px` |
| `read-pad-y` | — | 正文上下内边距 | `24px` | `24px` |

### color

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `read-bg` | `reader.surface` | 阅读区底色 | `#ffffff` | `#1e1e1e` |
| `read-fg` | `reader.text` | 正文颜色 | `#24292f` | `#d4d4d4` |
| `read-muted` | `reader.text-muted` | 引用/注释文字 | `#57606a` | `#9d9d9d` |
| `read-heading` | `reader.heading` | 标题颜色 | `#1f2328` | `#e8e8e8` |
| `read-link` | `reader.link` | 链接颜色 | `#0969da` | `#4daafc` |
| `read-quote-bar` | `reader.quote-bar` | 引用块左侧条 | `#d0d7de` | `#3c3c3c` |
| `read-code-bg` | `reader.code-bg` | 行内/块代码底色 | `#f6f8fa` | `#2d2d2d` |
| `read-code-fg` | `reader.code-fg` | 代码文字 | `#24292f` | `#d4d4d4` |
| `read-rule` | `reader.rule` | 表格线/分隔线 | `#d0d7de` | `#3c3c3c` |
| `read-table-head-bg` | `reader.table-head-bg` | 表头底色（Markdown 表格、CSV 视图） | `#f6f8fa` | `#252526` |
| `read-selection` | `reader.selection` | 文字选区底色 | `rgba(9,105,218,.2)` | `rgba(38,79,120,.8)` |
| `read-mark` | `reader.mark` | 搜索命中高亮 | `#fff8c5` | `#613d00` |
| `read-editor-bg` **v2** | `editor.surface` | 编辑器底色（txt/md 原位编辑） | `#ffffff` | `#1e1e1e` |
| `read-editor-caret` **v2** | `editor.caret` | 编辑器光标颜色 | `#0969da` | `#4daafc` |
| `read-pdf-backdrop` | `pdf.backdrop` | PDF/图片页面背后的底色 | `#e9ebee` | `#2a2a2a` |
| `read-pdf-page-bg` | `pdf.page-bg` | PDF 页面底色（加载前） | `#ffffff` | `#ffffff` |
| `read-pdf-page-shadow` | `pdf.page-shadow` | PDF 页面阴影 | `0 2px 8px rgba(0,0,0,.15)` | `0 2px 8px rgba(0,0,0,.5)` |
| `read-pdf-dark-filter` **v2** | `pdf.dark-filter` | PDF 深色滤镜参数：只在用户于 PDF 面板中打开“深色滤镜”时应用（默认原色显示）；v1 的 read-pdf-filter 改名 | `invert(.9) hue-rotate(180deg)` | `invert(.88) hue-rotate(180deg) brightness(.95)` |

### focus

| 令牌 | 角色 | 说明 | 浅色默认 | 深色默认 |
| --- | --- | --- | --- | --- |
| `read-focus-bg` **v2** | `focus.surface` | 专注模式阅读区底色 | `#fbfaf7` | `#191919` |
| `read-focus-fg` **v2** | `focus.text` | 专注模式正文颜色 | `#1f2328` | `#dcdcdc` |
| `read-focus-fs` **v2** | — | 专注模式正文字号 | `17px` | `17px` |
| `read-focus-lh` **v2** | — | 专注模式正文行高 | `1.9` | `1.9` |
| `read-focus-max-width` **v2** | — | 专注模式正文最大宽度 | `720px` | `720px` |
| `read-focus-pad-x` **v2** | — | 专注模式正文左右内边距 | `48px` | `48px` |
| `read-focus-pad-y` **v2** | — | 专注模式正文上下内边距 | `48px` | `48px` |
| `read-focus-chrome-opacity` **v2** | — | 专注模式下外框（顶栏、侧栏、状态栏、标签栏）的不透明度；1 表示不淡出 | `.35` | `.35` |

## 颜色角色（角色 → 令牌）

| 角色 | 令牌 | 轴 |
| --- | --- | --- |
| `accent.default` | `color-accent` | 外框 |
| `accent.on` | `color-accent-fg` | 外框 |
| `accent.soft` | `color-accent-soft` | 外框 |
| `border.default` | `color-border` | 外框 |
| `border.strong` | `color-border-strong` | 外框 |
| `diff.add-bg` | `color-diff-add-bg` | 外框 |
| `diff.add-fg` | `color-diff-add-fg` | 外框 |
| `diff.del-bg` | `color-diff-del-bg` | 外框 |
| `diff.del-fg` | `color-diff-del-fg` | 外框 |
| `editor.caret` | `read-editor-caret` | 阅读区 |
| `editor.surface` | `read-editor-bg` | 阅读区 |
| `feedback.danger` | `color-danger` | 外框 |
| `feedback.success` | `color-success` | 外框 |
| `feedback.warning` | `color-warning` | 外框 |
| `focus.surface` | `read-focus-bg` | 阅读区 |
| `focus.text` | `read-focus-fg` | 阅读区 |
| `icon.csv` | `color-icon-csv` | 外框 |
| `icon.favorite` | `color-fav` | 外框 |
| `icon.file` | `color-icon-file` | 外框 |
| `icon.folder` | `color-icon-folder` | 外框 |
| `icon.image` | `color-icon-image` | 外框 |
| `icon.md` | `color-icon-md` | 外框 |
| `icon.pdf` | `color-icon-pdf` | 外框 |
| `icon.root` | `color-icon-root` | 外框 |
| `input.bg` | `color-input-bg` | 外框 |
| `input.border` | `color-input-border` | 外框 |
| `pdf.backdrop` | `read-pdf-backdrop` | 阅读区 |
| `pdf.dark-filter` | `read-pdf-dark-filter` | 阅读区 |
| `pdf.page-bg` | `read-pdf-page-bg` | 阅读区 |
| `pdf.page-shadow` | `read-pdf-page-shadow` | 阅读区 |
| `reader.code-bg` | `read-code-bg` | 阅读区 |
| `reader.code-fg` | `read-code-fg` | 阅读区 |
| `reader.heading` | `read-heading` | 阅读区 |
| `reader.link` | `read-link` | 阅读区 |
| `reader.mark` | `read-mark` | 阅读区 |
| `reader.quote-bar` | `read-quote-bar` | 阅读区 |
| `reader.rule` | `read-rule` | 阅读区 |
| `reader.selection` | `read-selection` | 阅读区 |
| `reader.surface` | `read-bg` | 阅读区 |
| `reader.table-head-bg` | `read-table-head-bg` | 阅读区 |
| `reader.text` | `read-fg` | 阅读区 |
| `reader.text-muted` | `read-muted` | 阅读区 |
| `scrollbar.thumb` | `color-scrollbar` | 外框 |
| `splitter.default` | `color-sash` | 外框 |
| `splitter.dragging` | `color-sash-dragging` | 外框 |
| `splitter.hover` | `color-sash-hover` | 外框 |
| `state.active` | `color-active` | 外框 |
| `state.disabled-bg` | `color-disabled-bg` | 外框 |
| `state.drag-over` | `color-drag-over` | 外框 |
| `state.dragging-opacity` | `opacity-dragging` | 外框 |
| `state.focus-ring` | `color-focus-ring` | 外框 |
| `state.hover` | `color-hover` | 外框 |
| `state.selected` | `color-selected` | 外框 |
| `state.selected-fg` | `color-selected-fg` | 外框 |
| `statusbar.bg` | `color-status-bg` | 外框 |
| `statusbar.fg` | `color-status-fg` | 外框 |
| `surface.base` | `color-bg` | 外框 |
| `surface.chrome` | `color-chrome` | 外框 |
| `surface.chrome-alt` | `color-chrome-alt` | 外框 |
| `surface.overlay` | `color-overlay` | 外框 |
| `surface.panel` | `color-surface` | 外框 |
| `surface.raised` | `color-surface-raised` | 外框 |
| `surface.sunken` | `color-surface-sunken` | 外框 |
| `tab.bg` | `color-tab-bg` | 外框 |
| `tab.fg` | `color-tab-fg` | 外框 |
| `tab.indicator` | `color-tab-indicator` | 外框 |
| `tab.selected-bg` | `color-tab-active-bg` | 外框 |
| `tab.selected-fg` | `color-tab-active-fg` | 外框 |
| `text.disabled` | `color-text-disabled` | 外框 |
| `text.faint` | `color-text-faint` | 外框 |
| `text.muted` | `color-text-muted` | 外框 |
| `text.primary` | `color-text` | 外框 |
