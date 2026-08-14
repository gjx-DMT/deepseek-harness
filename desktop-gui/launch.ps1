# launch.ps1 - DeepSeek Harness GUI launcher (no console window)
# Starts Electron directly, with proper PATH setup for dsh backend.

param()

$ErrorActionPreference = 'Stop'

# Resolve paths relative to this script
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$parentDir = Split-Path -Parent $rootDir

$portableNodeDir = Join-Path $parentDir 'node-v22.19.0-win-x64'
$portableGitDir = Join-Path $parentDir 'portablegit\cmd'
$electronExe = Join-Path $scriptDir 'node_modules\electron\dist\electron.exe'

# Prepend portable Node.js and Git to PATH
$extraPaths = @()
if (Test-Path (Join-Path $portableNodeDir 'node.exe')) {
    $extraPaths += $portableNodeDir
}
if (Test-Path (Join-Path $portableGitDir 'git.exe')) {
    $extraPaths += $portableGitDir
}
if ($extraPaths.Count -gt 0) {
    $env:PATH = ($extraPaths -join ';') + ';' + $env:PATH
}

# Auto-install Electron if missing
if (-not (Test-Path $electronExe)) {
    $nodeExe = if (Test-Path (Join-Path $portableNodeDir 'node.exe')) {
        Join-Path $portableNodeDir 'node.exe'
    } else {
        'node'
    }
    Set-Location $scriptDir
    & $nodeExe (Join-Path $portableNodeDir 'node_modules\npm\bin\npm-cli.js') install
}

# Launch Electron directly (it's a GUI app, no console)
Set-Location $scriptDir
Start-Process -FilePath $electronExe -ArgumentList '.' -WorkingDirectory $scriptDir
