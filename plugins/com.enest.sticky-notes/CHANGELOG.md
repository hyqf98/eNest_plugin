# 备忘录 Changelog

> 功能参考 [ZTools-plugins/sticky-note](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本。
- 多张便签网格（2 列，窄屏自适应 1 列），右上「+ 新便签」快速新建。
- 5 色标签（amber / teal / rose / sky / violet）：卡左侧 3px 色条 + 卡顶色点循环切换。
- 沉浸编辑：无边框 textarea 自动高度，输入防抖 500ms 自动保存。
- 置顶：置顶卡排最前，色条加亮 + 「置顶」角标。
- 删除二次确认：第一次点击变红显示「再点确认」，2.5s 未确认自动恢复。
- 相对时间展示（刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD），每分钟自动刷新。
- 排序：置顶优先，其次 updatedAt 倒序。
- 持久化：storage.local（notes_v1），重开不丢；空数据引导空状态。
- onEnter 载荷带 type:'text' 选中文本时预填一条新便签草稿。

## 1.0.1 — UI 精致化 + 窄容器降级

- 布局：宽容器（>740px）便签网格 `auto-fill minmax(240px, 1fr)` 自动 2-3 列；窄容器（≤740px，Quick 内嵌）单列、间距收窄、新建按钮保持可达。
- 便签卡实体质感：左侧 4px 色条 + 卡顶色点 + 双层微投影（禁渐变），hover 描边提亮、focus-within 便签色光环。
- 排印：正文 14.5px / 行高 1.6；标题 15px 半粗 + 琥珀色 glyph；计数改中性胶囊徽标。
- 色点 hover 放大 1.15 倍并弹出「下一色」换色提示浮层（body 级 fixed，不被卡片裁切）。
- 置顶角标改 10px 大写字距 + 内联 pin 图标；删除确认态红色系（#f87171 / #ef4444）。
- 相对时间 11px tabular-nums 右对齐；全局过渡 140ms + 自定义缓动；prefers-reduced-motion 降级。
- 图标全部换内联 SVG（统一 1.2-1.4px 细描边）；空状态重排：56px glyph 卡 + 主文案 13px + 次行 12px。
- manifest 补 `form: panel` + `ui.themeAware`（深色 token 挂钩 html[data-theme]/[data-scheme]，本地深色回退）。
