# @enest/plugin-sdk

eNest 插件开发者 SDK —— 两个核心交付：

1. **运行时 API 类型**（`index.d.ts`）：由插件仓库 `scripts/generate-api-types.mjs` 从壳 preload/shared 契约自动生成，包含普通插件 `EnestPluginApi`、主题工作区 `EnestWorkspaceApi` 与兼容 `EnestHomeApi`。
2. **`plugin.json` manifest 校验**：ajv (2020-12) + 自含 schema 复制（上游 `eNest_plugin/docs/plugin-manifest.schema.json`），提供编程接口与 CLI。

## 安装

SDK 位于壳子 monorepo 的 `packages/plugin-sdk`。根 `package.json` 接入 workspaces 后（见下方「仓库接线」），插件工程内：

```bash
npm i -D @enest/plugin-sdk
# 或 monorepo 内相对安装：
npm i -D ../../eNest/packages/plugin-sdk
```

未接线 workspaces 时，可直接引用 `index.d.ts`（零依赖，纯类型）。

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

主题工作区使用可选的 `window.enestWorkspace`（`enestHome` 是兼容别名），实现目录、已安装、详情、设置四路由及渲染 ACK。设置只通过安全描述符提交，不注入 `enest` 或 `shellApi`；普通插件通过 `enest.home.register()` 只能确认自己的精确 manifest 声明，不能自动激活或注册未声明入口。完整契约见 `docs/developer/home.md`；SDK/CLI 同时校验 source 归属与重复 ID，打包器验证并构建全部首页 HTML。

## 2. manifest 校验 CLI

```bash
# 仓库内直跑
node packages/plugin-sdk/bin/enest-validate.mjs path/to/plugin.json

# workspaces 接线 / 全局安装后
npx enest-validate ./plugin.json
```

输出示例（失败）：

```text
FAIL ./plugin.json
  - (root) must have required property 'main' ({"missingProperty":"main"})
  - /id must match pattern "^[a-z0-9]+(\.[a-z0-9-]+)+$" (...)
all 检查项见 eNest_plugin/docs/plugin-manifest.schema.json
```

- 多文件参数逐个校验；任一失败 exit 1（可接入 CI）
- 额外启发式：文件所在目录名应等于 `id`（官方插件 monorepo 的硬约束），不符输出 warn
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

- `ajv ^8` 为 **optional peerDependency**（校验功能用）。SDK 不携带运行时依赖，运行时从宿主 `node_modules` 解析 ajv（2020 draft 入口 `ajv/dist/2020.js`）。
- 类型部分零依赖，可脱离 ajv 单独使用。
- 壳子仓库根已装 `ajv@8.20.x`，monorepo 内开箱即用。

## 仓库接线（eNest 维护者）

本包暂未接入根 workspaces（根 `package.json` 加一行即可）：

```jsonc
{
  "workspaces": ["packages/*"]
}
```

接线后 `npm run typecheck` 不受影响（tsconfig 只 include `src/**`）；重新生成类型：

```bash
node scripts/generate-api-types.mjs
# 产物：packages/plugin-sdk/src/enest-api.d.ts + docs/site/plugin/api-types.md
```

## 包结构

```
packages/plugin-sdk/
├── package.json            # name @enest/plugin-sdk，exports 见上
├── README.md
├── src/
│   ├── enest-api.d.ts      # 自动生成（scripts/generate-api-types.mjs），勿手改
│   ├── manifest-schema.json# 上游 eNest_plugin/docs/plugin-manifest.schema.json 的自含复制（x-upstream 标注）
│   └── validate.mjs        # validateManifest / validateManifestFile
└── bin/
    └── enest-validate.mjs  # CLI（pretty 错误、exit 1）
```

## 文档

- API 完整参考：壳子仓库 `docs/site/plugin/api.md`
- 类型文档（生成产物）：`docs/site/plugin/api-types.md`
- 权限表：`docs/site/plugin/permissions.md`
- 生命周期：`docs/site/plugin/lifecycle.md`
