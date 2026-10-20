# modules 固定方式

应用通过 `file:../modules/*` 依赖 `@kb/agent-api`、`@kb/fileops`、`@kb/identity-watch`、
`@kb/indexer`、`@kb/plan`、`@kb/sync`（npm 在 node_modules/@kb 下建符号链接）。

`../modules` 是独立 git 仓库，本基线固定在：

    fbff09c1cb02924b025c98f3bd961d52862a32b9  (fbff09c on 7631af3: yield+chunk + fork)

- 来源：用户机 `D:\STUDY MATERIAL\项目\知识库\modules` 的 master，经 `git bundle --all` 导入 box。
- 各模块 `dist/` 除 indexer 外都随 modules 仓库提交；`indexer/dist` 被 indexer/.gitignore 忽略，
  需要时在 modules/indexer 下 `npm run build` 重建。
- 换 modules 版本时：在 ../modules checkout 新提交，重建受影响的 dist，再改本文件中的哈希并提交。

## D3 / indexer fork (2026-10-13)

App `file:../modules-r11-E-3888323/indexer` junctions to `modules/indexer`.
Live modules tip for fork API: **`7631af3`** (tracks `src/fork.ts` + `exports["./fork"]`).
PIN hash below may still name an older doc tip; release uses package.json `file:` path.
