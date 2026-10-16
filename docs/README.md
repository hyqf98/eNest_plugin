# 开发文档导航

新开发者按以下顺序阅读：

1. [开发入门](developer/getting-started.md)：从源码项目到壳内运行。
2. [仓库工程结构](PLUGIN_STRUCTURE.md)：源码、静态资源、构建与归档边界。
3. [manifest 参考](manifest.md) 与 [JSON Schema](plugin-manifest.schema.json)：入口、权限、指令与市场资源。
4. [调试方式](developer/debug.md)：选择任意源码目录、本地或远程 HMR；dev（HMR/源码预览）与 prod（正式包）两种模式，启动命令按插件 package.json 解析（[enest 段 Schema](enest-package.schema.json)），壳子不预设工具链。
5. [API](developer/api.md)、[TypeScript 类型](developer/api-types.md)、[权限](developer/permissions.md)：基础能力直接可用，敏感资源通过宿主授权访问；[能力分类快照](plugin-permission-policy.json)由SDK生成工具同步。
6. [大小窗布局](developer/ui-standard.md)、[生命周期](developer/lifecycle.md)：迁移、销毁、后台与资源释放。
7. [主题插件](developer/themes.md)：主题声明、注册和卸载。
8. [宿主开发](developer/host-development.md)：main/preload/renderer 边界和能力扩展。

`developer/` 是宿主权威指南的同步副本，由 `docs:sync` / `docs:check` 管理；公共 API 类型由 `api:generate` / `api:check` 管理。不要在副本中单独修改 API 合同。

可运行的参考插件：`com.github.eNest.calculator`（基础入口）、`com.github.eNest.database` 与 `com.github.eNest.ssh`（综合工作台）。新增项目片段见 [模板](templates/plugin-boilerplate.md)。AI 使用 [enest-development skill](../skills/enest-development/SKILL.md)。

补充文档：[数据库工作台](DATABASE_WORKBENCH.md)、[双模式验收](dual-mode-acceptance.md)、[市场索引 Schema](registry.schema.json)。若历史专项文档的路径示例与工程契约冲突，以 `PLUGIN_STRUCTURE.md` 和当前 Schema 为准。

