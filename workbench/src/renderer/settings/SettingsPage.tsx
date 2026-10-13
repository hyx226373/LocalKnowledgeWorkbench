/**
 * 统一设置页。左侧分类，右侧复用已有页面。不依赖数据进程就能打开。
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { LoadingLabel } from '../ui/LoadingLabel';
import { PluginManager } from '../ui/PluginManager';
import { KeybindingsPage } from '../keybindings';
import { UpdateBody } from '../update/UpdatePage';
import { WebSiteGrantsBody } from '../web-site/grantsDialog';
import { WorkspacePickerSettings } from '../workspace-picker/WorkspacePickerSettings';
import { backgroundLoader } from '../lazyLoad';
import type { Appearance } from '../theme/appearance';
import type { IndexStatus, Root } from '../../shared/types';
import type { WorkspacePickerSettings as PickerSettings } from '../../shared/workspacePicker/types';
import type { QuickSwitchConflictReport } from '../workspace-picker/quickSwitchKey';
import type { AdapterPluginDto } from '../../shared/pluginIpc';
import { BrandMark } from '../theme/BrandMark';
import { AppearanceFields } from './AppearanceFields';
import { KbToggle } from './KbToggle';
import './settings-frame.css';
import { loadReaderBackToToc, readReaderBackToToc, subscribeReaderBackToToc, writeReaderBackToToc } from './readerBackToc';
import { loadZoomHudVisible, readZoomHudVisible, subscribeZoomHudVisible, writeZoomHudVisible } from './zoomHudVisible';
import { RESTORE_BAR_VISIBLE_KEY, readRestoreBarVisible, setRestoreBarVisible, subscribeRestoreBarVisible } from './restoreBarVisible';
import { SETTINGS_CATEGORIES, categoryNeedsData, type SettingsCategoryId } from './categories';
import { DEFAULT_UI_CHROME_PREFS, loadUiChromePrefs, saveUiChromePrefs, withUiChromePrefs, type UiChromePrefs } from './uiChromePrefs';

export function SettingsPage({
  category,
  onCategory,
  onClose,
  dataReady,
  appearance,
  onAppearance,
  onInstallTheme,
  showIgnored,
  onShowIgnored,
  indexStatus,
  roots,
  pickerSettings,
  workspaces,
  conflict,
  onPickerChange,
  onReconfigure,
  onUninstall,
  onUiChromeSaved,
  variant = 'dialog',
}: {
  category: SettingsCategoryId;
  onCategory(id: SettingsCategoryId): void;
  onClose(): void;
  dataReady: boolean;
  appearance: Appearance;
  onAppearance(next: Appearance): void;
  onInstallTheme(): void;
  showIgnored: boolean;
  onShowIgnored(on: boolean): void;
  indexStatus: IndexStatus[];
  roots: Root[];
  pickerSettings: PickerSettings;
  workspaces: readonly { id: string; name: string }[];
  conflict?: QuickSwitchConflictReport | null;
  onPickerChange(next: PickerSettings): void;
  onReconfigure(): void;
  onUninstall(plugin: AdapterPluginDto): Promise<void>;
  /** 保存成功后才调用。失败时不要靠它改壳层。 */
  onUiChromeSaved?(prefs: UiChromePrefs): void;
  /** 默认 dialog，和现在的弹层一致。page 时用「返回工作现场」走同一个 onClose。 */
  variant?: 'dialog' | 'page';
}) {
  const waiting = categoryNeedsData(category) && !dataReady;
  const page = variant === 'page';
  return (
    <div className="kb-dialog-backdrop" data-testid="settings-page" data-variant={variant} data-kb-overlay="" onMouseDown={page ? undefined : onClose}>
      <div
        className={page ? 'kb-dialog kb-settings kb-settings--page' : 'kb-dialog kb-settings'}
        role={page ? 'region' : 'dialog'}
        aria-modal={page ? undefined : true}
        aria-label="设置"
        data-testid="settings-dialog"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="kb-dialog-title">设置</div>
        <div className="kb-settings-layout">
          <nav className="kb-settings-nav" data-testid="settings-nav" aria-label="设置分类">
            {SETTINGS_CATEGORIES.map((item) => (
              <button key={item.id} type="button" data-testid={`settings-cat-${item.id}`} aria-current={category === item.id ? 'page' : undefined} onClick={() => onCategory(item.id)}>
                {item.label}
              </button>
            ))}
          </nav>
          <div className="kb-settings-pane" data-testid="settings-pane" data-category={category}>
            {waiting ? (
              <LoadingLabel testId="settings-loading" />
            ) : (
              <SettingsPane
                category={category}
                appearance={appearance}
                onAppearance={onAppearance}
                onInstallTheme={onInstallTheme}
                showIgnored={showIgnored}
                onShowIgnored={onShowIgnored}
                indexStatus={indexStatus}
                roots={roots}
                pickerSettings={pickerSettings}
                workspaces={workspaces}
                conflict={conflict}
                onPickerChange={onPickerChange}
                onReconfigure={onReconfigure}
                onUninstall={onUninstall}
                onUiChromeSaved={onUiChromeSaved}
              />
            )}
          </div>
        </div>
        <div className="kb-dialog-actions">
          {page ? (
            <button type="button" className="kb-button" data-testid="settings-back" onClick={onClose}>
              返回工作现场
            </button>
          ) : (
            <button type="button" className="kb-button" data-testid="settings-close" onClick={onClose}>
              关闭
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsPane(props: {
  category: SettingsCategoryId;
  appearance: Appearance;
  onAppearance(next: Appearance): void;
  onInstallTheme(): void;
  showIgnored: boolean;
  onShowIgnored(on: boolean): void;
  indexStatus: IndexStatus[];
  roots: Root[];
  pickerSettings: PickerSettings;
  workspaces: readonly { id: string; name: string }[];
  conflict?: QuickSwitchConflictReport | null;
  onPickerChange(next: PickerSettings): void;
  onReconfigure(): void;
  onUninstall(plugin: AdapterPluginDto): Promise<void>;
  onUiChromeSaved?(prefs: UiChromePrefs): void;
}) {
  if (props.category === 'update') return <UpdateBody embedded />;
  if (props.category === 'appearance') {
    return (
      <div className="kb-set-page" data-testid="settings-appearance">
        <h1>外观</h1>
        <p className="kb-set-lead">明暗是三项选择。太阳胶囊只在浅色和深色之间切换，跟随系统时停用。外框与阅读区可独立选美术主题包。</p>
        <AppearanceFields value={props.appearance} onChange={props.onAppearance} idPrefix="settings-appearance" showSchemeSun />
        <UiChromeSwitches onSaved={props.onUiChromeSaved} />
        <div className="kb-set-row">
          <div>
            <b>安装主题包</b>
            <p>从本地文件夹安装主题。不会改用户当前主题选择。</p>
          </div>
          <button type="button" className="kb-button" data-testid="settings-install-theme" onClick={() => void props.onInstallTheme()}>
            安装主题包（文件夹）…
          </button>
        </div>
      </div>
    );
  }
  if (props.category === 'keybindings') return <KeybindingsPage embedded onClose={() => undefined} />;
  if (props.category === 'plugins') return <PluginManager embedded focus={undefined} onClose={() => undefined} onUninstall={props.onUninstall} />;
  if (props.category === 'workspace') {
    return (
      <div className="kb-set-page" data-testid="settings-workspace">
        <h1>工作区启动</h1>
        <p className="kb-set-lead">进入工作区时的启动方式与底部文件条。内容接正式工作区服务。</p>
        <WorkspacePickerSettings
          embedded
          settings={props.pickerSettings}
          workspaces={props.workspaces}
          conflict={props.conflict}
          onChange={props.onPickerChange}
          onClose={() => undefined}
          onReconfigure={props.onReconfigure}
        />
        <RestoreBarSwitch />
      </div>
    );
  }
  if (props.category === 'web') {
    return (
      <div className="kb-set-page" data-testid="settings-web">
        <h1>网站授权</h1>
        <p className="kb-set-lead">按网站记住是否允许在应用内打开；可在此撤销。</p>
        <WebSiteGrantsBody embedded />
      </div>
    );
  }
  if (props.category === 'index') return <IndexPane status={props.indexStatus} roots={props.roots} />;
  if (props.category === 'ignored') {
    return (
      <div className="kb-set-page" data-testid="settings-ignored">
        <h1>忽略的文件</h1>
        <p className="kb-set-lead">node_modules、.git、$RECYCLE.BIN 等默认不显示、不索引。</p>
        <div className="kb-set-row">
          <div>
            <b>显示被忽略的文件</b>
            <p>打开后在目录树中显示被忽略项。</p>
          </div>
          <KbToggle testId="settings-show-ignored" label="显示被忽略的文件" checked={props.showIgnored} onChange={props.onShowIgnored} />
        </div>
      </div>
    );
  }
  if (props.category === 'delay') return <DelayPane />;
  if (props.category === 'reading') return <ReadingPane />;
  return <AboutPane />;
}

function IndexPane({ status, roots }: { status: IndexStatus[]; roots: Root[] }) {
  const nameOf = (id: string) => roots.find((r) => r.id === id)?.name ?? id;
  const rebuild = async () => {
    const ok = await dialogs.confirm({ title: '重建索引', body: '重建会重新扫描当前工作区里的根。继续？', ok: '重建', cancel: '取消' });
    if (!ok) return;
    const result = await kb.indexRebuild();
    await dialogs.alert({ title: '重建索引', body: result.ok ? result.detail || '已触发' : result.detail || '失败' });
  };
  return (
    <div className="kb-set-page" data-testid="settings-index"><h1>索引</h1><p className="kb-set-lead">索引状态来自正式服务。</p>
      <ul data-testid="settings-index-status">
        {status.length === 0 && <li>当前没有根</li>}
        {status.map((row) => (
          <li key={row.rootId} data-testid={`settings-index-${row.rootId}`}>
            {nameOf(row.rootId)} · {row.state} · {row.fileCount} 个文件{row.watching ? ' · 监听中' : ''}
            {row.lastError ? ` · ${row.lastError}` : ''}
          </li>
        ))}
      </ul>
      <button type="button" className="kb-button" data-testid="settings-index-rebuild" onClick={() => void rebuild()}>
        重建索引
      </button>
    </div>
  );
}

function DelayPane() {
  const [ms, setMs] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    let alive = true;
    void kb.getLayout('settings.backgroundLoadDelayMs').then((value) => {
      if (!alive) return;
      if (typeof value === 'number' && Number.isFinite(value)) setMs(String(value));
      else setMs(String(backgroundLoader.delayMs));
    }).catch(() => {
      if (alive) setMs(String(backgroundLoader.delayMs));
    });
    return () => {
      alive = false;
    };
  }, []);
  const save = () => {
    const n = Number(ms.trim());
    if (!Number.isInteger(n)) {
      setNote('须是整数，单位是毫秒');
      return;
    }
    backgroundLoader.delayMs = n;
    void kb.setLayout('settings.backgroundLoadDelayMs', n).then(
      () => setNote('已保存'),
      (err: unknown) => setNote(String((err as Error)?.message ?? err)),
    );
  };
  return (
    <div className="kb-set-page" data-testid="settings-delay"><h1>后台加载</h1><p className="kb-set-lead">延迟毫秒数写入正式 layout 键。</p>
      <label className="kb-field">
        后台加载延迟（毫秒）
        <input data-testid="settings-delay-ms" value={ms} inputMode="numeric" onChange={(e) => setMs(e.target.value)} />
      </label>
      <button type="button" className="kb-button" data-testid="settings-delay-save" onClick={save}>
        保存
      </button>
      {note ? <p data-testid="settings-delay-note">{note}</p> : null}
    </div>
  );
}

function RestoreBarSwitch() {
  const on = useSyncExternalStore(subscribeRestoreBarVisible, readRestoreBarVisible, readRestoreBarVisible);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  useEffect(() => {
    void kb.getLayout(RESTORE_BAR_VISIBLE_KEY).then((raw) => {
      if (raw === false) setRestoreBarVisible(false);
      else if (raw === true) setRestoreBarVisible(true);
    }).catch(() => undefined);
  }, []);
  return (
    <div className="kb-set-row" data-testid="settings-restore-bar">
      <div>
        <b>显示底部文件条</b>
        <p>只在有失败、找不到或等待手动打开的面板时出现。关掉后整栏隐藏，不删除条目。</p>
      </div>
      <KbToggle
        testId="settings-restore-bar-toggle"
        label="显示底部文件条"
        checked={on}
        busy={busy}
        disabled={busy}
        onChange={(next) => {
          if (writing.current) return;
          const prev = readRestoreBarVisible();
          writing.current = true;
          setRestoreBarVisible(next);
          setBusy(true);
          setNote('');
          void kb.setLayout(RESTORE_BAR_VISIBLE_KEY, next).then(
            () => setNote(next ? '已显示' : '已隐藏'),
            (err: unknown) => {
              setRestoreBarVisible(prev);
              setNote(String((err as Error)?.message ?? err));
            },
          ).finally(() => {
            writing.current = false;
            setBusy(false);
          });
        }}
      />
      {note ? <p data-testid="settings-restore-bar-note">{note}</p> : null}
    </div>
  );
}

function ReadingPane() {
  const on = useSyncExternalStore(subscribeReaderBackToToc, readReaderBackToToc);
  const zoomOn = useSyncExternalStore(subscribeZoomHudVisible, readZoomHudVisible);
  const [note, setNote] = useState('');
  const [zoomNote, setZoomNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [zoomBusy, setZoomBusy] = useState(false);
  const writing = useRef(false);
  const zoomWriting = useRef(false);
  useEffect(() => {
    void loadReaderBackToToc();
    void loadZoomHudVisible();
  }, []);
  return (
    <div className="kb-set-page" data-testid="settings-reading">
      <h1>阅读</h1>
      <p className="kb-set-lead">阅读器能力接正式服务；此处只改显示偏好。</p>
      <div className="kb-set-row">
        <div>
          <b>Markdown 显示「↑ 目录」</b>
          <p>没有这项设置时按打开处理。关闭后按钮藏起来，不重新渲染正文。</p>
        </div>
        <KbToggle
          testId="settings-back-toc"
          label="Markdown 显示「↑ 目录」"
          checked={on}
          busy={busy}
          disabled={busy}
          onChange={(next) => {
            if (writing.current) return;
            writing.current = true;
            setBusy(true);
            setNote('');
            void writeReaderBackToToc(next).then(
              () => setNote(next ? '已打开' : '已关闭'),
              (err: unknown) => setNote(String((err as Error)?.message ?? err)),
            ).finally(() => {
              writing.current = false;
              setBusy(false);
            });
          }}
        />
      </div>
      {note ? <p data-testid="settings-back-toc-note">{note}</p> : null}
      <div className="kb-set-row">
        <div>
          <b>显示内容缩放条</b>
          <p>控制阅读面板右下角缩小／百分比／放大／重置／适应浮条。隐藏不改变缩放值，快捷键与滚轮仍可用；文档「更多」菜单提供同一开关。</p>
        </div>
        <KbToggle
          testId="settings-zoom-hud"
          label="显示内容缩放条"
          checked={zoomOn}
          busy={zoomBusy}
          disabled={zoomBusy}
          onChange={(next) => {
            if (zoomWriting.current) return;
            zoomWriting.current = true;
            setZoomBusy(true);
            setZoomNote('');
            void writeZoomHudVisible(next).then(
              () => setZoomNote(next ? '已显示' : '已隐藏'),
              (err: unknown) => setZoomNote(String((err as Error)?.message ?? err)),
            ).finally(() => {
              zoomWriting.current = false;
              setZoomBusy(false);
            });
          }}
        />
      </div>
      {zoomNote ? <p data-testid="settings-zoom-hud-note">{zoomNote}</p> : null}
    </div>
  );
}

type ChromeKey = 'reduceMotion' | 'documentTabs' | 'drawerOpenByDefault' | 'topBarVisible';

function UiChromeSwitches({ onSaved }: { onSaved?: (prefs: UiChromePrefs) => void }) {
  const [prefs, setPrefs] = useState<UiChromePrefs>(DEFAULT_UI_CHROME_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyKey, setBusyKey] = useState<ChromeKey | null>(null);
  const [note, setNote] = useState('');
  const prefsRef = useRef(prefs);
  const writing = useRef(false);
  const alive = useRef(true);
  prefsRef.current = prefs;
  useEffect(() => {
    alive.current = true;
    void loadUiChromePrefs(kb).then(
      (next) => {
        if (!alive.current) return;
        setPrefs(next);
        setLoaded(true);
      },
      (err: unknown) => {
        if (!alive.current) return;
        setLoadFailed(true);
        setLoaded(true);
        setNote(String((err as Error)?.message ?? err));
      },
    );
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const onExternal = (ev: Event) => {
      const detail = (ev as CustomEvent<UiChromePrefs>).detail;
      if (!detail || detail.v !== 1 || writing.current || !alive.current) return;
      setPrefs(detail);
      setLoaded(true);
      setLoadFailed(false);
    };
    window.addEventListener('kb:ui-chrome-saved', onExternal);
    return () => window.removeEventListener('kb:ui-chrome-saved', onExternal);
  }, []);
  const change = (key: ChromeKey, next: boolean) => {
    if (!loaded || loadFailed || writing.current) return;
    const prev = prefsRef.current;
    const optimistic = withUiChromePrefs(prev, { [key]: next });
    writing.current = true;
    setBusyKey(key);
    setNote('');
    void saveUiChromePrefs(kb, optimistic).then(
      (stored) => {
        onSaved?.(stored);
        if (!alive.current) return;
        setPrefs(stored);
        setNote('已保存');
      },
      (err: unknown) => {
        if (!alive.current) return;
        setPrefs(prev);
        setNote(String((err as Error)?.message ?? err));
      },
    ).finally(() => {
      writing.current = false;
      if (alive.current) setBusyKey(null);
    });
  };
  const locked = !loaded || loadFailed || busyKey !== null;
  const rows: { key: ChromeKey; testId: string; title: string; desc: string }[] = [
    { key: 'reduceMotion', testId: 'settings-reduce-motion', title: '减少动效', desc: '关掉图标弹跳与过渡细动画。系统「减少动态效果」也会生效。' },
    { key: 'documentTabs', testId: 'settings-document-tabs', title: '显示文档标签', desc: '关掉标签条时，当前文档仍保持打开。' },
    { key: 'drawerOpenByDefault', testId: 'settings-drawer-default', title: '进入阅读时展开资料抽屉', desc: '从工作区卡片进入阅读时默认展开抽屉。' },
    { key: 'topBarVisible', testId: 'settings-topbar-visible', title: '显示顶栏', desc: '关掉后顶缘会留一条呼出区；也可用命令「显示/隐藏顶栏」。阅读专注模式仍会让顶栏半透明。' }
  ];
  return (
    <div className="kb-settings-switches" data-testid="settings-ui-chrome" aria-busy={!loaded || busyKey !== null}>
      {rows.map((row) => (
        <div className="kb-set-row" key={row.key}>
          <div>
            <b>{row.title}</b>
            <p>{row.desc}</p>
          </div>
          <KbToggle
            testId={row.testId}
            label={row.title}
            checked={prefs[row.key]}
            disabled={locked}
            busy={busyKey === row.key}
            onChange={(next) => change(row.key, next)}
          />
        </div>
      ))}
      {note ? <p data-testid="settings-ui-chrome-note">{note}</p> : null}
    </div>
  );
}

function AboutPane() {
  const [info, setInfo] = useState<{ version: string; electron: string; dataDir: string; installDir: string | null } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void kb.aboutInfo()
      .then((next) => {
        if (alive) setInfo(next);
      })
      .catch((err: unknown) => {
        if (alive) setError(String((err as Error)?.message ?? err));
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <div className="kb-set-page" data-testid="settings-about">
      <h1>关于</h1>
      <p className="kb-set-lead">本地知识工作台</p>
      <div data-testid="settings-about-mark">
        <BrandMark />
      </div>
      <p data-testid="settings-about-version">版本 {info?.version ?? '…'}</p>
      <p data-testid="settings-about-electron">Electron {info?.electron ?? '…'}</p>
      <p data-testid="settings-about-data">数据目录 {info?.dataDir ?? '…'}</p>
      <p data-testid="settings-about-install">安装目录 {info ? info.installDir ?? '未打包' : '…'}</p>
      {error ? <p data-testid="settings-about-error">{error}</p> : null}
    </div>
  );
}
