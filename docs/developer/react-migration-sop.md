# 官方插件 React 化迁移 SOP

> 适用范围：**eNest 官方插件**（`plugins/*`）。插件体系本身保持框架无关，
> 第三方开发者可自由选择 Vue / 原生 HTML / 任意技术，包格式与运行约束不变。

## 技术栈约定（与壳一致）

| 层 | 选型 | 说明 |
|----|------|------|
| UI 框架 | React 18.3 + react-dom | 版本与壳 `package.json` 对齐 |
| 行为组件 | Radix UI（按需） | `@radix-ui/react-{slot,select,switch,checkbox,tooltip,dialog,popover,toggle-group,slider,dropdown-menu}`，版本与壳对齐 |
| 标准控件层 | `src/ui/index.jsx` + `src/ui/pk-ui.css` | 从壳 `src/renderer/components/ui` 派生；`pk-*` 类名，token 直读，自包含样式 |
| 业务样式 | 各插件自有 CSS | DOM 结构/类名复刻，元素选择器样式继续生效 |

壳的 `components/ui/` 是组件层**唯一上游**；插件 `src/ui/` 模板整体复制，随壳升级同步。

## 迁移九步（每个插件）

1. **基线截图**（改造前）：
   ```bash
   node scripts/capture-plugin-ui.mjs <pluginId> /tmp/<id>-before
   ```
2. **依赖**：插件 `package.json` dependencies 加 `react@^18.3.1`、`react-dom@^18.3.1` + 按需
   `@radix-ui/*`（版本抄 calculator），workspace 根 `npm install`。
3. **入口**：`index.html` body 改 `<div id="root"></div>`；`src/entry.js` 末尾挂载：
   ```js
   import { createElement } from 'react'
   import { createRoot } from 'react-dom/client'
   import { App } from './jsx/App.jsx'
   createRoot(document.getElementById('root')).render(createElement(App))
   ```
4. **React 化**：`src/jsx/App.jsx` 复刻原 DOM（**结构/类名/id 一致**）；命令式逻辑转
   state/effects；plugin-kit 的 `PluginKit.create` 一次初始化，回调用 latest-ref 桥接
   （参考 calculator `src/jsx/App.jsx`）；**业务核心模块（core/backend API 调用）原样复用**。
5. **ui 模板**：复制 calculator 的 `src/ui/{index.jsx,pk-ui.css}`；表单类控件
   （下拉/开关/复选/分段）改用 `pk-*` 组件。
6. **冗余清理**：删除被取代的旧 JS 与手写控件样式（逐条核对，保留业务布局样式）。
7. **样式核验**：hover / focus / disabled / active × 明暗主题 × quick/shell 逐态确认生效。
8. **构建 + 截图对比**：
   ```bash
   node scripts/build-plugin.mjs <pluginId>          # 必须无错
   node scripts/validate-dist.mjs                     # 必须通过
   node scripts/capture-plugin-ui.mjs <pluginId> /tmp/<id>-after
   node scripts/diff-captures.mjs /tmp/<id>-before /tmp/<id>-after   # ≤0.5% 通过，抗锯齿级可接受
   ```
9. **版本**：`plugin.json` version minor +1（如 1.3.0 → 1.4.0）。

## 基础控件统一规范（2026-10-16 起）

所有官方插件的按钮/下拉视觉统一到 **@enest/plugin-kit 的 `.pk-btn` / `.pk-select-*` 参数**，实现机制在 `src/ui/pk-ui.css`：

- **`.btn` 别名映射**：pk-ui.css 在每插件级联的最后加载（业务 CSS → kit CSS → pk-ui.css），
  其中 `.btn` 与 `.pk-btn` 共享同一参数表（28px 高、1px 描边、surface 底、12.5px 字、
  `--pk-radius` 圆角）——各插件 CSS 里的 `.btn` 基础定义被统一覆盖，而**业务变体
  （`.btn.primary` / `.btn.icon` 等双类选择器）specificity 更高，继续生效**。
  新插件直接用 `.btn` 或 pk-ui 的 `<Button variant>` 均可，视觉一致。
- **Select 双通道同视觉**：命令式渲染器里的原生 `<select>` 由 plugin-kit
  `upgradeSelects` 自动升级（kit 参数）；React 层新表单用 pk-ui 的 Radix Select
  （`.pk-select-trigger` 已与 kit 参数完全一致：28px / 4px 10px / surface 底 / 弹层 280px）。
  两通道视觉相同，按场景选择：模板字符串 HTML 用原生 select，JSX 表单用 pk-select。
- **迁移后必须 `import './ui/pk-ui.css'`**（业务 CSS、kit CSS 与 App 导入之后，保持最后加载）。
  官方工具插件共用这套模板；主题展示插件保留自己的设计系统。新插件从 calculator 复制 `src/ui/` 模板。

## 精简工具栏与悬停导航

- 常用操作留在当前页面；导入、导出、复制变体和管理操作归入 `MoreMenu`。不为减少按钮数量隐藏必需的状态、连接信息或编辑工具。
- 列表与卡片的右键菜单必须同时有可点击的「更多」入口。`.pk-row-actions` 在 hover / focus-within 时显示，在触屏下常显；隐藏时不截获点击，但键盘可以聚焦进入。
- `DropdownMenu` / `MoreMenu` 从壳 `components/ui/DropdownMenu.tsx` 派生，行为使用已安装的 Radix DropdownMenu。`MoreMenu` 接受 `{key,label,onSelect,disabled?,danger?,hint?}`，勾选项使用 `as: 'check'` / `checked`；分隔符使用 `{sep:true}`。触发按钮与 portal 内容不向列表父项冒泡点击和键盘事件。
- 命令式引擎使用 `PluginKit.openMenu(eventOrAnchor, items, onPick, options)`，支持相同的危险项、禁用项与勾选状态；Shift+F10 / 方向键 / Esc 入口由绑定辅助方法提供。业务确认对话框仍由原处理函数负责，不得因为移动到菜单就跳过确认。
- 收起侧栏的小导航菜单使用 `PluginKit.hoverFlyout(anchor, getItems, options)`；需要预览现有列表的侧栏使用 `PluginKit.bindHoverPanel(anchor, panel, options)`，通过 `data-peek="true"` 设置临时浮层样式，禁止克隆或重新挂载编辑器、终端与连接视图。
- 悬停默认 120ms 展开、移出 300ms 收起；指针移入面板或键盘焦点在面板内时保持展开。鼠标悬停不抢焦点，方向键可显式进入，Esc / 窗口失焦 / 外部点击收起。`enabled` 可传函数读取当前折叠状态；已有点击展开逻辑使用 `handleClick:false`，保留鼠标点击与触屏路径。卸载时调用 `destroy()`，临时浮层不写入持久设置。
- 菜单的颜色、字体和圆角跟随宿主 token；实际内容中的颜色（用户色板、语法高亮、终端 ANSI）不属于界面强调色，不做批量替换。窗口变窄时菜单限高滚动，不能让最后几项落在窗口外。
- 构建命令使用插件目录短名，例如 `node scripts/build-plugin.mjs diff`，不是完整插件 ID。构建与静态检查不等于交互验收；测试、截图及原生功能操作按用户明确要求执行。

## 环境要点（踩过的坑）

- **构建必须 node@22**（vite 8 要求）：`/opt/homebrew/opt/node@22/bin/node`。
- `build-plugin.mjs` 已统一注入 `esbuild: { jsx: 'automatic' }`；插件目录放
  `vite.config.js`（同款配置）+ `jsconfig.json`（`"jsx": "react-jsx"`）保证 dev 一致。
- **`#root` 高度**：`html, body, #root { height: 100% }` 必须写进插件 CSS，否则全高布局断裂。
- **CSS 级联顺序是像素级一致的命门**：原版业务 CSS 以 `<link>`/内联 style 先于
  plugin-kit CSS 加载（kit 的 `button{font:inherit}` 会覆盖按钮字号）。React 化后
  **业务 CSS 必须放 entry.js 第一行 import**（先于 `@enest/plugin-kit/*`），复刻原顺序；
  顺序反了会产生 3~7% 像素偏差。也不要给 body 新增 font 声明（原版继承 kit 的 13px）。
- **原生 `<select>` 场景保留原生**：plugin-kit 的 MutationObserver 会自动
  `upgradeSelects`（内容自适应宽 + kit 视觉）。**不要**换成 pk-ui 的 Radix Select
  （固定 120px 宽 + 弹层行为不同，translate 实测产生 4% 布局偏差）。只有"无原生
  select 的新表单"才用 pk-select。
- **React 受控输入之外的 DOM 写回**：跨组件触发原联动管线时，用原生 value setter +
  `dispatchEvent(new Event('input'))`（unit-convert 预设按钮实测）。
- **hooks 规则**：plugin-kit 初始化 effect 必须放在任何条件 return 之前（pomodoro
  曾因快照为 null 提前 return 导致 kit 永不初始化）。
- CSP 禁内联脚本/eval/CDN——React/Radix 生产构建均兼容；不要用需要 `new Function` 的库。
- **package.json 的 name/version/type 必须与 plugin.json 同步 bump**（validate-manifests 强校验）。
- 体积参考：react+react-dom+Radix 按需打包后单插件约 +200KB。
- 截图工具会等 `#keypad button, .history-list .record` 之类渲染标志；新插件若无这些
  元素，工具会在 8s 后 WARN 并继续——此时人工确认截图含完整 UI 再进 diff。

## 已完成 React 化的插件

- `com.github.eNest.calculator` 1.4.0 —— 试点参考实现（视觉 diff 0.56~0.78%，功能冒烟全过）
