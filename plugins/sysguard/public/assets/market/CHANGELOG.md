# 进程与端口 Changelog

> 进程监控交互参考 [ZTools-plugins/process-monitor](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.1.0

- 新增「概览」仪表盘：CPU 总占用 / 物理内存合计 / 进程数 / 监听端口四张数据卡；
  大数字 tabular-nums 负字距排印，卡内内嵌迷你趋势（滚动窗口 sparkline）
- 阈值告警可视化：CPU / 内存可配置告警与危险阈值（设置面板），超阈值卡片换边框与数值色（warn / danger）
- Top 进程列表：CPU 占用最高 / 内存占用最高各 5 名，超阈值数值联动变色
- 刷新频率设置：1.5 / 3 / 5 / 10 秒可调（工具条 + 宿主设置同步），趋势窗口按 60 秒语义自适应容量，切换保留已有样本
- 仪表盘刷新为增量更新（只改文本 / 配色 / 重绘 spark，不重建 DOM），采样循环无整页闪烁
- Quick 形态图例补充进程数；采样器统一为 restart 管理，页面隐藏 / onOut 自动暂停

## 1.0.0

- 初始版本
- 进程表：PID / 进程名 / 用户 / CPU% / 内存（plugin-kit dataTable，列头排序、数字 mono 右对齐、行高 36px）；
  搜索（进程名 / pid）；收藏（★ 置顶 + accent 侧条）；「隐藏系统进程」开关（root / `_uid<500` 系统用户）
- 结束进程：行内「结束」→ 危险确认对话框（--danger 配色，正文写明 PID + 进程名 + 数据丢失警告 + 命令行元数据）
  → `sys.kill({ pid, signal: 'TERM', confirmed: true })` → toast + 自动刷新；宿主侧拒杀自身与 PID ≤ 1
- 端口表：协议 / 本地地址 / 端口 / 进程 / PID / 用户；按端口 / pid / 进程名搜索直达占用进程；
  点击端口行联动切换进程表并按 pid 过滤高亮
- 实时曲线：CPU 总占用（0-100）与物理内存合计滚动曲线（canvas，主题 token 取色，
  onThemeChange 重绘）；采样对齐宿主 sys.inspect 1s 采样缓存节律；
  `document.hidden` / `onOut` 自动暂停，恢复可见即续采；采样期间 `runtime.acquireActivity` 保活
- 双形态：Quick = 单列表（输入端口号查占用进程可直接结束 / 进程名搜索即杀候选）+ 底部迷你曲线；
  桌面 = 进程 / 端口 / 曲线 Tab + 隐藏系统进程开关
- 容器查询 ≤740px 收窄搜索与标题；Quick / shell 迁移（mode-change）实时切换形态
