/**
 * 全局 Agent 库窗口（单页 HTML）。只通过 window.kbp.call 调主进程。
 * 按来源是本批；按标签先显示空状态。
 */
export const PICKER_HTML = String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>全局 Agent 库</title>
<style>
  :root { color-scheme: light; --bg:#e9eef5; --panel:#fff; --line:#e3e8ef; --fg:#1e2936; --mute:#6b7785; --acc:#2f6bff; --acc-soft:#e8f0ff; --orange:#e8892f; --orange-bg:#fff4e8; --shadow:0 8px 28px #1e293614; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; font: 13px/1.45 "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif; background:var(--bg); color:var(--fg); display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:8px; padding:12px 16px 0; }
  .logo { width:22px; height:22px; border:1px solid #d5dbe3; border-radius:6px; display:grid; place-items:center; color:#5c6b7c; font-size:12px; background:#fff; }
  h1 { margin:0; font-size:15px; font-weight:650; flex:1; }
  header button.x { border:0; background:transparent; font-size:18px; line-height:1; cursor:pointer; color:#607086; padding:4px 8px; }
  .search { padding:10px 16px 0; }
  .search input { width:100%; border:1px solid var(--line); border-radius:8px; padding:8px 12px; font:inherit; background:#fff; }
  .body { flex:1; min-height:0; display:grid; grid-template-columns: 210px 1fr 280px; gap:10px; padding:10px 16px; }
  aside, .mid { background:var(--panel); border:1px solid var(--line); border-radius:12px; min-height:0; display:flex; flex-direction:column; }
  .tabs { display:flex; gap:4px; padding:10px; }
  .tabs button { flex:1; border:1px solid var(--line); background:#f4f6f9; border-radius:8px; padding:6px 0; cursor:pointer; font:inherit; color:var(--mute); }
  .tabs button.on { background:#fff; color:var(--fg); border-color:#cfd6e0; box-shadow:0 1px 2px #0001; }
  #source-list, #grid, #preview-scroll { overflow:auto; }
  .src { display:flex; align-items:center; gap:6px; width:100%; text-align:left; border:0; background:transparent; padding:7px 12px; cursor:pointer; font:inherit; color:var(--fg); }
  .src.on { background:var(--acc-soft); color:var(--acc); }
  .src .n { margin-left:auto; color:var(--mute); }
  .src.on .n { color:var(--acc); }
  #tag-empty { padding:18px 14px; color:var(--mute); }
  .mid-head { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line); }
  #mid-title { font-weight:650; }
  #mid-selected { margin-left:auto; color:var(--acc); }
  #grid { padding:12px; display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; align-content:start; }
  .card { position:relative; border:1px solid var(--line); border-radius:12px; background:#fff; min-height:124px; padding:28px 8px 10px; cursor:pointer; }
  .card.on { border-color:#b9d0ff; background:#f5f8ff; }
  .card.preview { outline:2px solid var(--acc); }
  .card.missing { opacity:.55; }
  .card input { position:absolute; left:8px; top:8px; }
  .badge { position:absolute; right:8px; top:8px; font-size:11px; padding:1px 6px; border-radius:999px; background:#eef1f5; color:#607086; }
  .badge.out { background:var(--orange-bg); color:var(--orange); }
  .badge.pv { background:var(--acc-soft); color:var(--acc); }
  .doc { width:28px; height:34px; margin:8px auto 8px; border:1.5px solid #b7c3d4; border-radius:4px; position:relative; }
  .doc:before { content:""; position:absolute; right:0; top:0; border-top:8px solid #d5deea; border-left:8px solid transparent; }
  .name { text-align:center; font-size:12px; word-break:break-all; }
  #preview { padding:0; }
  #preview-scroll { padding:12px 14px 16px; }
  .pv-top { display:flex; align-items:flex-start; gap:8px; }
  #pv-name { font-weight:700; flex:1; word-break:break-all; }
  .ro { font-size:11px; color:var(--mute); border:1px solid var(--line); border-radius:999px; padding:1px 6px; }
  #pv-meta { color:var(--mute); font-size:12px; margin:6px 0 10px; }
  pre { margin:0; white-space:pre-wrap; word-break:break-word; font:12.5px/1.55 ui-monospace, Consolas, monospace; }
  #preview-empty, .empty { color:var(--mute); padding:16px; }
  footer { display:flex; align-items:center; gap:12px; padding:8px 16px 12px; }
  .notes { color:var(--mute); font-size:12px; flex:1; }
  #remove-note { color:#9a6a32; }
  .actions { display:flex; gap:8px; }
  button.b { border:1px solid #d5dbe3; background:#fff; border-radius:8px; padding:7px 14px; cursor:pointer; font:inherit; }
  button.b.primary { background:var(--acc); border-color:var(--acc); color:#fff; }
  button.b:disabled { opacity:.5; cursor:default; }
  #err { color:#b42318; padding:0 16px 8px; min-height:0; }
</style></head>
<body>
  <header><span class="logo">库</span><h1>全局 Agent 库</h1><button class="x" id="close" type="button" aria-label="关闭">×</button></header>
  <div class="search"><input id="q" type="search" placeholder="搜索文件名..." aria-label="搜索文件名"></div>
  <div class="body">
    <aside>
      <div class="tabs" role="tablist">
        <button type="button" id="tab-source" class="on" role="tab">按来源</button>
        <button type="button" id="tab-tags" role="tab">按标签</button>
      </div>
      <div id="source-list"></div>
      <div id="tag-empty" hidden>还没有文件标签。</div>
    </aside>
    <section class="mid">
      <div class="mid-head"><div id="mid-title"></div><div id="mid-selected"></div></div>
      <div id="grid"></div>
    </section>
    <aside id="preview">
      <div id="preview-empty">单击文件查看只读 Markdown</div>
      <div id="preview-scroll" hidden>
        <div class="pv-top"><div id="pv-name"></div><span class="ro">只读 md</span></div>
        <div id="pv-meta"></div>
        <pre id="pv-text"></pre>
      </div>
    </aside>
  </div>
  <footer>
    <div class="notes">
      <div id="sync-note">确认后同步到当前仓库（引用模式，文件仍在全局库）</div>
      <div id="remove-note" hidden>移出只是不再在本仓库显示，文件仍在全局库</div>
    </div>
    <div class="actions">
      <button type="button" class="b" id="cancel">取消</button>
      <button type="button" class="b primary" id="ok">确认（加入 0 · 移出 0）</button>
    </div>
  </footer>
  <div id="err" role="alert"></div>
<script>
(function () {
  var snap = null;
  var tab = 'source';
  var groupKey = 'all';
  var checked = {};
  var original = {};
  var missing = {};
  var previewId = '';
  var q = '';
  function call(method) {
    var rest = Array.prototype.slice.call(arguments, 1);
    return window.kbp.call.apply(window.kbp, [method].concat(rest));
  }
  function $(id) { return document.getElementById(id); }
  function text(node, value) { node.textContent = value == null ? '' : String(value); }
  function counts() {
    var added = 0, removed = 0, selected = 0;
    (snap ? snap.files : []).forEach(function (file) {
      if (missing[file.id]) return;
      var on = !!checked[file.id];
      if (on) selected += 1;
      var was = !!original[file.id];
      if (on && !was) added += 1;
      if (!on && was) removed += 1;
    });
    return { added: added, removed: removed, selected: selected };
  }
  function visibleFiles() {
    if (!snap || tab !== 'source') return [];
    var group = (snap.groups || []).filter(function (item) { return item.key === groupKey; })[0] || snap.groups[0];
    var allow = {};
    ((group && group.ids) || []).forEach(function (id) { allow[id] = true; });
    var query = q.trim().toLowerCase();
    return snap.files.filter(function (file) {
      if (!allow[file.id]) return false;
      if (!query) return true;
      var name = (file.fileName || file.title || '').toLowerCase();
      return name.indexOf(query) >= 0;
    });
  }
  function renderSide() {
    var list = $('source-list');
    list.hidden = tab !== 'source';
    $('tag-empty').hidden = tab !== 'tags';
    $('tab-source').className = tab === 'source' ? 'on' : '';
    $('tab-tags').className = tab === 'tags' ? 'on' : '';
    list.textContent = '';
    if (tab !== 'source' || !snap) return;
    (snap.groups || []).forEach(function (group) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'src' + (group.key === groupKey ? ' on' : '');
      var label = document.createElement('span');
      text(label, (group.key === groupKey ? '▾ ' : '▸ ') + group.label);
      var n = document.createElement('span');
      n.className = 'n';
      text(n, String((group.ids || []).length));
      btn.appendChild(label);
      btn.appendChild(n);
      btn.addEventListener('click', function () { groupKey = group.key; previewId = ''; render(); });
      list.appendChild(btn);
    });
  }
  function renderGrid() {
    var grid = $('grid');
    var head = $('mid-title');
    grid.textContent = '';
    if (tab === 'tags') {
      text(head, '按标签');
      text($('mid-selected'), '');
      var empty = document.createElement('div');
      empty.className = 'empty';
      text(empty, '还没有文件标签。');
      grid.appendChild(empty);
      return;
    }
    var group = (snap.groups || []).filter(function (item) { return item.key === groupKey; })[0];
    var files = visibleFiles();
    var total = group && group.ids ? group.ids.length : files.length;
    text(head, '当前来源：' + (group ? group.label : '全部') + '（共 ' + total + ' 个 Agent 文件）');
    var selectedHere = files.filter(function (file) { return checked[file.id] && !missing[file.id]; }).length;
    text($('mid-selected'), '已选 ' + selectedHere + ' 项');
    if (!files.length) {
      var none = document.createElement('div');
      none.className = 'empty';
      text(none, '这个来源下没有匹配的 Agent 文件。');
      grid.appendChild(none);
      return;
    }
    files.forEach(function (file) {
      var card = document.createElement('div');
      var on = !!checked[file.id];
      var was = !!original[file.id];
      card.className = 'card' + (on ? ' on' : '') + (previewId === file.id ? ' preview' : '') + (file.missing ? ' missing' : '');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = on;
      box.disabled = !!file.missing;
      box.setAttribute('aria-label', file.fileName || file.title || file.id);
      box.addEventListener('click', function (event) { event.stopPropagation(); });
      box.addEventListener('change', function () {
        if (file.missing) return;
        checked[file.id] = box.checked;
        render();
      });
      card.appendChild(box);
      if (previewId === file.id) badge(card, '预览中', 'pv');
      else if (was && !on) badge(card, '将移出', 'out');
      else if (was && on) badge(card, '已在本仓库', '');
      var doc = document.createElement('div');
      doc.className = 'doc';
      var name = document.createElement('div');
      name.className = 'name';
      text(name, file.fileName || file.title || file.id);
      card.appendChild(doc);
      card.appendChild(name);
      card.addEventListener('click', function () { previewId = file.id; render(); loadPreview(file.id); });
      grid.appendChild(card);
    });
  }
  function badge(card, label, kind) {
    var el = document.createElement('span');
    el.className = 'badge' + (kind ? ' ' + kind : '');
    text(el, label);
    card.appendChild(el);
  }
  function renderPreview() {
    var show = tab === 'source' && previewId;
    $('preview-empty').hidden = !!show;
    $('preview-scroll').hidden = !show;
  }
  function renderFooter() {
    var n = counts();
    $('remove-note').hidden = n.removed <= 0;
    $('ok').disabled = !snap || !snap.targetId || (n.added === 0 && n.removed === 0);
    text($('ok'), '确认（加入 ' + n.added + ' · 移出 ' + n.removed + '）');
    var note = '确认后同步到当前仓库（引用模式，文件仍在全局库）';
    if (snap && snap.targetName) note = '落到「' + snap.targetName + '」。' + note;
    text($('sync-note'), note);
  }
  function render() { renderSide(); renderGrid(); renderPreview(); renderFooter(); }
  function kb(n) {
    var v = Number(n) || 0;
    if (v < 1024) return v + ' B';
    return (v / 1024).toFixed(v >= 10240 ? 0 : 1) + ' KB';
  }
  function ymd(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function originLabel(origin) {
    if (!origin) return '升级前未记来源';
    var found = (snap.workspaces || []).filter(function (ws) { return ws.id === origin; })[0];
    return found ? found.name : origin;
  }
  function loadPreview(id) {
    call('preview', id).then(function (doc) {
      if (previewId !== id) return;
      text($('pv-name'), doc.fileName || doc.title || id);
      text($('pv-meta'), '来源：' + originLabel(doc.origin) + ' · ' + kb(doc.bytes) + (doc.mtimeMs ? ' · ' + ymd(doc.mtimeMs) : ''));
      text($('pv-text'), doc.text || '');
      renderPreview();
    }).catch(function (err) { text($('err'), String(err && err.message || err)); });
  }
  function boot(data) {
    snap = data;
    checked = {};
    original = {};
    missing = {};
    (data.files || []).forEach(function (file) {
      var inside = (file.members || []).indexOf(data.targetId) >= 0;
      if (inside) { original[file.id] = true; checked[file.id] = true; }
      if (file.missing) missing[file.id] = true;
    });
    render();
  }
  $('q').addEventListener('input', function () { q = $('q').value || ''; render(); });
  $('tab-source').addEventListener('click', function () { tab = 'source'; render(); });
  $('tab-tags').addEventListener('click', function () { tab = 'tags'; render(); });
  $('close').addEventListener('click', function () { window.close(); });
  $('cancel').addEventListener('click', function () { window.close(); });
  $('ok').addEventListener('click', function () {
    var ids = Object.keys(checked).filter(function (id) { return checked[id]; });
    $('ok').disabled = true;
    text($('err'), '');
    call('apply', ids).then(function () { window.close(); }).catch(function (err) {
      text($('err'), String(err && err.message || err));
      renderFooter();
    });
  });
  call('snapshot').then(boot).catch(function (err) { text($('err'), String(err && err.message || err)); });
})();
</script>
</body></html>`;
