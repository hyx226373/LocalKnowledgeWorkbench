/**
 * 数据迁移窗口的界面（单页 HTML，内联脚本，只通过 window.kbm.call 调用主进程）。
 * 刻意不依赖工作台渲染进程（React/dockview），合并时不与界面代码冲突。
 */
export const MIGRATION_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>数据迁移 — 本地知识工作台</title>
<style>
  :root { color-scheme: dark; --bg:#1e1e1e; --panel:#252526; --line:#3a3a3a; --fg:#ddd; --mute:#9a9a9a; --acc:#3d8bfd; --bad:#f07070; --ok:#5cc28a; --warn:#e3b341; }
  * { box-sizing: border-box; }
  body { margin:0; font: 13px/1.5 system-ui, "Microsoft YaHei UI", "PingFang SC", sans-serif; background:var(--bg); color:var(--fg); }
  header { display:flex; gap:4px; padding:10px 14px 0; border-bottom:1px solid var(--line); background:var(--panel); }
  header button { background:none; border:0; color:var(--mute); padding:8px 14px; cursor:pointer; border-bottom:2px solid transparent; font:inherit; }
  header button.on { color:var(--fg); border-bottom-color:var(--acc); }
  main { padding:16px 18px; }
  section { display:none; } section.on { display:block; }
  h2 { font-size:15px; margin:0 0 8px; } p.note { color:var(--mute); margin:4px 0 12px; }
  .row { display:flex; gap:8px; align-items:center; margin:8px 0; }
  input[type=text] { flex:1; min-width:0; background:#111; color:var(--fg); border:1px solid var(--line); border-radius:4px; padding:6px 8px; font:inherit; }
  button.b { background:#333; color:var(--fg); border:1px solid #4a4a4a; border-radius:4px; padding:6px 12px; cursor:pointer; font:inherit; white-space:nowrap; }
  button.b.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.b:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; margin:8px 0; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:middle; }
  th { color:var(--mute); font-weight:normal; }
  code { font-family: Consolas, "Cascadia Mono", monospace; font-size:12px; color:#c8c8c8; word-break:break-all; }
  .badge { display:inline-block; padding:0 6px; border-radius:8px; font-size:12px; }
  .badge.ok { background:#1f3b2b; color:var(--ok); } .badge.bad { background:#4a2020; color:var(--bad); } .badge.warn { background:#463a17; color:var(--warn); }
  .msg { margin:10px 0; padding:8px 10px; border-radius:4px; white-space:pre-wrap; }
  .warnbox { margin:4px 0 12px; padding:8px 10px; border-radius:4px; border:1px solid #b58900; color:#e5c07b; background:rgba(181,137,0,.12); }
  .msg.ok { background:#1f3b2b; } .msg.err { background:#4a2020; } .msg:empty { display:none; }
  .kv { display:grid; grid-template-columns: 9em 1fr; gap:2px 10px; margin:8px 0; }
  .kv div:nth-child(odd) { color:var(--mute); }
  .kv div { word-break: break-all; }
</style></head>
<body>
<header>
  <button data-tab="export" data-testid="tab-export">导出</button>
  <button data-tab="import" data-testid="tab-import">导入并映射根目录</button>
  <button data-tab="repair" data-testid="tab-repair">根目录与缺失文件</button>
  <button data-tab="backups" data-testid="tab-backups">备份与回退</button>
</header>
<main>
<section id="export">
  <h2>导出数据迁移包</h2>
  <p class="note">包含：工作区（标签页、分屏、尺寸、每个面板的阅读状态）、收藏、虚拟集合（如有）、主题选择与已安装主题包、插件状态（已安装列表、授权、插件存储、视图状态）。<br>
  不包含：根目录里的原始资料文件、本机路径、网页登录数据、密钥与令牌、插件声明为不可迁移的数据、操作记录与备份。数据库用一致快照（不直接复制正在写入的文件）。</p>
  <p class="warnbox" data-testid="export-warning">包里含路径和插件数据，请妥善保管。（迁移包没有加密：里面有根目录原路径、文件相对路径、工作区名称和插件存储内容。）</p>
  <div class="row"><input type="text" data-testid="export-path" id="export-path" placeholder="导出到（.kbmigrate.zip）"><button class="b" data-testid="export-browse" id="export-browse">选择位置…</button></div>
  <div class="row"><button class="b primary" data-testid="export-run" id="export-run">导出</button></div>
  <div class="msg" data-testid="export-result" id="export-result"></div>
</section>
<section id="import">
  <h2>导入数据迁移包</h2>
  <p class="note">导入会<strong>替换</strong>本机当前的工作区、收藏、主题选择与插件状态。导入前自动备份当前数据，失败会自动恢复；成功后也可在“备份与回退”中恢复。</p>
  <div class="row"><input type="text" data-testid="import-path" id="import-path" placeholder="迁移包文件"><button class="b" data-testid="import-browse" id="import-browse">选择文件…</button><button class="b" data-testid="import-read" id="import-read">读取</button></div>
  <div id="import-detail" style="display:none">
    <div class="kv" data-testid="import-summary" id="import-summary"></div>
    <h2>根目录映射</h2>
    <p class="note">把每个根目录映射到这台电脑上资料所在的文件夹。可以先不映射（根显示“未映射”，记录保留，之后在“根目录与缺失文件”里映射）。</p>
    <div class="row"><input type="text" id="import-base" data-testid="import-base" placeholder="资料都在同一个上级文件夹？填在这里按名称自动匹配"><button class="b" id="import-base-browse">选择…</button><button class="b" id="import-suggest" data-testid="import-suggest">自动匹配</button></div>
    <table><thead><tr><th>根目录</th><th>原路径（导出电脑）</th><th style="width:44%">新路径（本机）</th><th>暂不映射</th></tr></thead><tbody id="map-body"></tbody></table>
    <div class="row"><button class="b primary" data-testid="import-run" id="import-run">备份当前数据并导入</button></div>
  </div>
  <div class="msg" data-testid="import-result" id="import-result"></div>
</section>
<section id="repair">
  <h2>根目录</h2>
  <table><thead><tr><th>根目录</th><th>状态</th><th style="width:50%">本机路径</th><th></th></tr></thead><tbody id="roots-body"></tbody></table>
  <h2>缺失的文件</h2>
  <p class="note">被收藏或被工作区引用、但在映射后的位置找不到的文件。记录不会被删除：重新定位到新位置（收藏、工作区里的标签与阅读位置跟着恢复），或稍后重新映射根目录。</p>
  <table><thead><tr><th>文件</th><th>引用</th><th style="width:46%">新位置</th><th></th></tr></thead><tbody id="missing-body"></tbody></table>
  <div class="msg" id="repair-result" data-testid="repair-result"></div>
</section>
<section id="backups">
  <h2>导入前的自动备份</h2>
  <p class="note">每次导入前自动备份（元数据库一致快照 + 主题包 + 插件包）；也可以随时手动备份。自动与手动备份合计保留最近 5 份。恢复会替换当前数据。</p>
  <div class="row"><button class="b primary" data-testid="backup-now" id="backup-now">立即备份</button></div>
  <table><thead><tr><th>时间</th><th>原因</th><th>位置</th><th></th></tr></thead><tbody id="backups-body"></tbody></table>
  <div class="msg" id="backups-result" data-testid="backups-result"></div>
</section>
</main>
<script>
const call = (m, ...a) => window.kbm.call(m, ...a);
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const errText = (e) => String(e && e.message || e).replace(/^Error invoking remote method 'kb-migration': (Error: )?/, '');
const show = (el, ok, text) => { el.className = 'msg ' + (ok ? 'ok' : 'err'); el.textContent = text; };
const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
const fmtBytes = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1024).toFixed(1) + ' KB';
function showTab(t) {
  for (const b of document.querySelectorAll('header button')) b.classList.toggle('on', b.dataset.tab === t);
  for (const s of document.querySelectorAll('section')) s.classList.toggle('on', s.id === t);
  if (t === 'repair') void loadRepair();
  if (t === 'backups') void loadBackups();
  document.body.dataset.tab = t;
}
window.__showTab = showTab;
for (const b of document.querySelectorAll('header button')) b.onclick = () => showTab(b.dataset.tab);

// ---- 导出
$('export-browse').onclick = async () => { const p = await call('pickSave'); if (p) $('export-path').value = p; };
$('export-run').onclick = () => busy($('export-run'), async () => {
  let p = $('export-path').value.trim();
  if (!p) { p = await call('pickSave'); if (!p) return; $('export-path').value = p; }
  try {
    const r = await call('exportTo', p);
    const c = r.manifest.contents;
    show($('export-result'), true, '已导出：' + r.file + '（' + fmtBytes(r.bytes) + '）\n' +
      c.workspaces + ' 个工作区（' + c.workspaceItems + ' 个面板）、' + c.favorites + ' 个收藏、' + r.manifest.roots.length + ' 个根目录、' +
      c.plugins.filter((x) => x.source === 'adapter').length + ' 个第三方插件、' + c.themePacks.length + ' 个主题包；快照完整性：' + r.manifest.snapshot.integrityCheck +
      (c.workspaceRefs ? '、' + c.workspaceRefs.refs + ' 条工作资料引用' : '') +
      (r.manifest.excluded.secretLikePluginKeys.length ? '\n未导出 ' + r.manifest.excluded.secretLikePluginKeys.length + ' 个看起来像密钥的插件存储项。' : '') +
      ((r.manifest.excluded.nonMigratablePluginKeys || []).length ? '\n未导出 ' + r.manifest.excluded.nonMigratablePluginKeys.length + ' 个插件声明为不可迁移的存储项。' : '') +
      '\n包里含路径和插件数据，请妥善保管。');
  } catch (e) { show($('export-result'), false, '导出失败：' + errText(e)); }
});

// ---- 导入
let pkg = null;
$('import-browse').onclick = async () => { const p = await call('pickPackage'); if (p) { $('import-path').value = p; await readPkg(); } };
$('import-read').onclick = () => readPkg();
$('import-base-browse').onclick = async () => { const p = await call('pickFolder', '资料所在的上级文件夹'); if (p) { $('import-base').value = p; await suggest(); } };
$('import-suggest').onclick = () => suggest();
async function readPkg() {
  $('import-result').textContent = '';
  const file = $('import-path').value.trim();
  if (!file) return;
  try {
    const r = await call('inspect', file, []);
    pkg = { file, manifest: r.manifest };
    const m = r.manifest, c = m.contents;
    $('import-summary').innerHTML = [
      ['导出时间', new Date(m.exportedAt).toLocaleString()],
      ['来源', (m.source.platform === 'win32' ? 'Windows' : m.source.platform) + ' · 应用 ' + m.app.version + ' · 格式 v' + m.formatVersion + ' · 数据库 v' + m.dbSchemaVersion],
      ['内容', c.workspaces + ' 个工作区（' + c.workspaceItems + ' 个面板）、' + c.favorites + ' 个收藏、' + c.resources + ' 条资源记录'],
      ['插件', c.plugins.filter((x) => x.source === 'adapter').map((x) => x.id + ' ' + x.version + (x.enabled ? '' : '（已停用）')).join('、') || '无第三方插件'],
      ['主题', (c.themePacks.join('、') || '无已安装主题包') + (c.appearance ? ' · 当前外观：外框 ' + c.appearance.chrome + '，阅读区 ' + c.appearance.reading + '，' + ({ light: '浅色', dark: '深色', system: '跟随系统' }[c.appearance.scheme] || c.appearance.scheme) : '')],
    ].map(([k, v]) => '<div>' + k + '</div><div>' + esc(v) + '</div>').join('');
    $('map-body').innerHTML = m.roots.map((root) => {
      const s = r.suggestions.find((x) => x.rootId === root.id);
      return '<tr data-testid="map-row" data-root-id="' + esc(root.id) + '" data-root-name="' + esc(root.name) + '">' +
        '<td>' + esc(root.name) + '<br><span class="note">' + root.fileCount + ' 个文件，' + root.referencedCount + ' 个被引用</span></td>' +
        '<td><code>' + esc(root.sourcePath) + '</code></td>' +
        '<td><div class="row"><input type="text" data-testid="map-path" value="' + esc(s && s.suggested || '') + '" placeholder="选择本机文件夹"><button class="b" data-testid="map-browse">浏览…</button></div></td>' +
        '<td><input type="checkbox" data-testid="map-skip"></td></tr>';
    }).join('');
    for (const tr of $('map-body').querySelectorAll('tr')) {
      tr.querySelector('[data-testid=map-browse]').onclick = async () => {
        const p = await call('pickFolder', '「' + tr.dataset.rootName + '」在本机的位置');
        if (p) tr.querySelector('[data-testid=map-path]').value = p;
      };
    }
    $('import-detail').style.display = '';
  } catch (e) { pkg = null; $('import-detail').style.display = 'none'; show($('import-result'), false, '无法读取迁移包：' + errText(e)); }
}
async function suggest() {
  if (!pkg || !$('import-base').value.trim()) return;
  const sug = await call('suggest', pkg.file, $('import-base').value.trim());
  for (const tr of $('map-body').querySelectorAll('tr')) {
    const s = sug.find((x) => x.rootId === tr.dataset.rootId);
    const inp = tr.querySelector('[data-testid=map-path]');
    if (s && s.suggested && s.reason === 'under-base') inp.value = s.suggested;
  }
}
$('import-run').onclick = () => busy($('import-run'), async () => {
  if (!pkg) return;
  const mappings = {};
  for (const tr of $('map-body').querySelectorAll('tr')) {
    const skip = tr.querySelector('[data-testid=map-skip]').checked;
    const v = tr.querySelector('[data-testid=map-path]').value.trim();
    mappings[tr.dataset.rootId] = skip || !v ? null : v;
  }
  show($('import-result'), true, '正在备份当前数据并导入…');
  try {
    const r = await call('importPackage', pkg.file, mappings);
    document.body.dataset.imported = '1';
    show($('import-result'), true, '导入完成。已映射 ' + r.mapped.length + ' 个根目录' + (r.unmapped.length ? '，未映射：' + r.unmapped.map((x) => x.name).join('、') : '') +
      '；被引用但找不到的文件：' + r.missing.referenced + ' 个' + (r.missing.referenced || r.unmapped.length ? '（见“根目录与缺失文件”）' : '') +
      '。\n导入前的数据已备份到：' + r.backup.dir);
  } catch (e) { show($('import-result'), false, errText(e)); }
});

// ---- 根目录与缺失文件
const ST = { ok: ['ok', '在线'], offline: ['warn', '离线'], unmapped: ['bad', '未映射'] };
async function loadRepair() {
  const roots = await call('roots');
  $('roots-body').innerHTML = roots.map((r) => '<tr data-testid="repair-root" data-root-id="' + esc(r.rootId) + '" data-status="' + r.status + '"><td>' + esc(r.name) + '</td>' +
    '<td><span class="badge ' + ST[r.status][0] + '">' + ST[r.status][1] + '</span>' + (r.missingReferenced ? ' <span class="badge bad">' + r.missingReferenced + ' 个缺失</span>' : '') + '</td>' +
    '<td><div class="row"><input type="text" data-testid="remap-path" value="' + esc(r.path || '') + '"><button class="b" data-testid="remap-browse">浏览…</button></div></td>' +
    '<td><button class="b" data-testid="remap-run">重新映射</button></td></tr>').join('');
  for (const tr of $('roots-body').querySelectorAll('tr')) {
    tr.querySelector('[data-testid=remap-browse]').onclick = async () => { const p = await call('pickFolder'); if (p) tr.querySelector('[data-testid=remap-path]').value = p; };
    tr.querySelector('[data-testid=remap-run]').onclick = () => busy(tr.querySelector('[data-testid=remap-run]'), async () => {
      try { await call('remapRoot', tr.dataset.rootId, tr.querySelector('[data-testid=remap-path]').value.trim()); show($('repair-result'), true, '已重新映射。未按同名路径自动配对；未配对的引用仍在缺失列表。'); await loadRepair(); }
      catch (e) { show($('repair-result'), false, '重新映射失败：' + errText(e)); }
    });
  }
  const miss = await call('listMissing');
  $('missing-body').innerHTML = miss.length ? miss.map((m) => '<tr data-testid="missing-row" data-resource-id="' + esc(m.resourceId) + '" data-rel-path="' + esc(m.relPath) + '">' +
    '<td><span class="badge bad">缺失</span> ' + esc(m.rootName) + ' / <code>' + esc(m.relPath) + '</code>' + (m.rootStatus !== 'ok' ? ' <span class="badge warn">根' + ST[m.rootStatus][1] + '</span>' : '') + '</td>' +
    '<td>' + [m.favorite ? '收藏' : '', ...m.workspaces.map((w) => '工作区「' + esc(w) + '」'), ...(m.collections || []).map((w) => '工作资料「' + esc(w) + '」')].filter(Boolean).join('、') + '</td>' +
    '<td><div class="row"><input type="text" data-testid="relocate-path" placeholder="新位置（须在已映射的根内）"><button class="b" data-testid="relocate-browse">浏览…</button></div></td>' +
    '<td><button class="b" data-testid="relocate-run"' + (m.kind !== 'file' ? ' disabled title="文件夹请重新映射根目录"' : '') + '>重新定位</button></td></tr>').join('')
    : '<tr><td colspan="4" class="note" data-testid="missing-none">没有缺失的文件。</td></tr>';
  for (const tr of $('missing-body').querySelectorAll('tr[data-resource-id]')) {
    tr.querySelector('[data-testid=relocate-browse]').onclick = async () => { const p = await call('pickFile', '重新定位：' + tr.dataset.relPath); if (p) tr.querySelector('[data-testid=relocate-path]').value = p; };
    tr.querySelector('[data-testid=relocate-run]').onclick = () => busy(tr.querySelector('[data-testid=relocate-run]'), async () => {
      try { const r = await call('relocate', tr.dataset.resourceId, tr.querySelector('[data-testid=relocate-path]').value.trim()); show($('repair-result'), true, '已重新定位到 ' + r.relPath + '（收藏与工作区引用不变）。'); await loadRepair(); }
      catch (e) { show($('repair-result'), false, '重新定位失败：' + errText(e)); }
    });
  }
  document.body.dataset.repairLoaded = String(Date.now());
}

// ---- 备份
async function loadBackups() {
  const list = await call('listBackups');
  $('backups-body').innerHTML = list.length ? list.map((b) => '<tr data-testid="backup-row"><td>' + esc(new Date(b.createdAt).toLocaleString()) + '</td><td>' + (b.reason === 'before-import' ? '导入前' : b.reason === 'manual' ? '手动' : esc(b.reason)) + '</td><td><code>' + esc(b.dir) + '</code></td>' +
    '<td><button class="b" data-testid="backup-restore" data-dir="' + esc(b.dir) + '">恢复到这份备份</button></td></tr>').join('') : '<tr><td colspan="4" class="note">还没有备份。</td></tr>';
  for (const btn of $('backups-body').querySelectorAll('[data-testid=backup-restore]')) btn.onclick = () => busy(btn, async () => {
    if (!confirm('恢复会替换当前的工作区、收藏、根目录映射与插件状态，确定？')) return;
    try { await call('restoreBackup', btn.dataset.dir); show($('backups-result'), true, '已恢复。'); }
    catch (e) { show($('backups-result'), false, '恢复失败：' + errText(e)); }
  });
}
$('backup-now').onclick = () => busy($('backup-now'), async () => {
  try { const b = await call('backupNow'); show($('backups-result'), true, '已备份到：' + b.dir); await loadBackups(); }
  catch (e) { show($('backups-result'), false, '备份失败：' + errText(e)); }
});
showTab('__TAB__');
</script>
</body></html>`;
