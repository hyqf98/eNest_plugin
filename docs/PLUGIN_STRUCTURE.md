# 插件工程、加载与发行契约

本契约区分源码和发行包；不支持旧根目录 `assets/js`、`logo` 或任意包路径。Schema 见 [plugin-manifest.schema.json](plugin-manifest.schema.json)，开发操作见 [debug.md](developer/debug.md)。

## 源码工程

```text
plugins/com.example.hello/       # 名称必须等于 manifest.id
├── plugin.json                 # main 固定 index.html
├── package.json                # name/version 对齐 manifest；type=module
├── index.html                  # 仅引用外部脚本，不写 inline JS
├── vite.config.ts              # 可选：React/Vue 插件、别名等编译配置
├── src/
│   ├── entry.js                # 可换为框架入口 .ts/.tsx
│   ├── js/
│   └── css/
├── public/assets/
│   ├── market/
│   │   ├── icon.svg
│   │   ├── README.md
│   │   └── screenshots/01-main.png
│   └── vendor/                 # 必须原样携带的第三方资源与许可证
├── tests/
└── dist/                       # 生成目录，不提交
```

官方插件使用 npm workspaces。`@enest/plugin-kit` 是仓库内部共享包，通过依赖与 import 引入；需要复制到独立仓库时也应作为合法 npm/file 依赖管理，不能写跨插件相对路径。业务自己的源码、样式、图片均可从 `src/` import，由构建器输出到 `assets/app/`；`public/` 只放不经编译的 `assets/market` 与 `assets/vendor`。

## 三种加载情况

| 情况 | 壳子读取的入口 | 编译与更新责任 |
| --- | --- | --- |
| 原生静态源码 | 根 `plugin.json`、`index.html`；`/src/*` 映射 `src/*`，`/assets/*` 映射 `public/assets/*` | 页面只使用浏览器可执行代码；需要更新时手动重载 |
| Vite / React / Vue / TS 开发 | 选择同一个源码根，`development.main` 指向已有 HTTP(S) 服务 | 开发者运行 npm，框架服务负责编译与 HMR |
| 安装发行包 | ZIP 根的 `plugin.json` 与 `index.html` | 运行已构建的离线 JS/CSS，不依赖开发服务器 |

选择文件夹后直接在该目录启动，不安装到源码仓库，也不复制到 `~/.eNest/plugins/`。壳子不扫描猜测 `dist/`、不执行 npm、不建立文件监听器。含裸 npm import、Vue SFC 或 TypeScript 的源码应选择开发服务器方式，不能期望壳子代替 Vite 编译。

`development.main` 是完整 URL，例如 `http://192.168.1.20:5173/`，保持 `main: "index.html"` 不变。不能将磁盘路径放进 `development.main`，不能添加 `development.mode` 或 `development.url`。生产清单由构建脚本自动移除 development，发行检查拒绝它。

## 构建与框架

```bash
npm run dev --workspace com.example.hello
node scripts/build-plugin.mjs com.example.hello
node scripts/pack-plugin.mjs com.example.hello
```

统一构建脚本读取插件自己的 Vite 配置，从根 `index.html` 构建。Vue 项目安装 `vue` 和 `@vitejs/plugin-vue`，React 项目安装 `react`、`react-dom` 及对应 Vite 插件，再在本项目 `vite.config.ts` 注册；HTML、manifest、public 和 dist 契约不变。构建使用相对 base，脚本固定产物目录、文件命名、禁用 Source Map，并拒绝 library/SSR 入口。

生产 CSP 不允许内联脚本、`eval` 或 CDN 脚本。业务使用 `addEventListener`，依赖打包进本地。Web Worker 和 Monaco 等编辑器也必须离线打包；WASM 可使用宿主允许的编译能力，但网络和操作系统功能仍走 `window.enest`。

## 发行结构

```text
{id}@{version}.enestplugin       # ZIP，以下就是归档根
  plugin.json                   # 无 development
  index.html
  assets/
    app/                        # 构建输出
    market/                     # 图标、说明、真实截图
    vendor/                     # 原样复制依赖
```

禁止包一层 `{id}/` 或 `dist/`。禁止绝对路径、`..`、反斜杠、编码分隔符、隐藏段、软链接、源码或测试目录。路径大小写必须与引用一致。校验器检查 HTML 的脚本/样式/图片、CSS URL、JS 模块与 worker 引用及 README 图片是否存在。

DSH 是唯一允许附带 `runtime/` 的插件，其固定版本位于 `scripts/plugin-contract.mjs`。构建器把生产依赖缓存到仓库 `dist/runtime-cache/`，再复制到插件 `dist/runtime/`；源码中不建立运行时软链接。宿主掌管该运行时的进程、端口和权限，插件页面不能自己访问 Node。运行时升级附件命名为 `dsh-runtime-<version>-<platform>-<arch>.tgz` 及 `.sha256`。

## 数据与响应式布局

插件自行实现业务逻辑；壳提供统一能力。插件私有数据使用 `enest.storage`，设置使用 `enest.settings`，这些基础能力无需声明或弹窗；宿主默认数据根为 `~/.eNest`。读写用户文件必须经 `enest.localFiles` 的授权选择和句柄，不接受自行拼出的绝对路径。详见 [权限与隔离](developer/permissions.md)。

Quick 和 shell 是同一插件实例的两种容器形态，不按固定屏幕宽度设计两套页面。用 `getLaunchMode` 与 `onModeChange` 切换工具布局，并保留输入、编辑模型与连接；用 Grid/Flex、`minmax(0,1fr)`、`min-width:0` 和容器/媒体查询实现窄窗收缩。至少验证 720×420、480×320、960×640，以及明暗主题和动画档位。完整约定见 [UI Standard](developer/ui-standard.md)。
