# 进程与端口 Changelog

> 进程监控交互参考 [ZTools-plugins/process-monitor](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- 进程表：PID / 进程名 / 用户 / CPU% / 内存（plugin-kit dataTable，列头排序、数字 mono 右对齐、行高 36px）；
  搜索（进程名 / pid）；收藏（★ 置顶 + accent 侧条）；「隐藏系统进程」开关（root / `_uid<500` 系统用户）
- 结束进程：行内「结束」→ 危险确认对话框（--danger 配色，正文写明 PID + 进程名 + 数据丢失警告 + 命令行元数据）
  → `sys.kill({ pid, signal: 'TERM', confirmed: true })` → toast + 自动刷新；宿主侧拒杀自身与 PID ≤ 1
- 端口表：协议 / 本地地址 / 端口 / 进程 / PID / 用户；按端口 / pid / 进程名搜索直达占用进程；
  点击端口行联动切换进程表并按 pid 过滤高亮
- 实时曲线：CPU 总占用（0-100）与物理内存合计 60s 滚动曲线（canvas，主题 token 取色，
  onThemeChange 重绘）；1.5s 采样对齐宿主 sys.inspect 1s 采样缓存节律；
  `document.hidden` / `onOut` 自动暂停，恢复可见即续采；采样期间 `runtime.acquireActivity` 保活
- 双形态：Quick = 单列表（输入端口号查占用进程可直接结束 / 进程名搜索即杀候选）+ 底部迷你曲线；
  桌面 = 进程 / 端口 / 曲线三 Tab + 隐藏系统进程开关
- 容器查询 ≤740px 收窄搜索与标题；Quick / shell 迁移（mode-change）实时切换形态
