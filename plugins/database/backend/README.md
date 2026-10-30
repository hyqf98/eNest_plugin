# 数据库插件后端

`index.ts` 是 Electron utility process 的后端入口，构建输出为插件 `dist/backend/index.cjs`。数据库驱动、SQL/结构/事务/CSV/比较/补全业务及相关测试由本插件维护；源码没有宿主运行时 import。

`package.json.enestBackend` 声明入口与后端依赖。通用插件构建工具打包本插件 TypeScript，并随插件复制后端生产依赖闭包。驱动包含动态加载、证书/资源文件和 DuckDB 原生库，不能按前端包的规则只复制 `.js`。DuckDB 的平台 `.node` 与动态库必须成组分发并在目标系统验证。

SQL 执行边界的唯一源码是本插件 `backend/sqlScript.ts`；本地 `scripts/generate-execution-parser.mjs` 生成前端 `src/js/executionParser.js`，使用本插件声明的 TypeScript 开发依赖，不读取宿主目录。在数据库插件目录运行 `npm run parser:generate` 或只读 `npm run parser:check`。本插件 Vite 配置在 dev 启动和构建解析配置时自动生成，仓库通用 build 及默认 pack 也复用该配置；内容不变时不重写文件。直接打包已有 dist 的 `--no-build` 不生成源码。详见 [SQL 脚本执行边界](SQL_SCRIPT_EXECUTION.md)。

0.0.1 起要求 eNest >=0.0.1。`contracts/`、连接与事务策略、权限动作路由、密码/文件能力组合和会话活动租约均在插件内。`facade.ts` 只通过通用 `host.request` 申请 `secret.resolve`、`files.resolve/pick/save`、`permission.authorize` 和 `activity.acquire/release`；宿主不再携带 `db.*` 分发器或数据库 DTO。用户选择的文件路径只在可信本机后端解析，不接受 renderer 自带的 `filePath/sqlitePath/options.file`。

前端 `src/js/backend-api.mjs` 创建插件私有的 `api.db` 兼容对象，不修改冻结的 `window.enest`，实际通道为标准 `backend.call`。原生授权/选择器等待不消耗 SQL 执行时限；取消/关闭直接使用 250ms deadline，避免同步驱动阻塞时卡在授权预检。达到 deadline 由通用 `backend.stop` 终止并等待进程退出，后续需重连。`init` 必须匹配插件 id、generation、wcId 和协议版本；关闭时先停止连接，再退出进程。一个连接活动租约覆盖其整个事务期间，关闭后释放；迟到的旧连接响应不会释放新连接租约。

验证入口：

- `tsc -p backend/tsconfig.json`：独立后端类型检查。
- `node --test backend/database-backend-contract.test.mjs`：本轮迁移专项，使用模拟 driver/host，不连接任何真实数据库。
- `node --test backend/*.test.mjs`：协议、生命周期、SQL adapter、CSV、原生文件访问边界。
- `tsx --tsconfig backend/tsconfig.json --test backend/*.test.ts`：脚本解析、SQLite/DuckDB 与可选服务集成。

SQLite 安全测试需要与产品一致、支持 `DatabaseSync.setAuthorizer` 的 Node 运行时；推荐通过 Electron 的 `ELECTRON_RUN_AS_NODE=1` 执行测试。不能为了适配较旧的系统 Node 去掉 authorizer。外部服务集成测试仅在对应测试环境变量存在时运行。
