# 数据库插件后端

`index.ts` 是 Electron utility process 的后端入口，构建输出为插件 `dist/backend/index.cjs`。数据库驱动、SQL/结构/事务/CSV/比较/补全业务及相关测试由本插件维护；源码没有宿主运行时 import。

`package.json.enestBackend` 声明入口与后端依赖。通用插件构建工具打包本插件 TypeScript，并随插件复制后端生产依赖闭包。驱动包含动态加载、证书/资源文件和 DuckDB 原生库，不能按前端包的规则只复制 `.js`。DuckDB 的平台 `.node` 与动态库必须成组分发并在目标系统验证。

`contracts/` 是当前 `db.*` API 的纯数据契约快照，`hostDbConfig.ts` 增加的是宿主经过文件句柄授权后发送的路径。兼容层继续使用原 `db*` RPC 方法。宿主负责：`backend.node` 授权、当前插件身份、密钥解引用、原生文件选择与句柄授权、请求上限、超时/取消、utility 退出和实例回收。后端不获取宿主 vault 或窗口 API。

验证入口：

- `tsc -p backend/tsconfig.json`：独立后端类型检查。
- `node --test backend/*.test.mjs`：协议、生命周期、SQL adapter、CSV、原生文件访问边界。
- `tsx --tsconfig backend/tsconfig.json --test backend/*.test.ts`：脚本解析、SQLite/DuckDB 与可选服务集成。

SQLite 安全测试需要与产品一致、支持 `DatabaseSync.setAuthorizer` 的 Node 运行时；推荐通过 Electron 的 `ELECTRON_RUN_AS_NODE=1` 执行测试。不能为了适配较旧的系统 Node 去掉 authorizer。外部服务集成测试仅在对应测试环境变量存在时运行。
