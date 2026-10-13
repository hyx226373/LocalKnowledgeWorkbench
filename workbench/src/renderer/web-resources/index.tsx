/**
 * 内置插件“网络资料”（第 11 轮 A · 星图组）：
 *  - 适配器 web.file：公开直链（PDF / 图片 / md / txt）缓存后交给内置阅读器（WebFileView）
 *  - 侧栏面板“网络资料”（WebResourcesPanel）
 *  - 命令（总包 §2.6 登记）：web.openUrl（打开网址…）、web.addToRefs（把当前网页加入本工作的资料）、web.copyUrl（复制网址）
 * 网页本身由随应用内置的沙箱适配器 web.generic 显示（resources/builtin-adapters/web.generic，主进程载入）。
 */
import './web-resources.css';
import { HOST_API_VERSION, type PluginModule } from '../plugin-host/types';
import { WEB_FILE_ADAPTER, webExtOfUrl } from '../../shared/webResources';
import { WebFileView, type WebFileState } from './WebFileView';
import { WebResourcesPanel } from './WebResourcesPanel';
import { addToRefs, copyUrl, openUrlPrompt } from './webActions';

export { openUrl, openUrlPrompt, openWebResource, webBridge, addToRefs, copyUrl, saveToLocal, lastCopied, lastSaved } from './webActions';

const plugin: PluginModule = {
  manifest: { id: 'builtin.web-resources', name: '网络资料', version: '1.0.0', engines: { workbench: `^${HOST_API_VERSION}` }, description: '网址作为资料：直链阅读器、侧栏网络资料、打开网址 / 加入工作资料 / 复制网址' },
  activate(api) {
    api.adapters.register<WebFileState>({
      id: WEB_FILE_ADAPTER,
      title: '网络文件（直链 PDF / 图片 / 文本）',
      sourceKinds: ['web'],
      displayMode: 'in-app-web',
      stateSchemaVersion: 1,
      // 白名单扩展名的直链：优先于 web.generic（1），低于第三方站点适配器（50+）
      match: (t) => (t.sourceKind === 'web' && webExtOfUrl(t.url) ? 10 : 0),
      restoreState: (raw) => {
        const r = raw as WebFileState | null;
        const i = r && typeof r === 'object' ? r.inner : undefined;
        return i && typeof i === 'object' && typeof i.adapterId === 'string' && typeof i.v === 'number' ? { inner: i } : {};
      },
      component: WebFileView,
    });
    api.panels.register({ id: 'web.resources', title: '网络资料', location: 'sidebar', order: 60, component: WebResourcesPanel });
    api.commands.register({ id: 'web.openUrl', title: '打开网址…', category: '网页', run: () => openUrlPrompt() });
    api.commands.register({ id: 'web.addToRefs', title: '把当前网页加入本工作的资料', category: '网页', run: () => addToRefs() });
    api.commands.register({ id: 'web.copyUrl', title: '复制当前网页的网址', category: '网页', run: () => copyUrl() });
  },
};
export default plugin;
