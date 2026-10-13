# 本地知识工作台 · 适配器 SDK（kb-adapter-sdk）

把“打开文件 / 网页 / 外部程序”的兼容逻辑全部放进**适配器插件**；核心只放置项目、启用/禁用插件、授权、恢复状态、显示占位。

| 路径 | 内容 |
|---|---|
| `docs/适配器规范.md` | manifest、权限、生命周期、各类宿主 API、显示方式与嵌入、状态迁移、占位、数据保留、安全、核心需新增的宿主能力 |
| `docs/验收示例.md` | 三类适配器的用户可操作验收清单 + 自动化测试示例 |
| `docs/接入任务模板.md` | “帮我接入这个网站/应用”→ 独立插件任务的提示词模板 |
| `src/types.ts` | 类型（零运行时依赖） |
| `src/policy.ts` | 规则参考实现：manifest 校验、域名/导航检查、参数模板展开、状态检查与恢复、授权说明、占位文案 |
| `src/mock-host.ts` | 模拟宿主（单测用） |
| `templates/file-adapter` | JSON 查看器（in-app-reader，P1） |
| `templates/web-adapter` | MDN 文档，仅 developer.mozilla.org（in-app-web，P2） |
| `templates/app-adapter` | 外部管理的 Notepad++（external-managed，P3） |

```bash
npm install
npm test     # tsc 编译 + node --test dist/
```

安装包：`manifest.main` 必须是单文件 ES 模块，用核心 `npm run plugin:build -- <模板目录> --out <输出目录>` 打包，经开发者模式安装（v1 无商店/签名）。

模板通过包自引用 `@kb-workbench/adapter-sdk`、`@kb-workbench/adapter-sdk/mock-host`、`@kb-workbench/adapter-sdk/policy` 导入 SDK，复制到独立目录后改为 devDependency 即可。

本仓库不修改 `/workspace/kb-workbench`（核心）；核心需要实现的能力见规范 §14，产品决定见 §15。核心以 `scripts/sync-adapter-sdk.mjs` 逐字同步 `src/types.ts` 与 `src/policy.ts`，改这两个文件时需通知核心重新同步。
