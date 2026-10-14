# SSH 工作台实现与验证

## 布局与恢复

桌面使用左侧连接、中央终端、右侧文件树和底部资源面板。Quick 保持 720×420 内容区，用顶部页签切换连接、终端、文件和资源；最小支持 480×240。Quick 与桌面迁移复用活动 WebContents 和会话。

终端标签支持排序、固定、改名和横纵分屏。固定标签排在前部，可在标签右键菜单取消固定。`ssh.ui.workspace` 仅保存白名单元数据：标签 ID、连接配置 ID、标题、固定状态、活动标签、分屏方向和分屏标签。重启恢复断开标签与布局，用户点击“连接”后才连接；不保存会话编号、终端输出、凭据或命令执行状态。已删除连接的标签会跳过。重复打开同一服务器的标签独立恢复与重连。

## 连接与代理

连接支持密码、私钥、SSH Agent、keyboard-interactive、最多 8 层跳板链和每个主机的 SHA256 信任记录。OpenSSH 导入遵守首值优先、别名和 ProxyJump 顺序；不执行本地配置命令。

连接表单“高级 → 此连接的网络代理”可选直连、HTTP CONNECT、SOCKS5。代理是每个连接的独立 TCP 传输设置：无跳板时拨目标服务器，有跳板时只拨第一台跳板，后续由 SSH `forwardOut` 继续连接。它不读取壳 HTTP 代理、`HTTP_PROXY` 或 `HTTPS_PROXY`，也不改变其他连接。

- HTTP CONNECT：无认证或 Basic 用户名密码认证；拒绝非 2xx 响应，407 使用固定错误文案，不回显响应正文。
- SOCKS5：无认证或 RFC 1929 用户名密码认证；配置认证时只请求认证方式 2，不静默降级。目标域名交给代理解析，支持 IPv4 和 IPv6；带接口区域的目标 IPv6（如 `%eth0`）明确拒绝。
- 代理认证密码保存在插件自己的 vault，配置仅包含 `secretRef`。测试可携带一次性密码，不写入配置。vault 保存失败会保留表单并停止保存。
- 改变代理协议、主机、端口或用户名后，不复用旧代理认证引用；可在表单清除已保存代理密码。导出配置不包含认证引用。
- 测试连接和保存连接共用参数采集，涵盖 Agent 路径、跳板链、终端设置、代理及密钥口令；填写的新口令优先于已存引用。

`src/main/ssh/sshProxy.ts` 使用 Node 原生 TCP，握手解析支持分包、合包和有界 HTTP 响应头。握手结束暂停 socket 并归还未读 SSH banner。socket 在拨号前纳入会话清理，关闭、取消、超时和跳板连接失败都会释放它。

## 设置归属

壳软件仅注册“跟随壳主题”和跳转“SSH 详细设置与快捷键”。终端行为、历史、快捷键重绑与冲突提示、监控间隔、信任主机管理都位于插件自己的设置页。代理、Agent 和跳板属于连接配置，不属于壳通用设置。

## 验证

宿主侧测试：

```sh
ENEST_TEST_SSH_PORT=65402 ENEST_TEST_SSH_PASSWORD=... ENEST_TEST_SSH_AGENT=1 \
node --test src/main/ssh/sshProxy.test.mjs src/main/ssh/sshIntegration.test.mjs \
  src/main/ssh/sshWorkbench.test.mjs src/main/ssh/sshLifecycle.test.mjs src/main/ssh/sshAuth.test.mjs
```

28 项通过，包含本机临时 TCP 代理及真实 Linux OpenSSH：两种代理的 vault 认证、实际 SSH 执行和首跳路由；分包/合包 banner、IPv6 编码、认证错误去敏、降级拒绝、无效帧、超时与取消。既有密码/私钥/隔离 Agent、两级跳板、资源与进程、SFTP 编辑冲突、上传下载、双向中断续传、断线重连续传、跨会话复制、本地隧道和生命周期测试仍通过。

插件状态回归：`node --test eNest_plugin/plugins/com.enest.ssh/tests/workspace-state.test.mjs`。浏览器使用真实 xterm/Monaco 与模拟宿主，验证三种尺寸、分屏和迁移、标签重载、固定/改名/排序、重复服务器标签单独重连、测试/保存参数一致、密钥口令和 vault 失败。模拟宿主测试不能替代安装后的 Electron/preload/CSP 验证。

## 本轮边界

- 实际 keyboard-interactive/OTP、远端 macOS/Windows 的资源与服务、Pageant、反向隧道尚未完成对应实机验收；已有实现和部分模拟验证。
- 代理仅实现明文 HTTP CONNECT、SOCKS5 TCP CONNECT；不包含 HTTPS 代理、PAC、HTTP Digest/NTLM、SOCKS UDP/BIND 或自动代理发现。
- OpenSSH Include 展开、Match 规则、ProxyCommand 和自动导入端口转发未实现，导入时报告警告。
- 自动重连退避、重启后的传输任务恢复尚未实现。当前运行时续传会验证源文件与已传前缀；关闭并重新打开应用后不保留断点日志。跨服务器复制保持源文件，不提供跨服务器移动或续传。
- 临时 Bash/Zsh 集成提供增强提示与历史；Windows 保留原生补全。进程/服务管理使用当前账户权限，不自动提权；Windows 不提供每进程 CPU 百分比。
