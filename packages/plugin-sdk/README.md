# @enest/plugin-sdk

eNest 插件开发者 SDK —— 两个核心交付：

1. **运行时 API 类型**（`index.d.ts`）：由插件仓库 `scripts/generate-api-types.mjs` 从壳 preload/shared 契约自动生成，包含普通插件、Workspace、Quick、主题 Chrome、主题设置、沙箱后台与辅助页的专用 API，以及 MCP 工具契约。
2. **`plugin.json` manifest 校验**：ajv (2020-12) + 自含 schema 复制（上游 `eNest_plugin/docs/plugin-manifest.schema.json`），提供编程接口与 CLI。

## 安装

SDK 位于独立插件仓库 `eNest_plugin/packages/plugin-sdk`；插件仓根 `package.json` 已接入 `plugins/*` 和 `packages/*` workspaces。独立插件工程可以依赖本地 SDK：

```bash
# 替换为本机插件仓路径；SDK 是开发依赖，不注入运行时实现。
npm i -D /path/to/eNest_plugin/packages/plugin-sdk
# 在插件仓 plugins/<name> 内：
npm i -D ../../packages/plugin-sdk
```

也可直接引用 `index.d.ts`（零依赖，纯类型）。npm registry 是否已发布及可用版本需单独确认，不应仅凭包名假设可在线安装。

## 1. window.enest 类型接入

插件页运行时由壳子 preload 注入 `window.enest`（另有 `window.zapi` 历史别名，`@deprecated`，计划 v2 移除）。SDK 提供完整类型。

**方式 A：triple-slash reference（任意 JS/TS 工程）**

```ts
/// <reference path="./node_modules/@enest/plugin-sdk/index.d.ts" />

const api = window.enest
await api.ui.setTitle('我的插件')
```

**方式 B：显式 import type（推荐，TS 工程）**

```ts
import type { EnestPluginApi } from '@enest/plugin-sdk'

declare const enest: EnestPluginApi // 或经 (window as any).enest 断言
```

**方式 C：直接挂全局（`tsconfig.json`）**

```jsonc
{
  "compilerOptions": {
    "types": ["@enest/plugin-sdk"] // 借 package.json types 入口生效
  }
}
```

安全用法（本地浏览器直开时无 API）：

```ts
const api = (window as { enest?: EnestPluginApi }).enest
if (!api) {
  console.warn('eNest API 不可用（非壳子环境）')
}
```

类型声明会同时为 `Window` 补上 `enest` / `zapi` 两个全局属性声明（`zapi` 带 `@deprecated` JSDoc）。

主题工作区使用可选的 `window.enestWorkspace`（`enestHome` 是兼容别名），实现 `catalog/detail` 两路由及渲染 ACK；已安装页是提供者自己的目录筛选，不向宿主发送 `installed` 路由。设置通过 `openSettings` 请求切换到独立设置 surface，主题设置页使用 `enestSettings` 安全描述符，不在 Workspace 中实现设置路由，也不注入 `enest` 或 `shellApi`。普通插件通过 `enest.home.register()` 只能确认自己的精确 manifest 声明，不能自动激活或注册未声明入口。完整契约见 [Workspace](../../docs/developer/home.md) 与 [设置边界](../../docs/developer/settings-and-windows.md)。

普通插件的 `enest.mcp.registerHandlers()` 在业务初始化后注册 manifest 声明的工具，不依赖前台 `onEnter`。MCP 默认关闭，当前原生管理 UI 尚未交付，详见 [MCP 工具贡献](../../docs/developer/mcp.md)。

存储类型统一来自宿主 `src/shared/types/storage.ts`，完成文件 DTO 复用 `file-stream.ts`。KV 的 `set/remove` 为有界入队，`storage.flush/commit` 提供显式提交回执；新图片使用 `storage.assets.put/list/get/remove`，有序输出由 `files.stream` 创建、完成后交给 `storage.files.list/get/remove/export` 按 ID 管理。`storage.blobs`、`assets.delete` 和图片/完成输出的 `path` 字段仅保留兼容。KV、session、后台文档、用户授权文件与密钥不共享无差别读写权限，也不提供跨资源事务，详见[数据存储与私有资源](../../docs/developer/storage.md)。

## 2. manifest 校验 CLI

```bash
# 仓库内直跑
node packages/plugin-sdk/bin/enest-validate.mjs path/to/plugin.json

# SDK 已作为本地依赖安装后（不要求全局安装）
./node_modules/.bin/enest-validate ./plugin.json
```

输出示例（失败）：

```text
FAIL ./plugin.json
  - (root) must have required property 'main' ({"missingProperty":"main"})
全部检查项见插件仓 docs/plugin-manifest.schema.json
```

- 多文件参数逐个校验；任一失败 exit 1（可接入 CI）
- 额外启发式：文件所在目录名应等于 `id` 的末段（官方插件 monorepo 的硬约束），不符输出 warn
- `-q` 静默模式：只输出错误

## 3. manifest 校验（编程接口）

```js
import { validateManifest, validateManifestFile } from '@enest/plugin-sdk/validate'

// 对象校验
const { ok, errors } = await validateManifest(manifestObj)

// 文件校验（读 + parse + 校验一步到位，附带解析后的 manifest）
const result = await validateManifestFile('./plugin.json')
if (!result.ok) {
  console.error(result.errors) // pretty 错误行数组
}
```

`validateManifest` 不抛异常：schema 违规、JSON 解析失败、ajv 缺失都收敛为 `{ ok: false, errors: [...] }`。

## 依赖说明

- `ajv ^8` 为 **optional peerDependency**（Node 端校验功能用）。SDK 不携带它，按 Node 包解析规则从开发工程/插件仓依赖中加载（2020 draft 入口 `ajv/dist/2020.js`）；缺失时校验返回可读错误。
- 类型部分零依赖，可脱离 ajv 单独使用。
- 插件仓根声明了 `ajv ^8.20.0`，安装仓库依赖后可供校验 CLI 使用。

## 仓库接线（eNest 维护者）

插件仓已接入 workspaces，无需再次添加：

```jsonc
{
  "workspaces": ["plugins/*", "packages/*"]
}
```

在插件仓根执行类型生成或只读漂移检查；`--host-root` 指向提供 preload/shared 契约的壳仓：

```bash
npm run api:generate -- --host-root /path/to/eNest
npm run api:check -- --host-root /path/to/eNest
# 类型：packages/plugin-sdk/index.d.ts
# 文档：docs/developer/api-types.md 与壳仓 docs/site/plugin/api-types.md
```

## 包结构

```
packages/plugin-sdk/
├── package.json            # name @enest/plugin-sdk，exports 见上
├── README.md
├── index.d.ts             # 从壳 preload/shared 生成，勿手改
├── src/
│   ├── manifest-schema.json# 插件仓 docs/plugin-manifest.schema.json 的自含复制
│   ├── mcp-tools.mjs      # 从壳 shared/mcpTools.ts 生成的声明校验器
│   └── validate.mjs        # validateManifest / validateManifestFile
└── bin/
    └── enest-validate.mjs  # CLI（pretty 错误、exit 1）
```

## 文档

- [API 完整参考](../../docs/developer/api.md)
- [类型文档（生成产物）](../../docs/developer/api-types.md)
- [权限表](../../docs/developer/permissions.md)
- [生命周期](../../docs/developer/lifecycle.md)
- [MCP 工具贡献](../../docs/developer/mcp.md)

`docs/developer/` 是壳仓 `docs/site/plugin/` 的同步副本，由插件仓 `docs:sync` / `docs:check` 管理。manifest schema 的权威源则是插件仓 `docs/plugin-manifest.schema.json`；修改贡献字段时先更新权威源，再由 `api:generate` 同步宿主与 SDK 副本，避免生成时删除另一仓新增的契约。
