# 主题开发包（theme-kit）

给主题外包（A / B / C 三个方向）使用。主题包是**纯数据**：`theme.json`（令牌）+ 受限 CSS + 布局预设 JSON。
主题包里不能有任何可执行代码，也不能修改工作台的核心布局代码。

| 文件 | 内容 |
| --- | --- |
| `README.md` | 本说明 |
| `TOKENS.md` | 全部令牌（122 个：外框 87、阅读区 35），含颜色角色、说明与浅色/深色默认值（自动生成） |
| `COMPONENTS.md` | **权威组件清单**：22 个组件 × 统一状态集合（8 种）的选择器、可用钩子类、CSS 规则（自动生成） |
| `CHANGELOG.md` | 主题接口变更记录（当前 2.0.0） |
| `MIGRATION-v1-to-v2.md` | v1 主题包升级到 v2 要改什么 |
| `theme.schema.json` | `theme.json` 的 JSON Schema（编辑器可据此补全与提示） |
| `template/` | 起步模板：令牌已填好当前默认值、示例 CSS、示例布局预设 |
| `bench-sample/` | 截图用的固定样例文件（不要修改） |

完整的接口说明见 `docs/05-主题接口.md`。

## 1. 主题由三个独立的“轴”组成

| 轴 | theme.json 中的位置 | 管什么 | 不管什么 |
| --- | --- | --- | --- |
| 外框样式 | `contributes.chromeThemes` | 顶栏、侧栏、目录树、标签、分隔条、搜索结果、菜单、插件侧栏、状态栏、对话框 | 阅读内容 |
| 阅读区样式 | `contributes.readingThemes` | Markdown/文本/PDF 背景/CSV 表格的字体、字号、行高、颜色 | 外框 |
| 布局预设 | `contributes.layoutPresets` | 分栏排列（几栏、横竖、比例）、侧栏宽度 | 颜色、字体 |

- 每个外框样式和阅读区样式都**必须同时提供 `light` 和 `dark`**。
- 用户可以任意组合，例如“B 的外框 + A 的阅读区 + 深色”。所以外框 CSS 不能假设阅读区长什么样，反之亦然。
- **组合机制**（外框 = chrome，阅读区 = reader / readingThemes）：
  - 一个主题包可以只贡献外框、只贡献阅读区，或两者都贡献；“外观”菜单里外框样式和阅读区样式是两个独立的下拉框（命令面板里也有“外框样式：…”“阅读区样式：…”命令），选择分别保存。
  - 应用时宿主分别取所选外框样式的外框令牌（`--kb-color-*`、`--kb-size-*` …）和所选阅读区样式的阅读区令牌（`--kb-read-*`），写到 `:root`；两个轴的令牌名不相交（外框样式里写 `read-*` 会报错），所以不会互相覆盖。
  - 受限 CSS 分别加作用域前缀：外框 CSS 只在 `:root[data-kb-chrome="<外框 id>"][data-kb-scheme="…"]` 下生效，阅读区 CSS 只在 `:root[data-kb-reading="<阅读区 id>"][data-kb-scheme="…"]` 下生效；外框 CSS 不能选择阅读区钩子，反之亦然。
  - 截图：`theme-shots` 用 `--chrome <id>` / `--reading <id>` 指定组合；e2e（`e2e/e2e-theme.mjs`）以“B（pro）外框 + A（study）阅读区”截图并核对两轴令牌各自来自哪个主题。
- **阅读专注模式**（v2）：命令“阅读专注模式（开/关）”（F9）。阅读区改用 `read-focus-*` 令牌，外框淡出，布局不变。
- **PDF 深色滤镜**（v2）：PDF 默认原色；用户可在每个 PDF 面板的工具栏打开“深色滤镜”（保存在该面板的阅读状态里）。主题只提供参数 `read-pdf-dark-filter`，不能强制开启。
- 切换外观不会改变打开的文件、分栏位置与阅读进度（有自动测试）。
- 任何会改变面板排列的需求都写成布局预设，不属于主题。

## 2. 规则（校验不通过的主题包不会被加载）

1. 只用令牌（`theme.json`）和受限 CSS。不要修改 `src/` 下的任何文件。
2. CSS 规则必须以 `COMPONENTS.md` 列出的钩子类开头；宿主会自动加作用域前缀。
3. 禁止布局属性：`width/height/margin/display/position/flex/grid/transform/overflow/z-index/top/left…`（完整列表见 `COMPONENTS.md`）。
   想调整尺寸，用尺寸令牌（`size-row`、`size-tab`、`size-topbar`、`row-inset`、`dock-gap` 等），它们只改外观、不改工作区保存的分栏比例。
4. 禁止 `url(...)`、`@import`、`@font-face`、`javascript:`：主题不能加载外部资源或字体文件，只能使用系统已安装的字体（请写好回退字体链，如 `"Source Han Serif SC", "Noto Serif CJK SC", SimSun, serif`）。
5. 不能在 CSS 里定义或改写 `--kb-*` 变量；不能选择 `html`、`body`、`*`、`#id`。
6. 外框 CSS 不能选择阅读区钩子（`.kb-reading`、`.kb-md`、`.kb-pdf-page`…），阅读区 CSS 只能选择阅读区钩子。
7. `theme.json` 的 `id` 必须唯一，不要使用 `kb.theme.*`（内置主题的前缀）。建议 `contractor.a` / `contractor.b` / `contractor.c`。
8. 所有文件使用 UTF-8 编码。

## 3. 在 Windows 上开始

前提：
- 已安装 **Node.js 20 LTS 或更新版本（x64）**（https://nodejs.org/ ，安装时勾选“Add to PATH”）。在 PowerShell 中运行 `node -v` 应显示 `v20.x` 或更高版本。
- 工作台源码已经放在本机，下文假设在 `D:\STUDY MATERIAL\项目\知识库\kb-workbench`（实际位置以 Amy 提供的为准）。
- 主题文件夹：`D:\STUDY MATERIAL\项目\知识库\themes\a`（B、C 分别用 `b`、`c`）。

在 PowerShell 中执行（路径含空格与中文，**必须加引号**）：

```powershell
# 1) 安装依赖（只需一次）
cd "D:\STUDY MATERIAL\项目\知识库\kb-workbench"
npm ci
#    如果 better-sqlite3 报 node-gyp / Python / Visual Studio 相关错误，改用下面两步：
#    npm ci --ignore-scripts
#    node node_modules/electron/install.js
#    如果下载 Electron 很慢，可先设置镜像：$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"

# 2) 构建（只需一次；以后 theme:shots 发现没有构建产物时也会自动构建）
npm run build

# 3) 从模板创建自己的主题包（只需一次）
Copy-Item -Recurse ".\theme-kit\template" "D:\STUDY MATERIAL\项目\知识库\themes\a"
#    然后编辑 themes\a\theme.json：把 id 改为 contractor.a，name/label 改为自己的名字

# 4) 截图（每次修改后运行）
node scripts/theme-shots.mjs "D:\STUDY MATERIAL\项目\知识库\themes\a" --out "D:\STUDY MATERIAL\项目\知识库\themes\a\shots"
```

第 4 步也可以写成 `npm run theme:shots -- "D:\...\themes\a" --out "D:\...\themes\a\shots"`。旧版 Windows PowerShell 有时会吞掉 `--`，所以优先直接用 `node scripts/theme-shots.mjs`。

截图时会弹出一个应用窗口，运行完自动关闭（约 10–20 秒），期间不要操作它。截图通过 `--force-device-scale-factor=1` 与视口模拟固定为 1280×800，与屏幕缩放比例和窗口大小无关。脚本使用临时数据目录，不会影响本机上正在使用的工作台数据。

## 4. 截图输出

`--out` 文件夹中会生成：

| 文件 | 内容 |
| --- | --- |
| `bench-light.png` / `bench-dark.png` | 功能基准界面（1280×800）：Markdown + PDF + CSV/图片分栏、收藏、目录树、搜索结果弹层、分隔条悬停、插件侧栏 |
| `states-light.png` / `states-dark.png` | 组件状态表：权威清单中的 22 个组件 × default/hover/active/focus-visible/disabled/selected/dragging/drag-over（悬停、按下、焦点由脚本强制），另有真实 dockview 标签、阅读区样例、颜色角色色板 |
| `report.md` / `report.json` | 校验错误与警告、实际生效的全部 `--kb-*` 值 |

**交付要求：`report.md` 中“错误（0）”，且“组件状态表 … 缺失 0”**。警告（例如有令牌未设置、使用默认值）可以保留，但请确认是有意为之。
只有一种轴的主题包（例如只做阅读区）可以用 `--chrome <id>` / `--reading <id>` 指定另一轴使用哪个已有样式（例如 `--chrome pro`）。

## 5. 在应用里试用

- 安装：应用顶栏“外观”→“安装主题包（文件夹）…”→ 选择主题文件夹。安装 = 复制到应用数据目录，以后修改需要重新安装。
- 开发时免安装：设置环境变量 `KB_THEME_DIRS` 指向主题文件夹（多个用 `;` 分隔），然后 `npm start`：
  ```powershell
  $env:KB_THEME_DIRS="D:\STUDY MATERIAL\项目\知识库\themes\a"; npm start
  ```
- 在“外观”菜单中分别选择外框样式、阅读区样式与浅色/深色/跟随系统。布局预设在“工作区”菜单与命令面板（Ctrl+Shift+P）中。

## 6. 布局预设格式

见 `template/layouts/example.json`：

```json
{ "id": "example.reading-desk", "label": "阅读桌", "sidebarWidth": 260,
  "grid": { "split": "row", "children": [ { "slot": 1, "size": 3 },
            { "split": "column", "size": 2, "children": [ { "slot": 2 }, { "slot": 3 } ] } ] } }
```

- `split` 为 `row`（左右）或 `column`（上下），嵌套时必须交替；`slot` 从 1 开始连续编号；`size` 为相对比例。
- 应用预设时，现有分组按顺序放入 slot 1、2、3…；分组多于 slot 时并入最后一个；空 slot 自动去掉。
- 预设只改排列：打开的文件、标签顺序与阅读进度不变。

## 7. 主题接口版本

`theme.json` 的 `engines.themeContract` 声明兼容的主题接口版本（当前 `^2.0.0`；声明 `^1.0.0` 的旧包按兼容模式加载，见 `MIGRATION-v1-to-v2.md`），`engines.workbench` 声明宿主 API（当前 `^0.2.0`）。
新增令牌只增加次版本号，旧主题包继续可用（新令牌使用默认值）；删除或改名令牌会增加主版本号。

修改主题接口（`src/shared/theme-contract.json`，由 `scripts/gen-theme-contract.py` 生成）后，由工作台维护者运行 `npm run theme:kit` 重新生成本目录下的 `TOKENS.md`、`COMPONENTS.md` 与 `theme.schema.json`。外包请勿修改这些文件。
