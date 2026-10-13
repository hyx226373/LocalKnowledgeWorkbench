# 生成 src/shared/theme-contract.json（主题接口的唯一事实来源）。修改令牌请改这里再运行：python3 scripts/gen-theme-contract.py
import json
FONT_UI = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif'
FONT_MONO = '"Cascadia Mono", Consolas, "JetBrains Mono", "Noto Sans Mono CJK SC", monospace'
T = []
def t(axis, group, name, desc, light, dark=None, role=None, since=None):
    e = {"name": name, "axis": axis, "group": group, "description": desc, "default": {"light": light, "dark": light if dark is None else dark}}
    if role: e["role"] = role
    if since: e["since"] = since
    T.append(e)
C, R = 'chrome', 'reading'
# ---------- 外框：字体 ----------
t(C,'typography','font-ui','界面字体（菜单、树、按钮、标签）',FONT_UI)
t(C,'typography','font-mono','界面等宽字体（快捷键、路径）',FONT_MONO)
t(C,'typography','font-ui-accent','强调字体（标签标题、状态栏、页码；可设为等宽或衬线）',FONT_UI)
for n,v,d in [('fs-xs','11px','最小字号（徽标、区块小标题）'),('fs-sm','12px','小字号（按钮、标签、次要信息）'),('fs-md','13px','界面正文字号'),('fs-lg','15px','较大字号（对话框标题）'),('fs-xl','20px','最大字号（空状态标题）')]:
    t(C,'typography',n,d,v)
t(C,'typography','fw-strong','强调字重','600')
t(C,'typography','ls-caps','区块小标题字距','.08em')
# ---------- 外框：间距 / 尺寸 ----------
for i,v in enumerate(['2px','4px','8px','12px','16px','24px'],1):
    t(C,'spacing',f'space-{i}',f'间距阶梯第 {i} 级',v)
for n,v,d in [('size-row','24px','树行/菜单项/搜索结果行高'),('size-control','26px','按钮、输入框高度'),('size-topbar','40px','顶栏高度'),('size-statusbar','22px','状态栏高度'),('size-tab','35px','标签栏高度'),('size-sash','4px','侧栏分隔条可见宽度'),('row-inset','0px','行（树/菜单）左右内缩，配合圆角做“胶囊”行'),('dock-gap','0px','分栏卡片之间的视觉间隙（纯视觉，不改变保存的分栏尺寸）'),('shell-inset','0px','外框四周留白（侧栏/分栏区与窗口边缘的距离）')]:
    t(C,'size',n,d,v)
for n,v,d in [('radius-sm','3px','小圆角（行、徽标、代码）'),('radius-md','4px','中圆角（按钮、输入框、弹层）'),('radius-lg','6px','大圆角（卡片、对话框、分组）'),('radius-pill','999px','胶囊圆角')]:
    t(C,'radius',n,d,v)
t(C,'elevation','shadow-1','一级阴影（卡片、分组）','none')
t(C,'elevation','shadow-2','二级阴影（弹层、搜索结果）','0 4px 16px rgba(16,24,40,.18)','0 4px 16px rgba(0,0,0,.5)')
t(C,'elevation','shadow-3','三级阴影（对话框）','0 16px 48px rgba(16,24,40,.24)','0 16px 48px rgba(0,0,0,.6)')
t(C,'motion','motion-fast','快速过渡时长（悬停）','80ms')
t(C,'motion','motion-normal','常规过渡时长（展开、弹层）','160ms')
t(C,'motion','motion-ease','缓动曲线','cubic-bezier(.2,0,0,1)')
t(C,'state','opacity-dragging','被拖动元素（标签、分隔条）的不透明度','.6',role='state.dragging-opacity',since='2.0.0')
# ---------- 外框：颜色 ----------
# 每个颜色令牌都对应一个“颜色角色”（role，点分命名，v2 起为权威语义名；CSS 变量名保持 --kb-<令牌名> 不变）
cols = [
 ('color-bg','应用底色（窗口最底层）','#f3f3f3','#181818','surface.base'),
 ('color-chrome','外框底色（顶栏、侧栏）','#f8f8f8','#1f1f1f','surface.chrome'),
 ('color-chrome-alt','次级外框色（区块头、次级按钮）','#ececec','#252526','surface.chrome-alt'),
 ('color-surface','分组/面板底色','#ffffff','#1e1e1e','surface.panel'),
 ('color-surface-raised','浮层底色（弹层、对话框、工具栏、提示条）','#ffffff','#252526','surface.raised'),
 ('color-surface-sunken','凹陷底色（编辑器装订线、对比视图、资料列表、代码框外框）','#f0f0f0','#161616','surface.sunken','2.0.0'),
 ('color-border','常规边框/分隔线','#e5e5e5','#2b2b2b','border.default'),
 ('color-border-strong','强调边框（输入框悬停、对话框）','#c8c8c8','#454545','border.strong'),
 ('color-text','主文字','#1f1f1f','#cccccc','text.primary'),
 ('color-text-muted','次要文字','#616161','#9d9d9d','text.muted'),
 ('color-text-faint','弱文字（占位、空状态）','#9e9e9e','#6b6b6b','text.faint'),
 ('color-text-disabled','禁用文字（v1 的 color-disabled-fg 改名）','#a6a6a6','#5a5a5a','text.disabled','2.0.0'),
 ('color-accent','强调色（主按钮、焦点、激活指示）','#005fb8','#0078d4','accent.default'),
 ('color-accent-fg','强调色上的文字','#ffffff','#ffffff','accent.on'),
 ('color-accent-soft','强调色浅底（标签、提示）','#e6f0fa','#0f2e4a','accent.soft'),
 ('color-hover','悬停底色','rgba(0,0,0,.05)','rgba(255,255,255,.06)','state.hover'),
 ('color-active','按下底色','rgba(0,0,0,.09)','rgba(255,255,255,.1)','state.active'),
 ('color-selected','选中底色（当前文件、选中结果）','#dbe8f7','#04395e','state.selected'),
 ('color-selected-fg','选中文字','#1f1f1f','#ffffff','state.selected-fg'),
 ('color-focus-ring','键盘焦点环（focus-visible）','#005fb8','#2f8fe0','state.focus-ring'),
 ('color-disabled-bg','禁用底色','#f0f0f0','#2a2a2a','state.disabled-bg'),
 ('color-drag-over','拖放目标高亮','rgba(0,95,184,.16)','rgba(0,120,212,.22)','state.drag-over'),
 ('color-overlay','对话框/命令面板遮罩','rgba(0,0,0,.25)','rgba(0,0,0,.45)','surface.overlay'),
 ('color-fav','收藏星标','#c48a1a','#e2c08d','icon.favorite'),
 ('color-danger','危险/错误','#c4314b','#f48771','feedback.danger'),
 ('color-success','成功/启用','#2d8a4e','#4ec27a','feedback.success'),
 ('color-warning','警告/扫描中/冲突','#b97a00','#f5a524','feedback.warning'),
 ('color-status-bg','状态栏底色','#007acc','#007acc','statusbar.bg'),
 ('color-status-fg','状态栏文字','#ffffff','#ffffff','statusbar.fg'),
 ('color-tab-bg','标签栏/未激活标签底色','#f3f3f3','#1f1f1f','tab.bg'),
 ('color-tab-fg','未激活标签文字','#6f6f6f','#8b8b8b','tab.fg'),
 ('color-tab-active-bg','激活标签底色','#ffffff','#1e1e1e','tab.selected-bg'),
 ('color-tab-active-fg','激活标签文字','#1f1f1f','#ffffff','tab.selected-fg'),
 ('color-tab-indicator','激活标签指示条（transparent 表示不显示）','transparent','transparent','tab.indicator'),
 ('color-sash','分隔条颜色','#e5e5e5','#2b2b2b','splitter.default'),
 ('color-sash-hover','分隔条悬停颜色','#005fb8','#0078d4','splitter.hover'),
 ('color-sash-dragging','分隔条拖动中颜色','#004c93','#3794ff','splitter.dragging','2.0.0'),
 ('color-input-bg','输入框底色','#ffffff','#313131','input.bg'),
 ('color-input-border','输入框边框','#cecece','#3c3c3c','input.border'),
 ('color-scrollbar','滚动条滑块','rgba(0,0,0,.2)','rgba(255,255,255,.18)','scrollbar.thumb'),
 ('color-diff-add-bg','对比视图：新增行底色','#e6ffec','rgba(46,160,67,.18)','diff.add-bg','2.0.0'),
 ('color-diff-add-fg','对比视图：新增行文字','#116329','#7ee787','diff.add-fg','2.0.0'),
 ('color-diff-del-bg','对比视图：删除行底色','#ffebe9','rgba(248,81,73,.18)','diff.del-bg','2.0.0'),
 ('color-diff-del-fg','对比视图：删除行文字','#82071e','#ffa198','diff.del-fg','2.0.0'),
 ('color-icon-folder','文件夹图标','#c09553','#c09553','icon.folder'),
 ('color-icon-root','根目录图标','#005fb8','#3794ff','icon.root'),
 ('color-icon-file','普通文件图标','#7a7a7a','#9d9d9d','icon.file'),
 ('color-icon-md','Markdown 图标','#3b82f6','#519aba','icon.md'),
 ('color-icon-pdf','PDF 图标','#e5484d','#e5484d','icon.pdf'),
 ('color-icon-image','图片图标','#30a46c','#4ec27a','icon.image'),
 ('color-icon-csv','表格图标','#12a594','#2ec4b6','icon.csv'),
]
for c in cols: t(C,'color',c[0],c[1],c[2],c[3],role=c[4],since=(c[5] if len(c)>5 else None))
# ---------- 阅读区 ----------
t(R,'typography','read-font','正文字体',FONT_UI)
t(R,'typography','read-font-heading','标题字体',FONT_UI)
t(R,'typography','read-font-mono','代码/纯文本字体',FONT_MONO)
t(R,'typography','read-fs','正文字号','15px')
t(R,'typography','read-fs-code','代码/纯文本字号','13px')
t(R,'typography','read-lh','正文行高','1.75')
t(R,'layout','read-max-width','Markdown 正文最大宽度（100% 表示铺满）','880px')
t(R,'layout','read-pad-x','正文左右内边距','32px')
t(R,'layout','read-pad-y','正文上下内边距','24px')
for c in [
 ('read-bg','阅读区底色','#ffffff','#1e1e1e','reader.surface'),
 ('read-fg','正文颜色','#24292f','#d4d4d4','reader.text'),
 ('read-muted','引用/注释文字','#57606a','#9d9d9d','reader.text-muted'),
 ('read-heading','标题颜色','#1f2328','#e8e8e8','reader.heading'),
 ('read-link','链接颜色','#0969da','#4daafc','reader.link'),
 ('read-quote-bar','引用块左侧条','#d0d7de','#3c3c3c','reader.quote-bar'),
 ('read-code-bg','行内/块代码底色','#f6f8fa','#2d2d2d','reader.code-bg'),
 ('read-code-fg','代码文字','#24292f','#d4d4d4','reader.code-fg'),
 ('read-rule','表格线/分隔线','#d0d7de','#3c3c3c','reader.rule'),
 ('read-table-head-bg','表头底色（Markdown 表格、CSV 视图）','#f6f8fa','#252526','reader.table-head-bg'),
 ('read-selection','文字选区底色','rgba(9,105,218,.2)','rgba(38,79,120,.8)','reader.selection'),
 ('read-mark','搜索命中高亮','#fff8c5','#613d00','reader.mark'),
 ('read-editor-bg','编辑器底色（txt/md 原位编辑）','#ffffff','#1e1e1e','editor.surface','2.0.0'),
 ('read-editor-caret','编辑器光标颜色','#0969da','#4daafc','editor.caret','2.0.0'),
 ('read-pdf-backdrop','PDF/图片页面背后的底色','#e9ebee','#2a2a2a','pdf.backdrop'),
 ('read-pdf-page-bg','PDF 页面底色（加载前）','#ffffff','#ffffff','pdf.page-bg'),
 ('read-pdf-page-shadow','PDF 页面阴影','0 2px 8px rgba(0,0,0,.15)','0 2px 8px rgba(0,0,0,.5)','pdf.page-shadow'),
 ('read-pdf-dark-filter','PDF 深色滤镜参数：只在用户于 PDF 面板中打开“深色滤镜”时应用（默认原色显示）；v1 的 read-pdf-filter 改名','invert(.9) hue-rotate(180deg)','invert(.88) hue-rotate(180deg) brightness(.95)','pdf.dark-filter','2.0.0'),
]: t(R,'color',c[0],c[1],c[2],c[3],role=c[4],since=(c[5] if len(c)>5 else None))
# ---------- 阅读专注模式（v2）：命令“阅读专注模式”（F9）开启后，阅读区改用这些令牌；外框按 read-focus-chrome-opacity 淡出 ----------
for n,d,l,dk,role in [
 ('read-focus-bg','专注模式阅读区底色','#fbfaf7','#191919','focus.surface'),
 ('read-focus-fg','专注模式正文颜色','#1f2328','#dcdcdc','focus.text'),
]: t(R,'focus',n,d,l,dk,role=role,since='2.0.0')
for n,d,v in [
 ('read-focus-fs','专注模式正文字号','17px'),
 ('read-focus-lh','专注模式正文行高','1.9'),
 ('read-focus-max-width','专注模式正文最大宽度','720px'),
 ('read-focus-pad-x','专注模式正文左右内边距','48px'),
 ('read-focus-pad-y','专注模式正文上下内边距','48px'),
 ('read-focus-chrome-opacity','专注模式下外框（顶栏、侧栏、状态栏、标签栏）的不透明度；1 表示不淡出','.35'),
]: t(R,'focus',n,d,v,since='2.0.0')

STATES = ['default','hover','active','focus-visible','disabled','selected','dragging','drag-over']
STATE_DESC = {
 'default':'默认外观',
 'hover':'鼠标悬停（:hover）',
 'active':'按下（:active）或“当前激活”（例如激活分组）',
 'focus-visible':'键盘焦点（:focus-visible；v1 名为 focus）',
 'disabled':'不可用（:disabled / [aria-disabled="true"]）',
 'selected':'选中/当前项（[aria-selected="true"]、当前标签、勾选）',
 'dragging':'自身正被拖动（v2 新增：[data-dragging="true"]）',
 'drag-over':'作为拖放目标、有东西拖到上方',
}
def comp(id, name, hook, states, axis='chrome', note='', since=None):
    full = {s: states.get(s) for s in STATES}
    unknown = set(states) - set(STATES)
    assert not unknown, (id, unknown)
    e = {"id": id, "name": name, "axis": axis, "hook": hook, "states": full, "note": note}
    if since: e["since"] = since
    return e
# 权威组件清单（v2）：每个组件都在组件状态表（npm run theme:shots → states-*.png）中逐状态渲染；没有的状态为 null。
COMPONENTS = [
 comp('button','按钮（主/次/幽灵）','.kb-button, .kb-button--secondary, .kb-button--ghost',
      {'default':'.kb-button','hover':':hover','active':':active','focus-visible':':focus-visible','disabled':':disabled','selected':'[aria-pressed="true"]（开关按钮按下，例如 PDF“深色滤镜”、编辑器“预览”）'}),
 comp('input','输入框/下拉框/多行文本','.kb-input, .kb-select, .kb-textarea',
      {'default':'.kb-input','hover':':hover','focus-visible':':focus-visible','disabled':':disabled'}),
 comp('toggle','复选开关','.kb-toggle',
      {'default':'.kb-toggle','hover':':hover','focus-visible':'.kb-toggle input:focus-visible','disabled':'[aria-disabled="true"]','selected':'.kb-toggle input:checked（勾选）'}, since='2.0.0'),
 comp('tab','标签页（dockview）','.kb-dock .dv-tab',
      {'default':'.dv-tab','hover':':hover','active':':active','focus-visible':':focus-visible','selected':'.dv-active-tab（所在分组激活时外层有 .dv-active-group）','dragging':'.dv-tab[data-dragging="true"]（正被拖动的标签）','drag-over':'.kb-dock .dv-drop-target-selection（拖到分组上方时出现的覆盖层，颜色来自 --kb-color-drag-over）'},
      note='未加载的后台标签：.dv-tab [data-lazy="pending"]（冷启动分级加载，切到它时才加载内容）'),
 comp('group','分栏分组（可做成卡片）','.kb-dock .dv-groupview, .kb-dock .dv-tabs-and-actions-container',
      {'default':'.dv-groupview','active':'.dv-active-group（当前激活分组）','drag-over':'.kb-dock .dv-drop-target-selection'}),
 comp('tree-row','目录树行/收藏行','.kb-tree-row',
      {'default':'.kb-tree-row','hover':':hover','active':':active','focus-visible':':focus-visible','disabled':'[aria-disabled="true"]（文件已不在原处）','selected':'[aria-selected="true"]（当前激活标签对应的文件）','drag-over':'[data-drag-over="true"]（预留）'},
      note='被忽略的项（显示被忽略的项时）：.kb-tree-row.ignored'),
 comp('collection-row','工作资料行（侧栏“本工作的资料”）','.kb-collection, .kb-collection-row',
      {'default':'.kb-collection-row','hover':':hover','active':':active','focus-visible':':focus-visible','disabled':'[aria-disabled="true"]（原文件已不在原处）','selected':'[aria-selected="true"]（当前激活标签）'},
      note='已打开为标签：[data-open="true"]', since='2.0.0'),
 comp('splitter','分隔条（侧栏 + 分栏）','.kb-sash, .kb-dock .dv-sash',
      {'default':'.kb-sash','hover':':hover','active':':active','dragging':'[data-dragging="true"]（侧栏分隔条拖动中；分栏分隔条拖动中为 .dv-sash:active）','disabled':'.dv-sash.dv-disabled'}),
 comp('search-result','搜索结果行','.kb-search-results, .kb-search-hit',
      {'default':'.kb-search-hit','hover':':hover','active':':active','selected':'[aria-selected="true"]（键盘选中）'}),
 comp('menu-item','菜单项（工作区切换、外观、命令面板）','.kb-popover, .kb-menu-item, .kb-menu-group-title',
      {'default':'.kb-menu-item','hover':':hover','active':':active','focus-visible':':focus-visible','disabled':'[aria-disabled="true"]','selected':'[aria-selected="true"]（当前工作区/选中命令）'}),
 comp('plugin-row','插件侧栏行','.kb-plugin-row, .kb-badge',
      {'default':'.kb-plugin-row','hover':':hover','disabled':'[data-status="disabled"] / [data-status="error"|"incompatible"|"denied"]'}),
 comp('statusbar','状态栏','.kb-statusbar, .kb-status-item',
      {'default':'.kb-status-item','hover':'.kb-status-item button:hover'},
      note='状态：.kb-status-item[data-state="idle"|"scanning"|"error"]'),
 comp('dialog','对话框','.kb-dialog-backdrop, .kb-dialog, .kb-dialog-title, .kb-dialog-body, .kb-dialog-actions',
      {'default':'.kb-dialog','focus-visible':'.kb-dialog:focus-within'}),
 comp('toast','提示条与横幅（保存成功、冲突、只读工作区）','.kb-toast, .kb-banner',
      {'default':'.kb-toast / .kb-banner'}, note='语气：[data-tone="info"|"success"|"warning"|"danger"]', since='2.0.0'),
 comp('section','侧栏区块/顶栏','.kb-sidebar, .kb-section, .kb-section-title, .kb-topbar',
      {'default':'.kb-section'}),
 comp('view-toolbar','视图工具栏（PDF 页码/缩放/深色滤镜、编辑器 编辑/预览/保存）','.kb-view-toolbar',
      {'default':'.kb-view-toolbar'}, note='其中的按钮使用 button 组件的全部状态'),
 comp('notice','空状态/占位/错误提示','.kb-notice, .kb-watermark',
      {'default':'.kb-notice'}),
 comp('diff','改动对比（保存前预览、冲突对比）','.kb-diff, .kb-diff-line',
      {'default':'.kb-diff-line[data-kind="ctx"]','selected':'.kb-diff-line[data-kind="add"] / [data-kind="del"]（新增/删除行，颜色来自 diff.* 角色）'}, since='2.0.0'),
 comp('reading','阅读区（所有视图的内容根）','.kb-reading, .kb-reading .kb-md, .kb-reading pre, .kb-table',
      {'default':'.kb-reading','selected':'.kb-reading ::selection'}, axis='reading'),
 comp('editor','文本/Markdown 原位编辑器','.kb-editor, .kb-editor-text',
      {'default':'.kb-editor-text','focus-visible':':focus-visible','disabled':'[readonly]（只读：冲突待处理时）','selected':'::selection'}, axis='reading',
      note='有未保存修改：.kb-editor[data-dirty="true"]；冲突：.kb-editor[data-conflict="true"]', since='2.0.0'),
 comp('pdf-page','PDF 页面','.kb-pdf-page',
      {'default':'.kb-pdf-page（原色，不加滤镜）','selected':'.kb-reading[data-dark-filter="on"] .kb-pdf-page（用户在该 PDF 面板开启了深色滤镜，应用 --kb-read-pdf-dark-filter）'}, axis='reading', since='2.0.0'),
 comp('reading-focus','阅读专注模式','.kb-reading[data-focus="on"]',
      {'default':'.kb-reading[data-focus="on"]（使用 read-focus-* 令牌）'}, axis='reading', since='2.0.0'),
]
# v1 → v2 改名（v1 主题包按兼容模式加载时自动换名，并给出警告）
RENAMED_TOKENS = {'color-disabled-fg': 'color-text-disabled', 'read-pdf-filter': 'read-pdf-dark-filter'}
RENAMED_STATES = {'focus': 'focus-visible'}
DISALLOWED = ['position','display','float','clear','flex','flex-basis','flex-direction','flex-flow','flex-grow','flex-shrink','flex-wrap','order','grid','grid-area','grid-auto-columns','grid-auto-flow','grid-auto-rows','grid-column','grid-row','grid-template','grid-template-areas','grid-template-columns','grid-template-rows','width','height','min-width','min-height','max-width','max-height','top','right','bottom','left','inset','z-index','overflow','overflow-x','overflow-y','visibility','columns','column-count','column-width','margin','margin-top','margin-right','margin-bottom','margin-left','transform','translate','scale','rotate','content','pointer-events','contain','zoom','aspect-ratio','resize','direction','writing-mode']
out = {
  "$comment": "由 scripts/gen-theme-contract.py 生成。主题接口版本见 version；令牌名在 CSS 中写作 --kb-<name>。",
  "version": "2.0.0",
  "compat": {"acceptsContract": "^1.0.0 || ^2.0.0", "renamedTokens": RENAMED_TOKENS, "renamedStates": RENAMED_STATES},
  "states": STATES,
  "stateDescriptions": STATE_DESC,
  "tokens": T,
  "components": COMPONENTS,
  "css": {"disallowedProperties": DISALLOWED, "allowedAtRules": ["@media (prefers-reduced-motion: reduce)", "@media (prefers-contrast: more)"], "forbiddenValues": ["url(", "expression(", "@import", "javascript:"]},
}
json.dump(out, open('src/shared/theme-contract.json','w'), ensure_ascii=False, indent=1)
print('contract', out['version'], len(T), 'tokens;', sum(1 for x in T if x['axis']=='chrome'), 'chrome,', sum(1 for x in T if x['axis']=='reading'), 'reading;', len(COMPONENTS), 'components')
