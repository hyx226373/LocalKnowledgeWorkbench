# native-app-host · DPI / 坐标契约（L2）

> 状态：原生侧冻结说明 · 2026-10-13  
> 对照：`01-共用接口.md` §2.1、`HOST-REPORT-0031` L2 根因

## 结论

**契约无改（行为）**：`host.panelToScreen` / `host.screenToPanel` 仍为 Electron **DIP** 平移；`host.setBounds` 当前仍 `usePhysical: false`，把调用方给出的矩形原样交给 helper（嵌入后为**父客户区坐标**）。

**L2 系统性漂移根因在渲染/插件侧**：`hostPanelLayoutSync` 把显示器列表传成 **空数组** → `pickDisplayForRect` 回落 `scaleFactor=1`，而主屏实为 **1.25** → 逻辑×缩放漏乘，矩形漂移。原生公式本身无系统性偏差。

## 单位表（插件 / 布局对照）

| 层 | API / 数据 | 单位 | 谁负责 ×scale |
|----|------------|------|----------------|
| DOM `getBoundingClientRect` | 内容占位 | CSS px = **DIP** | — |
| `host.panelToScreen` / `host.screenToPanel` | `point` + `panel` | **DIP**（只做原点加减；**不**乘 `panel.scaleFactor`） | 调用方须填对 `panel.{x,y}` DIP |
| `panelDipToPhysical` / `rectDipToPhysical` | 共享纯函数 | 输出 **物理像素** = DIP × `scaleFactor` | **插件/布局**在下发 Win32 前调用，或设 `usePhysical` |
| `rectDipToPhysicalTrunc` | 共享纯函数 | 物理 + `Math.trunc`（向 0） | 与 koffi `SetWindowPos` 一致 |
| `host.setBounds`（嵌入后） | `bounds` | **父 HWND 客户区坐标**（当前实现透传；Win32 侧为物理像素语义） | 调用方须已用**真实** `scaleFactor` 换算 |
| `listDisplays` / `pickDisplayForRect` | 显示器列表 | Electron `Display.bounds`（DIP）+ `scaleFactor` | **禁止传 `[]`**；空列表 → 回落 scale=1（视为调用方缺陷） |

## 公式（无漂移断言）

```
screenDip = panelLocalDip + panelOriginDip          // panelToScreen
physical  = trunc(dip * scaleFactor)                // Win32 SetWindowPos
```

- `scaleFactor` 必须来自 `screen.getAllDisplays()` / `getDisplayMatching`，禁止硬编码 96 DPI，禁止空列表回落当真值。
- 舍入：**向零截断**（`Math.trunc`），与 `win32KoffiHelper.setBounds` 一致。

## 插件 / 布局检查清单

1. `hostPanelLayoutSync`（或等价）传入的 displays **非空**，且含主屏 `scaleFactor`（如 1.25）。
2. 面板属性 `data-scale-factor` 与主进程 `screen` 一致；不得写死 `1`。
3. 内容区 DIP → 父客户区物理：先 DIP 相对父客户区原点，再 `× scaleFactor`，再 `trunc`，再 `host.setBounds`。
4. 不要用 `desktopPanel` / desk 路径冒充 native-app-host。

## 单测

`tests/native-dpi-coords.test.ts` — scale=1 / 1.25 往返、trunc 边界、空 displays 回落、setBounds 透传。
