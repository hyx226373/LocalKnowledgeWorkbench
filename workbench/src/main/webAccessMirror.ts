import type { WebAccessSnap, WebPluginSnap } from './webPanels';

/** 主进程里的网页授权副本。创建面板前由数据进程填好，读取本身不碰数据库。 */
export class WebAccessMirror {
  private snaps = new Map<string, WebAccessSnap>();
  private plugins: WebPluginSnap[] = [];

  put(pluginId: string, adapterId: string, snap: WebAccessSnap) {
    this.snaps.set(`${pluginId}\0${adapterId}`, snap);
  }

  setPlugins(list: WebPluginSnap[]) {
    this.plugins = Array.isArray(list) ? list : [];
  }

  webAccess(pluginId: string, adapterId: string): WebAccessSnap {
    const snap = this.snaps.get(`${pluginId}\0${adapterId}`);
    if (!snap) throw new Error(`网页访问信息还没有：${pluginId}/${adapterId}`);
    return snap;
  }

  webPlugins(): WebPluginSnap[] {
    return this.plugins;
  }

  onGrantsChanged(cb: (pluginId: string) => void): () => void {
    void cb;
    return () => undefined;
  }
}
