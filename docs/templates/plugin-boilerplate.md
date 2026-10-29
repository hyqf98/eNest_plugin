# 标准插件起步模板

按本模板新建 `plugins/<短名>/` 工程（目录名必须等于 `plugin.json.id` 的末段），同步修改 `plugin.json.id`（建议 `com.github.eNest.<短名>`）、`package.json.name`（等于短名）和构建命令中的插件目录名。完整格式见 [工程结构](../PLUGIN_STRUCTURE.md)。

只声明真正实现的布局。省略 `views` 的基础模板支持 quick/shell；需要自由面板组件时按下文增加 panel 呈现，不要仅给 manifest 增加一个标记。未声明 panel 的插件不会出现在组件选择器，也不能拖入；宿主不强制注入小组件样式。mode 是布局而非原生位置，完整契约见[UI 标准](../developer/ui-standard.md)和[自由面板](../developer/panels.md)。

`views.default` 只回退未适配的请求，不能用 `default: "panel"` 强制所有入口显示组件。Quick/快捷键与 Workspace 统一启动器会按最终布局选择窗口；宿主普通打开和显式固定/拖入有不同的位置保留规则。不要在插件内复刻这套入口决策，以 `getLaunchMode()` / 模式事件和实际视口绘制即可。

源码 HTML 使用外部入口：

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>我的工具</title>
</head>
<body>
  <main id="app"></main>
  <script type="module" src="./src/entry.js"></script>
</body>
</html>
```

`src/entry.js`（依赖 `@enest/plugin-kit`，开发时由 Vite 解析）：

```js
import '@enest/plugin-kit/style.css'
import '@enest/plugin-kit/responsive.css'
import '@enest/plugin-kit'
import './style.css'

const api = window.enest
const kit = window.PluginKit.create({ title: '我的工具', height: 420 })
const draft = document.createElement('textarea')
draft.setAttribute('aria-label', '输入内容')
document.querySelector('#app').append(draft)

// kit 同步 data-mode；容器迁移仍保留同一个 DOM 与输入。
api.onBeforeClose(async () => { await api.storage.set('draft', draft.value) })
api.onDestroy(() => { kit.destroy() })
```

私有存储、UI、设置和主题等基础能力无需声明或弹窗；按实际使用声明文件、网络、剪贴板等敏感权限；不要通过异常后退到 `navigator.clipboard`、Node、原生文件系统或任意 `fetch` 来绕开权限。外部文件通过宿主选择器取得句柄，读取、写入、保存都使用对应标准 API；用户取消时应保持原有输入和选择。

`src/style.css` 可从以下布局开始，不复制固定宽高的完整桌面：

```css
html, body { margin: 0; min-width: 0; min-height: 100%; }
body { background: var(--bg); color: var(--text); font-family: var(--font, system-ui); }
#app { display: grid; grid-template-columns: minmax(0, 1fr); gap: 1rem; padding: clamp(.75rem, 2vw, 1.5rem); }
textarea { box-sizing: border-box; min-width: 0; width: 100%; min-height: 10rem; background: var(--surface); color: inherit; }
@media (max-width: 560px) { #app { padding: .75rem; } }
```

组件使用壳子 `--bg`、`--surface`、`--text`、`--accent` 等 token。自定义动画要响应 `data-anim` 与 `prefers-reduced-motion`。主题和字体由宿主注入，不在 HTML 中硬编码 `enest://` 样式地址。

## 可选的组件呈现

在 `plugin.json` 增加以下片段；不替换原有 id、入口、功能与权限声明：

```json
{
  "views": {
    "layouts": ["quick", "shell", "panel"],
    "default": "shell",
    "panel": { "size": { "width": 240, "height": 240 } }
  },
  "ui": { "chrome": "none", "themeAware": true, "background": "transparent" }
}
```

复用上面的 `kit` 和 `draft`，不新建运行实例、存储副本或后台任务：

```js
import '@enest/plugin-kit/widget.css'

const widget = document.createElement('section')
widget.className = 'pk-widget'
const heading = document.createElement('div')
heading.className = 'pk-widget-heading'
const title = document.createElement('h1')
title.className = 'pk-widget-title'
title.textContent = '随手记'
heading.append(title)
const summary = document.createElement('p')
summary.className = 'pk-widget-content'
const expand = document.createElement('button')
expand.className = 'pk-btn pk-btn-sm'
expand.textContent = '在主窗编辑'
expand.addEventListener('click', () => {
  api.ui.openInShell().catch(error => kit.toast(error.message, 'error'))
})
widget.append(heading, summary, expand)
document.querySelector('#app').append(widget)
const updateSummary = () => { summary.textContent = draft.value.trim().slice(0, 480) || '暂无内容' }
const applyMode = mode => {
  draft.hidden = mode === 'panel'
  widget.hidden = mode !== 'panel'
  updateSummary()
}
const offMode = kit.onMode(applyMode)
draft.addEventListener('input', updateSummary)
applyMode(kit.mode)
api.onDestroy(() => { offMode(); draft.removeEventListener('input', updateSummary) })
```

这里切换的是同一份草稿的编辑/摘要呈现。`kit.mode/onMode` 与 `.quick-only/.shell-only/.panel-only` 都支持三布局；纯 API 实现则订阅 `enest.onModeChange` 后读取 `getLaunchMode()`，无需依赖 kit。

全局透明仅打开原生能力，CSS 也要配合。以下覆盖基础模板，使工作台保留底色，panel 只显示组件表面：

```css
html, body, #app { height: 100%; }
html, body { background: transparent !important; }
#app { background: var(--bg); }
:root[data-mode="panel"] #app { display: block; padding: 0; background: transparent; }
.pk-widget-content { margin: 0; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-height: 180px) {
  .pk-widget { gap: 4px; }
  .pk-widget-content { font-size: .85em; line-height: 1.4; }
}
```

`.pk-widget` 是可选语义表面，允许完全自绘。它不模糊真实桌面，也不控制面板移动；原生材质、移动与缩放归宿主。用户直接拖动组件边缘移动、拖动四角缩放，无需切换编辑模式或点击完成。平时保留真实内容交互，仅在实际拖动、缩放或菜单期间使用有界预览并短暂隐藏原生内容；松手自动恢复内容并保存布局，菜单关闭自动恢复交互。插件不应另造编辑工具栏或拖动控件。`panel.size` 是初始外框，不是固定内容视口，不保证小/中/大尺寸族；使用实际宽高与响应式布局。更完整的 React 例子见 `plugins/pomodoro/src/jsx/PanelView.jsx`，其三布局共用现有计时控制器。

## 分发与资源

市场资料位于 `public/assets/market/`，包括 `icon.svg`、`README.md` 和真实界面截图。最终 `dist/` 必须带上这些文件；README 的截图引用写成 `./screenshots/01-main.png`。

用户文件导入使用宿主 API，取消不改变当前内容：

```js
const [file] = await enest.localFiles.pick({ kind: 'file', access: 'read' })
if (file) {
  const text = await enest.localFiles.read({ handleId: file.id, encoding: 'text', maxBytes: 2 * 1024 * 1024 })
  draft.value = text
}
```

官方图像工具用 `@enest/plugin-kit/file-inputs` 把 `pick/read` 返回的授权字节转换为内存 `File`，复用图片解码算法；拖入文件先经 `fromDrop` 确认，再 `read`。这只是官方插件的开发适配层，不是恶意页面的安全边界；实际能力授权与文件句柄归属校验由宿主负责。不要在权限失败后直接读取原始拖拽 File，也不要把路径字符串当作句柄。
