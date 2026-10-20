# 组 5 接线说明

监听示例是外部进程。集成时不要把它 import 进主进程，也不要在应用启动时拉起。启动路径上多一个目录监视或子进程，都会碰到 0.2.1 已经修过的 Windows 监视问题。

## 建议命令

本脚本是模拟 agent（独立进程读文件）。必须显式传入隔离的 `--bridge` 或 `--user-data-dir`。没有默认桥目录，也不读 `KB_AGENT_BRIDGE`。

路径落在 `%LOCALAPPDATA%\LocalKnowledgeWorkbench` 或 `D:\example_dev` 时直接退出，打印拒绝原因，不写入。应用自己的桥根仍是 0.1 的用户数据目录，但这个示例不会去写它。

```text
node tools/kb-agent-watch/watch.mjs --bridge <隔离目录>\agent-bridge --agent <id> --scope current
```

PowerShell 5.1 用同目录的 `watch.ps1`（ASCII），参数见 `README.md`。不要把本脚本 import 进主进程，也不要在应用启动时拉起，也不要把它登记成已安装 agent CLI 的自动启动。不要登记新的 ActionId。`AGENT_START_HERE.md` 顶部那一行「现场入口：live/current/ENTRY.md」由集成组写。

## 发布侧要保持的约定

组 4 已经按这个顺序发布：正文副本、差异、分段、`changes/index.json`、snapshot、ENTRY，最后写 `marker.json`。监听看到新 marker 才读。请保持 marker 最后写。

当前工作区有内容发布时，`live/current/marker.json` 也要重写（组 4 的 `writeCurrentMarker` 已这样做）。`currentRevision` 只在切换工作区时增加。`live/current/changes/` 里只有 `workspace.switched`。工作区 jsonl 里不要写这条。

正文和差异的相对路径形如 `content/<materialId>/<64位hex>.txt`、`diff/<materialId>/<prevHex>__<hex>.diff`。文件名不带 `sha256:`。jsonl 里的 `contentHash` 仍然是 `sha256:<hex>`。

## 游标

`cursors/<agentId>.json` 只由监听进程写。工作台只读、不改、不删。格式是组 5 定的，见 `README.md`，不是冻结字段的改名。

`schemaVersion` 不是 1 的游标，监听不会覆盖。

## 合并后

本工作树基于 `7d8730a`，没有 `e2e/perf-startup.mjs`，也没有 `node_modules`。本组没有跑启动性能脚本，也没有启动 Electron。合并进已修好监视的 0.2.1 树之后，由集成组复跑 `e2e/perf-startup.mjs`。门禁仍是交互时间小于 2000ms、事件循环 p99 小于 100ms、操作 p95 小于 200ms。验收副本用 `D:\workspace\kb-work\userdata` 拷到 `userdata-accept`，不要动 用户的原库。
