// process-manager.js v2.0
// Unified process manager for DeepSeek Harness GUI.
//
// GUARANTEE: EVERY child process spawned through this module runs with
// windowsHide:true + shell:false on Windows. No black console window ever
// appears — not for Node.js, not for Python, not for PowerShell, not for
// any dsh backend subprocess.
//
// v2.0 upgrades:
//   - BackgroundService: long-running process lifecycle (start/stop/restart/health)
//   - Python runner: detect python.exe, run scripts hidden
//   - Service registry: track all background services, health-check, graceful shutdown
//   - ConPTY hint: set env vars so node-pty/ConPTY don't create visible windows
//   - Process groups: Windows Job Object-style cleanup via taskkill /T
//
// Inspired by ximo-Agent's TerminalExecTool and DeerFlow 2.0's service layer.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

// ---------------------------------------------------------------------------
// Tracked live processes (for graceful shutdown)
// ---------------------------------------------------------------------------
const liveProcesses = new Set();
const services = new Map(); // name → BackgroundService instance

// ---------------------------------------------------------------------------
// CORE: hiddenSpawn — the ONE function every process launch must go through.
//
// On Windows, windowsHide:true sets STARTF_USESHOWWINDOW + SW_HIDE on the
// child's STARTUPINFO, so even if the child creates a console it stays
// invisible. Combined with shell:false (no cmd.exe wrapper) this
// eliminates ALL black console windows.
// ---------------------------------------------------------------------------
function hiddenSpawn(command, args, options = {}) {
  const opts = {
    ...options,
    windowsHide: true,   // ★★★ core: hide console window on Windows
    shell: false,         // ★★★ core: never go through cmd.exe
  };

  const child = spawn(command, args, opts);

  if (child && child.pid) {
    liveProcesses.add(child);
    child.on('exit', () => liveProcesses.delete(child));
    child.on('error', () => liveProcesses.delete(child));
  }

  return child;
}

// ---------------------------------------------------------------------------
// Hidden spawnSync — synchronous version, same guarantees.
// ---------------------------------------------------------------------------
function hiddenSpawnSync(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    windowsHide: true,
    shell: false,
  });
}

// ---------------------------------------------------------------------------
// Executable resolution — no shell, no black window.
// Checks portable paths, then `where`/`which` via hiddenSpawnSync.
// ---------------------------------------------------------------------------
function resolveExecutable(name) {
  const portablePaths = [
    path.join(__dirname, '..', '..', 'node-v22.19.0-win-x64', `${name}.exe`),
    `C:\\Program Files\\nodejs\\${name}.exe`,
    `C:\\Program Files (x86)\\nodejs\\${name}.exe`,
  ];

  for (const p of portablePaths) {
    if (fs.existsSync(p)) return p;
  }

  if (process.platform === 'win32') {
    const result = hiddenSpawnSync('where', [name], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstLine = result.stdout.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) return firstLine;
    }
  } else {
    const result = hiddenSpawnSync('which', [name], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const p = result.stdout.trim();
      if (p && fs.existsSync(p)) return p;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Python detection — find python.exe / python3.exe / py.exe
// Returns { exe, version } or null.
// ---------------------------------------------------------------------------
function detectPython() {
  const candidates = [];

  // 1. Portable Python alongside repo
  const portablePythonDirs = [
    path.join(__dirname, '..', '..', 'python'),
    path.join(__dirname, '..', '..', 'python3'),
    path.join(__dirname, '..', '..', 'python-3.12'),
  ];
  for (const dir of portablePythonDirs) {
    if (fs.existsSync(dir)) {
      candidates.push(path.join(dir, 'python.exe'));
      candidates.push(path.join(dir, 'python3.exe'));
    }
  }

  // 2. Common system locations
  if (process.platform === 'win32') {
    candidates.push('C:\\Python312\\python.exe');
    candidates.push('C:\\Python311\\python.exe');
    candidates.push('C:\\Python310\\python.exe');
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'));
    candidates.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe'));
  }

  // 3. PATH lookup via where/which (hidden)
  const pathResult = resolveExecutable('python') || resolveExecutable('python3');
  if (pathResult) candidates.push(pathResult);

  // 4. Windows py launcher
  if (process.platform === 'win32') {
    const pyLauncher = resolveExecutable('py');
    if (pyLauncher) candidates.push(pyLauncher);
  }

  // Try each candidate and get version
  for (const exe of candidates) {
    if (!exe || !fs.existsSync(exe)) continue;
    try {
      const result = hiddenSpawnSync(exe, ['--version'], {
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (result.status === 0) {
        const version = (result.stdout || result.stderr || '').trim();
        return { exe, version: version || 'unknown' };
      }
    } catch (_) { /* try next */ }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Run a Python script hidden — no black window.
// Returns the child process (async) or result (sync).
// ---------------------------------------------------------------------------
function runPythonHidden(scriptPath, args = [], options = {}) {
  const py = detectPython();
  if (!py) {
    throw new Error('Python not found. Install Python 3.10+ or place it alongside the repo.');
  }

  const fullArgs = [scriptPath, ...args];
  return hiddenSpawn(py.exe, fullArgs, {
    cwd: options.cwd || path.dirname(scriptPath),
    env: buildHiddenEnv(options.env),
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function runPythonHiddenSync(scriptPath, args = [], options = {}) {
  const py = detectPython();
  if (!py) {
    throw new Error('Python not found. Install Python 3.10+ or place it alongside the repo.');
  }

  const fullArgs = [scriptPath, ...args];
  return hiddenSpawnSync(py.exe, fullArgs, {
    cwd: options.cwd || path.dirname(scriptPath),
    env: buildHiddenEnv(options.env),
    encoding: 'utf-8',
    timeout: options.timeout || 120000,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Kill a process tree on Windows without a black window.
// ---------------------------------------------------------------------------
function killProcessTree(pid) {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    hiddenSpawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10000,
    });
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch (_) {}
    try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Run a PowerShell command hidden.
// ---------------------------------------------------------------------------
function runPowerShellHidden(command, options = {}) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command', command,
  ];

  const psExe = resolveExecutable('powershell') ||
    (process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell');

  return hiddenSpawnSync(psExe, args, {
    encoding: 'utf-8',
    timeout: options.timeout || 60000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env,
  });
}

// ---------------------------------------------------------------------------
// Run a PowerShell script file hidden.
// ---------------------------------------------------------------------------
function runPowerShellScriptHidden(scriptPath, options = {}) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', scriptPath,
  ];

  const psExe = resolveExecutable('powershell') ||
    (process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell');

  return hiddenSpawnSync(psExe, args, {
    encoding: 'utf-8',
    timeout: options.timeout || 120000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    cwd: options.cwd || path.dirname(scriptPath),
    env: options.env,
  });
}

// ---------------------------------------------------------------------------
// Extract a ZIP archive hidden (no black window).
// ---------------------------------------------------------------------------
function extractZipHidden(zipPath, destPath) {
  const cmd = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destPath}' -Force`;
  const result = runPowerShellHidden(cmd, { timeout: 120000 });

  if (result.status !== 0) {
    const err = result.stderr || result.stdout || '(no output)';
    throw new Error(`Extract-Archive failed (exit ${result.status}): ${err}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build environment with DSH_SPAWN_WINDOWS_HIDE=1 + ConPTY hints.
// The patched dsh backend checks DSH_SPAWN_WINDOWS_HIDE before spawning.
// ---------------------------------------------------------------------------
function buildHiddenEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    DSH_SPAWN_WINDOWS_HIDE: '1',
    // Hint for node-pty / ConPTY to not create visible windows
    ConPTY_NO_WINDOW: '1',
    // Python: don't show interactive prompts
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    // Node: suppress unnecessary output
    NODE_NO_WARNINGS: '1',
  };
}

// ===========================================================================
// BackgroundService — long-running process lifecycle management
//
// Manages a single child process that runs continuously (e.g. the dsh web
// server, a Python agent, a PowerShell worker). Provides:
//   - start(): spawn the process hidden
//   - stop(): kill the process tree hidden
//   - restart(): stop then start
//   - isAlive(): health check
//   - onExit/onError callbacks
//
// All spawning goes through hiddenSpawn → windowsHide:true + shell:false.
// ===========================================================================
class BackgroundService {
  constructor(name, command, args, options = {}) {
    this.name = name;
    this.command = command;
    this.args = args || [];
    this.options = options;
    this.child = null;
    this.restartCount = 0;
    this.maxRestarts = options.maxRestarts ?? 3;
    this.autoRestart = options.autoRestart ?? true;
    this.restartDelayMs = options.restartDelayMs ?? 2000;
    this._onExit = null;
    this._onError = null;
    this._onOutput = null;
    this._restartTimer = null;
    this._isStopping = false;
  }

  start() {
    if (this.child && this.child.pid) {
      console.log(`[service:${this.name}] already running (pid=${this.child.pid})`);
      return this.child;
    }

    this._isStopping = false;
    console.log(`[service:${this.name}] starting: ${this.command} ${this.args.join(' ')}`);

    const opts = {
      cwd: this.options.cwd,
      env: buildHiddenEnv(this.options.env),
      stdio: this.options.stdio || ['ignore', 'pipe', 'pipe'],
    };

    this.child = hiddenSpawn(this.command, this.args, opts);

    if (this.child.stdout) {
      this.child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        if (this._onOutput) this._onOutput('stdout', text);
        else console.log(`[service:${this.name}]`, text.trimEnd());
      });
    }
    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        if (this._onOutput) this._onOutput('stderr', text);
        else console.error(`[service:${this.name}]`, text.trimEnd());
      });
    }

    this.child.on('exit', (code, signal) => {
      console.log(`[service:${this.name}] exited code=${code} signal=${signal}`);
      if (this._onExit) this._onExit(code, signal);

      // Auto-restart on unexpected exit
      if (!this._isStopping && this.autoRestart && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        console.log(`[service:${this.name}] auto-restart ${this.restartCount}/${this.maxRestarts} in ${this.restartDelayMs}ms`);
        this._restartTimer = setTimeout(() => {
          if (!this._isStopping) this.start();
        }, this.restartDelayMs);
      }
    });

    this.child.on('error', (err) => {
      console.error(`[service:${this.name}] error:`, err.message);
      if (this._onError) this._onError(err);
    });

    return this.child;
  }

  stop() {
    this._isStopping = true;
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this.child && this.child.pid) {
      killProcessTree(this.child.pid);
    }
    this.child = null;
  }

  restart() {
    this.stop();
    this._isStopping = false;
    this.restartCount = 0;
    setTimeout(() => this.start(), 500);
  }

  isAlive() {
    return !!(this.child && this.child.pid && !this.child.killed);
  }

  getPid() {
    return this.child ? this.child.pid : null;
  }

  onExit(fn) { this._onExit = fn; return this; }
  onError(fn) { this._onError = fn; return this; }
  onOutput(fn) { this._onOutput = fn; return this; }
}

// ---------------------------------------------------------------------------
// Service registry — register, start, stop, health-check all services
// ---------------------------------------------------------------------------
function registerService(name, command, args, options = {}) {
  if (services.has(name)) {
    console.log(`[registry] service "${name}" already exists, stopping old one`);
    services.get(name).stop();
  }
  const svc = new BackgroundService(name, command, args, options);
  services.set(name, svc);
  return svc;
}

function getService(name) {
  return services.get(name) || null;
}

function startAllServices() {
  for (const [name, svc] of services) {
    if (!svc.isAlive()) {
      console.log(`[registry] starting service: ${name}`);
      svc.start();
    }
  }
}

function stopAllServices() {
  for (const [name, svc] of services) {
    console.log(`[registry] stopping service: ${name}`);
    svc.stop();
  }
}

function healthCheck() {
  const results = {};
  for (const [name, svc] of services) {
    results[name] = {
      alive: svc.isAlive(),
      pid: svc.getPid(),
      restarts: svc.restartCount,
    };
  }
  return results;
}

// ---------------------------------------------------------------------------
// Graceful shutdown: kill all tracked live processes + all services
// ---------------------------------------------------------------------------
function killAll() {
  // Stop all registered services
  stopAllServices();

  // Kill all tracked live processes
  for (const child of liveProcesses) {
    try {
      if (child.pid) killProcessTree(child.pid);
    } catch (_) { /* already dead */ }
  }
  liveProcesses.clear();
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
function liveCount() {
  return liveProcesses.size;
}

function getStatus() {
  return {
    liveProcesses: liveCount(),
    services: healthCheck(),
  };
}

module.exports = {
  // v1.0 API (backward compatible)
  hiddenSpawn,
  hiddenSpawnSync,
  resolveExecutable,
  killProcessTree,
  runPowerShellHidden,
  runPowerShellScriptHidden,
  extractZipHidden,
  buildHiddenEnv,
  killAll,
  liveCount,
  // v2.0 additions
  detectPython,
  runPythonHidden,
  runPythonHiddenSync,
  BackgroundService,
  registerService,
  getService,
  startAllServices,
  stopAllServices,
  healthCheck,
  getStatus,
};
