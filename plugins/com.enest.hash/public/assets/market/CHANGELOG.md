# 哈希与加密 Changelog

> 功能参考 [ZTools-plugins](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）中的哈希 / 加密类插件，结合本壳子 API 自研实现。

## 1.0.0 首版

- **哈希**：输入即算，同屏展示 SHA-1 / SHA-224 / SHA-256 / SHA-384 / SHA-512 与 MD5（MD5 为 vendored 纯 JS 实现 `md5.mjs`，WebCrypto 不提供；SHA-224 平台缺失时该行显示"—"）。每行一键复制（`clipboard.write`）。
- **输出编码**：HEX / Base64 全局切换（哈希 + HMAC 共用，偏好持久化到 settings `encoding`）。
- **文件哈希**：拖入或点击选择本地文件（≤32MB）计算 SHA-256 并自动复制。采用 DOM File API 读取——壳子 `enest.localFiles` 句柄无内容读取通道（仅服务于 SSH 上传 / 拖出），故无需声明 localFiles 相关权限。
- **HMAC**：SHA-1/256/384/512 算法下拉 + 密钥输入，结果随哈希输入联动；随机密钥生成。
- **AES-GCM**：密钥（16/24/32 字节）与 IV（12 字节）base64 出入，一键生成；加密 / 解密，错误行内红条展示（密钥长度、IV 长度、解密失败）。
- **RSA**：2048 位密钥对生成（OAEP 加解密 + PSS 签名验签），PKCS#8 / SPKI base64 持久化到 `storage.local`，重启自动恢复；公钥加密 / 私钥解密 / 私钥签名 / 公钥验签。
- **JWT 解码**：三段式 JWT 解出 header / payload pretty JSON 与原样签名（**不验签**，界面注明）；exp / iat / nbf 附加人类可读时间与过期状态；非法结构行内红条。
- **工具**：随机盐 / IV 生成器（128 位，base64）。
- **双形态**：Quick 即输即算多算法列表（Tab 面板保留，文件区与加密区收敛，`ui.setHeight` 内容高度自适应）；桌面 Tab 分区（哈希 / 加密 / JWT）全量功能。
- 权限最小化：`clipboard.write`、`storage.local`（输出编码与 RSA 密钥对）、`ui.toast`、`ui.resize`。
- 核心纯逻辑（MD5 全向量 / SHA 家族 / base64-url JWT 解码）在 `tests/core.test.mjs` 覆盖自测。
