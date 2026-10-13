# 组 2 接线说明

界面都在 `src/renderer/agent-live/`。本文件列出集成组要改的公共文件。组 2 没有改这些文件。

不要做的事：

- 不要改 `src/shared/agentLive/types.ts`。本分支里的这份文件与 `96cc3c9` 的 blob `ef705d064b84b55f2687d639e36ebbc0f6170b6f` 相同。
- 不要改 `watcher.ts`，不要再加 chokidar 或逐文件 `fs.watch`。内容变化只消费组 1 已经接上的 `ResourceChangeFeed`。
- 不要改阅读器内部（`plugins/builtin-readers/editor.tsx`、`SandboxPanel` 正文）。阅读窗口按钮只挂在面板标题栏。
- 资料区向外拖只调用 `webContents.startDrag`，只传路径。`deleteSource` 固定是 `false`。拖拽结束后不得删除、移动或改写原文件。

## 1. 渲染进程入口（`src/renderer/App.tsx`）

用 `AgentLiveProvider` 包住现有界面。`client` 用 `createIpcAgentLiveClient(kb)`。`host` 由 App 填，因为只有这里知道当前工作区、活动面板和目录选中项。

```tsx
import { AgentLiveProvider, AgentMaterialsSidebar, ConnectAgentButton, createIpcAgentLiveClient } from './agent-live';

const client = useMemo(() => createIpcAgentLiveClient(kb), []);
// host 见下一节
<AgentLiveProvider client={client} host={host}>
  {/* 现有 app */}
</AgentLiveProvider>
```

顶栏标题右侧放 `<ConnectAgentButton />`。它是实心主按钮。点击复制 `live/current/ENTRY.md`，下拉里的「复制当前工作区入口」复制 `live/ws/<workspaceId>/ENTRY.md`。复制后的提示是「已复制，粘贴给你的 agent 即可」。已经接入的 agent 继续用这个路径，按钮不会新建连接。

侧栏放在目录内容下方，作为底部子栏：

```tsx
<DirViewHost ... />
<AgentMaterialsSidebar />
```

折叠状态随工作区保存，键名是 `agent-live-chrome`（`AGENT_LIVE_CHROME_KEY`）。建议存在 `kb.getLayout` / `kb.setLayout` 的按 workspaceId 分桶对象里。不要写进工作区导出或模板。组件通过 `host.loadChrome` / `host.saveChrome` 读写。

`SearchBox` 每个结果行里放 `<SearchHitAddButton item={ref} />`。按钮必须是 `.kb-search-hit` 的后代，悬停或聚焦才显示。`ref.absPath` 要用根路径和 `relPath` 拼出来（`joinRoot`）。行的 `onMouseDown` 会打开文件，按钮自己 `stopPropagation`。

## 2. host 要提供的能力

`AgentLiveHost` 在 `host.ts`。

- `workspaceId()`：当前工作区稳定 ID。
- `currentReading()`：活动阅读面板里的文件。没有文件时返回 `null`。
- `readingForPanel(panelId)`：同上，按面板取。网页和外部程序返回 `null`。
- `selection()`：目录或搜索里选中的文件。目录当前是单选；多选见第 5 节。
- `hostedForeground()`：活动面板是外部程序（`WorkspaceItem.sourceKind === 'app'`，或前台是托管窗口）时为 `true`。
- `notify`：接到现有 toast。
- `confirm`：接到 `dialogs.confirm`。清空本轮会问「只解除本轮引用，不会删除原文件，也不影响固定资料。」
- `writeClipboard`：`navigator.clipboard.writeText`，失败时走主进程剪贴板。
- `bridgeEntryPath` / `workspaceEntryPath`：主进程按 agent-bridge 目录返回绝对路径。渲染进程不要自己猜 `%LOCALAPPDATA%`。
- `pickFile`：重新定位用的文件选择。取消返回 `null`。
- `resolve`：目录拖拽往往只有 `resourceId`。用 `kb.getResource` 和根路径补上 `absPath`。补不上就不要加入。
- `startDragCopy`：见第 7 节。

真实路径用 `joinRoot(root.path, resource.relPath)`。不要把网页、图片片段、纯文本选区做成资料。

## 3. 阅读窗口标题栏（`src/renderer/panel-manager/react.tsx`）

只改 `PanelHeaderActions`，不改阅读器：

```tsx
import { ReaderAddMaterialButton } from '../agent-live';

export function PanelHeaderActions(props: IDockviewHeaderActionsProps) {
  const id = props.activePanel?.id;
  if (!id) return null;
  return (
    <>
      <ReaderAddMaterialButton panelId={id} />
      <WindowButtons id={id} prefix="pm-act" />
    </>
  );
}
```

按钮文案是「加入 agent 工作资料」。没有文件时组件返回 `null`。

## 4. 命令和快捷键

在现有 `api.commands.register` 处，等 `loadKeybindings()` 完成后再登记，这样能看见用户绑定：

```tsx
import { decideAddCurrentBinding, registerAgentLiveCommands, acceleratorsForGlobalHook } from './agent-live';
import { AGENT_LIVE_ACTIONS } from '../shared/agentLive/types';

const decision = decideAddCurrentBinding(commands.all(), getKeybindingsStore(), {
  hostedForeground: host.hostedForeground(),
});
registerAgentLiveCommands((command) => api.commands.register(command), decision.keybinding);
```

`agent.materials.addCurrent` 的默认键是 `Ctrl+Shift+A`，范围 `global`，这样 PDF 也能用。下面三种情况不挂这枚默认键：

- 用户已经绑过或清除过这条命令：保留用户的选择。
- `Ctrl+Shift+A` 和任一现有有效绑定冲突：不覆盖。
- 绑定是 `Ctrl+Alt+A`：不用。截图软件常占这枚键。

`src/renderer/keybindings/runtime.ts` 的 `pushBoundToMain` 在调用 `kb.setBoundShortcuts` 之前过滤：

```ts
const list = acceleratorsForGlobalHook(
  listBoundAccelerators(commands.all(), store),
  hostedForeground(),
).map((item) => item.key);
```

`hostedForeground()` 为真时，全局钩子里没有 `agent.materials.addCurrent`，原应用还能收到这枚键。命令自己的 `run` 也会直接返回。

命令面板里的条目都在 `actionCatalog.ts`。界面点击直接执行。桥调用资料变更时 `approvalRequired: true`。

## 5. 目录右键和多选（`src/renderer/dir-view/RowMenu.tsx`）

`fileMenu` 在文件条目上追加：

```tsx
import { agentLiveMenuItems, refsForAddGesture } from '../agent-live';
import { addSelection, getAgentLiveBinding } from '../agent-live';

const binding = getAgentLiveBinding();
if (binding && entry === 'file') {
  const refs = refsForAddGesture(clickedRef, selectedRefs);
  items.push(...agentLiveMenuItems(refs, (batch) => void addSelection(binding, batch)));
}
```

`refsForAddGesture`：右键落在多选内部就加入整批，否则只加入被点的那一项。

目录栏现在的 `select()` 每次只留下一个 `res:<id>`。组 2 不能改 `DirView`。集成组若要真正的多选，在 `TreeRow` 点击时按 Ctrl/Shift 把多个 `res:` 写进 `pane.selected`。命令 `agent.materials.addSelection` 读的是 `host.selection()`，目录和搜索共用。

拖进子栏已经能一次收多个文件。网页、文件夹、没有 `entry: 'file'` 的拖拽会被拒绝并提示。

## 6. 预加载和主进程

`src/preload/index.ts` 把下面的方法挂到 `window.kb`。`src/shared/types.ts` 的 `KbApi` 加上同名声明。名字要和 `ipcClient.ts` 的 `AgentLiveIpc` 一致。

| 渲染方法 | 主进程 |
| --- | --- |
| `agentLiveList(workspaceId)` | `store.list` |
| `agentLiveAdd(workspaceId, ref, opts?)` | `store.add`。可只返回 `'added' \| 'duplicate'` |
| `agentLiveAddMany(workspaceId, refs)` | 同一轮登记，交给组 4 合成一个 revision |
| `agentLiveRemove` / `agentLiveReorder` / `agentLiveSetPurpose` | store 同名方法 |
| `agentLivePin` / `agentLiveUnpin` / `agentLiveClearSession` / `agentLiveRelocate` | 见回交里的接口变更申请。`types.ts` 的 `AgentMaterialsStore` 还没有这四个方法 |
| `onAgentLiveChanged(cb)` | store `onChange` 后按 workspaceId 通知 |

加入路径只登记引用并返回。哈希、正文、token 由组 1 在后台算，算完再发一版。渲染进程不会为了反馈去读文件。

`clearSession` 只返回被清掉的 `materialId`。主进程不得删除原文件。`relocate` 保持原来的 `materialId`，把 `contentHash`、`bytes`、`estTokens`、`readable` 清成待算，`status` 改回 `ok`。

## 7. 向外拖（主进程）

`host.startDragCopy` 收到 `{ files, op: 'copy', deleteSource: false }`。

```ts
contents.startDrag({ file: request.files[0], icon });
```

Windows 的 `startDrag` 一次一个文件。多文件时只拖被抓住的那一项即可，名称拖动本来就只放当前行的路径。不要在 `dragend` 里 `unlink`、`rename` 或调用现有的移动落点。资料区排序用另一条 MIME `application/x-kb-agent-reorder`，不带文件路径，避免现有目录落点把它当成移动。

## 8. ActionId 登记

不要改 `registry.ts`。新建 `src/shared/actions/packages/agentLive.ts`：

```ts
import { registerActions } from '../registry';
import { AGENT_LIVE_ACTION_CATALOG } from '../../../renderer/agent-live/actionCatalog';

export function registerAgentLivePackage(): void {
  registerActions('agent-live', AGENT_LIVE_ACTION_CATALOG.map((item) => ({ ...item })));
}
```

`src/shared/actions/install.ts` 的 `installActionPackages` 里加一行 `registerAgentLivePackage()`。`actionCatalog.ts` 没有 React，主进程可以引用。不要从主进程引用 `panel.tsx`。

`agent.getContent` / `agent.getDiff` 由组 4 登记，这里没有重复。

渲染进程的 `commands.register` 也会写同一张表。两处都要有：桥在窗口起来之前就要能看见这些 ActionId。

## 9. 给组 3 的区头文案

ENTRY.md 两个资料区的段头调用：

```ts
import { formatSectionHeading } from '../../../renderer/agent-live/format';

formatSectionHeading('本轮资料', sessionItems);
formatSectionHeading('固定资料', pinnedItems);
```

已知体积和 token 时形如 `本轮资料 · 12 项 · 3.4MB · 约 41k tokens`。还在算的字段写「体积计算中」或「token 计算中」，不写 0。两区已知 token 合计超过 150000 时，侧栏显示「合计超过 150k tokens，仍可继续使用」，不禁用加入。

## 10. 预览

集成前可以用渲染进程预览看界面，不启动工作台：

`src/renderer/agent-live/preview.html`

`npx vite --port 5213` 后打开 `/agent-live/preview.html`。`?menu=1` 展开入口菜单，`?confirm=1` 打开清空确认，`?mobile=1` 用窄屏。这不是已经接进 `App.tsx` 的工作台。
