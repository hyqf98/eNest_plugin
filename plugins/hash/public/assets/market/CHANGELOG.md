# 哈希与加密 Changelog

> 功能参考 [ZTools-plugins](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）中的哈希 / 加密类插件，结合本壳子 API 自研实现。

## 1.1.0

- **文件哈希升级**：一次读取并行计算 SHA-256 / SHA-1 / MD5，读取与计算阶段有进行中进度条与状态文案，结果面板分档展示。
- **校验对比（新增）**：粘贴期望哈希即与当前 SHA-256 结果逐字符对比，容忍大小写、`0x` 前缀与 `-`/`:`/空格分隔符；一致 / 不一致徽章结论，不一致时高亮首个差异位与期望串。
- **结果卡片阵列**：六算法从行列表改为卡片网格（宽容器多列、窄容器单列），卡片 hover 显示复制按钮；空输入时展示引导空状态。
- **HMAC 修复**：「随机」密钥按钮此前未绑定事件，现已可用（32 字节随机密钥，base64）。
- **RSA 修复**：验签此前把密文文本同时当作数据与签名传入，现改为「私钥签名后可直接公钥验签」的正确数据流；RSA 错误改行内红条展示。
- **视觉升级**：顶栏 / 编码切换为半透明材质 + 分段控件（`prefers-reduced-transparency` 降级实色），结果值 tabular-nums，`:active` 按压反馈，`prefers-reduced-motion` 下停用位移。

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
