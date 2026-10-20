/**
 * Agent 数据位置：仅通过数据位置接口切换。
 */
import React, { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';
import { DIALOG_LAST_DIR } from '../../shared/dialogLastDir';
import { kb } from '../kb';
import { dialogs } from '../ui/dialogs';
import { agentPanelLocationGet, agentPanelLocationVia, changeAgentDataLocation } from '../agent-panel/client';
import { displayedAgentDataPath } from '../agent-panel/logic';

function errorText(error: unknown): string {
  return String((error as { message?: string })?.message ?? error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function AgentDataLocation() {
  const [path, setPath] = useState('');
  const [degraded, setDegraded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [envLocked, setEnvLocked] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const location = await agentPanelLocationGet();
    if (location) {
      const shown = displayedAgentDataPath(location, null);
      setPath(shown.path);
      setDegraded(false);
      setMissing(false);
      setEnvLocked(location.envLocked);
      return;
    }
    setEnvLocked(false);
    setPath('');
    setMissing(true);

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

  const change = async () => {
    const via = agentPanelLocationVia();
    if (envLocked) {
      setNote('KB_AGENT_DATA 已覆盖数据目录，不能在设置里更改位置');
      return;
    }
    if (via !== 'setLocation') {
      setNote('Agent 数据位置接口未连接');
      return;
    }
    if (typeof kb.pickFolder !== 'function') {
      setNote('无法打开目录选择框');
      return;
    }
    const picked = await kb.pickFolder({ dialogKey: DIALOG_LAST_DIR.agentDataLocation, title: '选择 Agent 数据目录' });
    if (!picked) return;
    let migrate = false;
    if (via === 'setLocation') {
      const mode = await dialogs.custom<'migrate' | 'switch' | null>({
        title: '更改 Agent 数据位置',
        cancelValue: null,
        testid: 'agent-data-location-mode',
        render: (done) => (
          <>
            <p>可以把现有 Agent 数据搬到新目录，也可以只切换以后写入的位置。</p>
            <div className="kb-dialog-actions">
              <button type="button" className="kb-button" data-testid="agent-data-migrate" onClick={() => done('migrate')}>
                迁移并切换
              </button>
              <button type="button" className="kb-button kb-button--secondary" data-testid="agent-data-switch" onClick={() => done('switch')}>
                仅切换
              </button>
              <button type="button" className="kb-button kb-button--secondary" onClick={() => done(null)}>
                取消
              </button>
            </div>
          </>
        ),
      });
      if (!mode) return;
      migrate = mode === 'migrate';
    }
    setBusy(true);
    setNote('');
    try {
      const result = await changeAgentDataLocation(picked, migrate);
      if (!result.ok) {
        setNote(result.reason || '未能更改位置');
        return;
      }
      setPath(result.path);
      setDegraded(result.via === 'archiveRoot');
      setMissing(false);
      setNote(result.via === 'archiveRoot' ? '数据位置接口未连接' : migrate ? '已迁移并切换' : '已切换位置');
      const fresh = await agentPanelLocationGet();
      if (fresh?.dir) setPath(fresh.dir);
      if (fresh) setEnvLocked(fresh.envLocked);

    } catch (error) {
      setNote(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const saved = note === '已迁移并切换' || note === '已切换位置';
  return (
    <div className="kb-set-page" data-testid="settings-agent-data">
      <h1>Agent 数据位置</h1>
      <p className="kb-set-lead">重生仓库与 Agent 数据默认放在应用目录下的 agent-data。可以迁移或切换到其他目录。</p>
      <section className="kb-set-card">
        <div className="kb-set-path-row">
          <p className="kb-agent-data-path" data-testid="settings-agent-data-path">
            <Folder size={16} strokeWidth={1.5} aria-hidden="true" />
            <span>{missing ? '接口未连接' : path || '（当前路径为空）'}</span>
          </p>
          <button type="button" className="kb-button kb-button--secondary" data-testid="settings-agent-data-change" disabled={busy || missing || envLocked} onClick={() => void change()}>
            更改位置…
          </button>
        </div>
        {degraded ? <p className="kb-set-banner kb-set-banner--warn">数据位置接口未连接。</p> : null}
        {envLocked ? <p className="kb-set-banner kb-set-banner--warn">环境变量 KB_AGENT_DATA 已指定数据目录，设置里不能更改。</p> : null}
        {note ? <p className={saved ? 'kb-set-note kb-set-note--ok' : 'kb-set-banner kb-set-banner--warn'} data-testid="settings-agent-data-note">{note}</p> : null}
      </section>
    </div>
  );
}
