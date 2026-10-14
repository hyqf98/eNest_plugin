# 官方插件工程与交付验收 · 2026-10-13

本次检查覆盖仓库中的全部 35 款插件。已完成源码工程、构建包、权限声明、文件导入、资源发布、双模式布局和图标/截图的统一迁移，并修复检查中实际复现的问题。本报告记录插件仓库结果；宿主安全边界、数据目录迁移、生命周期与性能结论应结合壳仓库的工程验收报告阅读。

## 已实施的工程契约

- 源码固定为 `plugins/<id>/plugin.json + package.json + index.html + src/ + public/`，目录名、manifest id、package name 一致。35 个项目均为可独立启动的 Vite workspace，入口文件只引用外部模块。
- 静态市场资源固定在 `public/assets/market/`，包含语义化 SVG 图标、README 和真实 UI 截图；构建后映射为 `dist/assets/market/`。共享适配器从 `@enest/plugin-kit` 导入，不再依赖跨插件目录或旧共享脚本路径。
- 生产固定入口 `dist/index.html`，同时输出 `dist/plugin.json`；生产 manifest 不含 `development`。归档直接打包 `dist` 内容，根目录不得再包一层项目文件夹；格式为 `<id>@<version>.enestplugin`。
- 普通插件包禁止源码、测试、node_modules、隐藏路径、符号链接和 source map；HTML/CSS/ESM/worker/README 内本地引用必须能在包内解析。中文/空格媒体文件名受支持，但路径穿越、控制字符、反斜线和 URL 转义混淆被拒绝。
- DSH 是受宿主管理的 runtime 例外，固定版本 `0.2.0-rc.2`，依赖放在生产包 `runtime/`；第三方依赖自带的隐藏文件不等同于普通插件源码。旧源码 runtime 已保存在忽略目录 `dist/migration-backups/com.enest.dsh-runtime/`，未删除其原始外部依赖。
- registry 与 release 媒体均从最终 ZIP 中读取，不从任意源码路径拼接。35 包的 manifest、入口、图标、README、截图、SHA-256 和大小已核对；105 个必需媒体文件与构建目录逐字节一致。

## 修复的实际问题

1. 批量重命名与局域网传件的入口 IIFE 少了调用括号，构建后只剩静态页面。已补调用，实际点击宿主文件选择器后，两款均能展示授权文件队列。
2. 网络调试台 WebSocket 参数/事件结构与宿主不一致，改用 `socketId`、base64 binary 和可清理订阅；HTTP 流式监听增加请求身份检查与清理，避免后续响应重复追加。
3. 进程与端口从端口跳转到进程时，旧搜索框值覆盖了目标 PID。现在输入及时写入状态，渲染不再反向覆盖程序设置的查询。
4. 编解码的 Quick 窄窗网格、Markdown/片段/网络工作区的宽度和头部布局已修复；共享 workbench 统一窄窗约束和滚动边界。
5. 图片工具箱在压缩/转换等任务完成后没有刷新结果动作，导致“另存、贴图、替换”一直禁用。现在重新渲染时同步结果状态；授权导入→选图→压缩→动作恢复的浏览器回归已通过。
6. 原生测试与调用检查发现 16 款插件合计 18 项敏感权限声明缺失，涉及文件导出、读写剪贴板和贴图，已补全 source/dist manifest。权限统一使用宿主生成的 10 项基础 / 37 项敏感分类：基础能力不再出现在官方插件的授权声明中；代码片段与供应商切换保留 `contribute`，明确用于接收 Quick 搜索文本并提供结果。35 份 README 与最终归档同步，新增能力声明回归检查。
7. 官方图片/哈希/二维码等导入统一走 `localFiles.pick/fromDrop → localFiles.read`。DOM File 只从宿主授权返回的字节创建；取消/拒绝授权不会退回读取原始拖入文件。批量改名/传件只使用句柄，不为入队读取完整文件。数据库、SSH、四款文本数据导入也迁移到相应句柄接口。

壳设置页现为全部 35 款已安装插件提供入口，包括没有自定义设置项的插件。权限区只显示需要用户同意的系统与隐私权限；基础能力另行解释。变更保存与原生授权事件实时同步；浏览器 mock 同样持久化、过滤旧基础授权，并拒绝基础能力的授权写入。旧的 renderer 授权弹窗已移除，原生宿主负责敏感操作的授权对话框。

官方适配器是约定与回归保障；真正的隔离边界仍是宿主的 sandbox、preload、权限校验和句柄所有权检查。不得将前端适配器描述为可以单独防住恶意插件。

## 验证层次与结果

| 层次 | 范围 | 结果 |
| --- | --- | --- |
| 工程/包契约 | 35 源码项目、35 dist、35 ZIP、35 索引记录、105 必需媒体 | 全部通过 |
| Node 测试与可选浏览器项 | `UTILITY_UI=1 npm test` | 一次完整运行 83/83 通过，0 失败、0 跳过 |
| 浏览器布局与资源 | 35 × 6 组合，实际模式标记、根横向溢出、非空内容、脚本错误、CSP、资源状态 | 210 组合全部通过 |
| 授权文件交互 | hash/image-tools/qrcode/color-picker/screen-assistant/batch-rename/lan-share | 7/7 通过；图片结果按钮修复后另复跑 1/1 |
| 文本与工作台交互 | 四款文本导入、数据库工作台 | 4/4、10/10 通过 |
| 网络与系统专项 | HTTP/Socket/进程交互与 WebSocket 文本/HEX | 修复后专项 6/6；WebSocket 1/1 |
| 双模式专项 | 4 开发工具、13 工具插件、图片与代码截图 | 对应专项均通过，包含主题/动画档/状态保持；不把多个时点运行虚报为一次完整套件 |
| 权限设置与详情界面 | 35 插件入口、敏感授权持久化/同步、基础能力说明、1080/560/400 宽度 | 全部通过，0 脚本异常、0 横向溢出 |
| Electron 原生隔离 | 35 最终生产插件在临时配置中启动、关闭及主题注册撤销 | 详见宿主原生报告与下方边界 |

Node 默认跳过的项目是 `UTILITY_UI=1` 才启用的六工具浏览器检查。本次完整测试运行已启用该项；其测试服务器也已从旧源码/共享目录迁移为标准生产 dist 预览。210 组合浏览器验收是另一组独立实际运行的证据；权限界面则在独立 renderer 预览中验证，不访问真实用户配置。

六种布局组合：shell 720×420、480×320、960×640；quick 720×420、480×320；shell 720×420 且基础字体 20px。测试实际检查 `data-mode` / `data-launch-mode` / `data-surface` 或相应工作区标记，hello 与主题演示是布局无关例外。

截图先执行实际离线交互再拍摄：算式与历史、代码画布、Base64、文本差异、摘要、图片压缩、JSON 格式化、二维码、正则替换、密码生成、图片标注和文件队列等。待办、笔记、验证器、系统进程和连接列表来自隔离演示数据。模拟宿主不访问用户文件、剪贴板、账户或真实服务；截图不是把设计稿伪装成运行结果。

## 逐插件矩阵

表中“结构/包/媒体”代表源码、构建目录、ZIP 与索引的联合校验；“布局”是上面六个尺寸/模式组合。ZIP 大小取最终归档字节，完整 SHA-256 记录在本地 `dist/plugin-audit.json` 和 `dist/registry.json`。

| 插件 | 版本 | 结构/包/媒体 | 布局 | ZIP 大小 |
| --- | --- | --- | --- | ---: |
| 批量重命名 (`com.enest.batch-rename`) | 1.0.0 | 通过 | 6/6 | 61.0 KiB |
| 计算器 (`com.enest.calculator`) | 1.2.0 | 通过 | 6/6 | 63.1 KiB |
| 供应商切换 (`com.enest.ccswitch`) | 1.0.0 | 通过 | 6/6 | 93.6 KiB |
| 剪贴板 (`com.enest.clipboard`) | 1.1.0 | 通过 | 6/6 | 58.0 KiB |
| 代码截图 (`com.enest.code-shot`) | 1.0.0 | 通过 | 6/6 | 101.0 KiB |
| 编解码 (`com.enest.codec`) | 1.1.0 | 通过 | 6/6 | 56.3 KiB |
| 取色器 (`com.enest.color-picker`) | 1.1.0 | 通过 | 6/6 | 105.2 KiB |
| Cron 工具 (`com.enest.cron`) | 1.0.0 | 通过 | 6/6 | 111.2 KiB |
| 数据库 (`com.enest.database`) | 1.1.1 | 通过 | 6/6 | 1.47 MiB |
| 文本对比 (`com.enest.diff`) | 1.0.0 | 通过 | 6/6 | 59.7 KiB |
| DSH 驾驶舱 (`com.enest.dsh`) | 0.1.0 | 通过 | 6/6 | 149.90 MiB |
| 哈希与加密 (`com.enest.hash`) | 1.0.0 | 通过 | 6/6 | 75.6 KiB |
| 图片工具箱 (`com.enest.image-tools`) | 1.0.0 | 通过 | 6/6 | 92.8 KiB |
| JSON 工具 (`com.enest.json-tools`) | 1.1.0 | 通过 | 6/6 | 59.0 KiB |
| 局域网传件 (`com.enest.lan-share`) | 1.0.0 | 通过 | 6/6 | 75.6 KiB |
| Markdown 笔记 (`com.enest.markdown`) | 1.0.0 | 通过 | 6/6 | 70.2 KiB |
| 中间件控制台 (`com.enest.middleware`) | 0.1.0 | 通过 | 6/6 | 154.3 KiB |
| 网络调试台 (`com.enest.net-kit`) | 1.0.0 | 通过 | 6/6 | 79.0 KiB |
| 密码工具箱 (`com.enest.password-kit`) | 1.1.0 | 通过 | 6/6 | 76.1 KiB |
| 番茄钟 (`com.enest.pomodoro`) | 1.1.0 | 通过 | 6/6 | 66.6 KiB |
| 二维码 (`com.enest.qrcode`) | 1.1.0 | 通过 | 6/6 | 122.3 KiB |
| 正则工作台 (`com.enest.regex`) | 1.0.0 | 通过 | 6/6 | 104.6 KiB |
| 远程桌面 (`com.enest.remote-desktop`) | 1.0.0 | 通过 | 6/6 | 2.08 MiB |
| 屏幕助手 (`com.enest.screen-assistant`) | 1.2.0 | 通过 | 6/6 | 92.3 KiB |
| 代码片段 (`com.enest.snippets`) | 1.0.0 | 通过 | 6/6 | 64.3 KiB |
| SSH管理 (`com.enest.ssh`) | 1.1.1 | 通过 | 6/6 | 1.55 MiB |
| 备忘录 (`com.enest.sticky-notes`) | 1.1.0 | 通过 | 6/6 | 100.3 KiB |
| 进程与端口 (`com.enest.sysguard`) | 1.0.0 | 通过 | 6/6 | 46.3 KiB |
| 主题示例 (`com.enest.theme-demo`) | 0.1.0 | 通过 | 6/6 | 65.7 KiB |
| 时间戳 (`com.enest.timestamp`) | 1.1.0 | 通过 | 6/6 | 88.0 KiB |
| 待办清单 (`com.enest.todos`) | 1.1.0 | 通过 | 6/6 | 95.8 KiB |
| 验证器 (`com.enest.totp`) | 1.0.0 | 通过 | 6/6 | 39.2 KiB |
| 翻译 (`com.enest.translate`) | 1.3.0 | 通过 | 6/6 | 61.0 KiB |
| 单位与汇率 (`com.enest.unit-convert`) | 1.0.0 | 通过 | 6/6 | 50.1 KiB |
| Hello 示例 (`com.example.hello`) | 1.0.1 | 通过 | 6/6 | 19.7 KiB |

## 原生与真实服务边界

宿主报告：[`official-plugin-native-smoke-2026-10-13.json`](../../docs/engineering/official-plugin-native-smoke-2026-10-13.json)。临时 profile 不为基础能力写授权；插件存储/设置/UI/vault/主题按统一策略直接可用，OS 与网络能力拒绝。检查生产 preload bridge、`sandbox=true`、没有 Node `require/process`、启动资源与图片、未处理异常、CSP，以及每次关闭后的实例/activity/session/native view 清理。主题演示实际注册主题包并验证禁用后撤销。

数据库、SSH、中间件、远程桌面和 DSH 的页面启动成功，不代表真实后端连接、操作系统权限弹窗或长期负载已经集成验收。没有使用用户数据库、远程服务器、桌面、真实凭据或真实 DSH 会话进行操作。ccswitch 被拒绝 `config.agent.read` 时的已捕获提示属于测试策略的预期路径。

DSH 包含受管理运行时，体积明显大于普通前端插件；其启动和内存需要结合宿主独立性能报告判断。浏览器截图的耗时也不能用作原生插件启动性能结论。

## 可复用工具与交付位置

- `scripts/validate-manifests.mjs`、`build-plugin.mjs`、`validate-dist.mjs`、`pack-plugin.mjs`：工程/构建/包验证。
- `scripts/build-registry.mjs`、`prepare-release.mjs`：以最终归档为唯一市场元数据来源。
- `scripts/capture-market.mjs`、`market-scenarios.mjs`、`preview-fixture.mjs`：可重跑真实 UI 演示与 210 组合检查。
- 本地证据：`dist/visual-audit.json`、`dist/plugin-audit.json`、`dist/market-contact-sheet.jpg`、35 个 `.enestplugin` 与 runtime 侧包。`dist/` 被忽略，不进入源码仓库。
- 开发说明见 [文档导航](README.md)、[标准工程结构](PLUGIN_STRUCTURE.md)、[开发者指南](developer/getting-started.md)、[API](developer/api.md)、[双模式布局](developer/ui-standard.md)、[主题](developer/themes.md)；AI 指导在 [enest-development skill](../skills/enest-development/SKILL.md)。SDK 与开发者指南由宿主生成/同步工具检查一致性。

本次只准备本地 `plugins-local` 发布资产，未向 GitHub 发布，也未 commit 或 push。实际发布前由仓库工作流设置真实 tag/REPO，不能把本地生成的占位发布 URL 视为已经上线。
