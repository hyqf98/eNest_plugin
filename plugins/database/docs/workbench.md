# 数据库工作台开发说明

## 构建与离线运行

以下源码路径均相对于数据库插件目录，依赖由插件仓库工作区统一管理。在数据库插件目录运行 `npm run build`。数据库入口为 `src/entry.js`，业务源码在 `src/js/`；Monaco、语法资源、SQL formatter 与 Web Worker 一起生成到本插件 `dist/assets/app/`，文件名带构建哈希。这些生成目录不提交 Git，通用 `pack-plugin.mjs` 先构建，再直接打包本插件 `dist/` 的内容。

运行不请求 CDN，不依赖 importmap 或 `unsafe-inline` 脚本。Quick 连接首页不加载 Monaco，进入已连接的查询页才动态加载本地编辑器。仓库共享包 `@enest/plugin-kit/workbench` 提供命令注册、快捷键冲突检测、选择模型、对话框、分隔条和通用 Monaco 加载器；SQL formatter 是数据库插件自己的依赖，由 `src/js/monacoEditor.js` 在编辑器增强或格式化时按需加载，不进入共享加载器。

SQL 执行边界的唯一源码为 `backend/sqlScript.ts`，由本插件 `scripts/generate-execution-parser.mjs` 生成前端 `src/js/executionParser.js`。在数据库插件目录运行 `npm run parser:generate` 或只读 `npm run parser:check`；Vite dev 启动及构建也会通过插件自己的配置准备解析器。详见 [SQL 脚本执行边界](../backend/SQL_SCRIPT_EXECUTION.md)。

## 页面与状态

- 连接首页提供搜索、上下键循环、Enter 连接、已连接继续，以及新建/编辑。Quick 中的完整配置操作先进入桌面工作台。
- 查询页保留每份文档的 Monaco model、撤销栈和选区，模式切换不销毁编辑器。Quick 控制台使用独立 `sessionKey`，打开时传 `readOnly`，不会复用桌面事务；迁移到桌面后同一控制台继续只读。
- 结果下方或右侧停靠。表数据的服务器分页、排序和筛选通过 `table.page`；普通查询的本地结果操作明确标注已加载范围。存在未提交变更时阻止服务器翻页。导出只包含当前已加载结果。
- Quick 默认显示紧凑结果；展开后提供字段文本筛选、清除条件、实际行范围和前后页。查询结果筛选仅作用于已加载数据；独立 Quick 控制台的表数据筛选重新查询服务器，并显示条件数。复制/导出分别覆盖筛选后的已加载结果或服务器当前页。独立只读控制台的大页迁入 Quick 后，后续读取限制为 200 行，并按返回的分页范围继续读取。
- 桌面控制台迁入 Quick 时保留文档和已加载结果，仅允许本地预览；运行前显示“桌面继续 / 新建快捷查询”。不会自动复制草稿、重连或重执行。新建快捷查询显式创建空白独立控制台，连接时才申请只读会话。表数据浏览沿用当前控制台，避免把从 Quick 迁入的只读控制台换成读写会话。
- 文档/JSON 单元格双击打开按类型呈现的懒加载树，可切换原文和复制；Escape 返回原控件。Redis 对象页按 SCAN 游标读取，并显示服务端实际返回的 type 与 TTL。TDengine 标签来自 metadata，不按名称猜测。
- 结构页按能力启用表设计：新建表、增/改名/删字段、增/删索引。客户端提交结构化设计到数据库插件后端生成 DDL，预览后才显式执行；后端重新生成语句并拒绝只读连接和未结束事务。
- 资源中心区分本插件连接与数据库服务器数据，权限不足和不支持均显示原因。不会把客户端数字当作全局服务器指标。
- 比较窗口支持缩放、最大化/恢复、两侧来源、对齐键、列映射、严格/文本/数值/JSON 规则、差异导航和导出。数据比较只有读取，不生成修复或同步 SQL；页面明确提示两侧独立读取及截断范围。
- 插件设置页管理快捷键、编辑器与结果布局。壳设置仅注册页面入口与跟随主题开关。

## Provider 扩展契约

本插件 `src/js/backend-api.mjs` 通过通用 `backend.call` 提供私有 `api.db` 适配器；`api.db.workbench({action,input})` 返回 driver descriptor 与能力状态。界面按 `capabilities` 展示/禁用操作，不能仅凭驱动名称推断事务、修改表或结果编辑能力。新驱动应先在本插件 `backend/` 实现 adapter，再提供准确的 family/language/transport/defaultPort 和能力原因；不向宿主添加数据库业务分发器。后端边界见 [后端说明](../backend/README.md)。

`queryTemplates.js` 提供 SQL 方言和原生语言示例，`monacoEditor.js` 负责语言、补全和格式化，`tableDesigner.js` 负责结构化设计，`documentInspector.js` 负责文档查看，`workbench.js` 管页面编排。凭据只传 `secretRef`；URI/高级选项拒绝内嵌密码或 token，凭据库失败即停止测试/保存。

SQLite/DuckDB 通过宿主 `localFiles.pick` / `pickSave` 选择文件，连接使用用途匹配的 `fileHandleId`；表单不允许任意路径输入，重启后需要重新授权失效句柄。CSV 导入同样使用文件句柄。

存储边界 `storageJson.js` 仅省略对象里的可选 `undefined` 字段；数组空项、数组 `undefined`、非有限数值、循环引用和非普通对象明确拒绝。连接表单、复制连接与只读切换必须等待宿主持久化成功，再更新状态和提示成功。写入失败保留表单输入并显示错误；后台自动保存也报告失败。

数据库插件后端负责只读校验、参数化、执行取消、事务生命周期和结果数值精度；权限及文件、密钥等通用原生能力由宿主验证。界面能力不是安全边界。SQL Server 精确 decimal/money 结果需要按后端错误建议显式 CAST 为文本，界面不做浮点猜测。

## 验证

以下验证命令从插件仓库根目录运行：`npm test` 运行共享行为与插件逻辑测试，`npm run validate` 校验 manifests。`npm run test:ui -- plugins/database/tests/database.ui.js` 使用本地 Chrome 和模拟 host，覆盖 480×240 Quick、720×420、编辑器状态迁移、凭据失败、严格 JSON 存储与写入失败、结构化 DDL、服务端分页排序筛选、资源/权限、只读比较与 JSON 树。mock 存储按宿主契约校验并复制 JSON，避免对象引用共享掩盖未落盘问题。它验证界面契约，不代表所有数据库的真机连接验证。

并发运行浏览器测试时指定独立端口与输出目录，例如 `DB_UI_PORT=4179 npm run test:ui -- plugins/database/tests/database.ui.js --output=test-results-db`。截图为测试数据生成，不用作真实服务器证明。数据库后端测试由本插件 `backend/` 维护，命令见 [后端说明](../backend/README.md)，不依赖壳仓库数据库源码。
