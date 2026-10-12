# JSON 工具 Changelog

> 功能参考 [ZTools-plugins/json-tools](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- 格式化（2 / 4 空格缩进）与压缩（minify），一键切换
- 校验：JSON 有效时输出节点数 / 最大深度 / 键数统计；失败时按 position 换算行:列，红字定位并选中文本中出错位置
- 转义 / 反转义：字符串与 JSON 字面量互转（塞代码 / 还原）
- 复制结果、清空、粘贴预填；onEnter 文本载荷自动格式化
- 大输入保护：>2MB 提示可能卡顿，>8MB 拒绝处理
