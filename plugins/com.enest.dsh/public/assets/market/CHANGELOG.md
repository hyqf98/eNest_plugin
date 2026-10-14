# Changelog

## 0.1.0（2026-10-13）

- 首版：小窗会话驾驶舱（多会话进度/切换/快速对话）、大桌面 iframe 完全体、独立设置台（Profile 管家/端口策略/版本与升级/备份/诊断）。
- 自包含 dsh 运行时（Electron RunAsNode 引擎）、端口冲突自动换口、插件关闭自动回收进程与端口。
- 宿主侧新增 `dsh.connect / dsh.chat / dsh.admin` 三档权限与 `net.embedLoopback` CSP 门控。
