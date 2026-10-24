# 素描本主题设计说明

主题 id：`com.github.eNest.sketchbook / sketchbook`。本文只记录这套外观的设计决策与实现边界，契约细节以 [主题包规范](../../docs/developer/themes.md) 与 [工作区协议](../../docs/developer/home.md) 为准。

## 设计读法

给设计师与开发者看的插件目录，手绘彩条语言，偏向纸张 + 马克笔 + 抖动描边的插画式界面。三档：VARIANCE 8（错落卡片、手绘旋转）、MOTION 6（彩条漂移、入场编排）、DENSITY 4（日常目录密度）。

## 视觉系统

| 维度 | 决策 |
| --- | --- |
| 纸面 | `--bg #eff1e9` / `--surface #fdfcf5`，暖灰纸色，不用纯白也不用米黄 |
| 墨色 | `--text #22262b`，深色模式 `#f2efe4`，两端都不是纯黑纯白 |
| 马克笔强调 | `--accent #e0542f`（浅）/ `#f4764c`（深）；只用于主操作与选中态 |
| 六色彩条 | 朱红 / 琥珀 / 苔绿 / 松石 / 靛蓝 / 洋红，只做描边、色条、下划线与分类标记，不做大面积填充 |
| 标题 | `Bradley Hand` → `Chalkboard SE` → `Kaiti SC` 手写栈，正文保持无衬线 |
| 形状 | `clip-path` 斜切与撕口（索引卡右下角、便签左侧撕口），不用圆角假装手绘 |
| 描边 | SVG `feTurbulence` + `feDisplacementMap` 位移滤镜推歪的 2px 线（`filter: url(#sk-rough)`），这是手抖感的来源 |
| 字体 | `Hannotate SC`（手札体）→ `HanziPen SC`（翩翩体）→ `Bradley Hand`，本机均有；中文手写而非楷体书法 |
| 版面 | 螺旋装订环 + 横线纸 + 页边红线，`.sk-paper` 自绘；卡片带 ±0.8° 旋转与胶带，拼贴而非网格 |
| 纸纹 | 纯 CSS 三向交叉细线，随 `--appearance-bg-grain` 缩放，不使用 data URI 或图片 |

## 无障碍

- `--text-3` 取 `#646d68`：在 `--bg` 上 4.69:1、`--surface` 上 5.20:1，正文级小字过 WCAG AA。
- 主按钮用 `--marker-fill`（强调色压深 18%），白字对比度 5.36:1；深色模式强调色本身够亮，改用深色字（6.08:1）。
- 次要文字直接用 `--text-2`（浅 5.75:1 / 深 7.55:1），不再用透明度混色。
- 焦点环统一 2.5px `--accent`；低动画档与 `prefers-reduced-motion` 下停用彩条漂移、骨架微光与入场编排。

## 零构建约束（重要）

主题工作区页面在**开发态源码加载**时由宿主直接从磁盘读取并注入
`script-src 'self'` 的 CSP（见 `src/main/home/homeSessionPolicy.ts`：loopback 例外只对内置首页开放，
`BUILT_IN_HOME_SOURCE` 之外一律走 `enest-home://surface/`）。因此：

- 工作区必须是**浏览器可直接执行的纯 ESM**，不能有 JSX / TS / 打包语法；
- CSS 用 `<link>` 引入，不能写 `import './x.css'`（那是 Vite 语法，原生浏览器会按 MIME 拒绝）；
- DOM 用 `src/shared/dom.js` 的 `h()` 构造，避免模板字符串注入与转义问题；
- 工作区改完 CSS/JS 直接刷新页面即可看到效果，不需要构建。

样式台和浏览器演示从 `plugin.json` 动态导入本包主题声明，由 Vite 转成 `assets/app/` 下的模块；不维护第二份主题参数，也不在运行时请求包根元数据。正式安装请使用 `build-plugin` 产物，源码调试请使用本插件的 Vite 服务。原生源码直读的样式台没有 Vite JSON 转译，不能读取宿主刻意隐藏的根 `plugin.json`，因此不作为样式台的可用预览入口；真实工作区只消费宿主快照，不导入这条预览路径，仍支持零构建加载。

## 手绘实现要点

- 抖动描边只能挂在**纯描边伪元素**上：`filter` 会让元素成为包含块，套在容器上会破坏定位与滚动。卡片本体用 `clip-path` 切形状，描边交给 `::before` 加滤镜。
- 两档滤镜：`#sk-rough`（大件，scale 3.6）与 `#sk-rough-fine`（按钮/标签/环，scale 1.7，避免细字被推糊）。
- 手写体大字号下笔画偏细，标题用 `font-weight: 600` + `letter-spacing: .01em` 补足；正文仍用无衬线，保证长段落可读。
- 装订环用 `clip-path: polygon(0 0, 62% 0, 58% 100%, 0 100%)` 只留伸进纸面的那一段，配一个打孔圆点。

## 结构

```text
plugin.json                 主题包（V2）+ homePages 声明
index.html + src/index/     主题样式台：按钮、输入框、开关、图标、小窗、通知、色板
homes/sketchbook.html       主题工作区入口
src/market/                 市场工作区：controller（握手/路由/动作）+ SketchMarket（UI）+ market.css
src/shared/                 applyAppearance（快照 → CSS 变量）、手绘图标集
public/assets/market/       icon.svg、README.md、CHANGELOG.md、screenshots
```

## 实现边界

- 首页是隔离页面，只拿到 `enestWorkspace`；设置入口走 `openSettings` 动作，不读 `shellApi`。
- 彩条、纸纹、开屏编排都在本页自绘：首页视图默认不透明，不能依赖壳层背景透出。
- 壳层背景使用宿主内置 `aurora` 动效叠加 pack 声明的彩条配色；插件不能注入 shader 或任意 CSS。
- 市场卡片的图标与截图只接受 `enest-home://catalog/<id>/...` 槽位；README 走受控 fetch，渲染为纯文本。
- 演示数据与预览钩子只在 `import.meta.env.DEV` 下动态引入，发布包内已确认不含相关字符串。

## 本地验证

```bash
cd eNest_plugin
node scripts/validate-manifests.mjs
node scripts/build-plugin.mjs sketchbook
node scripts/pack-plugin.mjs sketchbook
# 单页调样式（浏览器直开，mock 数据）
cd plugins/sketchbook && npx vite --host 127.0.0.1 --port 5210
#   http://127.0.0.1:5210/homes/sketchbook.html  市场工作区
#   http://127.0.0.1:5210/index.html             主题样式台
```
