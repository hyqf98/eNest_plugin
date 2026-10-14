# 主题示例 Changelog

## 0.1.0

首发：双路径主题包注册示例。

- **manifest 声明式**：`contributes.themePacks` 注册「暖沙 / 靛蓝」双模式主题包，安装即生效、无需插件运行。
- **运行时注册**：进入插件时 `enest.theme.register` 注册第 3 个主题包「墨绿」，演示运行式路径（需 `theme` 权限）。
- 到「设置 → 外观 → 主题」下拉验证三种主题的切换。
