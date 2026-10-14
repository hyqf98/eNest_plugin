---
name: enest-development
description: 开发、调试和验收 eNest Electron 宿主、通用前端插件、主题与综合插件。按标准工程、权限句柄和生命周期实现，并验证发布包；不把 DSH 专属外部运行时视为通用页面沙箱。
---

# eNest 开发

先确认当前目录是宿主仓库还是插件仓库，读取当前仓库 AGENTS.md 和 package.json，保留未提交改动。文档和工具路径相对于本技能所在的 eNest_plugin 仓库；无需壳仓库内被忽略的本地 scripts/packages。未要求时不提交或发布。

## 按任务读取

| 任务 | 先读 | 再按需读 |
| --- | --- | --- |
| 修改壳窗口、IPC、持久化或安全 | [宿主开发](../../docs/developer/host-development.md) | [权限](../../docs/developer/permissions.md)、[生命周期](../../docs/developer/lifecycle.md) |
| 新建 / 修改 HTML、Vue、React 插件 | [快速开始](../../docs/developer/getting-started.md)、[工程结构](../../docs/developer/structure.md) | [框架示例](../../docs/developer/examples.md)、[API](../../docs/developer/api.md)、[类型](../../docs/developer/api-types.md) |
| Quick、主窗和响应式 UI | [UI 标准](../../docs/developer/ui-standard.md) | [双模式工具](../../docs/developer/dual-mode-tools.md) |
| 主题或综合贡献点 | [主题](../../docs/developer/themes.md)、[manifest](../../docs/developer/manifest.md) | [生命周期](../../docs/developer/lifecycle.md) |
| 源码加载、远程调试、HMR、白屏 | [调试](../../docs/developer/debug.md) | [错误说明](../../docs/developer/errors.md) |
| 构建和发布包验收 | [工程结构](../../docs/developer/structure.md)、[manifest schema](../../docs/plugin-manifest.schema.json) | [插件仓库说明](../../README.md) |

类型签名以 `packages/plugin-sdk/index.d.ts` 为准。宿主源码可用时追到 preload 和主进程授权实现，不能凭旧示例猜接口。开发指南由 `scripts/sync-developer-docs.mjs` 从宿主权威文档同步，修改公共契约后运行文档和类型检查。

## 不可省略的契约

- 源码为 `plugins/<id>`，目录名等于 manifest.id。main 固定 `index.html`；公开资源在 `public/assets`，发布资源在 `dist/assets`。
- 图标用 `icon: assets/market/icon.svg`，详情用 `market.readme: assets/market/README.md`，截图在同一包的 `assets/market/screenshots`。开发可无截图，发布须有真实界面截图。
- `.enestplugin` 根直接是 dist 内容，文件名 `{id}@{version}.enestplugin`。普通包只包含入口、manifest、assets；不要引入 Node 程序、源码、测试、.env、依赖目录或符号链接。
- 业务界面、算法、数据模型和协议处理放在插件；壳提供统一能力，不能为每个业务功能新增宿主处理器。优先组合浏览器/WASM、私有存储、网络和文件 API，只有确实缺少原生能力时扩展通用接口。
- 页面没有 Node 权限，浏览器原生网络/系统 API 也不是权限失败后的备选通道。window.enest 的私有存储、UI、设置、主题、声明式入口和私有密钥保存直接可用，不需声明/弹窗；仅敏感能力声明最小权限并由用户授权；动态Quick provider读取全局查询，仍需contribute授权，分类以 docs/plugin-permission-policy.json 为准。文件靠宿主选择器签发的运行代次句柄，displayPath 仅展示；业务数据用 storage API，不能拼 HOME 或写源码目录。
- 开发者启动 npm run dev，宿主连接精确配置的 origin；不安装源码、不运行 npm、不监听文件做自动刷新。静态源码只映射 index.html、src、public/assets；生产预览明确选 dist。
- Quick/主窗由启动模式决定，断点只调整空间。持久化失败可见；在 onBeforeClose 保存，关闭后宿主统一释放资源。活动任务用 lease，不靠空转计时器逃避休眠。
- 主题沿用普通包并提供预览入口；运行时注册属于基础能力，禁用/卸载按 source 撤销。DSH runtime 是单独保留的专属例外，不可复制为新插件能力。

## 验证与交付

选择与修改相关的实际验证，不把 mock 当原生验收：

- 插件仓库：`npm ci`，`npm run validate`，`npm run build -- <id>`，`npm run validate:dist`，`node scripts/pack-plugin.mjs <id> --no-build`。全量时省略 build 的 id，pack 用 `npm run pack -- --no-build`。CLI 参数以仓库脚本为准。
- 宿主：`npm run typecheck`、`npm run build` 和相关 `node --test`。主进程/preload 修改后重启 dev。
- 公共 API：`npm run api:generate -- --host-root /path/to/eNest`；`npm run api:check -- --host-root /path/to/eNest` 不写文件。同步文档后运行 `npm run docs:check -- --host-root /path/to/eNest`。
- 使用临时数据根/独立 Electron profile，验证真实授权拒绝、句柄失效、关闭/重开、Quick 和主窗、窄窗与 150% 字号。需要外部 SSH/数据库时用测试服务与测试数据。
- 解包成品检查资源引用，确认 README 图片与截图来自最终包对应版本。不得用设计稿冒充功能截图。

交付说明实际修改、执行的检查及失败/未覆盖项。不要把未运行的测试或未实测的平台称为通过；性能说明附测量环境和结果，不宣称推测的加速比例。
