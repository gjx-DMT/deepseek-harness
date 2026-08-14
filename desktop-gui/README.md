# DeepSeek Harness GUI

将 [DeepSeek Harness (dsh)](../deepseek-harness-master) 的 Web UI 包装成一个可双击打开的 Electron 桌面应用。

启动时，主进程会自动在后台拉起 `dsh web` 子进程，等待 `http://127.0.0.1:3080` 就绪后，用 BrowserWindow 加载该地址；应用关闭时会一并终止 dsh 子进程。

## 目录结构

本目录（`deepseek-harness-gui`）应与下列目录位于同一父目录下：

```
<父目录>/
├── deepseek-harness-gui/      <- 本项目（Electron 包装器）
│   ├── package.json
│   ├── main.js                <- Electron 主进程
│   ├── preload.js             <- 预加载脚本
│   ├── start.bat              <- Windows 双击启动脚本
│   └── README.md
├── deepseek-harness-master/   <- dsh 源码（dsh web 在此目录运行）
├── node-v22.19.0-win-x64/     <- 便携版 Node.js（用于运行 dsh 与 electron）
└── portablegit/               <- 便携版 git（dsh 内部依赖 git）
```

所有路径均使用相对路径引用，整个父目录可以整体移动而无需修改任何配置。

## 首次使用

### 1. 安装 Electron

在 `deepseek-harness-gui` 目录下执行（任选其一）：

```bat
REM 方式一：使用自带的便携 Node.js（推荐，无需额外环境）
"%~dp0..\node-v22.19.0-win-x64\node.exe" "%~dp0..\node-v22.19.0-win-x64\node_modules\npm\bin\npm-cli.js" install electron
```

```bat
REM 方式二：如果系统已装 npm
npm install electron
```

### 2. 启动应用

双击 `start.bat` 即可。

或手动启动：

```bat
cd deepseek-harness-gui
"..\node-v22.19.0-win-x64\node.exe" "node_modules\electron\cli.js" .
```

## 工作原理

1. **检测已有服务**：启动时先快速探测 `http://127.0.0.1:3080`。若已有 dsh 在运行（例如你手动启动了一个用于开发），则直接复用，不再重复拉起，避免 `EADDRINUSE` 端口冲突。
2. **拉起 dsh**（仅在端口空闲时）：使用便携版 `node.exe` 在 `deepseek-harness-master` 目录下执行
   `node --import tsx/esm apps/cli/src/bin.ts web`。
3. **等待就绪**：轮询 `http://127.0.0.1:3080`，可访问后创建窗口并加载该地址。
4. **窗口**：标题 `DeepSeek Harness`，初始 `1400x900`，最小 `1000x700`。
5. **退出清理**：应用关闭时，仅终止由本应用拉起的 dsh 进程树（`taskkill /T /F`）；若复用的是已有服务，则不会杀掉它。
6. **异常处理**：若 dsh 进程意外退出或启动超时，弹出错误对话框并显示最近日志；若复用的服务中途失效，会提示页面加载失败。

## 故障排查

- **窗口长时间停在“正在启动”**：dsh 首次用 tsx 编译需要一些时间，默认等待 90 秒。若仍超时，请手动在 `deepseek-harness-master` 目录运行 `node --import tsx/esm apps/cli/src/bin.ts web` 查看报错。
- **dsh 端口被占用**：确保 `3080` 端口未被其他程序占用，或先关闭已有的 dsh 进程。
- **Electron 白屏**：少数显卡驱动下可能需要禁用 GPU 加速，可在 `main.js` 中取消注释 `app.disableHardwareAcceleration()`。
- **多实例冲突**：应用已启用单实例锁，重复启动会聚焦到已有窗口，不会重复拉起 dsh。
