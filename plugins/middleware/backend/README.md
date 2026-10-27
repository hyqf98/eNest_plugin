# 中间件插件后端

`index.ts` 是 Electron utility process 后端入口，构建输出为插件 `dist/backend/index.cjs`。Kafka、RabbitMQ、MQTT、RocketMQ 协议、业务服务、HTTP 访问和测试都在本插件内；源码不引用宿主运行时。

`package.json.enestBackend` 声明入口和后端依赖。通用插件构建工具打包本插件 TypeScript，并复制实际生产依赖闭包，保留库的动态加载与运行资源。`contracts/mw-workbench.ts` 是本插件拥有的数据契约与操作常量，不再在壳里保留副本。

## 0.4.0 迁移边界

要求 eNest >=0.2.2。前端仅调用通用 `backend.call('workbench', [{ action, input }], { timeoutMs })` 并订阅 `backend.event` 的 `mw.data` / `mw.error` 子事件，不覆盖冻结的 `window.enest`，不再依赖 `enest.mw` 或专属宿主进程管理器。默认查询 30 秒、连接测试/关闭 15 秒；显式超时范围为 250ms 至 24 小时。

后端以协议 v1 单次 `init` 绑定 pluginId/generation/wcId，并校验每条请求的插件归属、4 MiB 请求 / 8 MiB 返回与事件、32 个并发请求预算。插件 `workbench.ts` 解释 `mw.connect` / `mw.query` / `mw.admin`，每次调用通用 `permission.authorize`；只读连接在本后端拒绝所有变更。域权限不是 Node 沙箱，`backend.node` 仍是必须明确授权的完整本机 Node 信任。

主连接与 EMQX 管理面的 vault 引用分别经通用 `secret.resolve` 解引用。已有临时测试密码仍只用于本次请求。密钥不返回页面，不进入会话信息与事件；持久化连接只保存引用。EMQX 不再把引用字符串当作实际密码。

每个常驻连接在连接前 `activity.acquire`，在 tail 与驱动连接完成关闭后 `activity.release`；MQTT 等待 end 回调。相同 sessionKey 的并发连接会被拒绝，关闭过程会等待正在建立的连接/监听并回收晚到句柄。`shutdown` 阻止后续业务、关闭所有会话，只有清理成功才回报成功；失败不提前释放相应活动，宿主仍以真实 utility 退出确认资源回收，并提供有界终止兜底。HTTP/协议驱动仍由插件拥有，不透传宿主专用 service。

## 本轮专项验证

`tsc -p backend/tsconfig.json`

`node --test backend/middleware-backend-contract.test.mjs`

新增迁移专项只用 mock driver、mock MQTT 模块和 mock 控制端口，覆盖授权、密钥、只读、归属、预算、关闭竞态、lease、事件与冻结 API。未运行历史测试，未连接任何真实 Kafka/RabbitMQ/MQTT/EMQX/RocketMQ 服务，不替代真实集群回归验收。
