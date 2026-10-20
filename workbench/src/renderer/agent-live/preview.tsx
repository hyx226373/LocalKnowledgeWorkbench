import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AgentMaterial, MaterialRef } from '../../shared/agentLive/types';
import '../styles.css';
import './agent-live.css';
import { clearSession } from './actions';
import { AgentLiveProvider } from './context';
import type { AgentLiveHost } from './host';
import { createMemoryAgentLive } from './memoryClient';
import { MSG_CLEAR_BODY, MSG_CLEAR_TITLE } from './messages';
import { AgentMaterialsSidebar } from './panel';
import { ReaderAddMaterialButton } from './readerButton';
import { SearchHitAddButton } from './searchHitButton';

const WORKSPACE = 'ws-preview';
const EXPERIMENT: MaterialRef = {
  resourceId: 'r-exp',
  sourceId: 's-thesis',
  relPath: '第三章/实验.md',
  absPath: 'D:\\论文\\第三章\\实验.md',
  name: '实验.md',
};

function seed(): AgentMaterial[] {
  const base = {
    resourceId: null as string | null,
    sourceId: 's-thesis',
    purpose: null as string | null,
    status: 'ok' as const,
    contentHash: null,
    contentVersion: 0,
    readable: null,
    addedAt: '2026-10-08T07:00:00.000Z',
    hasText: true,
    pages: null as number | null,
  };
  return [
    {
      ...base,
      materialId: 'm-exp',
      resourceId: 'r-exp',
      relPath: '第三章/实验.md',
      absPath: 'D:\\论文\\第三章\\实验.md',
      name: '实验.md',
      purpose: '对照数据',
      order: 1,
      tier: 'session',
      bytes: 2_000_000,
      estTokens: 20_000,
    },
    {
      ...base,
      materialId: 'm-note',
      relPath: '第三章/记录.txt',
      absPath: 'D:\\论文\\第三章\\记录.txt',
      name: '记录.txt',
      order: 2,
      tier: 'session',
      bytes: 1_565_158,
      estTokens: 21_000,
    },
    {
      ...base,
      materialId: 'm-old',
      relPath: '第三章/旧稿.pdf',
      absPath: 'D:\\论文\\第三章\\旧稿.pdf',
      name: '旧稿.pdf',
      order: 3,
      tier: 'session',
      status: 'missing',
      bytes: 0,
      estTokens: 0,
      hasText: false,
      pages: 4,
    },
    {
      ...base,
      materialId: 'm-survey',
      relPath: '综述.pdf',
      absPath: 'D:\\论文\\综述.pdf',
      name: '综述.pdf',
      purpose: '背景',
      order: 1,
      tier: 'pinned',
      bytes: 20 * 1024 * 1024,
      estTokens: 160_000,
      pages: 40,
    },
  ];
}

function Preview() {
  const params = new URLSearchParams(location.search);
  const showSearch = params.get('mobile') !== '1';
  const client = useMemo(() => createMemoryAgentLive({ [WORKSPACE]: seed() }), []);
  const [toast, setToast] = useState('');
  const [dialog, setDialog] = useState<{ title: string; body: string; ok: string; cancel?: string; resolve: (value: boolean) => void } | null>(null);
  const host = useMemo<AgentLiveHost>(() => {
    const drags: { files: string[]; deleteSource: false }[] = [];
    return {
      workspaceId: () => WORKSPACE,
      currentReading: () => EXPERIMENT,
      readingForPanel: (panelId) => (panelId === 'panel-1' ? EXPERIMENT : null),
      selection: () => [EXPERIMENT, { absPath: 'D:\\论文\\第三章\\记录.txt', name: '记录.txt', relPath: '第三章/记录.txt' }],
      hostedForeground: () => false,
      notify: (message) => setToast(message),
      confirm: (spec) =>
        new Promise((resolve) => {
          setDialog({ ...spec, resolve });
        }),
      writeClipboard: async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          /* 无剪贴板权限时仍然提示已复制 */
        }
        void text;
      },
      bridgeEntryPath: async () => 'D:\\bridge\\live\\current\\ENTRY.md',
      workspaceEntryPath: async () => `D:\\bridge\\live\\ws\\${WORKSPACE}\\ENTRY.md`,
      pickFile: async () => 'D:\\论文\\第三章\\旧稿-新位置.pdf',
      startDragCopy: (request) => {
        drags.push(request);
        if (request.deleteSource !== false || request.op !== 'copy') throw new Error('拖出只能复制');
      },
      loadChrome: async () => null,
      saveChrome: async () => undefined,
    };
  }, []);

  useEffect(() => {
    if (params.get('confirm') !== '1') return;
    const binding = { client, host };
    void clearSession(binding);
    // 只在打开预览时弹一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, host]);

  return (
    <AgentLiveProvider client={client} host={host}>
      <div className="app al-preview-frame" data-testid="agent-live-preview">
        <header className="kb-topbar">
          <span className="title">本地知识工作台</span>

          <div className={'search al-preview-search'}>
            <input className="kb-input" readOnly value="实验" aria-label="搜索" />
            {showSearch && <div className="kb-popover kb-search-results" data-testid="search-results">
              <div className={'kb-search-hit al-search-hit--show'} data-match-kind="name">
                <div className="al-search-line">
                  <span>实验.md</span>
                  <SearchHitAddButton item={EXPERIMENT} />
                </div>
                <div className="p">论文 / 第三章/实验.md</div>
              </div>
            </div>}
          </div>
        </header>
        <div className="al-preview-body">
          <aside className="kb-sidebar al-preview-side" data-testid="sidebar">
            <AgentMaterialsSidebar />
          </aside>
          <main className="al-preview-main">
            <div className="al-preview-tab" data-testid="reader-tab">
              <span>实验.md</span>
              <ReaderAddMaterialButton panelId="panel-1" />
            </div>
            <p className="al-hint">拖名称是复制，不会移动原文件。拖左侧手柄只在区内排序。</p>
          </main>
        </div>
        {toast && (
          <div className="al-toast" data-testid="toast">
            {toast}
          </div>
        )}
        {dialog && (
          <div className="kb-dialog-backdrop" data-testid="agent-clear-dialog">
            <div className="kb-dialog" role="dialog" aria-labelledby="al-clear-title">
              <div className="kb-dialog-title" id="al-clear-title">
                {dialog.title || MSG_CLEAR_TITLE}
              </div>
              <div className="kb-dialog-body">{dialog.body || MSG_CLEAR_BODY}</div>
              <div className="kb-dialog-actions">
                <button type="button" className="kb-button kb-button--secondary" onClick={() => { dialog.resolve(false); setDialog(null); }}>
                  {dialog.cancel || '取消'}
                </button>
                <button
                  type="button"
                  className="kb-button"
                  data-testid="agent-clear-confirm"
                  onClick={() => {
                    dialog.resolve(true);
                    setDialog(null);
                  }}
                >
                  {dialog.ok}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AgentLiveProvider>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Preview />);
