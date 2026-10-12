# 编解码 Changelog

> 功能参考 [ZTools-plugins/base64](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- 四种模式：Base64 / URL / Hex / Unicode 编码与解码，全部中文安全（UTF-8 分块处理）
- 双栏布局，方向一键切换「编码 ⇄ 解码」，支持 Ctrl+Enter 执行
- 输出区一键复制、输入区一键清空 / 粘贴；结果可一键挪回输入并自动翻转方向（互换二次转换）
- 非法输入红条报错（中文提示），不清空已有输出
