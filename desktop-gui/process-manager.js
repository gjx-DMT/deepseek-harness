// process-manager.js
// Unified process manager for DeepSeek Harness GUI.
//
// Guarantees that EVERY child process spawned by the Electron main process
// runs with windowsHide:true and shell:false on Windows, so no black
// console window ever flashes.  Inspired by ximo-Agent's TerminalExecTool
// pattern: a single chokepoint for all process spawning.
//
// Also patches the dsh backend's own spawn calls by injecting the
// DSH_SPAWN_WINDOWS_HIDE=1 environment variable, which the patched dsh
// source checks before spawning its own children.

const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ---------------------------------------------------------------------------
// Tracked live processes (for graceful shutdown)
// ---------------------------------------------------------------------------
const liveProcesses = new Set();

// ---------------------------------------------------------------------------
// Hidden spawn — the ONE function every process launch must go through.
//
// On Windows, windowsHide:true sets STARTF_USESHOWWINDOW + SW_HIDE on the
// child's STARTUPINFO, so even if the child creates a console it stays
// invisible.  Combined with shell:false (no cmd.exe wrapper) this
// eliminates all black console windows.
// ---------------------------------------------------------------------------
function hiddenSpawn(command, args, options = {}) {
  const opts = {
    ...options,
    windowsHide: true,   // ★★★ core: hide console window on Windows
    shell: false,         // ★★★ core: never go through cmd.exe
  };

  // On non-Windows platforms windowsHide is a no-op, so it's safe to
  // always set it.
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
// Used for short-lived commands (where node, taskkill, Expand-Archive).
// ---------------------------------------------------------------------------
function hiddenSpawnSync(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    windowsHide: true,
    shell: false,
  });
}

// ---------------------------------------------------------------------------
// Resolve an executable path without spawning a shell.
// Replaces `execSync('where node')` which creates a black window.
// ---------------------------------------------------------------------------
function resolveExecutable(name) {
  // 1. Check common portable locations first
  const portablePaths = [
    // Portable Node alongside repo
    path.join(__dirname, '..', '..', 'node-v22.19.0-win-x64', `${name}.exe`),
    // System locations
    `C:\\Program Files\\nodejs\\${name}.exe`,
    `C:\\Program Files (x86)\\nodejs\\${name}.exe`,
  ];

  for (const p of portablePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // 2. Check PATH using hiddenSpawnSync (no black window)
  if (process.platform === 'win32') {
    // Use `where` without a shell
    const result = hiddenSpawnSync('where', [name], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstLine = result.stdout.trim().split(/\r?\n/)[0];
      if (firstLine && fs.existsSync(firstLine)) {
        return firstLine;
      }
    }
  } else {
    // POSIX: use `which`
    const result = hiddenSpawnSync('which', [name], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const p = result.stdout.trim();
      if (p && fs.existsSync(p)) return p;
    }
  }

  // 3. Last resort: return the bare name and hope it's in PATH
  return null;
}

// ---------------------------------------------------------------------------
// Kill a process tree on Windows without a black window.
// Replaces `execSync('taskkill /PID ... /T /F')` which creates a black window.
// ---------------------------------------------------------------------------
function killProcessTree(pid) {
  if (!pid || pid <= 0) return;

  if (process.platform === 'win32') {
    // Use hiddenSpawnSync so no cmd.exe window appears
    hiddenSpawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      timeout: 10000,
    });
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (_) { /* ignore */ }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (_) { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Run a PowerShell command hidden.
// Replaces `execSync('powershell -NoProfile -Command "..."')`.
//
// Returns { status, stdout, stderr } synchronously.
// ---------------------------------------------------------------------------
function runPowerShellHidden(command, options = {}) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command', command,
  ];

  // Find powershell.exe without a shell
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
// Extract a ZIP archive hidden (no black window).
// Uses PowerShell's Expand-Archive under the hood but runs it hidden.
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
// Build environment with DSH_SPAWN_WINDOWS_HIDE=1 so the patched dsh
// backend knows to hide its own child processes.
// ---------------------------------------------------------------------------
function buildHiddenEnv(extra = {}) {
  return {
    ...process.env,
    ...extra,
    DSH_SPAWN_WINDOWS_HIDE: '1',
    // Hint for node-pty / ConPTY to not create visible windows
    ConPTY_NO_WINDOW: '1',
  };
}

// ---------------------------------------------------------------------------
// Graceful shutdown: kill all tracked live processes
// ---------------------------------------------------------------------------
function killAll() {
  for (const child of liveProcesses) {
    try {
      if (child.pid) killProcessTree(child.pid);
    } catch (_) { /* already dead */ }
  }
  liveProcesses.clear();
}

// ---------------------------------------------------------------------------
// Get count of live processes (for diagnostics)
// ---------------------------------------------------------------------------
function liveCount() {
  return liveProcesses.size;
}

module.exports = {
  hiddenSpawn,
  hiddenSpawnSync,
  resolveExecutable,
  killProcessTree,
  runPowerShellHidden,
  extractZipHidden,
  buildHiddenEnv,
  killAll,
  liveCount,
};
