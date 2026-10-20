/**
 * UiNode 渲染器（H4）：只用 React 文本节点（textContent）输出插件给的字符串，没有任何 innerHTML / href / src / style 透传；
 * 外观全部来自主题令牌（.kb-ui-* 类），主题切换自动生效。输入应先经过 sanitizeUiNode。
 */
import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { JsonValue, UiNode, UiTreeNode } from '../../shared/adapter-sdk/types';

type OnAction = (action: string, payload: JsonValue | undefined) => void;

function Tree({ nodes, toggleAction, onAction, depth }: { nodes: UiTreeNode[]; toggleAction: string; onAction: OnAction; depth: number }) {
  return (
    <ul className="kb-ui-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((n, i) => {
        const hasKids = Array.isArray(n.children);
        return (
          <li key={n.id + ':' + i} role="treeitem" aria-expanded={hasKids ? !!n.expanded : undefined} data-node-id={n.id}>
            <div className="kb-ui-tree-row" style={{ paddingLeft: depth * 14 }}>
              {hasKids ? (
                <button className="kb-ui-tree-toggle" data-testid="ui-tree-toggle" aria-label={n.expanded ? '折叠' : '展开'} onClick={() => onAction(toggleAction, n.id)}>
                  {n.expanded
                    ? <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" style={{ verticalAlign: 'middle' }} />
                    : <ChevronRight size={14} strokeWidth={1.75} aria-hidden="true" style={{ verticalAlign: 'middle' }} />}
                </button>
              ) : (
                <span className="kb-ui-tree-toggle" />
              )}
              <span className="kb-ui-tree-label">{n.label}</span>
              {n.detail !== undefined && <span className="kb-ui-tree-detail">{n.detail}</span>}
            </div>
            {hasKids && n.expanded && n.children!.length > 0 && <Tree nodes={n.children!} toggleAction={toggleAction} onAction={onAction} depth={depth + 1} />}
          </li>
        );
      })}
    </ul>
  );
}

export function UiNodeView({ node, onAction }: { node: UiNode; onAction: OnAction }): React.ReactElement {
  switch (node.type) {
    case 'text':
      return <p className={'kb-ui-text' + (node.mono ? ' mono' : '')} data-tone={node.tone ?? 'normal'}>{node.text}</p>;
    case 'heading': {
      const H = (`h${node.level ?? 2}`) as 'h1' | 'h2' | 'h3';
      return <H className="kb-ui-heading">{node.text}</H>;
    }
    case 'code':
      return <pre className="kb-ui-code">{node.text}</pre>;
    case 'badge':
      return <span className="kb-badge kb-ui-badge" data-tone={node.tone ?? 'normal'}>{node.label}</span>;
    case 'button':
      return (
        <button className={'kb-button kb-button--small' + (node.variant === 'primary' ? '' : node.variant === 'ghost' ? ' kb-button--ghost' : ' kb-button--secondary')} disabled={node.disabled} data-testid="ui-button" data-action={node.action} onClick={() => onAction(node.action, node.payload)}>
          {node.label}
        </button>
      );
    case 'stack':
      return (
        <div className="kb-ui-stack" data-direction={node.direction ?? 'column'}>
          {node.children.map((c, i) => (
            <UiNodeView key={i} node={c} onAction={onAction} />
          ))}
        </div>
      );
    case 'keyValue':
      return (
        <dl className="kb-ui-kv">
          {node.rows.map((r, i) => (
            <React.Fragment key={i}>
              <dt>{r.key}</dt>
              <dd>{r.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      );
    case 'tree':
      return <Tree nodes={node.nodes} toggleAction={node.toggleAction} onAction={onAction} depth={0} />;
    case 'notice':
      return (
        <div className="kb-ui-notice" data-tone={node.tone} role={node.tone === 'error' ? 'alert' : 'status'}>
          <div className="kb-ui-notice-title">{node.title}</div>
          {node.message && <div className="kb-ui-notice-message">{node.message}</div>}
          {node.actions?.length ? (
            <div className="kb-ui-notice-actions">
              {node.actions.map((a, i) => (
                <button key={i} className="kb-button kb-button--secondary kb-button--small" data-testid="ui-button" data-action={a.action} onClick={() => onAction(a.action, a.payload)}>
                  {a.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
  }
}

