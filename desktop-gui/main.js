// main.js v2.0 — DeepSeek Harness GUI
//
// Electron main process for the DeepSeek Harness (dsh) Web UI wrapper.
// v2.0: Uses BackgroundService for dsh web server, Python/PowerShell detection,
// service health monitoring, and graceful degradation.
//
// ALL child processes go through process-manager.js v2.0 → windowsHide:true + shell:false.
// No black console window ever appears — not for Node, Python, PowerShell, or dsh backend.

const { app, BrowserWindow, dialog, Menu, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// Unified process manager v2.0 — the ONE chokepoint for all process spawning.
const pm = require('./process-manager');

// Load updater lazily.
let updater = null;
try {
  updater = require('./updater');
} catch (e) {
  console.warn('[updater] failed to load updater module:', e.message);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const APP_DIR = __dirname;
const ROOT_DIR = path.join(APP_DIR, '..');
const NODE_DIR = path.join(ROOT_DIR, 'node-v22.19.0-win-x64');
const GIT_CMD_DIR = path.join(ROOT_DIR, 'portablegit', 'cmd');
const DSH_DIR = path.join(ROOT_DIR, 'deepseek-harness-master');
const NODE_EXE = path.join(NODE_DIR, 'node.exe');

const WEB_URL = 'http://127.0.0.1:3080';
const WINDOW_TITLE = 'DeepSeek Harness';
const SERVER_TIMEOUT_MS = 90 * 1000;
const POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;

// ---------------------------------------------------------------------------
// Resolve Node.js executable
// ---------------------------------------------------------------------------
function resolveNodeExe() {
  if (fs.existsSync(NODE_EXE)) {
    console.log('[node] using portable:', NODE_EXE);
    return NODE_EXE;
  }
  const sysNode = pm.resolveExecutable('node');
  if (sysNode) {
    console.log('[node] using system:', sysNode);
    return sysNode;
  }
  return null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let dshService = null;       // BackgroundService for dsh web server
let mainWindow = null;
let isShuttingDown = false;
let serverReady = false;
let serverAlreadyRunning = false;
let healthCheckTimer = null;
const dshLogs = [];
const runtimeInfo = {
  node: null,
  python: null,
  git: null,
  powershell: null,
};

// ---------------------------------------------------------------------------
// Environment: prepend portable Node + git to PATH, set DSH_SPAWN_WINDOWS_HIDE=1
// ---------------------------------------------------------------------------
function buildEnv() {
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const extraPaths = [];
  if (fs.existsSync(NODE_DIR)) extraPaths.push(NODE_DIR);
  if (fs.existsSync(GIT_CMD_DIR)) extraPaths.push(GIT_CMD_DIR);
  const existingPath = process.env.PATH || '';
  const newPath = [...extraPaths, existingPath].filter(Boolean).join(pathSep);

  return pm.buildHiddenEnv({
    PATH: newPath,
    ELECTRON_RUN_AS_NODE: undefined,
  });
}

// ---------------------------------------------------------------------------
// Detect runtime tools at startup (Python, Git, PowerShell)
// ---------------------------------------------------------------------------
function detectRuntimes() {
  // Node.js
  runtimeInfo.node = resolveNodeExe();

  // Python
  runtimeInfo.python = pm.detectPython();
  if (runtimeInfo.python) {
    console.log(`[runtime] Python detected: ${runtimeInfo.python.exe} (${runtimeInfo.python.version})`);
  } else {
    console.log('[runtime] Python not found — Python-based plugins will be unavailable');
  }

  // Git
  const gitExe = pm.resolveExecutable('git');
  if (fs.existsSync(path.join(GIT_CMD_DIR, 'git.exe'))) {
    runtimeInfo.git = path.join(GIT_CMD_DIR, 'git.exe');
  } else if (gitExe) {
    runtimeInfo.git = gitExe;
  }
  if (runtimeInfo.git) {
    console.log('[runtime] Git detected:', runtimeInfo.git);
  }

  // PowerShell
  const psExe = pm.resolveExecutable('powershell');
  if (psExe) {
    runtimeInfo.powershell = psExe;
    console.log('[runtime] PowerShell detected:', psExe);
  }
}

// ---------------------------------------------------------------------------
// dsh backend management via BackgroundService
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

  // ★ Register dsh as a BackgroundService — auto-restart on crash
  dshService = pm.registerService('dsh-web', nodeExe, args, {
    cwd: DSH_DIR,
    env: buildEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    maxRestarts: 3,
    autoRestart: true,
    restartDelayMs: 2000,
  });

  dshService.onOutput((stream, text) => {
    pushLog(text);
  });

  dshService.onExit((code, signal) => {
    console.log(`[dsh] service exited code=${code} signal=${signal}`);
    if (!isShuttingDown) {
      handleDshCrash(`dsh 进程意外退出（code=${code}, signal=${signal}）。`);
    }
  });

  dshService.onError((err) => {
    console.error('[dsh] service failed to spawn:', err);
    if (!isShuttingDown) {
      handleDshCrash(`无法启动 dsh 进程：\n${err.message}`);
    }
  });

  // Start the service
  dshService.start();
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
  if (dshService) {
    dshService.stop();
    dshService = null;
  }
}

// ---------------------------------------------------------------------------
// Health monitoring — periodically check if dsh service is alive
// ---------------------------------------------------------------------------
function startHealthMonitor() {
  if (healthCheckTimer) clearInterval(healthCheckTimer);

  healthCheckTimer = setInterval(() => {
    if (isShuttingDown) return;

    const status = pm.healthCheck();
    const dshStatus = status['dsh-web'];

    if (dshStatus && !dshStatus.alive && serverReady) {
      console.warn('[health] dsh-web service is down!');
      // The BackgroundService auto-restart handles this, but we log it
    }

    // Send status to renderer if window is open
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('health-status', {
        services: status,
        runtimes: {
          node: runtimeInfo.node ? 'OK' : 'missing',
          python: runtimeInfo.python ? runtimeInfo.python.version : 'not found',
          git: runtimeInfo.git ? 'OK' : 'missing',
          powershell: runtimeInfo.powershell ? 'OK' : 'missing',
        },
      });
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthMonitor() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
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
    // Start health monitoring after server is ready
    startHealthMonitor();
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
// Application menu
// ---------------------------------------------------------------------------
function setupMenu() {
  const template = [
    {
      label: 'DeepSeek Harness',
      submenu: [
        {
          label: '检查更新',
          click: () => {
            if (!updater) {
              dialog.showErrorBox('检查更新失败', '更新模块未加载，请重启应用或检查网络设置。');
              return;
            }
            updater.checkAndPromptUpdate().catch((e) => {
              dialog.showErrorBox('检查更新失败', e.message);
            });
          },
        },
        { type: 'separator' },
        {
          label: '运行时状态',
          click: () => {
            const status = pm.getStatus();
            const runtimes = [
              `Node.js: ${runtimeInfo.node || '未找到'}`,
              `Python: ${runtimeInfo.python ? runtimeInfo.python.version + ' (' + runtimeInfo.python.exe + ')' : '未找到'}`,
              `Git: ${runtimeInfo.git || '未找到'}`,
              `PowerShell: ${runtimeInfo.powershell || '未找到'}`,
            ];
            const services = Object.entries(status.services).map(([name, s]) =>
              `${name}: ${s.alive ? '运行中 (PID:' + s.pid + ')' : '已停止'} (重启次数: ${s.restarts})`
            );
            dialog.showMessageBoxSync({
              type: 'info',
              title: '运行时状态 - DeepSeek Harness',
              message: '运行时环境',
              detail: [...runtimes, '', '后台服务:', ...services].join('\n'),
              buttons: ['确定'],
            });
          },
        },
        {
          label: '重启 dsh 服务',
          click: () => {
            if (dshService) {
              dialog.showMessageBoxSync({
                type: 'info',
                title: '重启服务',
                message: '正在重启 dsh web 服务...',
                buttons: ['确定'],
              });
              serverReady = false;
              dshService.restart();
              loadWebUI();
            }
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
// IPC handlers — allow renderer to query runtime info and run hidden commands
// ---------------------------------------------------------------------------
function setupIpc() {
  ipcMain.handle('pm:getStatus', () => {
    return pm.getStatus();
  });

  ipcMain.handle('pm:getRuntimes', () => {
    return {
      node: runtimeInfo.node,
      python: runtimeInfo.python,
      git: runtimeInfo.git,
      powershell: runtimeInfo.powershell,
    };
  });

  ipcMain.handle('pm:runPython', async (event, scriptPath, args, options) => {
    try {
      const child = pm.runPythonHidden(scriptPath, args || [], options || {});
      let stdout = '';
      let stderr = '';
      if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); });
      return new Promise((resolve) => {
        child.on('exit', (code) => resolve({ code, stdout, stderr }));
        child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
      });
    } catch (e) {
      return { code: -1, stdout: '', stderr: e.message };
    }
  });

  ipcMain.handle('pm:runPowerShell', async (event, command, options) => {
    try {
      const result = pm.runPowerShellHidden(command, options || {});
      return {
        code: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (e) {
      return { code: -1, stdout: '', stderr: e.message };
    }
  });
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
    // Detect runtime tools first
    detectRuntimes();

    setupMenu();
    setupIpc();

    const alreadyUp = await isServerUp(WEB_URL, 1500);
    if (alreadyUp) {
      serverAlreadyRunning = true;
      console.log('[dsh] detected an existing server on 3080, reusing it');
    } else {
      startDsh();
    }
    createWindow();
    await loadWebUI();

    // Check for updates after 2s
    setTimeout(() => {
      if (updater) {
        updater.checkAndPromptUpdate().catch((e) => {
          console.error('[updater] error:', e.message);
        });
      }
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
    isShuttingDown = true;
    stopHealthMonitor();
    killDsh();
    pm.killAll();
  });

  app.on('window-all-closed', () => {
    isShuttingDown = true;
    stopHealthMonitor();
    killDsh();
    pm.killAll();
    app.quit();
  });
}
