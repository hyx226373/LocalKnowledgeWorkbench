/**
 * 实测：主窗 webContents.capturePage 会不会包含子 WebContentsView。
 * 不移动鼠标，窗口 show:false。结果写到补证目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, nativeImage } from 'electron';

const outDir = process.argv[2] || process.env.KB_R40_PROOF_DIR;
if (!outDir) {
  console.error('缺少输出目录');
  app.exit(2);
}

function sampleXor(buf) {
  let xor = 0;
  for (let i = 0; i < buf.length; i += 64) xor ^= buf[i];
  return xor & 0xff;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 640,
    height: 480,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.show();
  await win.loadURL('data:text/html,<body style="margin:0;background:%23111"></body>');
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 40, y: 40, width: 200, height: 120 });
  await view.webContents.loadURL('data:text/html,<body style="margin:0;background:%23ff0044"></body>');
  await new Promise((r) => setTimeout(r, 800));
  const mainPng = (await win.webContents.capturePage()).toPNG();
  let childPng = null;
  let childError = '';
  try {
    childPng = (await view.webContents.capturePage()).toPNG();
  } catch (err) {
    childError = String(err && err.message ? err.message : err);
  }
  const bitmap = nativeImage.createFromBuffer(mainPng).toBitmap();
  let red = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    if (r > 200 && g < 40 && b < 90) red += 1;
  }
  const mainXor = sampleXor(mainPng);
  const childXor = childPng ? sampleXor(childPng) : null;
  const result = {
    method: 'BrowserWindow.webContents.capturePage，旁有一块 #ff0044 的 WebContentsView',
    mainBytes: mainPng.length,
    childBytes: childPng ? childPng.length : 0,
    childError,
    mainXor,
    childXor,
    redPixelsInMainCapture: red,
    includesNativeWeb: red > 50,
    note: '主窗页面是 #111。子视图是 #ff0044。主图里几乎没有这种红像素，就是 capturePage 没有把原生网页画进去。',
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'web-probe.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, 'web-probe-main.png'), mainPng);
  if (childPng) fs.writeFileSync(path.join(outDir, 'web-probe-child.png'), childPng);
  console.log(JSON.stringify(result));
  app.exit(0);
}).catch((err) => {
  fs.writeFileSync('D:/kb-r13-work/r40-probe-error.txt', String(err && err.stack ? err.stack : err));
  app.exit(1);
});
