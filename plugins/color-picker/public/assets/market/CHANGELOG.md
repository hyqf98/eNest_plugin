# 取色器 Changelog

> 功能参考 [ZTools-plugins/color-helper](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- 「开始取色」→ `screen.capture()` 全屏截图，视图内 object-fit: contain 适配显示
- 放大镜取点：鼠标移动时右侧画布渲染 11×11 像素放大网格（原始分辨率取色）+ 中心十字，实时预览 HEX / RGB
- 点击确定：主显示大色块 + HEX(#RRGGBB) / rgb(r,g,b) / hsl(h,s%,l%) 三行各一键复制（`clipboard.write` + toast）
- 历史色板：storage key `colors_v1` 持久化最近 24 色（去重、新在前），色块 hover 显示 HEX、点击复制并回填主显示，支持一键清空
- 手动输入 HEX 实时换算 RGB / HSL（非法输入红框提示），Enter 直接复制
- 深色主题对齐 com.github.eNest.translate 视觉基准；`ui.setTitle('取色器')`
