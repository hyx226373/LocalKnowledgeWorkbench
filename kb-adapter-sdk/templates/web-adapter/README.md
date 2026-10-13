# 网页适配器模板（示例：MDN 文档，仅 developer.mozilla.org）

显示方式：`in-app-web`（宿主管理的受限 webview 面板）。阶段：P2。

## 目录
```
manifest.json     net 权限：页面 developer.mozilla.org，另声明 3 个资源域名；web 选项：homeUrl、持久会话 30 天、离开域名需确认后外部打开、弹窗与下载拦截
src/index.ts      状态 = 去掉 query 的 URL + scrollY；恢复时再次校验域名；滚动恢复在加载稳定后重试一次
test/mdn.test.ts  授权范围（含资源域名行）、域外导航（含各种绕过写法）、弹窗（含域内）/下载/子资源、重启恢复、滚动重试、分区隔离与卸载数据
```

## 填写步骤
1. 复制本目录；`package.json` 同文件适配器模板。
2. **manifest.json**：
   - `permissions[0].domains`：**精确主机名**列表。只有确有必要才用 `*.example.com`（不包含裸域，需要裸域请另列）。禁止 `*`、IP、端口。
   - 页面的脚本/样式/图片/数据接口/内嵌 iframe 若来自其他域名（CDN），把它们列入 `resourceDomains`，并在 `reason` 与 README 中逐个说明用途。产品决定 D1：子资源**只**允许 `domains ∪ resourceDomains`，没列出的一律被拦截；不写 = 与 `domains` 相同。资源域名**不能**用于顶层导航。
   - **资源域名会列在授权对话框中**（“页面资源另可加载自：…”），用户看得到；增删任何域名都会改变权限声明哈希，已授权的用户会被**重新询问**。
   - 怎样找域名：宿主的子资源检查发生在**页面自身 CSP 之后**——页面 CSP 已挡掉的请求宿主看不到，“已拦截 N 个外部资源”计数只统计页面放行、但你没声明的请求。所以先看页面响应头 `Content-Security-Policy`（`curl -sI <页面>`）和页面脚本里出现的主机，再在开发者模式下真机浏览、对照拦截计数与 DevTools 网络面板。只声明内容必需的；遥测、广告、同意管理、支付等**不要**声明（被拦截不影响阅读）。
   - `match.web.urlPatterns`、`web.homeUrl` 必须在 `domains` 内。
   - `web.session.partition`：需要记住登录/偏好用 `persistent`，否则 `ephemeral`；`maxAgeDays` = **该插件连续 N 天未使用**（未打开网页面板）后，宿主启动时清除整个分区；`clearOnClose`。
   - `offDomain`：产品决定 D2 为 `open-external-with-confirm`（用户点横幅“用系统浏览器打开”并再次确认后才打开）。宿主只对 https、无 userinfo、且是**该面板刚被拦截的地址**或**条目自己的地址**提供这个按钮；插件没有“打开外部链接”的 API。
   - `popups`：宿主**可以拒绝所有弹窗，包括域内的** `window.open` / `target=_blank`（核心从不在应用内开新窗口）；需要弹窗的功能（如弹窗式 OAuth 登录）在面板内不可用。v1 没有应用内嵌登录：HTTP 认证与客户端证书也被拒绝，只能在允许域名内的页面本身登录。`downloads` 默认 `block`。
3. **src/index.ts**：改 `ADAPTER_ID`、状态结构（不得含 query、表单、令牌）；只调用 `target.web` 的方法。
   - `currentUrl()` 是宿主缓存值：刚 `navigate` 后可能还是旧地址，以 `onDidNavigate` 为准（模板只在导航完成事件里保存 URL）。
   - 滚动恢复是**尽力而为**：晚加载的图片、滚动锚定可能在 `setScroll` 后又把页面推走。模板在 `onLoadState('ready')` 时 `setScroll`，恢复期间不保存滚动；等约 1.2 s 无滚动变化（最多 5 s，参数见导出的 `scrollRestoreTiming`）后检查一次，偏差 > 8 px **只重试一次**，之后按用户滚动正常保存。不要写成循环重试。
   - 宿主可能在工作台浮层（菜单、对话框、命令面板、拖动标签）出现时**临时隐藏网页视图**、显示截图，且不通知插件；不要依赖网页一直可见。
   - 不要长时间同步占用事件循环（约 3 s 无心跳回应，宿主会终止插件进程，所有面板变“适配器出错”占位）；宿主调用可能以 `code: 'timeout'` 失败。见规范 §6.5。
   - 保存 URL 前用 `sanitizeUrlForState`：它**去掉整个 query 串**（以及 userinfo），只留 `origin + path + hash`。如果你的网站靠 query 定位内容（如 `?id=123`），要在状态里另存一个经过校验的最小字段，并在恢复时拼回；绝不保存令牌、会话 id。核心保存 web 条目的 `ref` 时也会做同样处理。
4. **test/**：把 `PAGE`、域名与恶意 URL 列表换成你的站点；保留“不能离开域名”“卸载删除会话数据”用例。
5. `npm test`；README 写 `docs/验收示例.md` B 节真机步骤。网页面板（H9）已由核心 `e270054` 实现。

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

## 你做不到的事（设计如此）
- 注入脚本、读取页面 DOM、读取 Cookie、修改请求头、打开任意 URL、访问本机文件或工作台数据。
- 需要这些能力时，写“宿主 API 请求”，不要绕过。

## 关于 MDN 的说明（本模板声明的资源域名）
2026-10-03 检查真实页面（`curl` 取 MDN 文档页的 CSP 响应头 + 静态查看 `/static/client/` 脚本）得到：页面自身脚本、样式、字体、图片都来自 developer.mozilla.org；内容还需要另外 3 个域名，已显式写入 `resourceDomains`：

| 域名 | 用途 | 不声明的后果 |
|---|---|---|
| `bcd.developer.mozilla.org` | “浏览器兼容性”表的数据（fetch JSON） | 兼容性表加载失败 |
| `*.mdnplay.dev` | 交互示例与实时示例的 iframe（每个示例随机子域） | 示例区域空白 |
| `mdn.github.io` | 示例使用的共享素材（`/shared-assets/` 图片、音视频） | 示例中图片/媒体缺失 |

有意**不**声明：`incoming.telemetry.mozilla.org`（遥测）、`transcend-cdn.com` 等（同意管理）、`js.stripe.com`（MDN Plus 支付）、`codepen.io`/`jsfiddle.net` 等（“在外部编辑器打开”）。它们被拦截不影响阅读，横幅的“已拦截 N 个外部资源”主要来自这些。以上基于静态检查，MDN 改版后可能变化；尚未在真机网页面板中逐请求核对——接入时请按 `docs/验收示例.md` B 节确认。

修改 `resourceDomains` 会让已授权用户重新确认权限。

## 显示方式与升级
- 显示方式：`in-app-web`「内嵌网页」——界面标签“内嵌网页 · 网页面板 · 仅限 <域名>”；工作台菜单/对话框盖住网页时暂时显示截图占位。
- 本模板状态只有 `{url, scrollY}`（v1）。以后改结构时照 file 模板用 `migrateOrPreserve`，迁移失败保留旧数据（`legacy`）并提示，不要让 `restoreState` 返回 undefined。
