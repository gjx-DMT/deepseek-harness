// updater.js
// Remote update checker for DeepSeek Harness GUI.
//
// On startup, queries the GitHub API for the latest commit on main branch.
// Compares with the stored local SHA. If they differ, shows a dialog
// prompting the user to update. If accepted, downloads the latest source
// archive from GitHub, extracts it, and replaces the source files while
// preserving local state (node_modules, .dsh, .git, etc.).
//
// The update runs through the system proxy (if configured) because
// PowerShell's HttpClient respects the Windows system proxy.

const { app, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { execSync, spawnSync } = require('node:child_process');
const os = require('node:os');

const GITHUB_OWNER = 'gjx-DMT';
const GITHUB_REPO = 'deepseek-harness';
const GITHUB_BRANCH = 'main';

// API endpoint for latest commit
const API_COMMITS = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`;
// Archive download URL
const ARCHIVE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.zip`;

// Files/directories to preserve during update (won't be overwritten)
const PRESERVE_PATTERNS = [
  'node_modules',
  '.git',
  '.dsh',
  'desktop-gui/node_modules',
  'desktop-gui/.version',
  'lib',
  'dist',
  '.sessions',
  '.storages',
  '.cache',
  '.pnpm-store',
];

// ---------------------------------------------------------------------------
// Version file: stores the SHA of the commit currently running locally
// ---------------------------------------------------------------------------
function getVersionFile() {
  return path.join(__dirname, '.version');
}

function getLocalVersion() {
  try {
    return fs.readFileSync(getVersionFile(), 'utf-8').trim();
  } catch (_) {
    return '';
  }
}

function saveLocalVersion(sha) {
  fs.writeFileSync(getVersionFile(), sha, 'utf-8');
}

// ---------------------------------------------------------------------------
// HTTP GET with proxy support (uses system proxy via Electron's net module)
// ---------------------------------------------------------------------------
function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const request = net.request(url);
    let body = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { body += chunk.toString(); });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse response: ${e.message}`));
        }
      });
    });
    request.on('error', reject);
    request.setHeader('User-Agent', 'DeepSeek-Harness-GUI-Updater');
    request.end();
  });
}

function httpGetBuffer(url) {
  return new Promise((resolve, reject) => {
    const { net } = require('electron');
    const request = net.request(url);
    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => { chunks.push(chunk); });
      response.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error', reject);
    request.setHeader('User-Agent', 'DeepSeek-Harness-GUI-Updater');
    request.end();
  });
}

// ---------------------------------------------------------------------------
// Check for updates
// Returns { hasUpdate, latestSha, localSha, commitMessage, commitDate } or null on error
// ---------------------------------------------------------------------------
async function checkForUpdate() {
  const localSha = getLocalVersion();
  console.log('[updater] local version:', localSha || '(none)');

  try {
    const data = await httpGetJson(API_COMMITS);
    const latestSha = data.sha;
    const commitMessage = data.commit ? data.commit.message : '(no message)';
    const commitDate = data.commit ? data.commit.committer.date : '';

    console.log('[updater] remote version:', latestSha);
    console.log('[updater] commit:', commitMessage.split('\n')[0]);

    const hasUpdate = localSha !== latestSha;
    return { hasUpdate, latestSha, localSha, commitMessage, commitDate };
  } catch (e) {
    console.error('[updater] failed to check for updates:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Download and extract the latest source from GitHub
// ---------------------------------------------------------------------------
async function downloadAndExtract() {
  const tmpDir = path.join(os.tmpdir(), 'dsh-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'source.zip');

  console.log('[updater] downloading archive...');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const buffer = await httpGetBuffer(ARCHIVE_URL);
    fs.writeFileSync(zipPath, buffer);
    console.log('[updater] download complete:', Math.round(buffer.length / 1024 / 1024), 'MB');

    // Extract using PowerShell's Expand-Archive
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });

    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
      { stdio: 'pipe', timeout: 60000 },
    );

    // The archive contains a single top-level directory like deepseek-harness-main/
    const entries = fs.readdirSync(extractDir);
    const topDir = entries.find((e) => {
      const stat = fs.statSync(path.join(extractDir, e));
      return stat.isDirectory();
    });

    if (!topDir) {
      throw new Error('Archive structure unexpected: no top-level directory found');
    }

    return path.join(extractDir, topDir);
  } catch (e) {
    throw new Error(`Download/extract failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Copy files from the downloaded source to the local repo, preserving
// local state (node_modules, .git, etc.)
// ---------------------------------------------------------------------------
function shouldPresserve(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  return PRESERVE_PATTERNS.some((p) => {
    if (p === normalized) return true;
    if (normalized.startsWith(p + '/')) return true;
    return false;
  });
}

function copyTree(srcDir, destDir, relBase = '') {
  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  let copied = 0;

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const relPath = path.join(relBase, entry.name);
    const destPath = path.join(destDir, relPath);

    // Skip preserved paths
    if (shouldPresserve(relPath)) {
      console.log('[updater] preserving:', relPath);
      continue;
    }

    if (entry.isDirectory()) {
      // Create directory if it doesn't exist
      fs.mkdirSync(destPath, { recursive: true });
      copied += copyTree(srcPath, destDir, relPath);
    } else {
      // Copy file
      const destDirName = path.dirname(destPath);
      if (!fs.existsSync(destDirName)) {
        fs.mkdirSync(destDirName, { recursive: true });
      }
      fs.copyFileSync(srcPath, destPath);
      copied++;
    }
  }

  return copied;
}

// ---------------------------------------------------------------------------
// Remove files that no longer exist in the new version
// (Compare the source file list with the local one, excluding preserved paths)
// ---------------------------------------------------------------------------
function removeStaleFiles(srcDir, destDir, relBase = '') {
  let removed = 0;
  const entries = fs.readdirSync(destDir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = path.join(relBase, entry.name);
    const destPath = path.join(destDir, relPath);
    const srcPath = path.join(srcDir, relPath);

    // Skip preserved paths
    if (shouldPresserve(relPath)) {
      continue;
    }

    if (!fs.existsSync(srcPath)) {
      // File/directory doesn't exist in new version - remove it
      if (entry.isDirectory()) {
        fs.rmSync(destPath, { recursive: true, force: true });
        console.log('[updater] removed stale dir:', relPath);
      } else {
        fs.unlinkSync(destPath);
        console.log('[updater] removed stale file:', relPath);
      }
      removed++;
    } else if (entry.isDirectory()) {
      removed += removeStaleFiles(srcPath, destPath, relPath);
    }
  }

  return removed;
}

// ---------------------------------------------------------------------------
// Apply update: download, extract, copy, clean up
// ---------------------------------------------------------------------------
async function applyUpdate(latestSha) {
  const dshDir = path.join(__dirname, '..');

  // 1. Download and extract
  const extractedDir = await downloadAndExtract();

  // 2. Copy new files over (preserving local state)
  console.log('[updater] copying new files...');
  const copied = copyTree(extractedDir, dshDir);
  console.log('[updater] copied', copied, 'files');

  // 3. Remove stale files
  console.log('[updater] removing stale files...');
  const removed = removeStaleFiles(extractedDir, dshDir);
  console.log('[updater] removed', removed, 'stale items');

  // 4. Save the new version
  saveLocalVersion(latestSha);
  console.log('[updater] update complete, version:', latestSha);

  return { copied, removed };
}

// ---------------------------------------------------------------------------
// Main update flow: check + prompt + apply
// Call this on app startup (after window is ready)
// ---------------------------------------------------------------------------
async function checkAndPromptUpdate() {
  const result = await checkForUpdate();

  if (!result) {
    console.log('[updater] update check failed, skipping');
    return;
  }

  if (!result.hasUpdate) {
    console.log('[updater] up to date');
    return;
  }

  // First run - no local version stored, just save it silently
  if (!result.localSha) {
    console.log('[updater] first run, saving version silently');
    saveLocalVersion(result.latestSha);
    return;
  }

  // There's an update available - prompt the user
  const firstLine = result.commitMessage.split('\n')[0];
  const date = new Date(result.commitDate).toLocaleString('zh-CN');

  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '发现新版本 - DeepSeek Harness',
    message: '发现远程仓库有更新',
    detail:
      `最新提交：${firstLine}\n` +
      `更新时间：${date}\n` +
      `提交 SHA：${result.latestSha.substring(0, 8)}\n\n` +
      `是否立即下载并更新？\n` +
      `更新后应用将自动重启。`,
    buttons: ['立即更新', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice === 1) {
    console.log('[updater] user postponed update');
    return;
  }

  // User chose to update
  try {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '正在更新 - DeepSeek Harness',
      message: '正在下载更新，请稍候...\n更新完成后应用将自动重启。',
      buttons: ['确定'],
    });

    await applyUpdate(result.latestSha);

    dialog.showMessageBoxSync({
      type: 'info',
      title: '更新完成 - DeepSeek Harness',
      message: '更新已完成！\n应用将自动重启以应用更改。',
      buttons: ['确定'],
    });

    // Restart the app
    app.relaunch();
    app.exit(0);
  } catch (e) {
    console.error('[updater] update failed:', e);
    dialog.showErrorBox(
      '更新失败 - DeepSeek Harness',
      `更新过程中出错：\n${e.message}\n\n` +
      `你可以稍后手动从 GitHub 下载最新版本：\n` +
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    );
  }
}

module.exports = {
  checkForUpdate,
  checkAndPromptUpdate,
  applyUpdate,
  getLocalVersion,
  saveLocalVersion,
};
