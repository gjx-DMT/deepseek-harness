// updater.js
// Remote update checker for DeepSeek Harness GUI.
//
// Two update modes:
//   1. GitHub Releases (preferred): checks for a new release tag, downloads
//      the NSIS installer, runs it, and quits.  This is the production path
//      used when electron-builder publishes releases.
//   2. Commit-based source update (fallback): compares the latest commit SHA
//      on main with the stored local SHA. If they differ, downloads the source
//      archive, extracts it, and replaces source files while preserving local
//      state (node_modules, .dsh, .git, etc.).
//
// All subprocess spawning goes through process-manager.js → windowsHide:true.
// Network requests use Electron's `net` module for system proxy support.

const { app, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Use process-manager for all subprocess spawning — guarantees windowsHide:true
const pm = require('./process-manager');

const GITHUB_OWNER = 'gjx-DMT';
const GITHUB_REPO = 'deepseek-harness';
const GITHUB_BRANCH = 'main';

// API endpoints
const API_RELEASES = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
const API_COMMITS = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/commits/${GITHUB_BRANCH}`;
// Archive download URL (for source update fallback)
const ARCHIVE_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/archive/refs/heads/${GITHUB_BRANCH}.zip`;

// Current app version (read from package.json)
function getAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    return pkg.version || '0.0.0';
  } catch (_) {
    return '0.0.0';
  }
}

// Files/directories to preserve during source update (won't be overwritten)
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
// Simple semver comparison: returns -1, 0, or 1
// ---------------------------------------------------------------------------
function compareVersions(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// HTTP helpers (Electron net module — system proxy aware)
// ---------------------------------------------------------------------------
function makeRequest(url, method = 'GET', headers = {}) {
  const { net } = require('electron');
  return net.request({ url, method, headers });
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const request = makeRequest(url, 'GET', {
      'User-Agent': 'DeepSeek-Harness-GUI-Updater',
      'Accept': 'application/json',
    });

    let body = '';
    request.on('response', (response) => {
      const statusCode = response.statusCode;

      if (statusCode >= 300 && statusCode < 400) {
        let location = response.headers.location;
        if (Array.isArray(location)) location = location[0];
        if (location) {
          response.on('data', () => {});
          response.on('end', () => {
            httpGetJson(location).then(resolve).catch(reject);
          });
          return;
        }
      }

      response.on('data', (chunk) => { body += chunk.toString('utf-8'); });
      response.on('end', () => {
        if (statusCode >= 400) {
          reject(new Error(`HTTP ${statusCode}: ${body.substring(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}. Body: ${body.substring(0, 200)}`));
        }
      });
    });

    request.on('error', (err) => {
      reject(new Error(`Request error: ${err.message}`));
    });

    request.end();
  });
}

function httpGetBuffer(url, onProgress) {
  return new Promise((resolve, reject) => {
    const request = makeRequest(url, 'GET', {
      'User-Agent': 'DeepSeek-Harness-GUI-Updater',
    });

    const chunks = [];
    let received = 0;
    let total = 0;

    request.on('response', (response) => {
      const statusCode = response.statusCode;

      if (statusCode >= 300 && statusCode < 400) {
        let location = response.headers.location;
        if (Array.isArray(location)) location = location[0];
        if (location) {
          response.on('data', () => {});
          response.on('end', () => {
            httpGetBuffer(location, onProgress).then(resolve).catch(reject);
          });
          return;
        }
      }

      if (statusCode >= 400) {
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }

      const contentLength = response.headers['content-length'];
      if (contentLength) total = parseInt(Array.isArray(contentLength) ? contentLength[0] : contentLength, 10);

      response.on('data', (chunk) => {
        chunks.push(Buffer.from(chunk));
        received += chunk.length;
        if (onProgress && total > 0) {
          onProgress(received, total);
        }
      });
      response.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    request.on('error', (err) => {
      reject(new Error(`Request error: ${err.message}`));
    });

    request.end();
  });
}

// ===========================================================================
// MODE 1: GitHub Releases update (preferred)
// Checks for a new release tag, downloads the NSIS installer, runs it.
// ===========================================================================

async function checkForReleaseUpdate() {
  const currentVersion = getAppVersion();
  console.log('[updater] current app version:', currentVersion);

  try {
    const release = await httpGetJson(API_RELEASES);
    if (!release || !release.tag_name) {
      console.log('[updater] no releases found');
      return null;
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    console.log('[updater] latest release:', latestVersion);

    if (compareVersions(currentVersion, latestVersion) >= 0) {
      console.log('[updater] release up to date');
      return null;
    }

    // Find the NSIS installer asset
    const assets = release.assets || [];
    const installerAsset = assets.find(a =>
      a.name.endsWith('-Setup.exe') || a.name.endsWith('.exe')
    );

    if (!installerAsset) {
      console.log('[updater] release has no installer asset, falling back to source update');
      return null;
    }

    return {
      type: 'release',
      currentVersion,
      latestVersion,
      downloadUrl: installerAsset.browser_download_url,
      fileName: installerAsset.name,
      fileSize: installerAsset.size,
      releaseNotes: release.body || '',
      releaseUrl: release.html_url,
    };
  } catch (e) {
    console.log('[updater] release check failed:', e.message);
    return null;
  }
}

async function downloadAndRunInstaller(updateInfo) {
  const tmpDir = path.join(os.tmpdir(), 'dsh-update-' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const installerPath = path.join(tmpDir, updateInfo.fileName);

  console.log('[updater] downloading installer:', updateInfo.fileName);

  const buffer = await httpGetBuffer(updateInfo.downloadUrl, (received, total) => {
    const pct = Math.round((received / total) * 100);
    if (pct % 10 === 0) {
      console.log(`[updater] download progress: ${pct}%`);
    }
  });

  fs.writeFileSync(installerPath, buffer);
  console.log('[updater] installer downloaded:', Math.round(buffer.length / 1024 / 1024), 'MB');

  // Run the NSIS installer via process-manager (hidden spawn — no black window)
  // The installer itself is a GUI app, so it will show its own UI.
  const child = pm.hiddenSpawn(installerPath, [], {
    cwd: tmpDir,
    detached: false,
    stdio: 'ignore',
  });

  // Quit the current app so the installer can replace files
  app.quit();
}

// ===========================================================================
// MODE 2: Commit-based source update (fallback)
// ===========================================================================

async function checkForCommitUpdate() {
  const localSha = getLocalVersion();
  console.log('[updater] local version SHA:', localSha || '(none)');

  try {
    const data = await httpGetJson(API_COMMITS);
    if (!data || !data.sha) {
      console.error('[updater] unexpected API response:', JSON.stringify(data).substring(0, 200));
      return null;
    }
    const latestSha = data.sha;
    const commitMessage = data.commit ? data.commit.message : '(no message)';
    const commitDate = data.commit && data.commit.committer ? data.commit.committer.date : '';

    console.log('[updater] remote version SHA:', latestSha);
    console.log('[updater] commit:', commitMessage.split('\n')[0]);

    const hasUpdate = localSha !== latestSha;
    return { hasUpdate, latestSha, localSha, commitMessage, commitDate };
  } catch (e) {
    console.error('[updater] failed to check for commit updates:', e.message);
    return null;
  }
}

async function downloadAndExtract() {
  const tmpDir = path.join(os.tmpdir(), 'dsh-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'source.zip');

  console.log('[updater] downloading archive...');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const buffer = await httpGetBuffer(ARCHIVE_URL);
    fs.writeFileSync(zipPath, buffer);
    console.log('[updater] download complete:', Math.round(buffer.length / 1024 / 1024), 'MB');

    // Extract via process-manager (hidden PowerShell, no black window)
    const extractDir = path.join(tmpDir, 'extracted');
    fs.mkdirSync(extractDir, { recursive: true });
    pm.extractZipHidden(zipPath, extractDir);

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

    if (shouldPresserve(relPath)) {
      console.log('[updater] preserving:', relPath);
      continue;
    }

    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copied += copyTree(srcPath, destDir, relPath);
    } else {
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

function removeStaleFiles(srcDir, destDir, relBase = '') {
  let removed = 0;
  const entries = fs.readdirSync(destDir, { withFileTypes: true });

  for (const entry of entries) {
    const relPath = path.join(relBase, entry.name);
    const destPath = path.join(destDir, relPath);
    const srcPath = path.join(srcDir, relPath);

    if (shouldPresserve(relPath)) {
      continue;
    }

    if (!fs.existsSync(srcPath)) {
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

async function applySourceUpdate(latestSha) {
  const dshDir = path.join(__dirname, '..');

  const extractedDir = await downloadAndExtract();

  console.log('[updater] copying new files...');
  const copied = copyTree(extractedDir, dshDir);
  console.log('[updater] copied', copied, 'files');

  console.log('[updater] removing stale files...');
  const removed = removeStaleFiles(extractedDir, dshDir);
  console.log('[updater] removed', removed, 'stale items');

  saveLocalVersion(latestSha);
  console.log('[updater] source update complete, version:', latestSha);

  return { copied, removed };
}

// ===========================================================================
// Main update flow: try Releases first, then fall back to commit-based
// ===========================================================================

async function checkAndPromptUpdate() {
  // --- Mode 1: Try GitHub Releases first ---
  const releaseUpdate = await checkForReleaseUpdate();

  if (releaseUpdate) {
    const notes = releaseUpdate.releaseNotes
      ? releaseUpdate.releaseNotes.substring(0, 500)
      : '(无发布说明)';

    const choice = dialog.showMessageBoxSync({
      type: 'info',
      title: '发现新版本 - DeepSeek Harness',
      message: `发现新版本 v${releaseUpdate.latestVersion}`,
      detail:
        `当前版本：v${releaseUpdate.currentVersion}\n` +
        `最新版本：v${releaseUpdate.latestVersion}\n` +
        `安装包：${releaseUpdate.fileName} (${Math.round(releaseUpdate.fileSize / 1024 / 1024)} MB)\n\n` +
        `发布说明：\n${notes}\n\n` +
        `是否下载并安装？`,
      buttons: ['立即安装', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
    });

    if (choice === 1) {
      console.log('[updater] user postponed release update');
      return;
    }

    try {
      await downloadAndRunInstaller(releaseUpdate);
      // app.quit() is called inside downloadAndRunInstaller
    } catch (e) {
      console.error('[updater] installer download failed:', e);
      dialog.showErrorBox(
        '更新失败 - DeepSeek Harness',
        `下载安装包失败：\n${e.message}\n\n` +
        `你可以手动从 GitHub 下载：\n` +
        `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`,
      );
    }
    return;
  }

  // --- Mode 2: Fall back to commit-based source update ---
  console.log('[updater] no release update, checking commit-based...');
  const commitResult = await checkForCommitUpdate();

  if (!commitResult) {
    console.log('[updater] update check failed, skipping');
    return;
  }

  if (!commitResult.hasUpdate) {
    console.log('[updater] up to date');
    return;
  }

  // First run - no local version stored, just save it silently
  if (!commitResult.localSha) {
    console.log('[updater] first run, saving version silently');
    saveLocalVersion(commitResult.latestSha);
    return;
  }

  const firstLine = commitResult.commitMessage.split('\n')[0];
  const date = new Date(commitResult.commitDate).toLocaleString('zh-CN');

  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '发现新版本 - DeepSeek Harness',
    message: '发现远程仓库有更新',
    detail:
      `最新提交：${firstLine}\n` +
      `更新时间：${date}\n` +
      `提交 SHA：${commitResult.latestSha.substring(0, 8)}\n\n` +
      `是否立即下载并更新？\n` +
      `更新后应用将自动重启。`,
    buttons: ['立即更新', '稍后再说'],
    defaultId: 0,
    cancelId: 1,
  });

  if (choice === 1) {
    console.log('[updater] user postponed commit update');
    return;
  }

  try {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '正在更新 - DeepSeek Harness',
      message: '正在下载更新，请稍候...\n更新完成后应用将自动重启。',
      buttons: ['确定'],
    });

    await applySourceUpdate(commitResult.latestSha);

    dialog.showMessageBoxSync({
      type: 'info',
      title: '更新完成 - DeepSeek Harness',
      message: '更新已完成！\n应用将自动重启以应用更改。',
      buttons: ['确定'],
    });

    app.relaunch();
    app.exit(0);
  } catch (e) {
    console.error('[updater] source update failed:', e);
    dialog.showErrorBox(
      '更新失败 - DeepSeek Harness',
      `更新过程中出错：\n${e.message}\n\n` +
      `你可以稍后手动从 GitHub 下载最新版本：\n` +
      `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    );
  }
}

module.exports = {
  checkForReleaseUpdate,
  checkForCommitUpdate,
  checkAndPromptUpdate,
  applySourceUpdate,
  getAppVersion,
  getLocalVersion,
  saveLocalVersion,
};
