# 素描本主题设计说明

主题 id：`com.github.eNest.sketchbook / sketchbook`。本文只记录这套外观的设计决策与实现边界，契约细节以 [主题包规范](../../docs/developer/themes.md) 与 [工作区协议](../../docs/developer/home.md) 为准。

## 设计读法

参考 [Looseleaf](https://kevintngo.github.io/looseleaf/)（"shadcn/ui，但由手画出来"）的**纸品系统**读法：界面不是"圆角卡片 + 彩色描边"，而是**一排摆在桌面上的真实纸片**。

三条硬读法：

1. **纸和桌面是两种不同的材质**。桌面（`--bg`）是低饱和灰绿 / 雾蓝 / 砂褐的布面，纸（`--surface`）是偏暖的近白。纸浮在桌面上靠投影分级，不靠描边。
2. **纸是直角物件**。纸片直角或斜切，圆角只给控件一点柔和（默认 3–6px）。手绘感来自"抖动描边 + 纸品 + 投影"，不来自圆角。
3. **纸片尺寸不必相等**。目录是一张 4 列 × 7 行的拼贴，每张纸按节奏表分到 1–2 列宽、2–4 行高；差异由内容填满，不留空白纸边。

## 纸品系统

| 纸品 | 底色来源 | 纹理 | 投影 |
| --- | --- | --- | --- |
| `card` 索引卡 | `--surface`（纯白） | 纸面高光 | `--sk-shadow-card` |
| `grid` 方格纸 | `--surface` | 两组 26px 等距线 | `--sk-shadow-card` |
| `kraft` 牛皮纸 | `--surface` 混 14% 暖砂 | 8° / 96° 双向纤维 | `--sk-shadow-pad` |
| `photo` 相纸 | 接近纯白 | 无 | `--sk-shadow-lift` |
| `slip` 便签 | `--surface` 混马克笔 7% | 纸面高光 | `--sk-shadow-slip` |

## 桌面：mesh 渐变（不是纯色）

桌面不是一块颜色，而是**多层径向光斑 + 线性底色**，外加一层 SVG 颗粒：

```
background-image:
  radial-gradient(… rgba(251,146,60,.30) …),   /* 左上暖橙光斑 */
  radial-gradient(… rgba(253,224,71,.34) …),   /* 右上淡金光斑 */
  radial-gradient(… rgba(168,162,158,.34) …),  /* 底部灰调过渡 */
  linear-gradient(152deg, #fffefb, #f8f4ec, #eee7db);  /* 底色 */
```

四条硬约束（写进 CSS 时必须遵守）：

1. **光斑用 `rgba()` 写透明度，不能写 `/`** —— 宿主的 `isSafePalettePaint` 白名单只允许字母数字与 `#.,()%+-`，斜杠会让整条 palette 被拒。
2. 光斑层**必须排在底色之前**（`background-image` 第一个最靠上）。
3. 纸必须是**纯白**（`--surface: #ffffff`）：桌面已经带暖光，纸再暖就会发腻。
4. 颗粒用 SVG `feTurbulence` 的 data URI，不用图片文件。

四套预设（`plugin.json` 的 `palettes`，id 稳定）：

| id | 名称 | 气质 |
| --- | --- | --- |
| `warmSand` | 暖沙日光 | 默认。奶油白桌面 + 落日暖光 |
| `morningMist` | 晨雾中性 | 极淡灰阶，最克制 |
| `terracotta` | 陶土纸感 | 米白到陶土，最暖 |
| `coolMist` | 冷雾青灰 | 白到冷灰，带天光 |

色值全部取自 Tailwind 真实色阶（stone / orange / amber / sky / teal），不是凭感觉调的数。

投影色是暖灰（浅色 `58 44 30`，深色 `4 7 8`），按 `--sk-shadow-k` 分级：hair / slip / card / lift / pad / paper / sticky。深色模式不是把浅色压暗：纸与桌面拉开明度差，墨改成暖白（`#ece6d9`），影更实。

## 版面：带式铺砖（band tiling）

**不要用固定节奏表。** 各组张数不是固定值的倍数时（设计组只有 1 张、媒体组 2 张），固定跨度必然留下几列宽的空洞 —— 这是上一版最大的缺陷（实测空洞率 11.7%，设计组 50.5%）。

现在的做法是**按真实张数现算**（`layoutSpans(cols, n)`，纯函数）：

- 一条"带"横跨满宽，带内各纸列宽之和 == 列数 → **带内无洞**
- 带与带首尾相接、各自等高 → **带间无洞**
- 于是任意张数 × 任意列数都严格铺满（已对 1..40 张 × 1..6 列全部验证）

错落来自两处：带内宽度切分轮换（`3+1` / `2+2` / `1+3` / `2+1+1`），以及带高轮换（2–3 行）。

**JS 与 CSS 必须同源**：有效列数由 JS 按视口与宿主设置算一次，写进 `--sk-columns`，网格的 `grid-template-columns` 与 span 都用它。窗口 resize 时重算并重排（140ms 去抖）。

**每张纸必须被填满**，按能放下多少分级：

| 尺寸 | 行数 | 内容 |
| --- | --- | --- |
| `wide` 横幅 | 3 | 截图剪贴画（吃满剩余高度）+ 简介 + 页脚 |
| `tall` 竖纸 | 3 | 同上 |
| `stamp` 大纸 | 2 | 标签 + 铅笔批注（**不贴图**，贴了会把页脚顶出去） |
| `stub` 小方纸 | 2 | 只有标题与主操作 |

关键实现细节：

- 截图放在 `.sk-card-clip`（`position: relative` + `overflow: hidden`）里，`<img>` 绝对定位 `object-fit: cover`。**绝不能让 `<img>` 的固有比例参与 flex 计算**，否则图片会反向把纸片撑破（实测高度从 320 涨到 616）。
- 胶带、图钉、折角是**绝对定位**的实物层，必须 `position: absolute` 且不占流内空间 —— 它们曾各占 19/21px，把剪贴画挤到只剩 94px。
- 无截图时用 `.sk-card-sketch`：一张"待填的速写页"，手绘小图 + 三行长短不一的笔迹。

## 详情双栏

两栏**严格等高**，各自在超过上限后内部滚动：

- 外框 `max-height: min(64vh, 720px)` + `grid-template-rows: minmax(0, 1fr)`
- 子面板 `min-height: 0`（不加这条，内容多的那栏会把整行撑开，另一栏底下留大片空白）
- 截图区与 README 各自 `overflow: auto`
- 窄视口（≤1100px）改单列，上限交给页面滚动，不做双滚动条

## 特别效果

### 常驻自动动效（不需要悬停）

- **线条沸腾（boil）**：三个同频不同种子的位移滤镜（`#sk-rough` / `-b` / `-c`）按 `steps(1)` 轮换，模仿真人反复描同一条线。高档作用于全部纸片，中档只给主推大纸，低档静止。
- **纸片浮动**：`sk-card-float`，每张相位错开（`--sk-i × -0.7s`），像被穿堂风吹着。
- **精选呼吸**：`sk-feature-breathe`，四张精选相位错开，`translate` + 微旋转。
- **剪贴画呼吸**：`sk-clip-breathe`，截图极轻微缩放，拉开层次。
- **胶带起伏**：`sk-tape-lift`，胶带随时间轻轻回正再翘起。
- **墨条呼吸**：`sk-ink-breathe`，左侧分类墨条的透明度缓慢变化。
- **涂鸦摆动**：`sk-doodle-sway`，精选角上的手绘记号。

### 交互与入场

- **纸片掀起**：悬停时纸角翻起（`.sk-dogear-hover` 用 `clip-path` + 渐变做出卷起的纸背），投影从 `card` 散成更大扩散。
- **胶带压实**：悬停时胶带回正并提升不透明度。
- **入场**：`sk-paste`（纸片被贴上桌面）与 `sk-feature-drop`（精选落下），按 `--sk-i` 错峰。

### 入场与常驻动画的交接（踩过的坑）

入场动画与常驻浮动都用 `animation`，直接叠加会互相覆盖：

1. 入场只碰 `opacity / scale / rotate`，常驻浮动只碰 `translate` —— 属性不重叠。
2. 入场结束后由 JS 移除 `is-new`，常驻动画接管。
3. **`animationend` 判定要收窄**：卡片内的胶带、墨条、图标也在跑动画，按 `target` 判断会被它们提前打掉；必须先确认 `event.target === node && !event.pseudoElement`。
4. **兜底定时器**：事件丢失（动画被跳过、元素不可见）时 1200ms 后强制收口，否则纸片会永远停在入场态、常驻动画不生效。

低动效档下以上全部 `animation: none`（含 `::before` / `::after` 伪元素动画，它们不能用 `:is()` 包住整条选择器声明）。

## 手绘实现要点

- 滤镜只挂在**纯描边的绝对定位伪元素**上（`filter: url(#sk-rough)`）。滤镜会让元素成为包含块，套在容器上会破坏定位与滚动 —— 这是最容易踩坏布局的地方。
- 三档粗糙度：`#sk-rough`（纸片外框，scale 3.4）、`#sk-rough-fine`（按钮 / 标签，scale 1.5，避免细字被推糊）、`#sk-rough-wild`（强调面，scale 5.2）。
- 标题下划线、圈注、撕口、折角都是真路径 / 真多边形，不是 CSS 圆角条。
- 纹理全部是纯 CSS 多层渐变：没有 data URI 纹理、没有图片、没有逐帧 JS。
- 纸品派生量（`--sk-*`）定义在 `:root`，不是 `.sk-surface`：卡片、按钮、面板都靠继承取得纸色，只在某个类上声明会让子元素拿不到。

## 设置页（`settingsPage`）

V2 主题包声明 `settingsPage: { version: 1, entry: "settings/preferences.html" }`，在宿主的隔离沙箱里自绘设置界面，只使用 `window.enestSettings`（快照 + 单次手势写入 + 原生分组入口）。

**必须对齐壳的设置页**，否则用户在两者之间切换会像换了个软件：

| 层 | 结构 | 关键尺寸 |
| --- | --- | --- |
| 页 | `.settings-shell` 单列居中 | `max-width: min(880px, 100%)`，`padding: clamp(28px,4.5vh,44px) … 120px` |
| 导航 | `.settings-tabs` 顶部横向胶囊 | 高 32px，`--radius-md` 容器 |
| 卡片 | `.s-card` | `padding: 24px`，`--radius-lg`，1px `--border` |
| 行 | `.field` 左标签右控件 | `grid-template-columns: 1fr var(--settings-control-width)`，`min-height: 68px`，行间 1px 分隔线 |
| 分段 | `.segmented` 胶囊 | 高 32px，选中项 `--surface` 底 + 发丝内边 |

右列宽度与壳同源：`--settings-control-width: 280px`。

**设置页不引入纸品/手绘层**（不 link `paper.css` / `paper-ui.css`，也不 import `sketchPrimitives`）—— 它是可信设置界面的一部分，保持中性克制；纸品语汇只留在主页面。

设置分组精简为 4 组 17 项：外观（桌面预设 + 5 个关键色）/ 版面 / 手写 / 细节。字段 id 是一次性句柄，不持久化、不猜测。

### 两个契约限制

1. **快照不带 `preview`**：`ThemeSettingsFieldDescriptor` 只有 `label` / `value` / `options[]`，所以预设缩略图必须由设置页按 id 自己画（`DESK_SWATCHES` / `DESK_PAINTS` 两张表，新增预设时同步）。
2. **快照不带 `background`**：`QuickThemeAppearance` 只公开 tokens/fonts/components/animation，所以设置页自己的桌面背景也要按预设 id 从 `DESK_PAINTS` 查。

### 握手顺序（踩过的坑）

宿主 8 秒内收不到 `ready()` 就判定主题设置不可用、回退系统设置。所以：

1. 拿到桥之后**立刻 `ready()`**，前面不能有任何可能抛错的准备；
2. 再订阅 `onState`、取首帧 `getState()`；
3. 订阅与首帧各自 try/catch，渲染失败只在页面内显示错误。

之前把 `ready()` 放在取快照之后，任何一步异常都会拖死握手 —— 表现就是设置页顶部出现「主题设置暂不可用」。

## 零构建约束（重要）

主题工作区在**开发态源码加载**时由宿主直接从磁盘读取并注入 `script-src 'self'` 的 CSP（见 `src/main/home/homeSessionPolicy.ts`：loopback 例外只对内置首页开放）。因此：

- 工作区必须是**浏览器可直接执行的纯 ESM**，不能有 JSX / TS / 打包语法；
- CSS 用 `<link>` 引入，不能写 `import './x.css'`（Vite 语法，原生浏览器按 MIME 拒绝），也不能用 `@import` 跨目录；
- DOM 用 `lib/dom.js` 的 `h()` 构造，避免模板字符串注入；
- 共享纸面层（`lib/paper.css`、`lib/paper-ui.css`、`lib/dom.js`、`lib/icons.js`、`lib/sketchPrimitives.js`）放在 `lib/`，不放在 `src/`：`settingsPage` 的 `enest-settings` 协议**拒绝 `src/` 目录**（见 `chromeAssetPath`），而工作区可以读取包内任意非 `src` / `backend` 资产。

样式台与浏览器演示从 `plugin.json` 动态导入本包主题声明。注意：Vite 会把 JSON 转成 ES 模块，所以**不能写 `with { type: 'json' }`** —— 那会让浏览器按严格 JSON 模块校验 MIME，而 dev 服务返回 `text/javascript`，整条 import 会被拒绝。

## 无障碍

- `--text-3` 在 `--surface` 上 ≥ 4.5:1；主按钮用 `--sk-marker-deep`（马克笔压深），白字对比 5.0:1 以上；深色模式改用深色字。
- 焦点环统一 2.5px 虚线马克笔色（`outline: 2.5px dashed var(--accent)`），不用浏览器发光框。
- 低动画档与 `prefers-reduced-motion` 下停用线条沸腾、悬停形变、骨架微光与入场编排；隐藏预热时持续动画 `animation-play-state: paused`。
- 纸片倾斜在 `prefers-reduced-motion` 与窄窗口下归零。

## 结构

```text
plugin.json                 主题包（V2）+ homePages + settingsPage 声明
lib/                        跨页面共享的纸面层（paper.css / paper-ui.css）与零构建 DOM 工具
index.html + src/index/     主题样式台：按钮、输入框、开关、图标、小窗、通知、色板
homes/sketchbook.html       主题工作区入口
settings/preferences.html   自绘设置页（隔离沙箱，只用 enestSettings）
src/market/                 市场工作区：controller（握手 / 路由 / 动作）+ SketchMarket（UI）+ market.css
src/quick/                  Quick 呈现页
src/shared/                 applyAppearance（快照 → CSS 变量）、previewTheme（声明预览）
public/assets/market/       icon.svg、README.md、CHANGELOG.md、screenshots
```

## 实现边界

- 首页是隔离页面，只拿到 `enestWorkspace`；设置入口走 `openSettings` 动作，不读 `shellApi`。
- 设置页只有 `enestSettings`：白名单字段句柄与原生分组入口，拿不到普通插件桥、任意网络或文件能力。
- 纸面、桌面纹理与漂移都在本页自绘：首页视图默认不透明，不能依赖壳层背景透出。
- 壳层背景使用宿主内置光效（`none` / `aurora` / `ripple` / `fold` / `orbit`）；插件不能注入 shader 或任意 CSS。
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
#   http://127.0.0.1:5210/homes/sketchbook.html      市场工作区
#   http://127.0.0.1:5210/settings/preferences.html 自绘设置页（预览桥）
#   http://127.0.0.1:5210/index.html                 主题样式台
```
