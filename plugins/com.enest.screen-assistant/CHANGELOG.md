# 屏幕助手 Changelog

> 功能参考 [ZTools-plugins/shortcut-capture](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.1.0

- 新增「贴图」独立页签，onEnter 收到 code='pin' 直接进入。
- 贴图三入口：截图并贴（选区截图后直接贴出）、贴剪贴板图片（clipboard.readImage）、贴本地图片（PNG/JPEG/WebP 文件选择）。
- 新增贴图管理区：pin.list() 实时列出贴图，支持单条关闭（pin.close）与全部关闭（pin.closeAll），空列表显示"暂无贴图"。
- 截图历史持久化：storage.local（key 'sa_history_v1'）保存最近 8 条 {id, ts, thumb, w, h}，thumb 为 canvas 压缩缩略图（宽 ≤360、JPEG quality 0.72），旧的淘汰；启动时与"最近"列表合并展示（会话内原图优先）。
- 历史条目点击可贴图：优先会话内原图，无原图时贴持久化缩略图。
- manifest 权限新增 clipboard.readImage，版本升至 1.1.0。
