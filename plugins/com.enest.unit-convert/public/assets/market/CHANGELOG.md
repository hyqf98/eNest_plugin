# 单位与汇率 Changelog

> 功能参考 [ZTools-plugins/unit-convert](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

初始版本。

- 类目 Tabs：长度 / 面积 / 体积 / 质量 / 温度 / 速度 / 数据量 / 进制 / 汇率
- 同屏多值联动：类目内每行「单位名 + 输入框」，改任一行其余即时换算，焦点行为主
- 温度：摄氏 / 华氏 / 开尔文精确公式互转
- 进制：2 / 8 / 10 / 16 互转，二进制按 4 位分组显示
- 汇率：基准币种下拉 + 金额，16 个常用币种一屏换算；数据源 `https://open.er-api.com/v6/latest/USD`（`net.fetch`），24h `storage.local` 缓存；失败回落缓存 + 时间戳提示，再失败用静态参考汇率，不白屏
- 人民币大写：票据规则（元 / 角 / 分 / 整，四舍五入到分）+ 中文数字（万 / 亿分段，段间补零）
- 常用量预设：1 英寸 = 2.54 cm 等静态换算，点击自动填入对应类目
- Quick 形态：类目横向 chips + 联动列表即输即算；桌面：Tabs 全量 + 汇率区 + 人民币大写工具区
- 点击汇率行 / 大写结果一键复制（`clipboard.write`）
