# 番茄钟 Changelog

> 功能参考 [ZTools-plugins/pomodoro-timer](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本。
- 环形倒计时（SVG stroke-dashoffset）+ mm:ss 大号显示，专注 🍅 / 休息 ☕ 阶段标签。
- 时长可调：专注 5-90 分钟（默认 25）、休息 1-30 分钟（默认 5），持久化到插件设置。
- 开始/暂停、重置、跳过本阶段。
- 阶段结束系统通知（api.notify）+ toast，自动进入下一阶段继续计时。
- 今日统计：storage 持久化，跨天自动清零；wall-clock 计时（setInterval 250ms 对齐 Date.now 差值），失焦回来仍准确，后台不停表。
