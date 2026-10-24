# Changelog

## 1.3.2（2026-10-24）

- 会话截图贴图改由插件自有的 `@enest/native-surfaces` 辅助页面渲染，宿主不再保留贴图 HTML 或图像业务状态。
- 通过通用辅助窗口保持原有截图操作；资源随插件打包，关闭时按插件实例归属回收。需要 eNest >= 0.2.3。

## 1.3.1（2026-10-24）

- RDCleanPath、X.224、TLS 和证书确认策略迁入本插件 `backend/`；宿主不再按 RDP 首包猜测应用协议。
- RDP 与 SSH 共用当前插件按需启动的后端进程；仅通过通用 endpoint/activity/proxy/dialog 能力接入宿主。
- WebSocket 桥校验宿主提供的页面 Origin、Host 与一次性令牌；限制连接/缓冲，异常、拒绝、关闭及迟到授权均回收。
- X.224 按完整 TPKT 读取，修复 TCP 分片首包被误当完整响应；连接测试发送有效协商报文，不再将错误 DER 当成功。
- 需要 eNest >= 0.2.2 与 `backend.node` 全信任授权。Windows RDS/xrdp 真实远端未在本轮验证；本轮验证仅限 mock/本地 loopback。

## 1.0.0（2026-10-13）

首发：VNC / RDP 双协议远程桌面插件。

### 功能

- 资产管理：连接资产（名称 / 主机 / 端口 / 协议 / 凭据 / 分组 / 标签 / SSH 隧道引用 / 只读开关）；密码经 `vault.set` → secretRef 加密保存，无明文回读（编辑留空 = 不修改）
- 最近连接（时间 + 时长）、连接测试（TCP 探活 + 协议握手首包诊断：VNC 读 RFB 版本串、RDP 走桥握手）
- 导入导出 JSON（密码导出为空并注明）；从粘贴解析 `vnc://` `rdp://` URI 快速新建
- VNC 会话：vendored noVNC，RFB over ws；ZRLE / Tight / Hextile 协商、指针形状、剪贴板文本双向、画质 / 编码切换、只读
- RDP 会话：vendored ironrdp-wasm（wasm-pack `--target web`，wasm-opt=false）；SessionBuilder → Session（run / shutdown / resize / applyInputs / synchronizeLockKeys）；mac Cmd 修饰键映射远端 Ctrl
- 会话体验：Quick 单会话沉浸（状态条：状态 / 延迟 / 帧率 / 断开）；Shell 多会话 Tab（非激活保活）；缩放三档（适应 / 1:1 / 拉伸）；会话信息浮层；截图保存 / 贴图；自动重连（指数退避、不清屏）；会话期间防休眠；onBeforeClose 优雅断开
- 传输：`net.socket.connect` → `net.socket.serveWs` 本地桥；SSH 隧道资产先 `enest.ssh.workbench tunnel.open`

### 第三方组件（vendored）与来源

| 组件 | 版本 | 路径 | License | 来源 |
|------|------|------|---------|------|
| noVNC | 1.5.0 | `assets/vendor/novnc/` | MPL-2.0（部分模块 BSD） | https://github.com/novnc/noVNC（npm `@novnc/novnc@1.5.0`，vendored 最小集：core lib + input + decoders + crypto） |
| pako | （随 noVNC） | `assets/vendor/novnc/lib/vendor/pako/` | MIT | 随 `@novnc/novnc` 分发（`lib/vendor/pako`） |
| ironrdp-wasm | master（2026-10-13 构建） | `assets/vendor/rdp-wasm/` | MIT | https://github.com/electerm/ironrdp-wasm（Devolutions IronRDP `ironrdp-web` 薄再导出；wasm-pack `--target web --release`，`wasm-opt = false`） |
| RDCleanPath 代理协议 | — | 插件 `backend/rdpProtocol.ts`、`backend/rdpBridge.ts`（1.3.1 起） | MIT | 移植自 electerm/ironrdp-wasm `example/lib/rdp-proxy.js`（ASN.1 RDCleanPath + X.224 + TLS 终止） |

- `rdp_client_bg.wasm` 6.7MB（wasm-opt 关闭所致；启用后可压至 2-3MB 级），随插件包分发，不影响壳子首屏。
- RDP 真机（Windows RDS / xrdp）未在本期验证，协议层经假 TCP+TLS 服务器全链路单测覆盖。

### 安全

- 密码仅存 vault（secretRef）；导出 JSON 密码为空并注明
- ws 桥仅绑 127.0.0.1 + 一次性 token（壳子 net.socket 既有边界）
- rdp 模式忽略请求内 destination，TLS 固定升级到 `net.socket.connect` 已建立连接（目标选择权在 connect 调用侧）
