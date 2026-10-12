# 密码工具箱 Changelog

> 功能参考 [ZTools-plugins/random-password](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）与 uuid-kit

## 1.0.0

- 初始版本。
- 密码生成：长度 6-64 滑杆（默认 16）、小写/大写/数字/符号四类字符集勾选、`crypto.getRandomValues` + rejection sampling 无偏随机、四段强度条（弱/中/强/极强）、一键复制。
- 会话历史：最近 8 条生成记录，点击即复制。
- UUID v4 批量生成：数量 1-100、单条复制与全部复制（换行分隔）、version 4 / variant 位正确设置、小写输出。
