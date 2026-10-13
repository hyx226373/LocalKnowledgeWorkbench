# web.generic（内置通用网页适配器）

- 随工作台安装包发布（`resources/builtin-adapters/web.generic/`，宿主以 `source: 'builtin'` 加载），不需要开发者模式安装；可以在插件管理里禁用，不能卸载。
- 权限：`net.mode = 'ask-per-site'`（SDK 修订 10，只有内置适配器可声明）。每个网站（精确主机名）第一次打开时宿主询问；批准记录在授权的 `grantedHosts`，插件管理可逐个撤销。
- 允许 http 网站（同样需要批准，外框标注“不安全连接”）；IP、端口、`file:`/`javascript:`/`data:` 一律拒绝。
- 状态：去掉 query 的 URL + 滚动位置；会话分区 `persist:kbweb.web.generic`，90 天未使用自动清除。
- 打包：在 kb-workbench 目录运行 `node scripts/bundle-builtin-adapters.mjs`（产物提交到仓库，`--check` 校验是否最新）。
