/**
 * 统一快捷键设置页（B2）：搜索 / 录制 / 清除 / 恢复默认；冲突提示；when 编辑；
 * 备份导入导出；保留键；插件未安装；系统级呼出独立子分组（本轮不启用）。
 */
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { commands } from '../plugin-host/registry';
import { dialogs } from '../ui/dialogs';
import { bindingFromEvent, bindingFromWheel, formatKeybinding } from './normalize';
import { suspendContentZoomWheel } from '../zoom/wheelTrigger';
import { isReservedKey, RESERVED_KEYS } from './reserved';
import {
  effectiveOf,
  findConflict,
} from './store';
import {
  exportUserKeybindings,
  getFocusCommandId,
  getKeybindingsStore,
  importUserKeybindings,
  resetAllUserKeybindings,
  resetUserKeybinding,
  setFocusCommandId,
  setUserKeybinding,
  subscribeKeybindings,
} from './runtime';
import { WHEN_LABELS, WHEN_OPTIONS, type KeybindingWhen } from './types';
import { SUMMON_RULES_DOC } from './summon';

export function KeybindingsPage({ onClose, embedded = false }: { onClose: () => void; embedded?: boolean }) {
  const store = useSyncExternalStore(subscribeKeybindings, getKeybindingsStore);
  const cmdVersion = useSyncExternalStore(
    (cb) => commands.subscribe(cb),
    () => commands.getVersion(),
  );
  const allCmds = useMemo(() => commands.all(), [cmdVersion, store]);
  const focusId = useSyncExternalStore(subscribeKeybindings, getFocusCommandId);
  const [q, setQ] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [recHint, setRecHint] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!focusId || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-command-id="${CSS.escape(focusId)}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      (el as HTMLElement).setAttribute('data-focus-row', '1');
    }
  }, [focusId, allCmds, q]);

  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const infos = allCmds.map((c) => {
      const e = effectiveOf(c, store);
      return { cmd: c, eff: e };
    });
    // orphan overrides（插件未安装）
    for (const id of Object.keys(store.overrides)) {
      if (allCmds.some((c) => c.id === id)) continue;
      infos.push({
        cmd: {
          id,
          title: id,
          category: '插件',
          run: () => undefined,
          owner: 'missing',
        } as (typeof allCmds)[0] & { missing?: boolean },
        eff: effectiveOf({ id, title: id }, store),
      });
      (infos[infos.length - 1]!.cmd as { missingPlugin?: boolean }).missingPlugin = true;
    }
    return infos
      .filter(({ cmd, eff }) => {
        if (!qq) return true;
        const hay = `${cmd.title} ${cmd.category ?? ''} ${cmd.id} ${eff.key ?? ''} ${cmd.keybinding ?? ''}`.toLowerCase();
        return hay.includes(qq);
      })
      .sort((a, b) => (a.cmd.category ?? '').localeCompare(b.cmd.category ?? '', 'zh') || a.cmd.title.localeCompare(b.cmd.title, 'zh'));
  }, [allCmds, store, q]);

  useEffect(() => {
    if (!recording) return;
    const cmd = allCmds.find((c) => c.id === recording);
    const when = effectiveOf(cmd ?? { id: recording, title: '' }, store).when;
    const apply = async (b: string) => {
      const reserved = isReservedKey(b);
      if (reserved) {
        setRecHint(`保留键「${reserved.key}」不可改绑：${reserved.reason}`);
        return;
      }
      const other = findConflict(store, allCmds, recording, b, when);
      if (other) {
        const ok = await dialogs.confirm({
          title: '快捷键冲突',
          body: `「${b}」已被「${other.title}」使用。要替换吗？原命令将清除快捷键。`,
          ok: '替换',
          cancel: '取消',
        });
        if (!ok) {
          setRecHint('已取消');
          return;
        }
        const r = await setUserKeybinding(recording, b, { replace: true, when });
        if (!r.ok) setRecHint(r.reason === 'reserved' ? '保留键' : '无法绑定');
        else {
          setRecording(null);
          setRecHint('');
        }
        return;
      }
      const r = await setUserKeybinding(recording, b, { when });
      if (!r.ok) {
        if (r.reason === 'reserved') setRecHint(`保留键：${r.reserved.reason}`);
        else if (r.reason === 'conflict') setRecHint(`已被「${r.otherTitle}」使用`);
        else setRecHint('无效快捷键');
        return;
      }
      setRecording(null);
      setRecHint('');
    };
    if (cmd?.trigger === 'wheel') {
      setRecHint('滚动滚轮…（需要 Ctrl、Alt 或 Meta）');
      const release = suspendContentZoomWheel();
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const b = bindingFromWheel(e);
        if (!b) {
          setRecHint('滚轮必须带 Ctrl、Alt 或 Meta，不能只有 Shift');
          return;
        }
        void apply(b);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        setRecording(null);
        setRecHint('');
      };
      window.addEventListener('wheel', onWheel, { capture: true, passive: false });
      window.addEventListener('keydown', onKey, true);
      return () => {
        release();
        window.removeEventListener('wheel', onWheel, { capture: true });
        window.removeEventListener('keydown', onKey, true);
      };
    }
    const onKey = async (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(null);
        setRecHint('');
        return;
      }
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey && !e.metaKey) {
        await setUserKeybinding(recording, null);
        setRecording(null);
        setRecHint('已清除');
        return;
      }
      const b = bindingFromEvent(e);
      if (!b) {
        setRecHint('请按下组合键…');
        return;
      }
      await apply(b);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, allCmds, store]);

  const onWhenChange = async (id: string, when: KeybindingWhen) => {
    const e = effectiveOf(allCmds.find((c) => c.id === id) ?? { id, title: '' }, store);
    await setUserKeybinding(id, e.key, { when, replace: true });
  };

  const backup = async () => {
    const text = exportUserKeybindings();
    try {
      await navigator.clipboard.writeText(text);
      await dialogs.alert({ title: '备份快捷键', body: '已复制 JSON 到剪贴板。也可在下方「导出」保存。\n\n格式与设置导入相同；完整应用备份（迁移包）亦含 layout KV 中的 settings.keybindings。' });
    } catch {
      await dialogs.alert({ title: '备份快捷键', body: text });
    }
  };

  const restoreBackup = async () => {
    const r = await dialogs.prompt({
      title: '从备份恢复快捷键',
      body: '粘贴此前导出的 JSON（{ "v":1, "overrides":{...} }）',
      fields: [{ name: 'json', label: 'JSON', value: '' }],
      ok: '恢复',
    });
    if (!r?.json) return;
    try {
      await importUserKeybindings(r.json);
      await dialogs.alert({ title: '已恢复', body: '快捷键覆盖已从备份写入，立即生效。' });
    } catch (e) {
      await dialogs.alert({ title: '恢复失败', body: String((e as Error).message ?? e) });
    }
  };

  return (
    <div className={embedded ? 'kb-settings-embed' : 'kb-dialog-backdrop'} data-testid="keybindings-page" onMouseDown={embedded ? undefined : onClose}>
      <div
        className={embedded ? 'kb-keybindings' : 'kb-dialog kb-dialog--wide kb-keybindings'}
        role={embedded ? 'region' : 'dialog'}
        aria-modal={embedded ? undefined : true}
        aria-label="自定义快捷键"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="kb-dialog-title">自定义快捷键</div>
        <div className="kb-dialog-body kb-keybindings-body">
          <div className="kb-keybindings-toolbar">
            <input
              ref={searchRef}
              className="kb-input"
              data-testid="keybindings-search"
              placeholder="搜索名称 / 分类 / 快捷键…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <button type="button" className="kb-button kb-button--secondary kb-button--small" data-testid="keybindings-reset-all" onClick={() => void resetAllUserKeybindings()}>
              全部恢复默认
            </button>
            <button type="button" className="kb-button kb-button--secondary kb-button--small" data-testid="keybindings-backup" onClick={() => void backup()}>
              备份快捷键
            </button>
            <button type="button" className="kb-button kb-button--secondary kb-button--small" data-testid="keybindings-restore-backup" onClick={() => void restoreBackup()}>
              从备份恢复
            </button>
          </div>
          {recording && (
            <div className="kb-keybindings-recording" data-testid="keybindings-recording" role="status">
              正在为「{allCmds.find((c) => c.id === recording)?.title ?? recording}」录制… 按组合键；Backspace 清除；Esc 取消
              {recHint ? <span className="kb-keybindings-hint"> — {recHint}</span> : null}
            </div>
          )}
          <div className="kb-keybindings-list" ref={listRef} data-testid="keybindings-list">
            {rows.map(({ cmd, eff }) => {
              const missing = !!(cmd as { missingPlugin?: boolean }).missingPlugin;
              const reservedDefault = cmd.keybinding ? isReservedKey(cmd.keybinding) : null;
              return (
                <div
                  key={cmd.id}
                  className="kb-keybindings-row"
                  data-testid="keybindings-row"
                  data-command-id={cmd.id}
                  data-focus-row={focusId === cmd.id ? '1' : undefined}
                  onClick={() => setFocusCommandId(cmd.id)}
                >
                  <div className="kb-keybindings-meta">
                    <span className="kb-keybindings-title">
                      {cmd.title}
                      {missing ? <span className="kb-badge" data-testid="keybindings-missing-plugin">（插件未安装）</span> : null}
                    </span>
                    <span className="kb-keybindings-cat faint">{cmd.category ?? '未分类'} · {cmd.id}</span>
                  </div>
                  <label className="kb-keybindings-when" title="作用范围">
                    <span className="faint">范围</span>
                    <select
                      data-testid="keybindings-when"
                      value={eff.when}
                      onChange={(e) => void onWhenChange(cmd.id, e.target.value as KeybindingWhen)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {WHEN_OPTIONS.map((w) => (
                        <option key={w} value={w}>
                          {WHEN_LABELS[w]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="kb-button kb-button--secondary kb-button--small kb-keybindings-accel"
                    data-testid="keybindings-record"
                    data-recording={recording === cmd.id ? '1' : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRecHint('');
                      setRecording(cmd.id);
                    }}
                    title={cmd.trigger === 'wheel' ? '点击后滚动滚轮；Esc 取消' : '点击后按下新快捷键；Backspace 清除'}
                  >
                    {eff.key ? formatKeybinding(eff.key) : eff.isCleared ? '（已清除）' : '未设置'}
                  </button>
                  {!eff.isDefault && (
                    <button
                      type="button"
                      className="kb-button kb-button--ghost kb-button--small"
                      data-testid="keybindings-reset-one"
                      onClick={(e) => {
                        e.stopPropagation();
                        void resetUserKeybinding(cmd.id);
                      }}
                    >
                      恢复默认
                    </button>
                  )}
                  {reservedDefault && (
                    <span className="kb-badge" title={reservedDefault.reason} data-testid="keybindings-reserved-note">
                      默认曾为保留键
                    </span>
                  )}
                  {missing && (
                    <button
                      type="button"
                      className="kb-button kb-button--ghost kb-button--small"
                      data-testid="keybindings-cleanup-orphan"
                      onClick={(e) => {
                        e.stopPropagation();
                        void resetUserKeybinding(cmd.id);
                      }}
                    >
                      清理
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <details className="kb-keybindings-section" data-testid="keybindings-reserved-section">
            <summary>保留键（不可改绑）</summary>
            <ul>
              {RESERVED_KEYS.map((r) => (
                <li key={r.key}>
                  <kbd className="kbd">{r.key}</kbd> — {r.reason} <span className="kb-badge">保留</span>
                </li>
              ))}
            </ul>
          </details>

          <details className="kb-keybindings-section" data-testid="keybindings-system-section">
            <summary>系统级呼出（未启用）</summary>
            <p>
              本轮<strong>不注册</strong> Electron <code>globalShortcut</code>（应用未聚焦时的系统级加速键）。避免与应用内快捷键混列误导。
              若未来启用须另轮裁定；风险包括：与其它应用抢键、无焦点时误触、权限与安全审查。
            </p>
          </details>

          <details className="kb-keybindings-section" data-testid="keybindings-summon-section">
            <summary>呼出规则</summary>
            <pre className="kb-keybindings-doc">{SUMMON_RULES_DOC}</pre>
          </details>
        </div>
        {!embedded && (
          <div className="kb-dialog-actions">
            <button type="button" className="kb-button" data-testid="keybindings-close" onClick={onClose}>
              关闭
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
