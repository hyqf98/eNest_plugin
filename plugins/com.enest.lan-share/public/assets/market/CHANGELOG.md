# 局域网传件 Changelog

> 功能参考 [ZTools-plugins/lan-share](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）；二维码生成内置 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 1.4.4（MIT, Kazuhiko Arase，拷贝自本仓库 com.enest.qrcode 插件 vendor 目录）

## 1.0.0

- 初始版本
- 发送：拖入 / 选择文件（`localFiles.fromDrop` / `localFiles.pick` 句柄白名单），时长 5 / 10 / 30 分钟
- `lan.share.start` 起限时下载服务：0.0.0.0 随机端口（局域网可见是功能本身）、6 位数字取件码、只读 GET、Range 断点支持、并发上限、到期自动关停
- 展示：取件码大字（--mono）、局域网地址列表（每个 ip:port/d/id?code=，点击复制）、二维码（扫码即下）、倒计时、下载请求实时日志（文件 / ip / 时间）
- 接收说明卡（桌面形态）：三步扫码下载；历史记录（storage.local：文件 / 时间 / 下载次数，最多 50 条）
- stop 手动停止 + 到期自动 toast + 系统通知；关闭插件自动停止分享（宿主 scope 释放兜底）
- Quick = 单流程窄栏（丢文件 → 码 + 二维码）；桌面 = 左历史右当前双栏；容器查询 ≤740px 单列
