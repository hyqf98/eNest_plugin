# 中间件插件后端

`index.ts` 是 Electron utility process 后端入口，构建输出为插件 `dist/backend/index.cjs`。Kafka、RabbitMQ、MQTT、RocketMQ 协议、业务服务、HTTP 访问和测试都在本插件内；源码不引用宿主运行时。

`package.json.enestBackend` 声明入口和后端依赖。通用插件构建工具打包本插件 TypeScript，并复制实际生产依赖闭包，保留库的动态加载与运行资源。`contracts/mw-workbench.ts` 是兼容 `mw.*` 的数据契约与操作常量快照。

宿主负责 `backend.node` 授权、密钥解引用、当前插件身份、请求上限、进程取消和实例回收。后端通过原 `mw*` RPC 响应请求，通过 utility `parentPort` 发送 `mw.data` / `mw.error`；宿主只接收当前实例、当前插件身份的事件。

验证：`tsc -p backend/tsconfig.json`；`node --test backend/*.test.mjs`。测试使用真实 Kafka 模块加载、本地 HTTP/TLS 服务或驱动 mock，不等同于真实外部 Kafka/RabbitMQ/MQTT 集群验收。
