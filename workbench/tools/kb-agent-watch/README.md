# kb-agent-watch

本组脚本是「模拟 agent」（独立进程读文件），不是已安装的真实 agent CLI 自动唤醒。

零依赖的监听示例。监视 `agent-bridge/live/<scope>/` 目录，把增量通知打到标准输出，进度只写在 `cursors/<agentId>.json`。不调用模型，不改用户文件，不进入工作台进程，不调用本机 agent CLI。

Node 版是 `watch.mjs`。Windows PowerShell 5.1 版是 `watch.ps1`（纯 ASCII，无 BOM；中文说明只写在本文件）。两边的通知和游标字段一致。

## 用法

```text
node tools/kb-agent-watch/watch.mjs (--bridge <agent-bridge> | --user-data-dir <dir>) --agent <id> [--scope current|ws/<id>] [--once] [--poll-only] [--poll-ms N] [--debounce-ms N]
```

```text
powershell -NoProfile -ExecutionPolicy Bypass -File tools/kb-agent-watch/watch.ps1 (-Bridge <agent-bridge> | -UserDataDir <dir>) -Agent <id> [-Scope current|ws/<id>] [-Once] [-PollOnly] [-PollMs N] [-DebounceMs N]
```

环境变量只接受 `KB_AGENT_SCOPE`（默认 `current`）和 `KB_AGENT_ID`。桥目录不读环境变量。

必须显式传入 `--bridge` 或 `--user-data-dir`（PowerShell 为 `-Bridge` 或 `-UserDataDir`）。没有默认桥目录。`--user-data-dir` 表示桥在 `<目录>/agent-bridge`。传入路径若落在 `%LOCALAPPDATA%\LocalKnowledgeWorkbench` 或 `D:\example_dev`，脚本直接退出并打印拒绝原因，不创建、不写入。`--scope current` 监视 `live/current/` 目录（不是 `marker.json` 这一个文件），再顺着 marker 的 `wsDir` 读当前工作区。`--scope ws/<id>` 只监视该工作区目录。

`--once` 读一轮后退出，退出码 0。marker 暂时读不到时退避重试，仍然退出 0。参数不合法退出 2。`--help` 打一行 `kind: help` 的 JSON。

`--poll-ms` 限制在 5000 到 10000，默认 7000。`--debounce-ms` 小于 300 时抬到 300。

## 监视

只对 `live/<scope>/` 这一个目录做非递归 `fs.watch`（PowerShell 用 `FileSystemWatcher`，`IncludeSubdirectories = $false`）。不监视 `marker.json` 本身，因为原子替换会让单文件监视失效。`--poll-only` 不建目录监视。

目录事件按最后一次起算，静默 300ms 再读 marker。另外每 5 到 10 秒读 marker 的修改时间和 revision。读失败或 JSON 不完整时按 50、100、200、400、800 毫秒退避重读，不退出，也不把文件判成损坏。

标准输出每行一条 JSON。Node 用 `fs.writeSync(1, …)`，PowerShell 用标准输出的原始 UTF-8 字节，避免管道被块缓冲。

## 通知

常看的 `kind`：`ready`、`bootstrap`、`change`、`cursor.expired`、`entry.stale`、`schema.unexpected`、`cursor.unreadable`。

第一次接入读入口、快照和导航，游标放到当前版本，不回放全部历史。之后只发游标之后的事件。`change` 带 `type`、`known`、`revision`、`read`（应读文件的绝对路径）、`segment` 和原始 `event`。

认识的类型与组 4 的冻结列表一致，含 `material.pinned`、`material.unpinned`、`session.cleared`。不认识的类型照样转发，`known` 为 false。

`content.changed` 的 `read` 只有原文件、正文副本和差异。清单类事件再加 ENTRY 和 snapshot。`workspace.switched` 带当前入口和目标工作区的 ENTRY、snapshot。从 `content/`、`diff/` 相对路径还原绝对路径时拒绝 `..` 和带 `sha256:` 的相对路径。`read` 里不出现 `agent-token.json`。

`cursor.expired` 表示中间有版本已被删掉。请改读 `snapshot.json`，不要沿缺口补齐。判定是 `cursor + 1 < oldestRevision`：游标正好停在保留窗口的前一版时，下一版还在日志里，照常回放。

ENTRY 第一行的 `revision` 和 marker 不一致时发 `entry.stale`。以 marker 的 revision 和 json 为准。

## 游标

只写 `<bridge>/cursors/<agentId>.json`。两个 agentId 两份文件，互不覆盖。工作台不写这个文件。

```json
{
  "schemaVersion": 1,
  "agentId": "agent-a",
  "scope": "ws-a",
  "bootstrapped": true,
  "updatedAt": "2026-10-08T00:00:00.000Z",
  "workspaceId": "ws-a",
  "currentRevision": 0,
  "workspaces": { "ws-a": 3 }
}
```

`agentId` 匹配 `^[A-Za-z0-9._-]{1,64}$`。先写通知，再写游标；两次之间如果进程退出，下次会再发一次。写入用临时文件、fsync、改名，`EPERM`、`EEXIST`、`EACCES`、`EBUSY` 按 20/40/80/160 毫秒重试 5 次，仍失败就留下 tmp。磁盘上的 `schemaVersion` 不是 1 时不覆盖。读不出来时发一次 `cursor.unreadable`，稍后重试，不把进度归零。

启动时如果 `cursors/<agent>.json.tmp` 自己能解析，会先提升成正式文件。
