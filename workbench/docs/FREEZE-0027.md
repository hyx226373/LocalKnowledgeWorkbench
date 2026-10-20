# FREEZE-0027（主线冻结，各组只许按此实现）

外贴：`D:\workspace\kb\汇报\一次并行-2026-10-06\安装包修复-外贴\27-版本目录升级.md`。
基线：`D:\workspace\kb\kb-wt-r13-021`，分支 `r14-022`，tip `3277b9cc616acb66498f970cbe44f7ba27bfa960`。
冻结分支：`r14-027-freeze`。冻结代码在 `src/shared/layout/**` 与 `tests/layout-contract-0027.test.ts`。
各组从冻结提交切工作树，**禁止修改** `src/shared/layout/**`。要改契约就停，写 `D:\workspace\kb-work\updater-0027\requests\<组>.md`。

版本号仍是 `0.2.4`，直到主线合入后再改为 `0.2.5`。不要改 `package.json` / `package-lock.json`。
不要提交 `e2e/perf-startup-0017.mjs`。不要 push。不要 `npm install` / `npm ci` / 新依赖。不要升级 Electron、katex、mermaid。
不要写 `D:\example_dev`。不要杀 用户的 `LocalKnowledgeWorkbench`。不要打开她的库。
不要启动工作台或更新器窗口，不要运行安装包。同一时间最多一个真正的 Electron；`ELECTRON_RUN_AS_NODE` 单测可以跑。
进程检查只用 `Get-Process` 和 `build/kb-proc-check.ps1`。禁止 `Get-CimInstance`、`Get-WmiObject`、`wmic`、`Win32_Process`。
不要改 `build/installer.nsh`。本外贴的常规路径不再是静默 NSIS。

## 布局

Electron 会加载 exe 旁边的 `resources\app.asar`。旧安装根上的 `resources\` 是工作台本体，所以启动器和更新器不能把 exe 放在安装根，否则会误打开工作台包。快捷方式仍叫「本地知识工作台」，目标是启动器。

```text
<installRoot>/
  current.json
  launcher/
    kb-launch.exe
    （Electron 44.5.1 运行时，resources/app 只含启动器）
  updater/
    kb-updater.exe
    （独立 Electron 运行时，必须有可见窗口）
    state.json
    handoff.json
    update.lock
    launcher.lock
  versions/
    <当前>/          # 完整 win-unpacked，主程序名 LocalKnowledgeWorkbench.exe
    <上一版>/        # 切换成功后保留，供回退
```

用户数据仍是 `%LOCALAPPDATA%\LocalKnowledgeWorkbench`，或 `KB_USER_DATA`。不许放进 `versions/`。
隔离安装根必须在 `D:\workspace\kb-work\updater-0027\` 下。`isUnderStudyDev` 为真则拒绝。

版本目录只保留 `current` 与 `previous`。其余目录只在更新器阶段 `done` 之后删除。失败、切换中、回退中都不删。
候选包先解到 `versions/<版本>.partial`，完整性通过后再改名为 `versions/<版本>`。失败删掉 `.partial`，不动 `current.json`。

## 谁可以写

| 文件 | 谁写 |
| --- | --- |
| `current.json` | 更新器；迁移器；启动器仅当 `mayLauncherWritePointer` 为真，且用户点了「启动上一版」 |
| `updater/state.json` | 工作台只写 `preparing` / `ready` / `cancelled`；更新器写其后的阶段 |
| `updater/handoff.json` | 只有工作台，在用户确认并 `makeBackup` 成功之后 |
| `updater/update.lock` | 只有更新器 |
| `versions/<版本>/` | 工作台解压，或迁移器复制 |

`current.json` 用 `writeCurrent` / `writeAtomicJson`。占用码 `EPERM` `EACCES` `EBUSY` `EEXIST` 才重试，间隔 200/400/800/1600 ms，最多 5 次。其它错误不重试。最终失败恢复改名前的原文。

## 进程

| 进程 | 职责 |
| --- | --- |
| `launcher/kb-launch.exe` | 单实例锁 `updater/launcher.lock`。调用 `planLaunch`。拉起 `versions/<current>/LocalKnowledgeWorkbench.exe`。不扫盘，不打开 `workbench.db` |
| 工作台 | 读 `dirpack.json`，下载 zip，校验大小和 sha512，解压，校验完整性，进度可取消。确认文案用 `RESTART_TO_UPDATE_TITLE` / `RESTART_TO_UPDATE_BODY`。然后 `makeBackup`，写 handoff，拉起更新器，退出 |
| `updater/kb-updater.exe` | 可见窗口，标题 `UPDATE_WINDOW_TITLE`。等本安装根里的工作台退出 → `pointAt` → 启动新版 → 等 `<userData>/update-ready.json` → 完成或 `pointBack` |

工作台现有阶段名（`downloading` / `verifying` / `ready` 等）不要改名。目录包模式只在 `applyMode === 'dirpack'` 时走新路径。没有 `current.json` 的旧布局仍走原来的 NSIS 分支，但新feed不靠它完成 0.2.5。

就绪标记由工作台在窗口与数据库都可用后写入：

```json
{ "schema": 1, "version": "0.2.5", "at": "2026-10-11T00:00:00.000Z" }
```

更新器超时见 `PHASE_TIMEOUT_MS`：等待退出 60 秒，切换 30 秒，启动 45 秒，验证 60 秒。超时写阶段日志，不切换或按 `decideRecovery` 回退。错误要带日志路径。
进程范围只包括本次安装根 `versions\` 下的 `LocalKnowledgeWorkbench.exe` 及其子进程。看到路径在 `D:\example_dev\LocalKnowledgeWorkbench` 下的进程即失败，不许结束它。禁止 Cim / Wmi / wmic。

阶段日志每行一个 JSON：`formatPhaseLog`。每阶段有 `start` 和 `end` 或 `fail`，`end` 带 `ms`。

被杀掉之后只按 `decideRecovery` 行动。`rollback-pointer` 用 `pointBack`，不删版本目录。

## 清单与双轨

`dirpack.json` 与旧的 `latest.yml` 放在同一 feed 目录。0.2.5 客户端只消费 `dirpack.json`。
zip 内部是 win-unpacked 的内容，不是整棵安装根。解压目标是 `versions/<版本>/`。
必需文件见 `VERSION_TREE_REQUIRED`。缺一个或大小为 0 就不许写 `ready`。

双轨（G8，写死）：

- 不把 `latest.yml` 的 version 改成 0.2.5。0.2.4 更新器继续只看见自己能装的 NSIS setup。
- 新系统只读 `dirpack.json`。旁边多一个 `dirpack.json` 不得改变 `parseLatestYml` 的结果。
- 已有 `current.json` 时，禁止再 `spawn` 带 `/S` 或 `--updated` 的 NSIS。
- 本机进入新布局的办法是迁移包，不是静默安装器。

## 迁移

`planMigration` 先判定。`copy-then-point` 时：

1. 整份复制旧根到 `versions/<版本>/`。排除 `versions\`、`launcher\`、`updater\`、`current.json`。
2. 用 `verifyVersionTree` 检查副本。失败则删副本，不写 `current.json`，不改旧 exe。
3. 写 `current.json`：`current` 为该版本，`previous` 为 null。
4. 把根上的 `LocalKnowledgeWorkbench.exe` 改名为 `LocalKnowledgeWorkbench.exe.pre-layout`。这一步失败时 `current.json` 已指向副本，旧文件还在，报告里写明，不要删副本。
5. 快捷方式改到 `launcher\kb-launch.exe`，显示名 `SHORTCUT_NAME`。门禁使用临时目录，不改 用户的桌面，除非主线另给路径。
6. 用户数据目录原样继续用。不复制、不打开 `workbench.db`。

低于 `0.2.2`、没有 exe、没有 `resources\app.asar`、已经有 `current.json`、或落在 `D:\example_dev`（且没有 用户另批）都拒绝。FileVersion `0.2.4.0` 归一成目录名 `0.2.4`。

## 文件所有权

| 组 | 只许改 |
| --- | --- |
| A 启动器 | `src/launcher/**`、`scripts/build-launcher-0027.mjs`、`scripts/shortcuts-0027.ps1`、`tests/launcher-0027.test.ts` |
| B 准备 | `src/shared/update/dirpack.ts`、`src/main/update/prepareDirpack.ts`、`src/main/update/service.ts`、`src/main/update/attach.ts`、`src/renderer/update/UpdatePage.tsx`、`tests/update-dirpack-0027.test.ts`，以及为就绪标记必须碰到的 `src/main/index.ts` 最少行 |
| C 更新器 | `src/updater/**`、`scripts/build-updater-0027.mjs`、`tests/updater-switch-0027.test.ts` |
| D 迁移验收 | `src/migrate/**`、`scripts/migrate-layout-0027.mjs`、`scripts/assemble-layout-0027.mjs`、`scripts/gates-0027/**`、`docs/update-compat-0027.md`、`tests/migrate-layout-0027.test.ts` |

公共契约只在本冻结提交。各组不要互相改文件。

## 合入门禁

顺序：冻结 → A → B → C → D → 主线把 version 改为 `0.2.5` → G1–G9。任一项失败就不进真正升级源，也不改 `%LOCALAPPDATA%\LocalKnowledgeWorkbench-update-feed\`。
每个短分支提交前 `git status`：没有 `node_modules`，没有 `e2e/perf-startup-0017.mjs`。不要 push。
门禁脚本没有环境变量 `KB_GATE_ALLOW_ELECTRON=1` 时必须退出码 2，不许启动 Electron。该变量只由主线在独占时设置。

G1–G10 的定义以外贴 27 为准。日志根：`D:\workspace\kb-work\updater-0027\`。候选 feed：`D:\workspace\kb-work\feed-0.2.5\`。
真正升级源只有 G1–G9 全 PASS 且 用户授权后才追加 `dirpack.json` 和 zip。即便授权，也不改 `latest.yml` 的 0.2.4。
