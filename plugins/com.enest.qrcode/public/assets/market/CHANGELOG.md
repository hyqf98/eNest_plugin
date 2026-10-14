# 二维码 Changelog

> 功能参考 [ZTools-plugins/qrcode-helper](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）；内置 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4（MIT, Kazuhiko Arase）与 [jsQR](https://github.com/cozmo/jsQR) 1.4.0（Apache-2.0, Cosmo Wolfe）

## 1.0.0

- 初始版本
- 生成 / 解码双页签；生成 textarea 防抖 300ms 实时渲染
- 生成参数：尺寸 128-512px（滑杆）、纠错等级 L/M/Q/H（默认 M）、前景 / 背景色（默认黑 / 白）
- canvas 渲染：quiet zone 4 模块、模块整数像素对齐；UTF-8 编码保证中文内容可被通用扫码器解码；容量超限（version 40 上限）时 toast 报错不清空
- 「复制图片」→ `clipboard.writeImage`；「保存 PNG」走 `<a download>`，enest:// 环境受限时提示改用复制
- 解码：剪贴板图片（`clipboard.readImage`，空时 toast）与本地图片（file input）双入口；img → canvas → getImageData → jsQR（双向反色尝试）
- 解码结果一键复制；失败红字「未识别到二维码」
- 会话内生成历史最近 6 条（文本 + 缩略图，点击恢复文本与全部参数）
- `onEnter` 载荷 `type:'text'` 时预填生成输入并自动生成
