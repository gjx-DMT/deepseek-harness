// main.js
// Electron main process for the DeepSeek Harness (dsh) Web UI wrapper.
//
// Responsibilities:
//   1. Resolve Node.js (portable alongside repo, or system PATH).
//   2. Spawn the `dsh web` backend as a child process.
//   3. Wait until http://127.0.0.1:3080 responds, then load it in a BrowserWindow.
//   4. Cleanly kill the dsh process tree on quit.
//   5. Surface a dialog if dsh crashes / fails to start.

const { app, BrowserWindow, dialog, Menu } = require('electron');
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const updater = require('./updater');

// ---------------------------------------------------------------------------
// Paths
//   desktop-gui/           <- __dirname (APP_DIR)
//   ..                      <- repo root = dsh source dir (DSH_DIR)
//   ../../node-v22.19.0...  <- portable Node.js (optional, dev only)
//   ../../portablegit/cmd   <- portable git (optional, dev only)
// ---------------------------------------------------------------------------
const APP_DIR = __dirname;
const DSH_DIR = path.join(APP_DIR, '..');
const PARENT_DIR = path.join(DSH_DIR, '..');
const PORTABLE_NODE_DIR = path.join(PARENT_DIR, 'node-v22.19.0-win-x64');
const PORTABLE_GIT_DIR = path.join(PARENT_DIR, 'portablegit', 'cmd');

const WEB_URL = 'http://127.0.0.1:3080';
const WINDOW_TITLE = 'DeepSeek Harness';
const SERVER_TIMEOUT_MS = 90 * 1000;
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Resolve Node.js executable
//   1. Portable Node alongside repo (dev environment)
//   2. System Node in PATH (cloned-from-GitHub environment)
// ---------------------------------------------------------------------------
function resolveNodeExe() {
  const portableExe = path.join(PORTABLE_NODE_DIR, 'node.exe');
  if (fs.existsSync(portableExe)) {
    console.log('[node] using portable:', portableExe);
    return portableExe;
  }
  // Fall back to system Node
  try {
    const sysNode = execSync('where node', { encoding: 'utf-8' }).trim().split(/\r?\n/)[0];
    if (sysNode && fs.existsSync(sysNode)) {
      console.log('[node] using system:', sysNode);
      return sysNode;
    }
  } catch (_) { /* not in PATH */ }
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let dshProcess = null;
let mainWindow = null;
let isShuttingDown = false;
let serverReady = false;
let serverAlreadyRunning = false;
const dshLogs = [];

// ---------------------------------------------------------------------------
// Environment: prepend portable Node + git to PATH if available
// ---------------------------------------------------------------------------
function buildEnv() {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const extraPaths = [];
  if (fs.existsSync(PORTABLE_NODE_DIR)) extraPaths.push(PORTABLE_NODE_DIR);
  if (fs.existsSync(PORTABLE_GIT_DIR)) extraPaths.push(PORTABLE_GIT_DIR);
  const existingPath = process.env.PATH || '';
  const newPath = [...extraPaths, existingPath].filter(Boolean).join(pathSep);
  return {
    ...process.env,
    PATH: newPath,
    ELECTRON_RUN_AS_NODE: undefined,
  };
}

// ---------------------------------------------------------------------------
// dsh backend management
// ---------------------------------------------------------------------------
function pushLog(chunk) {
  const text = chunk.toString();
  dshLogs.push(text);
  if (dshLogs.length > 500) dshLogs.shift();
  console.log('[dsh]', text.trimEnd());
}

function startDsh() {
  const nodeExe = resolveNodeExe();
  if (!nodeExe) {
    dialog.showErrorBox(
      'DeepSeek Harness - Node.js 未找到',
      '未找到 Node.js 可执行文件。\n\n' +
      '请安装 Node.js v22.19+ (https://nodejs.org/)，\n' +
      '或将便携版 node-v22.19.0-win-x64 放在仓库同级目录下。',
    );
    app.quit();
    return;
  }

  const args = ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web'];
  dshProcess = spawn(nodeExe, args, {
    cwd: DSH_DIR,
    env: buildEnv(),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (dshProcess.stdout) dshProcess.stdout.on('data', pushLog);
  if (dshProcess.stderr) dshProcess.stderr.on('data', pushLog);

  dshProcess.on('exit', (code, signal) => {
    console.log(`[dsh] process exited code=${code} signal=${signal}`);
    if (!isShuttingDown) {
      handleDshCrash(`dsh 进程意外退出（code=${code}, signal=${signal}）。`);
    }
  });

  dshProcess.on('error', (err) => {
    console.error('[dsh] failed to spawn:', err);
    if (!isShuttingDown) {
      handleDshCrash(`无法启动 dsh 进程：\n${err.message}`);
    }
  });
}

function handleDshCrash(reason) {
  const tail = dshLogs.slice(-40).join('').trim() || '(无输出)';
  const message =
    `${reason}\n\n` +
    `最近日志：\n${tail}\n\n` +
    `请尝试在仓库根目录手动运行：\n` +
    `node --import tsx/esm apps/cli/src/bin.ts web\n\n` +
    `应用将退出。`;
  dialog.showErrorBox('DeepSeek Harness - dsh 异常', message);
  app.quit();
}

function killDsh() {
  if (!dshProcess) return;
  isShuttingDown = true;
  const pid = dshProcess.pid;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      try { dshProcess.kill('SIGTERM'); } catch (_) { /* ignore */ }
    }
  } catch (e) {
    console.log('[dsh] kill notice (probably already dead):', e.message);
  } finally {
    dshProcess = null;
  }
}

// ---------------------------------------------------------------------------
// Wait for the web server to respond
// ---------------------------------------------------------------------------
function isServerUp(url, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeout, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitForServer(url, timeout = SERVER_TIMEOUT_MS, interval = POLL_INTERVAL_MS) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const attempt = () => {
      if (isShuttingDown) return reject(new Error('应用正在关闭'));

      const req = http.get(url, (res) => {
        res.destroy();
        resolve();
      });

      req.on('error', () => {
        if (isShuttingDown) return reject(new Error('应用正在关闭'));
        if (Date.now() - startedAt >= timeout) {
          reject(new Error(`服务器在 ${Math.round(timeout / 1000)}s 内未就绪`));
        } else {
          setTimeout(attempt, interval);
        }
      });

      req.setTimeout(3000, () => {
        req.destroy(new Error('request timeout'));
      });
    };

    attempt();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const LOADING_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>正在启动</title>
<style>
  html, body { margin: 0; height: 100%; background: #0f172a; color: #e2e8f0;
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; gap: 28px; }
  .title { font-size: 26px; font-weight: 600; letter-spacing: .5px; }
  .sub { font-size: 14px; color: #94a3b8; }
  .spinner { width: 46px; height: 46px; border: 4px solid #1e293b;
    border-top-color: #38bdf8; border-radius: 50%; animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
  <div class="wrap">
    <div class="spinner"></div>
    <div class="title">正在启动 DeepSeek Harness</div>
    <div class="sub">正在后台拉起 dsh web 服务，请稍候…</div>
  </div>
</body>
</html>`;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: WINDOW_TITLE,
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(APP_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setTitle(WINDOW_TITLE);
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    if (!validatedURL || !/^https?:/i.test(validatedURL)) return;
    console.error('[window] did-fail-load', errorCode, errorDescription, validatedURL);
    if (!isShuttingDown && !serverReady) {
      dialog.showErrorBox(
        'DeepSeek Harness - 页面加载失败',
        `无法加载 dsh Web UI (${validatedURL})：\n${errorDescription} (code ${errorCode})\n\n` +
        (serverAlreadyRunning
          ? '当前复用的是已存在的 dsh 服务，该服务可能已停止。'
          : 'dsh 服务可能尚未就绪，请稍后重试或查看日志。'),
      );
    }
  });

  mainWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(LOADING_HTML));
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function loadWebUI() {
  try {
    await waitForServer(WEB_URL);
    serverReady = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(WEB_URL);
      mainWindow.setTitle(WINDOW_TITLE);
      mainWindow.focus();
    }
  } catch (e) {
    const tail = dshLogs.slice(-40).join('').trim() || '(无输出)';
    dialog.showErrorBox(
      'DeepSeek Harness - 启动失败',
      `无法连接到 dsh Web 服务：\n${e.message}\n\n最近日志：\n${tail}\n\n` +
      `请尝试在仓库根目录手动运行：\n` +
      `node --import tsx/esm apps/cli/src/bin.ts web`,
    );
    killDsh();
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// Application menu: includes manual update check
// ---------------------------------------------------------------------------
function setupMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            updater.checkAndPromptUpdate().catch((e) => {
              dialog.showErrorBox('检查更新失败', e.message);
            });
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '刷新页面' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    setupMenu();

    const alreadyUp = await isServerUp(WEB_URL, 1500);
    if (alreadyUp) {
      serverAlreadyRunning = true;
      console.log('[dsh] detected an existing server on 3080, reusing it');
    } else {
      startDsh();
    }
    createWindow();
    await loadWebUI();

    // After the UI is loaded, check for remote updates in the background.
    // Delay 2s so the user sees the UI first before any update dialog.
    setTimeout(() => {
      updater.checkAndPromptUpdate().catch((e) => {
        console.error('[updater] error:', e.message);
      });
    }, 2000);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (serverReady && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(WEB_URL);
      }
    }
  });

  app.on('before-quit', () => {
    killDsh();
  });

  app.on('window-all-closed', () => {
    killDsh();
    app.quit();
  });
}
