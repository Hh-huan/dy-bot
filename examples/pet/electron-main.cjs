/**
 * 可选：把参考桌宠包成透明、置顶的 Windows 桌宠窗口。
 *
 * 使用：
 *   cd examples/pet
 *   npm install
 *   npm run start:electron
 *
 * 前提：先运行 node bridge/server.mjs，并让扩展连上桥接。
 */
const { app, BrowserWindow, screen } = require('electron');

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 360,
    height: 680,
    x: Math.max(20, width - 380),
    y: Math.max(20, height - 700),
    transparent: true,
    frame: false,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: '桌宠 · 直播助手',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadURL('http://127.0.0.1:8787/pet');
  win.on('closed', () => app.quit());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
