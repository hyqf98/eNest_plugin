---
name: enest-development
description: 开发、调试和验收 eNest Electron 宿主、通用前端插件、主题与综合插件。按标准工程、权限句柄和生命周期实现，并验证发布包；不把 DSH 专属外部运行时视为通用页面沙箱。
---

# eNest 开发

先确认当前目录是宿主仓库还是插件仓库，读取当前仓库 AGENTS.md 和 package.json，保留未提交改动。本技能的 `references/` 自带完整官方指南（含 API 参考与类型），按下面的表按需读取；路径相对于本技能目录，不依赖它被安装或软链到何处。类型签名以 `packages/plugin-sdk/index.d.ts` 为准；宿主源码可用时追到 preload 和主进程授权实现，不能凭旧示例猜接口。未要求时不提交或发布。

## 按任务读取

| 任务 | 先读 | 再按需读 |
| --- | --- | --- |
| 第一次接触 eNest、不了解整体模型 | [插件开发概览](references/README.md) | 按下面各行进入专项 |
| 新建 / 修改 HTML、Vue、React 插件 | [快速开始](references/getting-started.md)、[工程结构](references/structure.md) | [框架示例](references/examples.md)、[API](references/api.md)、[类型](references/api-types.md) |
| 调用 `window.enest` 任何能力、查方法签名或权限 | [API](references/api.md) 先看「方法索引」 | [类型](references/api-types.md)、[权限](references/permissions.md) |
| 存取数据、图片资源、导出文件 | [数据存储](references/storage.md) | [API](references/api.md)「storage」、[权限](references/permissions.md) |
| 读写用户文件、拖入路径、另存为 | [权限](references/permissions.md)「系统文件」 | [API](references/api.md)「文件句柄与 WebSocket 新接口」 |
| 定时、倒计时、分步后台任务 | [后台步骤计划](references/deadline-tasks.md) | [API](references/api.md)「runtime」「生命周期」、[生命周期](references/lifecycle.md) |
| Node 后端、沙箱后台、辅助页 | [本机后端](references/backend.md) | [API](references/api.md)「backend」「background」「auxiliary」、[设置与窗口](references/settings-and-windows.md) |
| 贡献 MCP 工具 | [MCP](references/mcp.md) | [权限](references/permissions.md) |
| 插件设置页、`page` 入口、Quick / 主窗 / 独立窗 | [设置与窗口](references/settings-and-windows.md) | [API](references/api.md)「settings」「ui」 |
| Quick、主窗和响应式 UI | [UI 标准](references/ui-standard.md) | [双模式工具](references/dual-mode-tools.md)、[生命周期](references/lifecycle.md) |
| 官方插件的 React + Radix 工程与控件 | [React 迁移 SOP](references/react-migration-sop.md) | [UI 标准](references/ui-standard.md)「官方插件技术栈」「设计语言与样式规范」 |
| 主题、首页、主题 Chrome 或综合贡献点 | [主题](references/themes.md)、[manifest](references/manifest.md) | [主题工作区](references/home.md)、[主题 Chrome](references/chrome.md)、[设置与窗口](references/settings-and-windows.md) |
| 自由画布、自由桌面或迁移旧 `panels` 布局 | [旧布局迁移](references/panels.md) | [主题](references/themes.md) |
| 改 `plugin.json`、指令、触发词、打开方式 | [manifest](references/manifest.md) | [schema](../../docs/plugin-manifest.schema.json)、[错误码](references/errors.md) |
| 源码加载、远程调试、HMR、白屏 | [调试](references/debug.md) | [错误码](references/errors.md)、[FAQ](references/faq.md) |
| 调用报错、被拒绝、安装或加载失败 | [错误码](references/errors.md) | [权限](references/permissions.md)、[调试](references/debug.md) |
| 修改壳窗口、IPC、持久化或安全 | [宿主开发](references/host-development.md) | [权限](references/permissions.md)、[生命周期](references/lifecycle.md) |
| 构建和发布包验收 | [工程结构](references/structure.md)、[manifest](references/manifest.md) | [插件仓库说明](../../README.md) |

读 API 时先看 `references/api.md` 的「方法索引」：它按命名空间列出方法、所需权限和对应指南。再到同名小节读参数、返回与失败语义；不要只凭方法名猜行为，也不要用旧示例代替现行签名。

## 不可省略的契约

- 源码为 `plugins/<短名>`，目录名与 package.name 等于 manifest.id 的末段；完整 manifest.id 才是权限、安装与数据归属身份，不能按末段猜测所有者。main 固定 `index.html`；公开资源在 `public/assets`，发布资源在 `dist/assets`。
- 图标用 `icon: assets/market/icon.svg`，详情用 `market.readme: assets/market/README.md`，截图在同一包的 `assets/market/screenshots`。开发可无截图，发布须有真实界面截图。
- `.enestplugin` 根直接是 dist 内容，文件名 `{短名}@{version}.enestplugin`。普通前端包只包含入口、manifest、assets；声明 Node 后端时，构建器按锁文件收集 `backend/` 及其生产依赖。不得把源码、测试、.env、根 node_modules 或符号链接装进包；插件自有额外运行时遵循插件本地构建钩子与分发校验，不能成为宿主特判。
- 业务界面、算法、数据模型和协议处理放在插件；壳提供统一能力，不能为每个业务功能新增宿主处理器。优先组合浏览器/WASM、私有存储、网络和文件 API，只有确实缺少原生能力时扩展通用接口。
- 官方插件每个有字符串 `cmds` 的功能都要写固定 `title`。`code` 保持稳定；英文名、同义词和历史简称放在 `cmds`，不用手写可自动生成的全拼和首字母。内容指令用自己的 `label`，内部激活不需要名称入口。
- 页面没有 Node 权限，浏览器原生网络/系统 API 也不是权限失败后的备选通道。window.enest 的私有存储、UI、设置、主题、声明式入口和私有密钥保存直接可用，不需声明/弹窗；仅敏感能力声明最小权限并由用户授权；动态Quick provider读取全局查询，仍需contribute授权，分类以 docs/plugin-permission-policy.json 为准。文件靠宿主选择器签发的运行代次句柄，displayPath 仅展示；业务数据用 storage API，不能拼 HOME 或写源码目录。
- 宿主按插件 package 声明连接精确配置的开发 origin，服务未运行时通过通用开发加载器启动并管理进程；静态源码由开发注册监听，移除注册时回收。源码不会复制成已安装插件，也不作为市场安装失败的兜底。静态源码只映射标准入口；后端须先构建，服务离线时只有版本匹配的产物可用于预览，具体以开发加载指南为准。
- Quick/主窗由启动模式决定，断点只调整空间。持久化失败可见；在 onBeforeClose 保存，关闭后宿主统一释放资源。活动任务用 lease，不靠空转计时器逃避休眠。
- 默认主题是宿主源码 `src/shared/theme/defaultTheme/package.ts` 内置包，直接加载外观与启动动画，不在插件仓发布，也没有首启选主题门禁。第三方主题仍沿用普通包并提供预览入口；运行时注册属于基础能力，禁用/卸载按 source 撤销。主题设置表单由壳渲染：只声明 `presentation`、`options[].preview` 和 pack 级 `palettes`（自定义氛围配色，id 不得覆盖内置 8 个），不得注入 HTML/CSS/JS 或选择器改设置界面。DSH 的外部运行时策略归 DSH 插件本地构建钩子，不是宿主提供的通用页面沙箱或按插件 ID 放行的例外。

## 文档维护

指南只有一个编辑点，技能里的内容是生成副本，不要在 `references/` 里直接改：

- 宿主契约指南（API、权限、主题等）：改宿主仓库的 `docs/site/plugin/`，它是权威源，同时供官网网页版显示。
- 插件仓自有指南（如 React 迁移 SOP）：改 `docs/developer/` 中的对应文件，并在同步脚本的 `localGuides` 登记。
- 改完从插件仓库运行 `npm run docs:sync -- --host-root /path/to/eNest`，一次生成 `docs/developer/` 和本技能的 `references/`。`npm run docs:check -- --host-root /path/to/eNest` 只校验，两处任一陈旧或技能内出现未登记文件都会失败。
- `references/api-types.md` 与 `packages/plugin-sdk/index.d.ts` 由 `npm run api:generate` 从 preload 生成，不手改。

## 验证与交付

选择与修改相关的实际验证，不把 mock 当原生验收：

- 插件仓库：`npm ci`，`npm run validate`，`npm run build -- <id>`，`npm run validate:dist`，`node scripts/pack-plugin.mjs <id> --no-build`。全量时省略 build 的 id，pack 用 `npm run pack -- --no-build`。CLI 参数以仓库脚本为准。
- 宿主：`npm run typecheck`、`npm run audit:contracts`、`npm run audit:source` 与必要的构建检查。只有用户明确要求时才运行相关测试或原生用例；主进程/preload 修改后重启 dev。
- 公共 API：`npm run api:generate -- --host-root /path/to/eNest`；`npm run api:check -- --host-root /path/to/eNest` 不写文件。公共契约或指南变更后运行 `npm run docs:sync -- --host-root /path/to/eNest`，再用 `npm run docs:check -- --host-root /path/to/eNest` 确认。
- 使用临时数据根/独立 Electron profile，验证真实授权拒绝、句柄失效、关闭/重开、Quick 和主窗、窄窗与 150% 字号。需要外部 SSH/数据库时用测试服务与测试数据。
- 解包成品检查资源引用，确认 README 图片与截图来自最终包对应版本。不得用设计稿冒充功能截图。

交付说明实际修改、执行的检查及失败/未覆盖项。不要把未运行的测试或未实测的平台称为通过；性能说明附测量环境和结果，不宣称推测的加速比例。
