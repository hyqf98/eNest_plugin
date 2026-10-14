# 供应商切换

AI CLI 供应商切换台：10 应用配置管理、50+ 预设、MCP 同步、会话浏览与用量统计（复刻 cc-switch）

## 功能

- AI CLI 供应商切换台
- MCP 服务器管理
- AI 会话浏览与用量
- 切换台设置

## 使用方式

在 eNest 中打开插件，或使用快捷启动搜索功能名称。主窗口适合连续操作，Quick 适合完成一次任务；可在两种模式之间切换。

## 数据与权限

本插件申请的敏感权限：`net.fetch`、`hotkey`、`notify`、`clipboard.write`、`shell.openExternal`、`config.agent.read`、`config.agent.write`、`fs.write`、`contribute`。使用相应系统、网络或用户数据能力时，eNest 检查清单并请求用户授权；你可以在插件设置中改为允许、询问或拒绝。

`contribute` 用于接收 Quick 搜索并提供结果；只有授权后，插件才能收到全局 Quick 搜索文本。

插件自身的数据与密钥存储、壳内界面、插件设置、主题和声明式功能入口属于 eNest 的基础能力，直接可用，无需在清单中声明或单独授权。插件仍在隔离环境运行，不能直接访问 Node 或操作系统；读取、写入用户文件须经过宿主的文件选择与句柄 API。

## 界面预览

![供应商切换主界面](./screenshots/01-main.png)

截图使用隔离演示数据，不连接用户的真实账户、服务器或文件。
