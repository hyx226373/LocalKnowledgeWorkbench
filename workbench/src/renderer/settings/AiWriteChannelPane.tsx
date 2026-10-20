/**
 * 设置 · AI 写入通道。左档位，右上按文件夹，右下按 agent 的提示词。
 */
import { useEffect, useState } from 'react';
import { defaultDistillTemplate } from '../../shared/skillDistill';
import {
  BUILTIN_WRITE_AGENTS,
  WRITE_TIERS,
  WRITE_TIER_META,
  defaultTemplate,
  withPromptDraft,
  type AgentPrompt,
  type AiWriteSettings,
  type PromptSlot,
  type WriteTier,
} from '../../shared/aiWriteChannel';
import type { Root } from '../../shared/types';
import { kb } from '../kb';
import { AiWriteBoard } from '../aiWrite/approval';
import { dialogs } from '../ui/dialogs';
import './ai-write.css';

export function AiWriteChannelPane({ roots }: { roots: Root[] }) {
  const [settings, setSettings] = useState<AiWriteSettings | null>(null);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [tier, setTier] = useState<PromptSlot>('high');
  const [draft, setDraft] = useState<string | null>(null);
  const [inboxDraft, setInboxDraft] = useState<string | null>(null);
  useEffect(() => {
    void kb.aiWriteSettingsGet().then((next) => {
      setSettings(next);
      setAgentId(next.pasteAgentId);
    }).catch((err: unknown) => setError(String((err as Error)?.message ?? err)));
  }, []);
  useEffect(() => {
    if (!roots.length) return;
    void kb.aiWriteSyncRoots({ roots: roots.map((root) => ({ path: root.path, name: root.name })) }).catch(() => undefined);
  }, [roots]);
  const save = async (next: AiWriteSettings) => {
    setError('');
    try {
      const saved = await kb.aiWriteSettingsSet(next);
      setSettings(saved);
      return saved;
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
      return null;
    }
  };
  if (!settings) return <div className="kb-set-page kb-ai-write"><h1>AI 写入通道</h1><p role="status">{error || '正在加载…'}</p></div>;
  const agent = settings.agents.find((item) => item.id === agentId) ?? settings.agents[0];
  const template = tier === 'distill' ? (agent?.distill ?? '') : (agent?.templates[tier] ?? '');
  const shown = draft === null ? template : draft;
  return (
    <div className="kb-set-page kb-ai-write" data-testid="settings-ai-write">
      <h1>AI 写入通道</h1>
      <p className="kb-set-lead">作用于链接区里的文件夹和文件。复制的链接只带用户放进去的那些，不带整个根，也不列文件清单。未单独设档的路径用左侧默认档。高、中、低由软件备份；快速通道无备份。</p>
      <div className="kb-ai-write-grid">
        <div role="radiogroup" aria-label="默认档位">
          {WRITE_TIERS.map((id) => {
            const meta = WRITE_TIER_META[id];
            return (
              <label key={id} className="kb-ai-tier" data-testid={`ai-write-tier-${id}`}>
                <input type="radio" name="ai-write-tier" checked={settings.defaultTier === id} onChange={() => void save({ ...settings, defaultTier: id })} />
                <span>
                  <b>{meta.label}</b>
                  <strong className="kb-ai-backup" data-testid={`ai-write-backup-${id}`}>{meta.backup}</strong>
                  <small>Token {meta.token} · 速度 {meta.speed} · 安全性 {meta.safety}</small>
                  <em>{meta.scene}</em>
                </span>
              </label>
            );
          })}
        </div>
        <div className="kb-ai-side">
          <section className="kb-ai-card" data-testid="ai-write-folders">
            <h2>按文件夹</h2>
            <table className="kb-ai-table">
              <thead><tr><th>文件夹</th><th>档位</th><th></th></tr></thead>
              <tbody>
                {settings.folders.length === 0 ? <tr><td colSpan={3}>还没有单独规则。</td></tr> : null}
                {settings.folders.map((folder) => (
                  <tr key={folder.id} data-testid={`ai-write-folder-${folder.id}`}>
                    <td>{folder.path}</td>
                    <td>
                      <select aria-label={`${folder.path} 的档位`} value={folder.tier} onChange={(event) => void save({ ...settings, folders: settings.folders.map((item) => item.id === folder.id ? { ...item, tier: event.target.value as WriteTier } : item) })}>
                        {WRITE_TIERS.map((id) => <option key={id} value={id}>{WRITE_TIER_META[id].label} · {WRITE_TIER_META[id].backup}</option>)}
                      </select>
                    </td>
                    <td><button type="button" className="kb-button" onClick={() => void save({ ...settings, folders: settings.folders.filter((item) => item.id !== folder.id) })}>移除</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="kb-ai-actions">
              <button type="button" className="kb-button" data-testid="ai-write-add-folder" onClick={() => void (async () => {
                const picked = await kb.pickFolder({ title: '选择要单独设档的文件夹' });
                if (!picked) return;
                const tierPick = settings.defaultTier;
                await save({ ...settings, folders: [...settings.folders.filter((item) => item.path !== picked), { id: `f_${Date.now().toString(36)}`, path: picked, tier: tierPick }] });
              })()}>添加文件夹…</button>
              {roots.filter((root) => !settings.folders.some((folder) => folder.path === root.path)).map((root) => (
                <button key={root.id} type="button" className="kb-button" onClick={() => void save({ ...settings, folders: [...settings.folders, { id: `f_${root.id}`, path: root.path, tier: settings.defaultTier }] })}>加入 {root.name}</button>
              ))}
            </div>
          </section>
          <PromptDrawer
            settings={settings}
            agent={agent}
            tier={tier}
            shown={shown}
            onAgent={(id) => {
              setAgentId(id);
              setDraft(null);
              if (settings.pasteAgentId !== id) void save({ ...settings, pasteAgentId: id });
            }}
            onTier={(next) => {
              setTier(next);
              setDraft(null);
            }}
            onDraft={setDraft}
            onSave={() => {
              if (!agent) return;
              const text = draft === null ? template : draft;
              void save({
                ...settings,
                pasteAgentId: agent.id,
                agents: settings.agents.map((item) => item.id === agent.id ? withPromptDraft(item, tier, text) : item),
              }).then(() => { if (tier === 'distill' && !text.trim()) setDraft(null); });
            }}
            onReset={() => {
              if (!agent) return;
              const text = tier === 'distill' ? defaultDistillTemplate() : defaultTemplate(agent.id, tier, agent.name);
              setDraft(null);
              void save({ ...settings, agents: settings.agents.map((item) => item.id === agent.id ? withPromptDraft(item, tier, text) : item) });
            }}
            onAdd={() => void (async () => {
              const result = await dialogs.prompt({ title: '添加 agent', ok: '添加', fields: [{ name: 'name', label: '名称', placeholder: '例如 Windsurf' }] });
              const name = result?.name?.trim();
              if (!name) return;
              const id = `custom-${Date.now().toString(36)}`;
              const created: AgentPrompt = {
                id,
                name: name.slice(0, 40),
                builtin: false,
                templates: { high: defaultTemplate(id, 'high', name), medium: defaultTemplate(id, 'medium', name), low: defaultTemplate(id, 'low', name), fast: defaultTemplate(id, 'fast', name) },
                distill: defaultDistillTemplate(),
              };
              const saved = await save({ ...settings, pasteAgentId: id, agents: [...settings.agents, created] });
              if (saved) {
                setAgentId(id);
                setDraft(null);
              }
            })()}
            onRemove={() => void (async () => {
              if (!agent || settings.agents.length < 2) return;
              const ok = await dialogs.confirm({ title: '移除 agent', body: `移除 ${agent.name} 的提示词？内置 agent 可以之后用「恢复内置 agent」加回来。`, ok: '移除', cancel: '取消' });
              if (!ok) return;
              const agents = settings.agents.filter((item) => item.id !== agent.id);
              const saved = await save({ ...settings, agents, pasteAgentId: agents[0]?.id ?? settings.pasteAgentId });
              if (saved) setAgentId(saved.pasteAgentId);
            })()}
            onRestoreBuiltins={() => {
              const present = new Set(settings.agents.map((item) => item.id));
              const missing = BUILTIN_WRITE_AGENTS.filter((item) => !present.has(item.id)).map((item) => ({
                id: item.id,
                name: item.name,
                builtin: true,
                templates: { high: defaultTemplate(item.id, 'high', item.name), medium: defaultTemplate(item.id, 'medium', item.name), low: defaultTemplate(item.id, 'low', item.name), fast: defaultTemplate(item.id, 'fast', item.name) },
                distill: defaultDistillTemplate(),
              }));
              if (!missing.length) return;
              void save({ ...settings, agents: [...settings.agents, ...missing] });
            }}
          />
        </div>
      </div>
      <section className="kb-ai-card" data-testid="ai-write-inbox-root">
        <h2>收件箱根目录</h2>
        <div className="kb-ai-actions">
          <input
            className="kb-ai-inbox-path"
            aria-label="收件箱根目录"
            data-testid="ai-write-inbox-path"
            value={inboxDraft ?? settings.inboxRoot ?? ''}
            placeholder="尚未选择"
            onChange={(event) => setInboxDraft(event.target.value)}
            onBlur={(event) => {
              const text = event.target.value.trim();
              setInboxDraft(null);
              if (text === (settings.inboxRoot ?? '')) return;
              const next = { ...settings };
              if (text) next.inboxRoot = text;
              else delete next.inboxRoot;
              void save(next);
            }}
          />
          <button type="button" className="kb-button" data-testid="ai-write-inbox-pick" onClick={() => void (async () => {
            const picked = await kb.pickFolder({ title: '选择收件箱根目录' });
            if (!picked) return;
            setInboxDraft(null);
            await save({ ...settings, inboxRoot: picked });
          })()}>选择…</button>
        </div>
        <p className="kb-set-copy">AI 只看这里的副本。不能选在资料文件夹、agent-data 或正式用户数据目录里。</p>
        <p className="kb-set-copy">会话清单在工作台数据目录。</p>
      </section>
      <section className="kb-ai-card" data-testid="ai-write-stage">
        <h2>暂存与批准</h2>
        <AiWriteBoard />
      </section>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

export function PromptDrawer(props: {
  settings: AiWriteSettings;
  agent: AgentPrompt | undefined;
  tier: PromptSlot;
  shown: string;
  onAgent: (id: string) => void;
  onTier: (tier: PromptSlot) => void;
  onDraft: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
  onAdd: () => void;
  onRemove: () => void;
  onRestoreBuiltins: () => void;
}) {
  return (
    <section className="kb-ai-card" data-testid="ai-write-prompts">
      <h2>按 agent 定制提示词</h2>
      <div className="kb-ai-tabs" role="tablist">
        {props.settings.agents.map((item) => (
          <button key={item.id} type="button" role="tab" aria-selected={item.id === props.agent?.id} onClick={() => props.onAgent(item.id)}>{item.name}</button>
        ))}
      </div>
      <label className="kb-field">档位
        <select aria-label="提示词档位" value={props.tier} onChange={(event) => props.onTier(event.target.value as PromptSlot)}>
          {WRITE_TIERS.map((id) => <option key={id} value={id}>{WRITE_TIER_META[id].label} · {WRITE_TIER_META[id].backup}</option>)}
          <option value="distill">蒸馏</option>
        </select>
      </label>
      <textarea className="kb-ai-template" aria-label="提示词模板" data-testid="ai-write-template" value={props.shown} placeholder={props.tier === 'fast' ? '留空也可以。链接正文会带上真实路径，并要求按需读取。' : props.tier === 'distill' ? '留空保存会恢复默认全文。' : ''} onChange={(event) => props.onDraft(event.target.value)} />
      <div className="kb-ai-actions">
        <button type="button" className="kb-button" onClick={props.onSave}>保存提示词</button>
        <button type="button" className="kb-button" data-testid="ai-write-reset-prompt" onClick={props.onReset}>恢复默认</button>
        <button type="button" className="kb-button" data-testid="ai-write-add-agent" onClick={props.onAdd}>添加 agent</button>
        <button type="button" className="kb-button" disabled={!props.agent || props.settings.agents.length < 2} onClick={props.onRemove}>移除 agent</button>
        <button type="button" className="kb-button" onClick={props.onRestoreBuiltins}>恢复内置 agent</button>
      </div>
    </section>
  );
}
