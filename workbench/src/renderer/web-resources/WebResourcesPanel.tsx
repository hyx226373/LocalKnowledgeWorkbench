/**
 * 侧栏“网络资料”面板（第 11 轮 A8）：收藏与最近打开的网址；打开 / 收藏 / 加入本工作资料 / 复制网址 / 保存到本地 / 移除。
 * 不改侧栏目录树（B/C 所有）：通过 panels.register({ location: 'sidebar' }) 注册的独立面板。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { kb } from '../kb';
import type { PluginApi } from '../plugin-host/types';
import { WEB_FILE_ADAPTER, isInsecureUrl, type WebResource } from '../../shared/webResources';
import { copyUrl, flash, openUrlPrompt, openWebResource, saveToLocal, webBridge, WebFlash } from './webActions';
import { dialogs } from '../ui/dialogs';
import { GlobeIcon, ExternalLinkIcon, StarIcon } from '../ui/shellMarks';
import { beginDrag, endDrag } from '../dnd/drag';
import type { DragPayload } from '../dnd/types';
import { AgentAddIconButton } from '../agent-live/addIconButton';
import '../drawer/module.css';

export function WebResourcesPanel(_props?: { api?: PluginApi }) {
  const [list, setList] = useState<WebResource[] | null>(null);
  const reload = useCallback(() => void kb.webResourceList({ limit: 200 }).then(setList, () => setList([])), []);
  useEffect(() => {
    reload();
    return kb.onWebResourcesChange(() => reload());
  }, [reload]);
  const addRef = async (w: WebResource) => {
    const ws = webBridge.get()?.currentWorkspaceId();
    if (!ws) return;
    await kb.addWorkspaceRefs(ws, [w.resourceId]);
    flash(`已加入本工作资料：${w.title}`);
  };
  const remove = async (w: WebResource) => {
    const ok = await dialogs.confirm({ title: '移除网络资料？', body: `从网络资料列表移除「${w.title}」并删除它的本地缓存。\n工作资料中的引用会保留（显示为缺失），可以单独移除。网站本身不受影响。`, ok: '移除', danger: true });
    if (ok) await kb.webResourceRemove(w.resourceId);
  };
  return (
    <div className="kb-web-resources" data-testid="web-resources-panel">
      <div className="kb-web-resources-tools" hidden>
        <button className="kb-button kb-button--small" data-testid="web-open-url" onClick={() => void openUrlPrompt()}>
          打开网址…
        </button>
        <WebFlash />
      </div>
      <WebFlash />
      {list && list.length === 0 && <p className="kb-module-empty">还没有网络资料。点添加打开网址。</p>}
      <div className="kb-quiet-list">
        {(list ?? []).map((item) => (
          <div key={item.resourceId} className="kb-net-row" data-testid="web-resource-row" data-resource-id={item.resourceId} data-url={item.url} data-favorite={item.favorite ? 'true' : 'false'}
            draggable
            onDragStart={(e) => {
              const payload: DragPayload = {
                v: 1,
                items: [{
                  resourceId: item.resourceId,
                  sourceKind: 'web',
                  from: { kind: 'workspace-refs', workspaceId: webBridge.get()?.currentWorkspaceId() || '' },
                  entry: 'file',
                  name: item.title || item.host,
                }],
              };
              beginDrag(payload, e.dataTransfer);
            }}
            onDragEnd={() => endDrag()}
>
            <span className="kb-net-ic" aria-hidden="true"><GlobeIcon /></span>
            <button
              type="button"
              className="kb-net-main"
              title={(item.title || item.host) + '\n' + item.url}
              onClick={() => void openWebResource(item.resourceId)}
              data-testid="web-resource-open"
            >
              <b title={item.title || item.host}>{item.title || item.host}</b>
              <small title={item.host}>
                {item.host}
                {item.adapterId === WEB_FILE_ADAPTER ? ` · ${item.ext || '文件'}${item.cached ? ' · 已缓存' : ''}` : ' · 网页'}
                {isInsecureUrl(item.url) ? ' · 不安全连接' : ''}
              </small>
            </button>
            <span className="kb-net-actions">
              <AgentAddIconButton
                testId="agent-add-web"
                className="kb-mini-btn"
                refs={[{ resourceId: item.resourceId, absPath: "", name: item.title || item.host }]}
              />
              <button type="button" className="kb-mini-btn" title={item.favorite ? '取消收藏' : '收藏'} data-testid="web-resource-star" onClick={() => void kb.webResourceUpdate(item.resourceId, { favorite: !item.favorite })}>
                <StarIcon filled={!!item.favorite} />
              </button>
              <button type="button" className="kb-mini-btn" title="加入本工作资料" data-testid="web-resource-addref" onClick={() => void addRef(item)}>
                +
              </button>
              <button type="button" className="kb-mini-btn" title="复制网址" data-testid="web-resource-copy" onClick={() => void copyUrl(null, item.url)}>
                <ExternalLinkIcon />
              </button>
              {item.adapterId === WEB_FILE_ADAPTER && (
                <button type="button" className="kb-linkish" title="保存" data-testid="web-resource-save" onClick={() => void saveToLocal({ resourceId: item.resourceId })}>
                  保存
                </button>
              )}
              <button type="button" className="kb-linkish danger" title="移除" data-testid="web-resource-remove" onClick={() => void remove(item)}>
                移除
              </button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
