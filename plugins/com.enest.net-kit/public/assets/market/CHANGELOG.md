# 网络调试台 Changelog

> HTTP 调试与 curl 导入参考 [ZTools-plugins/zapapi](https://github.com/ZToolsCenter/ZTools-plugins) 与 [ZTools-plugins/curl-tool](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- HTTP 模式：method / URL / Headers / Params / Body（none / json 校验 / form / raw）构建；
  `net.fetch` 流式发送，`net.chunk` 增量渲染；响应徽章行（状态色系映射 2xx ok / 3xx 中性 / 4xx·5xx danger）+
  耗时 + 大小；body 视图切换（JSON 可折叠树 / HTML 表格预览 / 文本 / 图片 / hex）；大响应分页「加载更多」，
  超限由宿主 32MB 上限兜底；SSE 逐事件滚动展示（暂停 / 继续）
- 断言：状态码等值 / 状态码集合 / 耗时阈值 / JSONPath 存在性（自实现轻量子集，支持 `..` 递归、`[*]`、索引）/
  Body 包含，结果 pass·fail 徽章
- curl 导入（shell 词法解析：-X / -H / -d / --data-raw / -F / -A / -e / -b / -u / -m / -k / 续行与引号转义；
  `@file` 明确拒绝并提示）与导出复制
- 多环境变量 `{{host}}` / `{{token}}`（dev / staging / prod，storage 持久），替换预览与未定义变量提示
- 集合（分组 / 命名 / 删除，storage 持久）与最近 50 条历史（点击回填）
- TCP 模式：连接面板（host / port / TLS / 超时）；接收区默认 16 进制 dump（偏移 + 16 字节 + ASCII，
  等宽右对齐），4MB 环形缓冲丢弃 + 行内提示；视图切换 hexdump / ascii / utf8 / utf16le / json / base64 /
  长度前缀帧（大端·小端 2·4 字节）/ 分隔符帧（\r\n、\n、\0）/ 正则提取 + 自定义 JS 解码器（storage 持久，
  `new Function` 于插件上下文运行，错误行内提示不崩）；时间戳列开关
- 发送侧编码策略：文本 / hex 字面 / base64 / 附加长度头 / 附加分隔符；`\n \t \x41` 转义；模板历史；
  循环发送（间隔 + 次数）
- WebSocket 模式：wss:// 直连（浏览器原生）；帧收发、hex / text 双视图、暂停 / 继续、ping·pong 计数；
  ws:// 明文提示改走 TCP 模式（宿主 serveWs 桥仅服务于已建 TCP 流，不做 ws 反代）
- 双形态：Quick 智能识别输入（http(s):// 即发即看 / host:port 探活连接 / curl 开头解析发送）；
  桌面三栏（集合树 | 请求·连接构建 | 响应·字节流）+ 多会话 Tab
- manifest 声明 `net.allowInsecure: true`：HTTP 调试台的核心场景是测试本地 / 内网明文 `http://` 服务
  （`127.0.0.1:3000` 等），经宿主白名单放行；重定向逐跳仍按该规则校验
