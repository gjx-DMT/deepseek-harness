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
// HTTP GET with system proxy support
// Uses Node's https module with CONNECT proxy tunnel if a system proxy is set.
// ---------------------------------------------------------------------------

// Detect the Windows system proxy (same one PowerShell/Invoke-RestMethod uses).
function getSystemProxy() {
  try {
    // Check environment variables first
    if (process.env.HTTPS_PROXY) return process.env.HTTPS_PROXY;
    if (process.env.https_proxy) return process.env.https_proxy;
    if (process.env.HTTP_PROXY) return process.env.HTTP_PROXY;
    if (process.env.http_proxy) return process.env.http_proxy;

    // On Windows, read the registry for the system proxy
    if (process.platform === 'win32') {
      try {
        const output = execSync(
          'powershell -NoProfile -Command "[System.Net.WebRequest]::GetSystemWebProxy().GetProxy([Uri]\'https://github.com\').ToString()"',
          { encoding: 'utf-8', timeout: 5000 },
        ).trim();
        if (output && output !== 'https://github.com/' && output.startsWith('http')) {
          return output;
        }
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return null;
}

function httpGet(url, asBuffer = false) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const proxyUrl = getSystemProxy();

    if (proxyUrl) {
      // Use HTTP CONNECT tunnel through the proxy
      const proxyParsed = new URL(proxyUrl);
      const tunnelReq = require('node:net').connect({
        host: proxyParsed.hostname,
        port: proxyParsed.port || 80,
      });

      tunnelReq.setTimeout(30000, () => {
        tunnelReq.destroy(new Error('Proxy connection timeout'));
      });

      tunnelReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
          return;
        }

        const tlsSocket = require('node:tls').connect({
          socket,
          servername: parsedUrl.hostname,
        }, () => {
          const reqPath = parsedUrl.pathname + parsedUrl.search;
          const reqLines = [
            `GET ${reqPath} HTTP/1.1`,
            `Host: ${parsedUrl.hostname}`,
            'User-Agent: DeepSeek-Harness-GUI-Updater',
            'Accept: application/json',
            'Connection: close',
            '',
            '',
          ];
          tlsSocket.write(reqLines.join('\r\n'));

          let headersParsed = false;
          let statusCode = 0;
          let headerBuf = Buffer.alloc(0);
          let bodyBuf = Buffer.alloc(0);

          tlsSocket.on('data', (chunk) => {
            if (!headersParsed) {
              headerBuf = Buffer.concat([headerBuf, chunk]);
              const headerEnd = headerBuf.indexOf('\r\n\r\n');
              if (headerEnd !== -1) {
                const headerStr = headerBuf.slice(0, headerEnd).toString();
                const statusLine = headerStr.split('\r\n')[0];
                statusCode = parseInt(statusLine.split(' ')[1], 10);
                bodyBuf = headerBuf.slice(headerEnd + 4);
                headersParsed = true;

                if (asBuffer && (statusCode === 200 || statusCode === 302)) {
                  // For binary downloads, resolve with the response directly
                  if (statusCode === 302) {
                    // Follow redirect
                    const locationMatch = headerStr.match(/location:\s*(.*)/i);
                    if (locationMatch) {
                      const redirectUrl = locationMatch[1].trim();
                      tlsSocket.destroy();
                      httpGet(redirectUrl, asBuffer).then(resolve).catch(reject);
                      return;
                    }
                  }
                }
              }
            } else {
              bodyBuf = Buffer.concat([bodyBuf, chunk]);
            }
          });

          tlsSocket.on('end', () => {
            if (statusCode >= 300 && statusCode < 400 && !asBuffer) {
              // Follow redirect for JSON
              const headerStr = headerBuf.toString();
              const locationMatch = headerStr.match(/location:\s*(.*)/i);
              if (locationMatch) {
                const redirectUrl = locationMatch[1].trim();
                httpGet(redirectUrl, asBuffer).then(resolve).catch(reject);
                return;
              }
            }
            if (asBuffer) {
              resolve(bodyBuf);
            } else {
              try {
                resolve(JSON.parse(bodyBuf.toString('utf-8')));
              } catch (e) {
                reject(new Error(`Failed to parse response (status ${statusCode}): ${e.message}`));
              }
            }
          });

          tlsSocket.on('error', reject);
        });

        tlsSocket.on('error', reject);
      });

      tunnelReq.on('error', reject);
      tunnelReq.write(
        `CONNECT ${parsedUrl.hostname}:443 HTTP/1.1\r\n` +
        `Host: ${parsedUrl.hostname}:443\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`,
      );
    } else {
      // Direct connection, no proxy
      const https = require('node:https');
      const req = https.get(url, {
        headers: {
          'User-Agent': 'DeepSeek-Harness-GUI-Updater',
          'Accept': 'application/json',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          const location = res.headers.location;
          if (location) {
            res.destroy();
            httpGet(location, asBuffer).then(resolve).catch(reject);
            return;
          }
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (asBuffer) {
            resolve(buf);
          } else {
            try {
              resolve(JSON.parse(buf.toString('utf-8')));
            } catch (e) {
              reject(new Error(`Failed to parse response: ${e.message}`));
            }
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy(new Error('Request timeout'));
      });
    }
  });
}

function httpGetJson(url) {
  return httpGet(url, false);
}

function httpGetBuffer(url) {
  return httpGet(url, true);
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
    if (!data || !data.sha) {
      console.error('[updater] unexpected API response:', JSON.stringify(data).substring(0, 200));
      return null;
    }
    const latestSha = data.sha;
    const commitMessage = data.commit ? data.commit.message : '(no message)';
    const commitDate = data.commit && data.commit.committer ? data.commit.committer.date : '';

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
