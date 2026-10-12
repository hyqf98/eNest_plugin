# 计算器 Changelog

> 功能参考 [ZTools-plugins/simple-calculator](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.1.0

- UI 精致化重做 + 双形态响应式（form 保持 mini）。
- 窄容器（≤740px，Quick 内嵌）：居中紧凑计算器（~340px），历史收起为可展开 `<details>`，整体高度收在 ~520px 内。
- 宽容器（>740px，主窗）：左计算器 / 右常驻历史侧栏，容器查询驱动。
- 输入区改为微内嵌井（深一档底色 + 内描边 + 顶部内阴影），大号等宽表达式 20px+，结果行右侧对齐灰色预览小字；确认写回时 120ms 主色呼吸过渡。
- 按键板分层：数字键浅面浮起、运算符键中性深面、AC/⌫ 危险淡红、`=` 主色实底（#5b8cff）；按键 44-48px 高、圆角 10px，按下 `translateY(1px)` + 亮度反馈，数字 `tabular-nums`。
- 历史条目：表达式灰 / 结果白右对齐，hover 出复制按钮；标题带条数徽标与空态插画。
- 主题 token 对齐壳子注入体系（`--bg/--surface/--text/--danger` 等），themeAware 换肤生效；焦点环 `focus-visible` 全覆盖；图标改内联 SVG。
- 计算逻辑（tokenizer/parser/防抖求值/历史）未改动。

## 1.0.0

- 初始版本。
- 四则运算（+ - * /）与括号、小数、取模（%）。
- 自写 tokenizer + 递归下降 parser 安全求值，不使用 eval / new Function。
- 输入防抖 150ms 即时显示结果；回车或 = 确认并把结果写回输入框，支持链式计算。
- 键盘可直接输入；按键板支持 0-9、. + - * / % ( ) ⌫ AC =。
- 会话内历史记录（最多 12 条，最新在上），点击回填，单条可复制结果。
- 复制结果走 clipboard.writeText 并 toast 提示。
- Quick 小窗（mini form）紧凑布局，深色主题。
