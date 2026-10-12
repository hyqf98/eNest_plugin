# eNest_plugin

eNest 官方插件 monorepo。源码在 `plugins/<pluginId>/`，CI 自动生成 `registry.json` 并打包全部插件为 GitHub Release 资产。

壳子（eNest 桌面端）从本仓库 **Release** 读取插件列表与安装包：

```
GET https://github.com/hyqf98/eNest_plugin/releases/latest/download/registry.json
GET https://github.com/hyqf98/eNest_plugin/releases/latest/download/{id}@{version}.enestplugin
```

回退（无 Release 时）：`raw.githubusercontent.com/hyqf98/eNest_plugin/main/registry.json`

## 目录结构

标准插件形态见 [docs/PLUGIN_STRUCTURE.md](docs/PLUGIN_STRUCTURE.md)（对齐 uTools：`plugin.json` + `logo` + `index.html` + `assets/`）。

```
eNest_plugin/
├── plugins/
│   └── com.example.hello/
│       ├── plugin.json          # 插件清单（权威元数据）
│       ├── logo.png             # 可选 128×128
│       ├── index.html           # 入口（ui.chrome 缺省 none，全幅）
│       └── assets/              # css / js / images
├── docs/PLUGIN_STRUCTURE.md     # 标准结构说明
├── registry.json                # CI 生成，勿手改（本地可提交快照便于预览）
├── scripts/build-registry.mjs   # 扫 plugins/ 生成 registry
├── scripts/pack-plugin.mjs      # 打 .enestplugin（zip）
├── scripts/prepare-release.mjs  # 截图/图标附件与最终下载 URL
└── .github/workflows/release.yml
```

## 插件清单 `plugin.json`

必填字段与壳子 `PluginManifest` 对齐，市场扩展字段放在 `market` 段：

```jsonc
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "一句话说明插件做什么",
  "author": "Your Name",
  "main": "index.html",
  "permissions": ["storage.local"],
  "category": "效率",
  "icon": "icon.png",
  "homepage": "https://github.com/org/eNest_plugin/tree/main/plugins/com.example.hello",
  "engines": { "enest": ">=0.1.0" },
  "ui": {
    "chrome": "none",
    "themeAware": true,
    "background": "opaque",
    "preferredColorScheme": "auto"
  },
  "market": {
    "featured": false,
    "tags": ["剪贴板", "效率"],
    "screenshots": [],
    "minWidth": 400,
    "minHeight": 300
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✓ | 全局唯一，反向域名，目录名必须等于 id |
| `name` | ✓ | 显示名 |
| `version` | ✓ | semver，`major.minor.patch` |
| `description` | ✓ | 市场卡片描述（建议 ≤80 字） |
| `main` | ✓ | 入口 HTML 相对路径 |
| `category` | ✓ | 分类：效率 / 开发 / 设计 / 媒体 / 其它 |
| `icon` | | 相对路径；缺省用 name 首字 |
| `permissions` | | 与壳子权限表一致（白名单见 `docs/plugin-manifest.schema.json`，权威源为壳子 `src/shared/types/plugin.ts` → `PLUGIN_PERMISSIONS`，当前 21 项） |
| `engines` | | `enest` 版本范围：`*` / `^x.y.z` / `>=x.y.z` / 精确 |
| `features` | | Quick 指令 `{ code, explain?, cmds }` |
| `window` | | Quick 内容尺寸建议 width / height 和下限 minWidth / minHeight；插件应响应实际视口，可用 enest.ui.resize 更新（需 ui.resize 权限），主窗大小由用户控制 |
| `form` | | `mini` 命令面板小窗 / `panel` 主窗 Tab（缺省） |
| `development` | | 开发态入口 URL `{ main }` |
| `ui` | | chrome（缺省 none，default 已废弃）/ themeAware / background / preferredColorScheme |
| `market` | | 市场展示扩展 |

> Manifest JSON Schema：`docs/plugin-manifest.schema.json`（CI 用 ajv 校验，脚本 `scripts/validate-manifests.mjs`）。
> 单文件快速校验也可用壳子仓库 SDK：`node ../eNest/packages/plugin-sdk/bin/enest-validate.mjs plugins/<id>/plugin.json`（详见 [packages/plugin-sdk](../eNest/packages/plugin-sdk/README.md)）。

## 首页推荐与截图元数据

维护入口始终是**本独立插件仓库**的 `plugins/<id>/plugin.json`，壳子不维护插件截图表：

```jsonc
"market": {
  "featured": true,
  "tags": ["截图", "录屏"],
  "screenshots": [
    "assets/screenshots/main.png",
    "https://cdn.example.com/my-plugin/recording.webp"
  ]
}
```

示例路径需换成实际文件或可用 URL。规则如下：

- `featured` 指定首页推荐候选，缺省 `false`；沿用已有字段，无需额外的 banner 元数据。
- `screenshots` 是有序 `string[]`，最多 8 张、不可重复；**第一张用于首页推荐封面**。应提交真实产品截图，建议横向 16:10 或 16:9；首页完整显示图片，不裁掉界面内容。
- 本地路径相对当前 `plugin.json` 所在的插件根，例如 `assets/screenshots/main.png`。支持 PNG / JPG / JPEG / WebP / GIF，不接受绝对路径、`..`、反斜杠或逃出插件根的符号链接。校验/构建会拒绝缺失的文件、目录和不支持的扩展名。
- 外链必须是无账号密码的 HTTPS URL（允许 CDN 查询参数）；生成器保留它，不下载、不校验外部服务在线状态。
- 缺省或 `[]` 表示暂无截图，壳子显示插件名称/描述/图标，不把首页概念图或通用插画伪装成插件截图。旧索引缺少该字段仍可读取。

`build-registry.mjs` 将字段展开为 `registry.plugins[].screenshots`：本地文件转换为相对 `registry.json` 的 `plugins/<id>/assets/screenshots/main.png`，路径按段做 URL 编码，外链保持绝对 URL。`prepare-release.mjs` 再把实际本地图片复制为 `dist/{id}@{version}-screenshot-1.png` 等附件，输出 Release 绝对下载地址。图标按 `logo` 优先、`icon` 兜底读取声明的真实文件（支持 SVG），同样复制为扁平附件；不再假设图标必须叫 `icon.png`。

发布索引位于 `dist/registry.json`；`asset.url/size/sha256` 与所有本地截图/图标 URL 均对应本次 Release 的真实附件，缺包或缺图会阻断生成。壳子通过市场服务获取索引，将 `screenshots` 与 `featured` 一起传给首页；相对媒体地址按索引所在 URL 解析，图片加载失败则回退文字内容。

```bash
node --test scripts/market-assets.test.mjs
# 打包全部插件后生成待上传文件，不会创建或发布 GitHub Release
REPO=hyqf98/eNest_plugin TAG=plugins-local node scripts/prepare-release.mjs
```

## registry.json（壳子列表索引）

CI 由所有 `plugin.json` 聚合，**一次下载即可渲染完整列表与分类**：

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-16T12:00:00.000Z",
  "channel": "stable",
  "categories": ["效率", "开发", "设计", "媒体", "其它"],
  "plugins": [
    {
      "id": "com.example.hello",
      "name": "Hello",
      "version": "1.0.0",
      "description": "…",
      "author": "…",
      "category": "效率",
      "icon": "https://github.com/<org>/eNest_plugin/releases/download/plugins-123/com.example.hello%401.0.0-icon.png",
      "screenshots": [],
      "tags": ["示例"],
      "permissions": ["storage.local"],
      "engines": { "enest": ">=0.1.0" },
      "featured": false,
      "installs": 0,
      "asset": {
        "name": "com.example.hello@1.0.0.enestplugin",
        "url": "https://github.com/<org>/eNest_plugin/releases/download/plugins-123/com.example.hello%401.0.0.enestplugin",
        "size": 10240,
        "sha256": "…"
      }
    }
  ]
}
```

### 壳子加载策略（约定）

1. **列表**：优先拉 `releases/latest/download/registry.json`，缓存到本地；失败回退上次缓存或内置 mock。
2. **分类**：直接用 registry.categories / plugin.category，无需二次请求。
3. **安装**：下载 `asset.url` → 校验 `sha256` → 解压 `.enestplugin`（zip）→ 本地 `~/eNest/plugins/`。
4. **更新**：对比本地已装 `version` 与 registry；有新版提示下载。

## 发布命名约定

- Release tag：CI 使用 `plugins-${github.run_number}`
- 资产：`{id}@{version}.enestplugin`
- 附属：`registry.json`、`{id}@{version}-icon.{ext}`、`{id}@{version}-screenshot-{序号}.{ext}`
- GitHub Release 的附件没有目录层级；媒体与安装包都使用扁平且唯一的文件名。

## 开发流程

```bash
# 1. 新建插件目录
mkdir -p plugins/com.example.hello
# 2. 写 plugin.json + index.html
# 3. 校验全部 manifest（ajv + docs/plugin-manifest.schema.json）
node scripts/validate-manifests.mjs
# 3b. 单文件校验（壳子 SDK CLI；workspaces 接线后也可 npx enest-validate）
node ../eNest/packages/plugin-sdk/bin/enest-validate.mjs plugins/com.example.hello/plugin.json
# 4. 本地生成索引预览（内部先跑同一校验，失败不产出）
node scripts/build-registry.mjs
# 5. 单包
node scripts/pack-plugin.mjs com.example.hello
```

合并到 `main` 后由 GitHub Actions 校验、测试、打包全部插件并创建 **草稿 Release**。当前 `draft: true` 保持不变；正式发布该 Release 后，壳子下次刷新市场才会从 `releases/latest/download/registry.json` 获取新元数据。此流程不会自动提交本地生成的索引快照。

## 分类枚举

固定五类，CI 校验 `category` 必须落在枚举内：

- `效率` `开发` `设计` `媒体` `其它`
