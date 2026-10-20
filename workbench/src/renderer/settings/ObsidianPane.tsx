/**
 * 设置里的 Obsidian 一节。中转库路径和跨盘开关。
 * 初始化只准备中转库目录，不写 obsidian.json，并请用户自己在 Obsidian 里打开这个文件夹。
 */
import React, { useEffect, useState } from 'react';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { KbToggle } from './KbToggle';
import { JUNCTION_WARNING, type ObsidianBridgeSettings } from '../../shared/obsidianBridge/types';

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function ObsidianPane() {
  const [settings, setSettings] = useState<ObsidianBridgeSettings | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await kb.obsidianBridgeGet();
    setSettings(next);
    setDraft(next.relayVaultDir);
  };

  useEffect(() => {
    let stop = false;
    void load().catch((error) => {
      if (!stop) setNote(errorText(error));
    });
    return () => {
      stop = true;
    };
  }, []);

  const savePath = async (dir: string | null) => {
    setBusy(true);
    setNote('');
    try {
      const next = await kb.obsidianBridgeSetVault(dir);
      setSettings(next);
      setDraft(next.relayVaultDir);
      setNote(dir ? '已保存中转库路径' : '已恢复默认中转库路径');
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    const picked = await kb.pickFolder({ title: '选择中转库文件夹' });
    if (!picked) return;
    await savePath(picked);
  };

  const init = async () => {
    setBusy(true);
    setNote('');
    try {
      const result = await kb.obsidianBridgeInit();
      if (!result.ok) {
        setNote(result.message || '没有初始化');
        return;
      }
      await load();
      await dialogs.alert({ title: '初始化中转库', body: result.instructions || '中转库已准备好。请在 Obsidian 里打开这个文件夹作为库。' });
    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const toggleJunction = async (next: boolean) => {
    if (next) {
      const ok = await dialogs.confirm({
        title: '跨盘使用目录联接',
        body: `打开后，跨盘改为目录联接，保存直接落在原文件上。${JUNCTION_WARNING}`,
        ok: '打开',
        cancel: '取消',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    setNote('');
    try {
      const saved = await kb.obsidianBridgeSetJunction(next);
      setSettings(saved);
      setNote(next ? '已打开跨盘联接' : '已关闭跨盘联接');
    } catch (error) {
      setNote(errorText(error));
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kb-set-page" data-testid="settings-obsidian">
      <h1>Obsidian</h1>
      <p className="kb-set-lead">
        用 Obsidian 打开同一篇 Markdown。文件已经在某个库里时直接打开；否则经中转库做临时链接。不写 obsidian.json，也不把库放进工作台的正式数据目录。
      </p>
      <section className="kb-set-card">
      <div className="kb-set-row">
        <div>
          <b>中转库路径</b>
          <p>默认是用户主目录下的 LKW-Relay-Vault。可以改到别的空文件夹。不要选资料目录，也不要选正在用的正式库。</p>
        </div>
      </div>
      <input
        className="kb-input"
        data-testid="obsidian-vault-path"
        aria-label="中转库路径"
        value={draft}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="kb-dialog-actions">
        <button type="button" className="kb-button" data-testid="obsidian-vault-save" disabled={busy} onClick={() => void savePath(draft.trim())}>
          保存路径
        </button>
        <button type="button" className="kb-button kb-button--secondary" data-testid="obsidian-vault-browse" disabled={busy} onClick={() => void browse()}>
          选择文件夹
        </button>
        <button type="button" className="kb-button kb-button--secondary" data-testid="obsidian-vault-reset" disabled={busy || settings?.usingDefault === true} onClick={() => void savePath(null)}>
          恢复默认
        </button>
      </div>
      {settings?.usingDefault ? <p className="kb-set-copy">当前使用默认路径。</p> : null}
      <div className="kb-set-row" data-testid="obsidian-bundled-plugin">
        <div>
          <b>可选插件：工作台桥{settings?.bundledPlugin ? ` ${settings.bundledPlugin.version}` : ''}</b>
          <p>{settings?.bundledPlugin ? `已随工作台附带（${settings.bundledPlugin.id}），默认不启用。点下面的「初始化中转库」才会装进中转库并启用；不会装进你的其它库。` : '这个版本没有附带工作台桥。'}</p>
        </div>
      </div>
      <div className="kb-set-row">
        <div>
          <b>初始化中转库</b>
          <p>第一次使用时准备这个文件夹，并启用工作台桥。做完后请在 Obsidian 里选「打开文件夹作为库」，选中上面的路径。这一次即可，程序不会改 obsidian.json。</p>
        </div>
        <button type="button" className="kb-button" data-testid="obsidian-init" disabled={busy} onClick={() => void init()}>
          初始化中转库
        </button>
      </div>
      <div className="kb-set-row">
        <div>
          <b>跨盘使用目录联接</b>
          <p>默认关闭。关闭时，原文件和中转库不在同一个盘，就只复制这一篇，保存后写回原文件；同一个盘仍然用硬链接。打开后与中转库里工作台桥的 data.json 保持一致。</p>
        </div>
        <KbToggle
          testId="obsidian-junction"
          label="跨盘使用目录联接"
          checked={settings?.crossVolumeJunction === true}
          disabled={busy || !settings?.vaultReady}
          onChange={(value) => void toggleJunction(value)}
        />
      </div>
      {settings?.warning ? (
        <p className="kb-obsidian-warning" data-testid="obsidian-junction-warning" role="status">
          {settings.warning}
        </p>
      ) : null}
      {!settings?.vaultReady ? <p className="kb-set-copy">中转库还没初始化，跨盘开关要等初始化之后才能改。</p> : null}
      {note ? <p className="kb-set-copy" data-testid="obsidian-note">{note}</p> : null}
      </section>
    </div>
  );
}
