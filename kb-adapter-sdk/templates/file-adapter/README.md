# 文件适配器模板（示例：JSON 查看器）

显示方式：`in-app-reader`（在应用内沙箱 iframe 中渲染）。阶段：P1。

## 目录
```
manifest.json          插件与适配器声明（权限：fs.read，ask-per-root，仅 .json）
src/index.ts           适配器实现：restoreState(迁移 v1→v2) / open / mount / getState / onThemeChange / onPermissionDenied / dispose
test/json-viewer.test.ts  用模拟宿主的单元测试（授权、拒绝、重启恢复、主题、禁用、卸载、迁移、坏文件）
```

## 填写步骤
1. **复制**本目录到新插件目录；在新目录 `package.json` 中加入 `"type": "module"`、devDependencies `typescript`、`@types/node`、`"@kb-workbench/adapter-sdk": "file:<SDK 路径>"`，tsconfig 参考 SDK 根目录（`module: NodeNext`，`resolveJsonModule: true`）。`tsc` 只用于类型检查和跑单测；安装包用下文的打包脚本生成。
2. **manifest.json**：改 `id`、`name`、`publisher`、`description`；`contributes.adapters[0]`：
   - `id`（建议 `<插件id>.<名称>`）、`title`
   - `match.file.extensions` / `mimeTypes` / `maxSizeBytes`、`priority`（覆盖内置阅读器用 150–200）
   - `permissions[0]`：`scope`（建议 `ask-per-root`）、`extensions`（与 match 一致）、`reason`（中文，会原样出现在授权框）
   - 需要修改文件时再加 `{ "kind": "fileops.write", "operations": [...], "optional": true }`。**必需**的 `fileops.write` 会在用户一打开文件时就弹“允许修改”；声明 `optional: true` 则推迟到第一次 `requestFileops` 时才询问（推荐）。每批修改仍需用户在计划对话框中批准。
   - `stateSchemaVersion`、`maxStateBytes`
3. **src/index.ts**：搜索 `TODO(fill)`；
   - 定义状态类型（只存“看到哪里”）；写 `restore…State`：先迁移再校验，不合法返回 `undefined`
   - 读取只用 `ctx.files.readText/readBytes/contentUrl(item.ref)`
   - 渲染**只能**用 `target.render(UiNode)`。v1 没有 `target.element`（沙箱 iframe 不可见，宿主传 `undefined`），无法自绘 DOM/canvas
   - 不要自己拼 `kbfile://` 地址；需要内容 URL 时调用 `ctx.files.contentUrl(id)`，其形式由宿主决定（v1 的 UiNode 也没有图片节点）
   - 状态改变后调用 `ctx.requestSave()`
4. **test/**：保留模板中的通用用例（授权、拒绝、重启、主题、禁用、卸载、迁移），替换示例数据与断言。
5. 运行 `npm test`（tsc + node --test），再按下文打包、安装、在真机上验收。
6. **README**：写清权限、状态字段、已知限制，以及 `docs/验收示例.md` A 节的真机步骤。

## 打包与安装（v1：仅开发者模式）
- **`manifest.main` 必须是单文件 ES 模块**（包内相对路径，`.js`/`.mjs`）。宿主以 `import('kbplugin://<插件id>/<main>')` 加载：不解析裸模块名、不带 node_modules、不能拆成多个 chunk。不要直接把 `tsc` 的输出当作 `main`（它保留 `import '@kb-workbench/adapter-sdk'`，在宿主中无法解析）。
- 用核心的打包脚本（esbuild，SDK 导入解析到核心内置副本，`mock-host` 不允许打包）：
  ```bash
  # 在 kb-workbench 目录
  npm run plugin:build -- <本插件源码目录> --out <输出目录>
  ```
  产物：`<输出目录>/manifest.json` + `<输出目录>/dist/index.js`（单文件）。
- 安装（产品决定 D7：没有商店和签名）：工作台 → 侧栏“插件”→“管理插件…”→ 勾选“开发者模式”→“安装本地插件文件夹（开发者模式）…”→ 选输出目录。改代码后重新打包、再次安装即覆盖升级（保留授权与存储）。
- 核心安装检查除 `validateAdapterManifest` 外还要求：插件 id 不以 `builtin.` `demo.` `kb.` 开头；每个适配器 id 以插件 id 为前缀。

## 注意
- 不要把文件内容放进状态（宿主会拒绝超过 2048 字符的字符串和超过 16 KB 的状态）。
- 不要在 `match` 之外“顺便”读其他文件；越界读取会被宿主拒绝并触发 `onPermissionDenied`。
- 主题：UiNode 自动跟随主题令牌；`onThemeChange` 中不得改变状态。
- **不要长时间同步占用事件循环**：大文件解析要分段 `await`。宿主约每 0.5 s 发心跳，约 3 s 无回应即终止插件进程（该插件所有面板变“适配器出错”占位）。`activate`/`open`/`mount` 约 10 s 内要完成。
- 宿主调用可能失败或超时（`code: 'timeout'`，见 `HostErrorCode` 与规范 §6.5）：模板显示“读取超时，请稍后重试”+“重新读取”按钮；不要无限自动重试。
- **升级不丢状态**：改状态结构时提升 `stateSchemaVersion`，在 `STATE_MIGRATIONS` 里加一步；`restoreJsonViewerState` 用 SDK `migrateOrPreserve`，迁移失败返回默认视图 + `legacy`（旧数据原样），保存时一并写回，面板提示“旧版本的视图状态无法迁移，已原样保留（没有丢失）”，可“丢弃旧状态”。不要让 `restoreState` 抛错或返回 undefined（宿主会重置并在下次保存时覆盖旧状态）。
- 显示方式：`in-app-reader`「内嵌渲染」——内容由插件在沙箱中渲染，界面标签“内嵌渲染 · 应用内阅读（沙箱）”。
