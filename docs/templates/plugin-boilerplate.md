# 标准插件起步模板

以 `plugins/com.example.hello` 为最小可运行参考。复制工程时同步修改目录名、`plugin.json.id`、`package.json.name` 和构建命令中的插件 ID；版本也保持一致。完整格式见 [工程结构](../PLUGIN_STRUCTURE.md)。

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

// 当前页面迁移至另一容器时保留同一个 DOM 与输入。
kit.onMode(mode => { document.documentElement.dataset.mode = mode })
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
