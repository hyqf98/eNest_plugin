# 验证器 Changelog

> 功能参考 [ZTools-plugins/totp](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

初始版本。

- 条目：账号名 / 签发方 / secret(base32) / 位数(6/8) / 周期(30/60s) / 算法(SHA1/SHA256/SHA512)
- TOTP 计算：WebCrypto HMAC（RFC 4231 / RFC 6238），base32 解码（RFC 4648），动态截取（RFC 4226 §5.3）
- 添加：otpauth://totp/ 粘贴解析（label / issuer / digits / period / algorithm）+ 手动表单 + Quick 内从剪贴板读取（`clipboard.read`）
- 列表：账号 + 6/8 位大数字（`--mono` 大字号）+ SVG 倒计时环（描边动画，剩余 ≤5s 转 `--danger`）+ 点击复制（`clipboard.write`）+ 选中条目周期切换自动接力复制
- 分组 / 搜索（账号 + 签发方 + 分组）/ 编辑；拖拽排序字段（sortOrder）已预留，当前以添加顺序排列
- 导入导出：口令加密 JSON（PBKDF2-SHA256 210000 轮派生 AES-256-GCM），导出经 `shell.saveTextFile`，导入解密恢复
- Quick：搜索账号即出码复制；桌面：列表 + 编辑 + 导入导出
- 倒计时环在 `document.hidden` / `onOut` 时暂停，`onEnter` 恢复

## 安全权衡说明

- **secret 以明文存储在 `storage.local`**（宿主 SQLite）。曾考虑 `vault.set` 转 `secretRef`，但 vault 是只写不读的设计（明文不回到插件页），而 TOTP 计算必须取回明文 secret，故只能退而求其次使用 `storage.local`。请勿在共享账户或不受信设备上使用本插件。
- 备份文件本身使用口令派生密钥加密（AES-256-GCM），口令不落盘、遗忘不可恢复。
