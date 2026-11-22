# Native wallpaper helpers

这三个 helper 实现同一个控制协议：TCP loopback + token，JSON 行命令；仅在 eNest 运行期间由插件后端启动，父进程退出或控制连接断开即退出。

## Windows

- 构建：`powershell -ExecutionPolicy Bypass -File native/windows/build-helper.ps1`
- 依赖：Windows 10/11、.NET Framework 4.8 的 `csc.exe`、WebView2 Evergreen Runtime。
- 构建脚本自动从 NuGet 下载 `Microsoft.Web.WebView2` 并缓存到 `native/windows/.cache/`。
- 输出：`helper-cache/win32-x64/`，包含 `wallpaper-host.exe`、WebView2 SDK DLL 与 `WebView2Loader.dll`。
- 通过 Progman/WorkerW 附着到桌面图标之后；Explorer 重启时重试。

## macOS

- 构建：`bash native/macos/build-helper.sh`（需要 Xcode Command Line Tools）。
- 依赖：macOS 12+。
- 输出：`helper-cache/darwin-arm64/` 或 `darwin-x64/`。
- 使用 AppKit + WKWebView，在 `desktopIconWindow - 1` 层创建逐屏窗口。
- 构建脚本做 ad-hoc 签名；正式分发仍需 Developer ID 签名与 notarization，否则 Gatekeeper 可能拦截。

## Linux

- 构建：`bash native/linux/build-helper.sh`
- 依赖（Ubuntu/Debian）：`cmake g++ pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libjson-glib-dev libgtk-layer-shell-dev`。
- 输出：`helper-cache/linux-x64/`（glibc x64）。
- X11 使用 desktop window hint；Wayland wlroots 使用 gtk-layer-shell。GNOME/KDE Wayland 不提供任意桌面层，helper 会返回明确错误。

## 协议

- 启动参数：`--config <json>`。
- stdout 输出 `READY <port>`；客户端连接后发送 `{"token":"..."}`，helper 回 `{"event":"ready"}`。
- 命令：`{"cmd":"pause"}`、`{"cmd":"resume"}`、`{"cmd":"settings","settings":{...}}`、`{"cmd":"stop"}`。
- 事件：`ready`、`attached`、`paused`、`resumed`、`error`。
- 配置包含 `parentPid`、`dataDir`、`content:{type,url,title}`、`settings:{fpsLimit,mute,pauseOnFullscreen,pauseOnBattery,lowPower,quality}`。
- 不读取任意系统文件；只渲染用户选择的本地媒体或 Web URL。远程 Web 内容在 helper 的 WebView 中执行，需用户明确选择。
