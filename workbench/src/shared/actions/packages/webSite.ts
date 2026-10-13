/**
 * 网页外部资源授权。桥可以提出，批准只在人机界面。
 * 不注册执行体：approvalRequired 时桥直接返回 awaiting_approval。
 */
import { registerActions } from '../registry';
import type { ActionInput } from '../types';

const site = { type: 'string', minLength: 1, description: '可注册域名，例如 example.com' };

function args(required: string[], properties: Record<string, object>, description: string): object {
  return { type: 'object', additionalProperties: false, required, properties, description };
}

export const WEB_SITE_ACTION_INPUTS: readonly ActionInput[] = [
  {
    actionId: 'web.allowSite',
    title: '按网站允许或拒绝外部资源',
    category: '网页',
    source: 'web',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['site', 'choice'], { site, choice: { enum: ['session', 'always', 'deny'], description: '允许本次、始终允许或拒绝' } }, '人机界面选择。桥只提出，不写入授权。'),
  },
  {
    actionId: 'web.allowAllBlocked',
    title: '全部允许当前被拦网站',
    category: '网页',
    source: 'web',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['sites'], { sites: { type: 'array', items: site, minItems: 1 } }, '一键放行当前提示条里的网站。来源记为 allow-all。'),
  },
  {
    actionId: 'web.neverBlock',
    title: '从不拦截外部资源',
    category: '网页',
    source: 'web',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args([], { site, global: { type: 'boolean' }, enabled: { type: 'boolean' } }, '单个网站，或全局开关。全局开关须在界面上看到「所有网页面板将不再拦截外部资源」。'),
  },
  {
    actionId: 'web.revokeSite',
    title: '撤销网站授权',
    category: '网页',
    source: 'web',
    bridgeInvokable: true,
    approvalRequired: true,
    argsSchema: args(['site'], { site }, '从配置里去掉该网站。之后外部资源会再次询问。'),
  },
];

let undo: (() => void) | null = null;

export function registerWebSitePackage(): void {
  if (undo) return;
  undo = registerActions('web', WEB_SITE_ACTION_INPUTS);
}

export function disposeWebSitePackage(): void {
  undo?.();
  undo = null;
}
