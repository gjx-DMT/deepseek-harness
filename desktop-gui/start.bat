@echo off
chcp 65001 >nul
setlocal
title DeepSeek Harness

REM ============================================================
REM  DeepSeek Harness GUI - Windows launcher
REM  Paths are resolved relative to this batch file.
REM  Works with both portable Node (dev) and system Node (clone).
REM ============================================================

REM --- Resolve paths ---
set "GUI_DIR=%~dp0"
if "%GUI_DIR:~-1%"=="\" set "GUI_DIR=%GUI_DIR:~0,-1%"
set "ROOT_DIR=%GUI_DIR%\.."
set "PARENT_DIR=%ROOT_DIR%\.."
set "PORTABLE_NODE_DIR=%PARENT_DIR%\node-v22.19.0-win-x64"
set "PORTABLE_GIT_DIR=%PARENT_DIR%\portablegit\cmd"

REM --- Prepend portable Node.js and git to PATH if they exist ---
if exist "%PORTABLE_NODE_DIR%\node.exe" (
  set "PATH=%PORTABLE_NODE_DIR%;%PATH%"
)
if exist "%PORTABLE_GIT_DIR%\git.exe" (
  set "PATH=%PORTABLE_GIT_DIR%;%PATH%"
)

REM --- Verify Node.js is available ---
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo [错误] 未找到 Node.js。
  echo 请安装 Node.js v22.19+ https://nodejs.org/
  echo 或将便携版 node-v22.19.0-win-x64 放在仓库上级目录。
  pause
  exit /b 1
)

REM --- Verify Electron has been installed ---
if not exist "%GUI_DIR%\node_modules\electron\cli.js" (
  echo [错误] 未检测到 Electron，正在安装...
  cd /d "%GUI_DIR%"
  call npm install
  if %ERRORLEVEL% NEQ 0 (
    echo [错误] Electron 安装失败，请手动运行: npm install
    pause
    exit /b 1
  )
)

REM --- Launch Electron ---
cd /d "%GUI_DIR%"
node "%GUI_DIR%\node_modules\electron\cli.js" .

if %ERRORLEVEL% NEQ 0 (
  echo.
  echo [提示] Electron 已退出，返回码 %ERRORLEVEL%。
  pause
)

endlocal
