import { Menu, Tray, nativeImage } from 'electron';

function trayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    buf[o] = 0x3a;
    buf[o + 1] = 0x7d;
    buf[o + 2] = 0x2f;
    buf[o + 3] = 255;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 1 });
}

/** 托盘菜单在主进程。渲染进程卡死时，这两项仍然调用更新服务。 */
export function createUpdateTray(opts: { onCheck: () => void; onInstall: () => void; installEnabled: () => boolean }): { refresh: () => void; destroy: () => void } | null {
  try {
    const tray = new Tray(trayIcon());
    tray.setToolTip('本地知识工作台');
    const rebuild = () => {
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '检查更新', click: () => opts.onCheck() },
          { label: '打开下载链接', enabled: opts.installEnabled(), click: () => opts.onInstall() },
        ]),
      );
    };
    rebuild();
    return { refresh: rebuild, destroy: () => tray.destroy() };
  } catch (err) {
    console.error('[update] 托盘不可用', err);
    return null;
  }
}
