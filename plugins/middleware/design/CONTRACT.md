# com.github.eNest.middleware 插件开发契约（UI 代理必读）

## 红线
1. **只准用已存在的 eNest 插件 API**（见下），禁止调用想象中的 API；宿主 `mw.*` 经 `api.js` 封装调用，页面代码不得直接碰 `window.enest.mw`。
2. 只写自己名下文件，禁止改动他人文件（骨架文件已就位：plugin.json / index.html / assets/css/main.css / assets/js/components.js / assets/js/pages/index.js）。
3. import 别名：`@workbench/workbench.js`（共享 kit：escapeHtml/createDialog/CommandRegistry/bindDockResize/loadMonaco）、`./` 同目录相对导入、`../components.js`。**禁止** import 壳子仓任何东西。
4. 视觉：全部用 CSS 变量 token（main.css 已定义），禁止写死与主题冲突的色值；布局骨架 B（连接即 Tab）、表格紧（28px）/表单松、弹窗按钮右对齐、危险操作用 confirmDanger 两段式。用户特别要求：**弹框与按钮对齐、间距统一**（按钮区统一 `display:flex; gap:10px; justify-content:flex-end`）。
5. 中文文案；代码注释只写非显而易见约束。

## 已就位骨架
- `index.html`：`#conn-tabs` / `#tree` / `#resizer-tree` / `#subnav` / `#page-host` / `#status-bar` / `#modal-root` / `#drawer-root` / `#ctx-root` / `#local-toast`
- `assets/css/main.css`：完整设计系统（token/表格/卡片/抽屉/弹窗/菜单/轨迹/sparkline/quick 适配），含 `.write` 类（quick 模式自动隐藏写操作按钮）
- `assets/js/components.js`：`fmt(num/compact/bytes/ms/datetime/datetimeMs)`、`KIND_META/kindDot/envChip`、`gate(caps,key)/capTitle`、`el()` DOM 助手、`chip/healthChip/lagBar`、`simpleGrid({columns,rowKey,onRowClick,onRowCtx,...})→{root,update,setSelected,getSelectedRow}`、`confirmDanger({title,message,requireText,confirmLabel})→Promise<bool>`、`infoDialog({title,width})→{close,body,footer}`、`showContextMenu(x,y,items)`、`payloadHighlight(text)`、`sparkline(values)`、`escapeHtml`
- `assets/js/pages/index.js`：页面注册表（id/title/kinds/page loader），**不要改它**

## 宿主 API（api.js 提供，UI-A 实现；B/C 按 此签名调用）
```js
api.mw(action, input)                       // → enest.mw.workbench({action, input})，HOST_LAG/权限错误转译成中文 toast 并 throw
api.kinds()                                  // kinds.list → 描述符数组 [{kind,label,transport,defaultPort,messageQueryModes,capabilities}]
api.testConnection(config)                   // test
api.openConnection(conn) / api.closeConnection(sessionKey)   // session.open/close；open 返回 {sessionKey,capabilities,messageQueryModes,...}
api.listSessions()
api.vault.set(key, secret) / vault.has(key) / vault.remove(key)   // 密码只进 vault，连接配置存 secretRef
api.storage.get(key) / set(key, value) / remove(key)             // 持久化（store.js 防抖封装）
api.session.get(key) / session.set(key, value)                   // 会话级（关 Tab 即清）
api.toast(message, type)                    // 'info'|'success'|'warn'|'error'，回落本地 #local-toast
api.notify(title, body)
api.copy(text)
api.onMwData(cb) / onMwError(cb)            // 订阅 'mw.data'/{sessionKey,tailId,message} 与 'mw.error'；返回取消函数
api.mode()                                  // 'quick'|'shell'
api.onModeChange(cb)
api.openInShell()
api.setTitle(text)
```

## 页面模块契约（B/C 产出）
```js
// pages/xxx.js 导出：
export default {
  id: 'topics',            // 与注册表一致
  render(root, ctx) {},    // root=页面容器（.page-host 内 .page div）；ctx 见下
  destroy() {}             // 可选：离开页面时停轮询/断监听，必须实现若有定时器
}
```
**ctx**：`{ api, store, conn, sessionKey, caps, queryModes, mode, switchPage(id), refreshStatus() }`
- `conn`：连接对象 `{ id, kind, name, env, readOnly, note, ...config }`（store.connections 里的原对象）
- `caps`：会话能力 `Record<string,{state,reason}>`（open 时回填；未 open 用 kinds 静态）
- `mode`：'quick'|'shell'——quick 下一切写操作按钮加 `.write` 类自动隐藏，数据量钳制 ≤200
- 危险操作（删/清空/重置 offset/踢出）：必须 `confirmDanger`，且 `conn.readOnly || mode==='quick'` 时直接 toast 拒绝
- 所有宿主调用失败：catch 后 `api.toast(err.message, 'error')`，页面不崩

## 数据模型（@shared mw-workbench 摘要，字段以此为准）
- MwTopic: `{ name, entity:'topic'|'queue'|'exchange'|'retained'|'subscription', partitions?, replicas?, messageCount?, consumerCount?, durable?, autoDelete?, type?, internal?, totalSizeBytes?, lag?, extras?{} }`
- MwMessage: `{ messageId?, topic, partition?, offset?, timestamp, key?, payload, payloadEncoding?, payloadType?, headers?{}, properties?{}, redelivered?, payloadBytes?, extras?{} }`
- MwConsumerGroup: `{ groupId, state?, members?, totalLag?, topics?[], extras?{} }`；MwClient: `{ clientId, host?, connectedAt?, subscriptionsCount?, extras?{} }`
- MwOverview: `{ kind, clusterName?, brokers:[{id,host,roles?,alive?,extras?}], metrics:{}, notes?[] }`
- MwTrace: `{ key, messageId?, steps:[{phase:'produced'|'stored'|'consume-attempt', timestamp, status, actor, detail?{}, costMs?}] }`
- action 清单（api.mw 第一个参数）：`overview / topics.list / topic.describe / topic.create / topic.update / topic.delete / topic.purge / partitions.grow / exchanges.list / exchange.create / exchange.delete / bindings.list / binding.create / binding.delete / groups.list / group.describe / group.resetOffsets / clients.list / client.kick / messages.query / messages.get / messages.send / messages.resend / tail.start / tail.stop / configs.describe / configs.alter / trace.message / retained.list / retained.delete`（输入字段见 mw-workbench.ts；sessionKey 由 api.mw 自动注入）

## store 契约（UI-A 实现；B/C 消费）
- `store.connections`: `[{id,kind,name,env,readOnly,note,secretRef?,bootstrapServers?,managementUrl?,brokerUrl?,dashboardUrl?,vhost?,username?,saslMechanism?,tls?,emqx?...,options?}]`
- `store.activeTab`: connectionId | null；`store.tabs`: [connectionId]
- `store.ui`: `{ treeWidth, collapsedGroups?[], lastPage: {connId: pageId} }`
- `store.save()`（防抖）/ `store.flush()`（onBeforeClose 调）
