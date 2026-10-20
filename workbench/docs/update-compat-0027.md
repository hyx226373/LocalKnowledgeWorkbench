# 0.2.4 与目录包双轨

版本号在主线合入前保持 `0.2.4`。不要把 `0.2.5` 写进 `latest.yml`，也不要把 `0.2.5` 塞进 NSIS 安装源。差量包不做。

## 旧轨：latest.yml

已发布源的 `latest.yml` 继续 `version: 0.2.4`。`path` 仍是以 `-setup.exe` 结尾的 NSIS 包，例如 `LocalKnowledgeWorkbench-0.2.4-win-x64-setup.exe`。

0.2.4 更新器只看见自己能装的 setup。同一目录旁边多一个 `dirpack.json`，不得改变 `parseLatestYml` 的结果。

已经有 `current.json` 的安装根，不再静默执行带 `/S` 或 `--updated` 的 NSIS。

## 新轨：dirpack.json

新布局的客户端只读 `dirpack.json`。包内是完整 win-unpacked，解压到 `versions/<版本>/`，不是整棵安装根，也不是差量。

## 本机如何进入新系统

本机不靠静默安装器，靠一次性迁移进入新布局：

1. `planMigration` 先判定。低于 `0.2.2`、没有主程序、没有 `resources\app.asar`、已经有 `current.json`，或落在 `D:\example_dev`（且 用户未另批），都拒绝，不复制。
2. 旧根复制到 `versions/<版本>/`。排除 `versions\`、`launcher\`、`updater\`、`current.json`。
3. `verifyVersionTree` 失败则删掉这份副本，不写 `current.json`，不改根上的 exe。
4. 通过后写 `current.json`：`current` 为该版本，`previous` 为 null。
5. 根上的 `LocalKnowledgeWorkbench.exe` 改名为 `LocalKnowledgeWorkbench.exe.pre-layout`。这一步失败时指针已经写下，旧 exe 还在，不删副本。

用户数据目录原样继续用，不复制、不打开 `workbench.db`。默认不写 `D:\example_dev`。
