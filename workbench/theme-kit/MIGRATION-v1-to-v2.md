# 主题包迁移：主题接口 v1 → v2

适用于 A / B / C 三个视觉组已经交付或正在制作的主题包。改动很小，大约 10 分钟。

## 必改

1. `theme.json` → `engines.themeContract` 改为 `"^2.0.0"`（不改也能加载，但报告里会有“v1 兼容模式”警告）。
2. 令牌改名（在 light 和 dark 两个变体里都要改）：
   - `color-disabled-fg` → `color-text-disabled`
   - `read-pdf-filter` → `read-pdf-dark-filter`
3. 如果你的 `read-pdf-filter` 是为了“深色模式下 PDF 不刺眼”：保留它的值，改名即可。**它不再自动生效**，只在用户在 PDF 面板里点“深色滤镜”时才会用到。如果你写的是 `none`，可以直接删掉（用默认参数）。
4. 交付文档、设计稿里的状态名 `focus` 改为 `focus-visible`（CSS 选择器本来就写 `:focus-visible`，不用改）。

## 建议补充（新令牌，不设置就用默认值，报告中只是“未设置令牌”警告）

| 用途 | 令牌 | 说明 |
| --- | --- | --- |
| 分隔条拖动中 | `color-sash-dragging` | 建议比 `color-sash-hover` 深一档 |
| 凹陷底色 | `color-surface-sunken` | 侧栏“本工作的资料”列表、改动对比框 |
| 改动对比 | `color-diff-add-bg`、`color-diff-add-fg`、`color-diff-del-bg`、`color-diff-del-fg` | 保存前预览、冲突对比 |
| 被拖动的标签 | `opacity-dragging` | 0–1 |
| 编辑器 | `read-editor-bg`、`read-editor-caret` | txt/md 原位编辑 |
| 阅读专注模式 | `read-focus-*`（8 个） | F9 开关；外框淡出程度用 `read-focus-chrome-opacity` |

## 新组件钩子（可以写受限 CSS）

`.kb-toggle`、`.kb-collection` / `.kb-collection-row`、`.kb-toast` / `.kb-banner`、`.kb-diff` / `.kb-diff-line`（外框）；`.kb-editor` / `.kb-editor-text`、`.kb-pdf-page`、`.kb-reading[data-focus="on"]`（阅读区）。各组件的状态选择器见 `COMPONENTS.md`。

## 自查

```powershell
node scripts/theme-shots.mjs "D:\...\themes\a" --out "D:\...\themes\a\shots"
```

`report.md` 中：错误 0；没有“v1 兼容模式”“改名为”警告；“组件状态表：22 个组件 … 缺失 0”。在 `states-light.png` / `states-dark.png` 中检查新行（复选开关、本工作的资料、提示条、改动对比、编辑器、PDF 页面（原色 / 深色滤镜）、阅读专注模式）以及新增的 `dragging` 列。
