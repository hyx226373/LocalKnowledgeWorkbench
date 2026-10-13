/**
 * 文本 / Markdown 原位编辑（第 9 轮 C）。
 * - 保存全部走主进程服务层（api.workspace.textEdit → IPC → TextEditService → FileOpsBackend），渲染进程不写盘；
 * - Ctrl+S / “保存”直接保存（产品决定：不默认弹出改动预览；工具栏“查看改动”可随时预览，“保存前预览”可打开），
 *   每次保存写恢复记录（备份 + op_log），可“撤销上次保存”逐级回到上一版；agent 提出的修改计划一律先显示差异预览（planDialog）；
 * - 编码保持原样：UTF-8 / UTF-8 BOM / UTF-16 LE/BE / GBK(GB18030) 都按原编码写回，状态栏显示编码；
 * - 打开时记下内容哈希；保存时磁盘内容已变 → 冲突对话框：保留我的 / 采用外部的 / 对比后再决定，绝不静默覆盖；
 * - 同一文件在其他面板/外部被修改：没有未保存修改时自动刷新；有未保存修改时只提示，不冲掉；
 * - 未保存的修改随时存成草稿（插件存储），关闭标签、退出或崩溃后再打开会恢复。
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ToolbarColumns2Icon, ToolbarEyeIcon, ToolbarPencilIcon } from '../../ui/shellMarks';
import { KbToggle } from '../../settings/KbToggle';
import { loadZoomHudVisible, readZoomHudVisible, subscribeZoomHudVisible, writeZoomHudVisible } from '../../settings/zoomHudVisible';
import type { PluginApi } from '../../plugin-host/types';
import type { SaveOutcome, TextSnapshot } from '../../../shared/textEdit';
import type { DiffLine, TextDiff } from '../../../shared/textDiff';
import { diffLines } from '../../../shared/textDiff';
import { dialogs } from '../../ui/dialogs';
import { editorStatus, ENCODING_LABEL } from '../../editorStatus';

const DRAFT_KEY = (rid: string) => `draft:${rid}`;
const PREVIEW_PREF = 'editor.previewBeforeSave';
const errMsg = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'kb': (Error: )?/, '');

export function DiffView({ diff, testid = 'diff' }: { diff: TextDiff; testid?: string }) {
  if (diff.identical) return <div className="kb-diff-stats">没有改动</div>;
  const sign = (l: DiffLine) => (l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'gap' ? '' : ' ');
  return (
    <>
      <div className="kb-diff-stats" data-testid={`${testid}-stats`}>
        +{diff.added} 行 · −{diff.removed} 行{diff.approximate ? '（改动范围较大，按整段显示）' : ''}
      </div>
      <div className="kb-diff" data-testid={testid}>
        {diff.lines.map((l, i) => (
          <div className="kb-diff-line" data-kind={l.kind} key={i}>
            <span className="sign">{sign(l)}</span>
            <span className="t">{l.text || ' '}</span>
          </div>
        ))}
      </div>
    </>
  );
}

type ConflictChoice = 'mine' | 'theirs' | 'cancel';

/** 冲突对话框：保留我的 / 采用外部的 / 对比后再决定 */
async function askConflict(relPath: string, disk: TextSnapshot, mine: string): Promise<ConflictChoice> {
  const first = await dialogs.custom<ConflictChoice | 'compare'>({
    title: '文件已在别处被修改',
    testid: 'conflict-dialog',
    cancelValue: 'cancel',
    render: (done) => (
      <>
        <div className="kb-dialog-body">
          「{relPath}」在你打开之后被外部软件或其他面板修改过。为避免互相覆盖，请选择怎么处理（无论选哪个，被替换的内容都会先备份，可以撤销）。
        </div>
        <div className="kb-dialog-actions">
          <button className="kb-button kb-button--secondary" data-testid="conflict-cancel" onClick={() => done('cancel')}>
            继续编辑
          </button>
          <button className="kb-button kb-button--secondary" data-testid="conflict-compare" onClick={() => done('compare')}>
            对比后再决定
          </button>
          <button className="kb-button kb-button--secondary" data-testid="conflict-theirs" onClick={() => done('theirs')}>
            采用外部的
          </button>
          <button className="kb-button" data-testid="conflict-mine" onClick={() => done('mine')}>
            保留我的
          </button>
        </div>
      </>
    ),
  });
  if (first !== 'compare') return first;
  const d = diffLines(disk.text, mine);
  return dialogs.custom<ConflictChoice>({
    title: '对比：外部版本 → 我的版本',
    testid: 'conflict-compare-dialog',
    wide: true,
    cancelValue: 'cancel',
    render: (done) => (
      <>
        <div className="kb-dialog-body">
          <div className="kb-diff-stats">“−”是只在外部版本里的内容，“+”是只在你的版本里的内容。</div>
          <DiffView diff={d} testid="conflict-diff" />
        </div>
        <div className="kb-dialog-actions">
          <button className="kb-button kb-button--secondary" data-testid="conflict-cancel" onClick={() => done('cancel')}>
            继续编辑
          </button>
          <button className="kb-button kb-button--secondary" data-testid="conflict-theirs" onClick={() => done('theirs')}>
            采用外部的
          </button>
          <button className="kb-button" data-testid="conflict-mine" onClick={() => done('mine')}>
            保留我的
          </button>
        </div>
      </>
    ),
  });
}

export interface EditableDoc {
  snap: TextSnapshot | null;
  error: string | null;
  draft: string;
  setDraft: (s: string) => void;
  dirty: boolean;
  /** 磁盘内容在有未保存修改时变了（外部/其他面板） */
  external: TextSnapshot | null;
  /** 刚刚自动载入了外部修改（没有未保存修改时） */
  refreshedAt: number;
  restoredDraft: boolean;
  busy: boolean;
  save: () => Promise<void>;
  undoLastSave: () => Promise<void>;
  loadExternal: () => Promise<void>;
  compareExternal: () => Promise<void>;
  saveCount: number;
  getPreviewPref: () => Promise<boolean>;
  setPreviewPref: (v: boolean) => Promise<void>;
}

/** 一个面板里的一份可编辑文档 */
export function useEditableDoc(api: PluginApi, resourceId: string, notify: (s: string) => void): EditableDoc {
  const te = api.workspace.textEdit;
  const [snap, setSnap] = useState<TextSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraftState] = useState('');
  const [external, setExternal] = useState<TextSnapshot | null>(null);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveCount, setSaveCount] = useState(0);
  const snapRef = useRef<TextSnapshot | null>(null);
  const draftRef = useRef('');
  snapRef.current = snap;
  draftRef.current = draft;
  const dirty = !!snap && draft !== snap.text;
  const draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // 编码与未保存状态 → 状态栏 / 移除资料时的确认
  const statusKey = useRef(Symbol('doc'));
  useEffect(() => {
    if (snap) editorStatus.set(resourceId, statusKey.current, { encoding: snap.encoding, eol: snap.eol, dirty, editable: snap.editable });
  }, [resourceId, snap, dirty]);
  useEffect(() => {
    const k = statusKey.current;
    return () => editorStatus.remove(resourceId, k);
  }, [resourceId]);

  const persistDraft = useCallback(
    (text: string) => {
      clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        const s = snapRef.current;
        if (!s) return;
        const v = text === s.text ? null : { text, baseHash: s.hash, at: Date.now(), panel: String(statusKey.current) };
        void (async () => {
          if (v === null) {
            if (!editorStatus.isDirtyExcept(resourceId, statusKey.current)) {
              await api.storage.set(DRAFT_KEY(resourceId), null).catch(() => {});
            }
            return;
          }
          const prev = await api.storage.get<{ text: string; baseHash: string; at?: number; panel?: string }>(DRAFT_KEY(resourceId)).catch(() => null);
          // 若已有其他面板更新的不同草稿且更新，保留对方并只在本面板提示外部冲突（不静默盖掉）
          if (prev && prev.text && prev.text !== v.text && (prev.at ?? 0) > (v.at - 2000) && prev.panel && prev.panel !== v.panel) {
            return;
          }
          await api.storage.set(DRAFT_KEY(resourceId), v).catch(() => {});
        })();
      }, 500);
    },
    [api, resourceId],
  );
  const setDraft = useCallback(
    (t: string) => {
      // 同一次调用里接着 save() 时，渲染还没把 draft 写回 ref。
      draftRef.current = t;
      setDraftState(t);
      persistDraft(t);
    },
    [persistDraft],
  );
  const accept = useCallback(
    (s: TextSnapshot) => {
      setSnap(s);
      setDraftState(s.text);
      setExternal(null);
      clearTimeout(draftTimer.current);
      // E9：其他面板仍有未保存时，不得清空共享草稿键
      const clear = () => {
        if (editorStatus.isDirtyExcept(resourceId, statusKey.current)) return;
        void api.storage.set(DRAFT_KEY(resourceId), null).catch(() => {});
      };
      queueMicrotask(clear);
    },
    [api, resourceId],
  );

  // 打开：读快照 + 恢复草稿
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 快照与草稿一起取到后再一次性设置（否则第一帧正文为空，阅读位置会按空内容恢复）
        const [s, d] = await Promise.all([
          te ? te.open(resourceId) : Promise.reject(new Error('当前环境不支持编辑')),
          api.storage.get<{ text: string; baseHash: string }>(DRAFT_KEY(resourceId)).catch(() => null),
        ]);
        if (!alive) return;
        setError(null);
        if (d && typeof d.text === 'string' && d.text !== s.text && s.editable) {
          setDraftState(d.text);
          setRestoredDraft(true);
          // 草稿基于的版本已不是磁盘上的版本：按“外部已修改”处理（保存时走冲突流程）
          if (d.baseHash !== s.hash) {
            setExternal(s);
            setSnap({ ...s, hash: d.baseHash });
          } else setSnap(s);
        } else {
          setDraftState(s.text);
          setSnap(s);
        }
      } catch (e) {
        if (alive) setError(errMsg(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, te, resourceId]);

  // 卸载（关闭标签、切换工作区、视图重建）时立即写下未保存的草稿，不等防抖
  useEffect(
    () => () => {
      clearTimeout(draftTimer.current);
      const s0 = snapRef.current;
      if (s0 && draftRef.current !== s0.text) void api.storage.set(DRAFT_KEY(resourceId), { text: draftRef.current, baseHash: s0.hash, at: Date.now() }).catch(() => {});
    },
    [api, resourceId],
  );

  // 文件变化（外部软件 / 其他面板保存 / 撤销）
  useEffect(() => {
    const d = api.workspace.onDidChangeFile(resourceId, async () => {
      const cur = snapRef.current;
      if (!te || !cur) return;
      let s: TextSnapshot;
      try {
        s = await te.open(resourceId);
      } catch {
        return;
      }
      if (s.hash === cur.hash) return;
      if (draftRef.current === cur.text) {
        accept(s);
        setRefreshedAt(Date.now());
      } else setExternal(s);
    });
    return () => d.dispose();
  }, [api, te, resourceId, accept]);

  const handleOutcome = useCallback(
    async (r: SaveOutcome, text: string): Promise<void> => {
      if (r.status === 'saved') {
        accept(r.snapshot);
        setSaveCount((n) => n + 1);
        notify('已保存（原内容已备份，可点“撤销上次保存”恢复）');
        return;
      }
      if (r.status === 'unchanged') {
        accept(r.snapshot);
        notify('没有改动');
        return;
      }
      const choice = await askConflict(r.disk.relPath, r.disk, text);
      if (choice === 'cancel') {
        setExternal(r.disk);
        return;
      }
      if (choice === 'theirs') {
        accept(r.disk);
        notify('已采用外部版本（你的修改已放弃）');
        return;
      }
      // 保留我的：以刚看到的外部版本为基准再保存（外部版本先进备份库）；期间若又变了，再次进入冲突流程
      await handleOutcome(await te!.save(resourceId, text, r.disk.hash), text);
    },
    [accept, notify, te, resourceId],
  );

  const save = useCallback(async () => {
    const s = snapRef.current;
    if (!te || !s || busy) return;
    if (!s.editable) return void dialogs.alert({ title: '无法保存', body: s.readOnlyReason ?? '该文件不可编辑' });
    const text = draftRef.current;
    setBusy(true);
    try {
      const pref = await api.storage.get<boolean>(PREVIEW_PREF).catch(() => null);
      const pv = await te.previewSave(resourceId, text, s.hash);
      if (pv.conflict) return await handleOutcome({ status: 'conflict', disk: pv.disk, diff: pv.diff }, text);
      if (pv.diff.identical) return void notify('没有改动');
      // 产品决定：用户自己保存时默认不弹预览（保存后可撤销）；只有在工具栏打开“保存前预览”后才弹
      if (pref === true) {
        const ok = await dialogs.custom<'save' | 'cancel' | 'save-always'>({
          title: `保存「${pv.relPath}」？`,
          testid: 'save-preview-dialog',
          wide: true,
          cancelValue: 'cancel',
          render: (done) => (
            <>
              <div className="kb-dialog-body">
                <DiffView diff={pv.diff} testid="save-diff" />
                <div className="kb-diff-stats">保存前原内容会备份到应用备份库；可用“撤销上次保存”回到这一版。</div>
              </div>
              <div className="kb-dialog-actions">
                <button className="kb-button kb-button--secondary" data-testid="save-cancel" onClick={() => done('cancel')}>
                  取消
                </button>
                <button className="kb-button kb-button--secondary" data-testid="save-always" title="以后保存时不再弹出改动预览（工具栏“查看改动”仍可预览，可在工具栏重新打开“保存前预览”）" onClick={() => done('save-always')}>
                  保存，以后不再预览
                </button>
                <button className="kb-button" data-testid="save-confirm" onClick={() => done('save')}>
                  保存
                </button>
              </div>
            </>
          ),
        });
        if (ok === 'cancel') return;
        if (ok === 'save-always') void api.storage.set(PREVIEW_PREF, false);
      }
      await handleOutcome(await te.save(resourceId, text, s.hash), text);
    } catch (e) {
      await dialogs.alert({ title: '保存失败', body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [te, busy, api, resourceId, handleOutcome, notify]);

  const undoLastSave = useCallback(async () => {
    if (!te || busy) return;
    if (draftRef.current !== snapRef.current?.text && !(await dialogs.confirm({ title: '放弃未保存的修改？', body: '撤销上次保存会把文件恢复为上一版，并丢弃编辑器里还没保存的修改。', ok: '撤销上次保存', danger: true }))) return;
    setBusy(true);
    try {
      let r = await te.undoLastSave(resourceId);
      if (r.status === 'nothing') return void (await dialogs.alert({ title: '没有可撤销的保存', body: '这个文件在本应用里还没有保存记录。' }));
      if (r.status === 'conflict') {
        const ok = await dialogs.confirm({ title: '文件在那次保存之后又被修改过', body: '继续撤销会用上一版覆盖现在的内容。现在的内容会先存进备份库：撤销后可以在“操作记录”（视图 → 操作记录）里找到这次撤销，点“恢复撤销前的内容”找回。', ok: '仍然撤销' });
        if (!ok) return;
        r = await te.undoLastSave(resourceId, true);
      }
      if (r.status === 'unrecoverable') return void (await dialogs.alert({ title: '无法撤销', body: r.detail.join('；') }));
      if (r.status === 'undone') {
        accept(r.snapshot);
        notify('已撤销上次保存，恢复为上一版');
      }
    } catch (e) {
      await dialogs.alert({ title: '撤销失败', body: errMsg(e) });
    } finally {
      setBusy(false);
    }
  }, [te, busy, resourceId, accept, notify]);

  const loadExternal = useCallback(async () => {
    if (!te) return;
    if (draftRef.current !== snapRef.current?.text && !(await dialogs.confirm({ title: '载入外部版本？', body: '会丢弃编辑器里还没保存的修改。', ok: '载入并丢弃我的修改', danger: true }))) return;
    accept(await te.open(resourceId));
  }, [te, resourceId, accept]);

  const compareExternal = useCallback(async () => {
    if (!te) return;
    const disk = await te.open(resourceId);
    const choice = await askConflict(disk.relPath, disk, draftRef.current);
    if (choice === 'theirs') accept(disk);
    else if (choice === 'mine') {
      setBusy(true);
      try {
        await handleOutcome(await te.save(resourceId, draftRef.current, disk.hash), draftRef.current);
      } finally {
        setBusy(false);
      }
    }
  }, [te, resourceId, accept, handleOutcome]);

  const getPreviewPref = useCallback(async () => (await api.storage.get<boolean>(PREVIEW_PREF).catch(() => null)) === true, [api]);
  const setPreviewPref = useCallback(async (v: boolean) => void (await api.storage.set(PREVIEW_PREF, v).catch(() => {})), [api]);
  return { snap, error, draft, setDraft, dirty, external, refreshedAt, restoredDraft, busy, save, undoLastSave, loadExternal, compareExternal, saveCount, getPreviewPref, setPreviewPref };
}

/** 编辑工具栏 + 外部修改提示。对齐预览 DocBar：模式轻按钮＋选中底板＋路径弱化；低频进更多。 */
function modeIcon(id: string) {
  if (id === 'preview' || id === 'read') return <ToolbarEyeIcon />;
  if (id === 'edit') return <ToolbarPencilIcon />;
  if (id === 'split') return <ToolbarColumns2Icon />;
  return null;
}

export function EditorBar({
  doc,
  modes,
  mode,
  setMode,
  onPreviewChanges,
  crumb,
}: {
  doc: EditableDoc;
  modes: { id: string; label: string }[];
  mode: string;
  setMode: (m: string) => void;
  onPreviewChanges: () => void;
  crumb?: string;
}) {
  const editing = mode !== 'preview' && mode !== 'read';
  const s = doc.snap;
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const zoomOn = useSyncExternalStore(subscribeZoomHudVisible, readZoomHudVisible);
  const [zoomBusy, setZoomBusy] = useState(false);
  useEffect(() => {
    void loadZoomHudVisible();
  }, []);
  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [moreOpen]);
  return (
    <>
      <div className="kb-view-toolbar editor-toolbar" role="toolbar" aria-label="编辑">
        <div className="kb-doc-tools">
          <span className="kb-seg kb-doc-modes" role="group" aria-label="视图">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                className={mode === m.id ? 'kb-mode on' : 'kb-mode'}
                data-testid={`mode-${m.id}`}
                aria-pressed={mode === m.id ? 'true' : 'false'}
                onClick={() => setMode(m.id)}
              >
                {modeIcon(m.id)}
                {m.label}
              </button>
            ))}
          </span>
          {crumb ? (
            <span className="kb-doc-crumb" title={crumb} data-testid="doc-crumb">
              {crumb}
            </span>
          ) : (
            <span className="kb-doc-crumb" aria-hidden="true" />
          )}
          <span className="kb-doc-actions">
            {editing && (
              <>
                <button className="kb-button" data-testid="editor-save" disabled={!s?.editable || doc.busy} title="保存（Ctrl+S）：原内容备份后直接写入，可用“撤销上次保存”恢复" onClick={() => void doc.save()}>
                  保存
                </button>
                <button className="kb-button kb-button--secondary" data-testid="editor-diff" disabled={!doc.dirty} onClick={onPreviewChanges}>
                  查看改动
                </button>
              </>
            )}
            <button className="kb-button kb-button--secondary" data-testid="editor-undo-save" disabled={doc.busy} title="把文件恢复为上一次保存之前的版本（可逐级撤销）" onClick={() => void doc.undoLastSave()}>
              撤销上次保存
            </button>
            {s && (
              <span className="state mono" data-testid="editor-encoding" title="文件编码与换行；保存时保持不变">
                {ENCODING_LABEL[s.encoding]} · {s.eol === 'crlf' ? 'CRLF' : 'LF'}
              </span>
            )}
            <span className="state" data-testid="editor-state">
              {!s ? '' : !s.editable ? `只读：${s.readOnlyReason}` : doc.dirty ? '● 未保存' : '已保存'}
            </span>
            <div className="kb-doc-more" ref={moreRef}>
              <button
                type="button"
                className="kb-button kb-button--secondary"
                data-testid="editor-more"
                aria-expanded={moreOpen}
                aria-haspopup="menu"
                onClick={() => setMoreOpen((v) => !v)}
              >
                更多
              </button>
              {moreOpen ? (
                <div className="kb-doc-more-menu" role="menu" data-testid="editor-more-menu">
                  {editing ? <PreviewToggle doc={doc} /> : null}
                  <label title="隐藏后仍可用快捷键与滚轮缩放；再开即恢复浮条">
                    <span>显示内容缩放条</span>
                    <KbToggle
                      testId="editor-zoom-hud-toggle"
                      label="显示内容缩放条"
                      checked={zoomOn}
                      busy={zoomBusy}
                      disabled={zoomBusy}
                      onChange={(next) => {
                        if (zoomBusy) return;
                        setZoomBusy(true);
                        void writeZoomHudVisible(next).finally(() => setZoomBusy(false));
                      }}
                    />
                  </label>
                </div>
              ) : null}
            </div>
          </span>
        </div>
      </div>
      {doc.restoredDraft && doc.dirty && (
        <div className="kb-banner kb-editor-banner" data-testid="editor-draft-restored" data-tone="info">
          已恢复上次未保存的修改。
        </div>
      )}
      {doc.external && (
        <div className="kb-banner kb-editor-banner" data-testid="editor-external-change" data-tone="warning" role="status">
          这个文件已在别处被修改（外部软件或其他面板）。你的未保存修改仍然保留，不会被冲掉。
          <button className="kb-button kb-button--secondary" data-testid="external-compare" onClick={() => void doc.compareExternal()}>
            对比后再决定
          </button>
          <button className="kb-button kb-button--secondary" data-testid="external-load" onClick={() => void doc.loadExternal()}>
            载入外部版本
          </button>
        </div>
      )}
    </>
  );
}

/** “保存前预览”开关（存插件存储 editor.previewBeforeSave；缺省关） */
function PreviewToggle({ doc }: { doc: EditableDoc }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    void doc.getPreviewPref().then((v) => alive && setOn(v));
    return () => {
      alive = false;
    };
  }, [doc]);
  return (
    <label className="kb-check" title="打开后，每次保存前先显示改动预览" data-testid="editor-preview-toggle">
      <input type="checkbox" checked={on === true} onChange={(e) => (setOn(e.target.checked), void doc.setPreviewPref(e.target.checked))} />
      保存前预览
    </label>
  );
}

export function EditorTextarea({ doc, testid = 'editor-text' }: { doc: EditableDoc; testid?: string }) {
  return (
    <textarea
      className="kb-editor-text"
      data-testid={testid}
      spellCheck={false}
      readOnly={!doc.snap?.editable}
      value={doc.draft}
      onChange={(e) => doc.setDraft(e.target.value)}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          e.stopPropagation();
          void doc.save();
        }
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey) {
          // Tab 插入制表符（Shift+Tab 仍可离开编辑框）
          e.preventDefault();
          const t = e.currentTarget;
          const a = t.selectionStart;
          const b = t.selectionEnd;
          const v = t.value.slice(0, a) + '\t' + t.value.slice(b);
          doc.setDraft(v);
          requestAnimationFrame(() => t.setSelectionRange(a + 1, a + 1));
        }
      }}
    />
  );
}

export async function showPendingChanges(doc: EditableDoc) {
  if (!doc.snap) return;
  const d = diffLines(doc.snap.text, doc.draft);
  await dialogs.custom<void>({
    title: '未保存的改动',
    testid: 'pending-diff-dialog',
    wide: true,
    cancelValue: undefined,
    render: (done) => (
      <>
        <div className="kb-dialog-body">
          <DiffView diff={d} testid="pending-diff" />
        </div>
        <div className="kb-dialog-actions">
          <button className="kb-button" onClick={() => done()}>
            关闭
          </button>
        </div>
      </>
    ),
  });
}
