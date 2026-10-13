# modules 固定方式

应用通过 `file:../modules/*` 依赖 `@kb/agent-api`、`@kb/fileops`、`@kb/identity-watch`、
`@kb/indexer`、`@kb/plan`、`@kb/sync`（npm 在 node_modules/@kb 下建符号链接）。

`../modules` 是独立 git 仓库，本基线固定在：

    c3919250b50127eaa4c95d4c06b5e4e03c5683c7  (c391925 记录第10轮返工报告，写明提交 a1ead68)

- 来源：用户机 `D:\STUDY MATERIAL\项目\知识库\modules` 的 master，经 `git bundle --all` 导入 box。
- 各模块 `dist/` 除 indexer 外都随 modules 仓库提交；`indexer/dist` 被 indexer/.gitignore 忽略，
  需要时在 modules/indexer 下 `npm run build` 重建。
- 换 modules 版本时：在 ../modules checkout 新提交，重建受影响的 dist，再改本文件中的哈希并提交。
