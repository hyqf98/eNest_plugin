# 时间戳 Changelog

> 功能参考 [ZTools-plugins/com-ztools-timestamp](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本。
- 当前时间卡：每秒实时刷新本地时间（YYYY-MM-DD HH:mm:ss），秒级 / 毫秒级时间戳大号可点击行，点击即复制并 toast 提示；附 UTC 时间小字。
- 时间戳 → 时间：输入即转换，自动识别 10 位秒级 / 13 位毫秒级（其他位数按毫秒），显示完整日期时间与相对描述（N 天前 / N 天后），非法输入红字提示，结果一键复制。
- 时间 → 时间戳：datetime-local 输入（默认当前时间），实时显示对应秒级 / 毫秒级时间戳，各带复制。
- 格式速览：ISO 8601（含时区偏移）、YYYY/MM/DD、HH:mm:ss、Unix 秒，随当前时间实时刷新，各行点击复制。
- 相对时间解析：支持 `-1h` `+30m` `3d` `2w`（h/m/d/w）解析为相对当前的时刻，显示其时间与秒级时间戳，非法提示。
- 深色主题单文件实现，无外部依赖；Quick 小窗 mini 形态紧凑布局。
