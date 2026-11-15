'use strict';
// Cortex.os — غلاف سطح المكتب الحقيقي (Electron)
// يشغّل خادم Cortex المحلي إن لم يكن يعمل، ثم يفتح نافذة تطبيق أصلية.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = Number(process.env.APP_PORT || 3737);
const URL = `http://127.0.0.1:${PORT}/`;
let serverChild = null;

function ping() {
  return new Promise(resolve => {
    const req = http.get(URL + 'api/status', res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}

async function waitReady(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await ping()) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function ensureServer() {
  if (await ping()) return true;
  serverChild = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'ignore',
    windowsHide: true
  });
  serverChild.on('error', () => {});
  return waitReady(20000);
}

function stopServer() {
  if (serverChild) { try { serverChild.kill(); } catch {} serverChild = null; }
}

app.whenReady().then(async () => {
  const ok = await ensureServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    title: 'Cortex.os',
    backgroundColor: '#101318',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  });
  if (ok) {
    await win.loadURL(URL);
  } else {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(
      '<body style="background:#101318;color:#e8ecf1;font-family:sans-serif;display:grid;place-items:center;height:100vh">' +
      '<div style="text-align:center"><h2>تعذّر تشغيل خادم Cortex المحلي</h2><p>جرّب تشغيل <code>npm start</code> يدويًا ثم أعد فتح التطبيق.</p></div></body>'
    ));
  }
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
});

app.on('window-all-closed', () => { stopServer(); app.quit(); });
app.on('before-quit', stopServer);
process.on('exit', stopServer);
