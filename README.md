# eNest 官方插件仓库

本仓库维护插件源码、共享 UI 工具、API 类型、开发文档和发布工具。所有插件使用同一套源码与发行目录契约；Vue、React、Vite 和原生前端都通过根目录的 `plugin.json` 与 `index.html` 接入壳子。

先读 [开发入门](docs/developer/getting-started.md)、[工程结构](docs/PLUGIN_STRUCTURE.md) 和 [manifest 参考](docs/manifest.md)。AI 开发入口是 [skills/enest-development/SKILL.md](skills/enest-development/SKILL.md)，完整导航在 [docs/README.md](docs/README.md)。

## 开发与验证

在本仓库根目录执行：

```bash
npm install
npm run dev --workspace calculator
# 在 eNest 开发测试中选择 plugins/calculator 源码文件夹即可，
# 开发服务未运行时壳子会自动执行 npm run dev 拉起（无需手动启动）。
```

开发者可以选择仓库外的源码文件夹。壳子只读标准入口，不复制源码到已安装插件目录。`development.main` 声明的开发服务未运行时，壳子自动拉起并管理进程（忘记插件/退出时回收）；端口被其它进程占用时自动改用空闲端口。插件内 F12/⌘⌥I/Ctrl+Shift+I 开关 DevTools，⌘R 重载。跨机开发可用 `--host 0.0.0.0` 启动，并将 `development.main` 配为实际 IP、端口与入口路径。

每个插件的 dev 端口在各自 `package.json` 的 `scripts.dev` 中声明，且与 `plugin.json` 的 `development.main` 保持一致、全仓唯一（现按插件分配 5173–5208）。

```bash
npm run validate                 # 源码清单、包名/版本、市场资源
npm test                         # 单元与包格式合同
npm run build                    # 自动发现并构建所有 plugins/*
npm run validate:dist            # 路径边界、入口与离线资源引用
npm run capture:market -- --check # 全部发行页面：生产 CSP、资源与尺寸检查
npm run test:ui                  # 关键交互流程，宿主能力使用隔离 fixture
npm run pack -- --no-build       # 打包已验证的 dist 内容
npm run registry                # 只从最终归档读取市场数据
```

首次新增插件还没有截图时，可用 `node scripts/capture-market.mjs <id> --build` 构建预览并生成真实页面截图，随后重新构建以把截图纳入发行包。截图脚本使用隔离演示数据，不能替代真实数据库、SSH、操作系统权限和硬件功能的集成测试。

## 源码与发行包

```text
plugins/<id>/
  plugin.json                 # main: index.html；源码可声明 development.main
  package.json                # name === id；version 与 manifest 一致
  index.html                  # 加载 src/entry.js
  src/                        # 业务源码、框架组件和样式
  public/assets/market/       # icon.svg、README.md、screenshots/*
  public/assets/vendor/       # 必须原样复制的第三方静态资源
  tests/
  dist/                       # 构建生成，不提交
    plugin.json               # 已移除 development
    index.html
    assets/app/               # 打包后的 JS、CSS、worker
    assets/market/
    assets/vendor/
```

`.enestplugin` 是 ZIP，根目录直接是 `dist/` 的内容，不能再套一层插件目录。源码、测试、`node_modules`、软链接、隐藏路径、Source Map、TS/TSX/Vue 文件不进入包。DSH 的固定生产运行时是唯一显式 `runtime/` 例外，详见 [工程结构](docs/PLUGIN_STRUCTURE.md)。

共享工具以 npm workspace `@enest/plugin-kit` 引用，由 Vite 编译到各自发行包；不复制 `assets/shared`，不引用其他插件目录。类型由 `@enest/plugin-sdk` 提供，维护入口见 [API 类型](docs/developer/api-types.md)。

## 图标、说明与截图

每个清单必须声明：

```json
{
  "icon": "assets/market/icon.svg",
  "market": {
    "readme": "assets/market/README.md",
    "screenshots": ["assets/market/screenshots/01-main.png"]
  }
}
```

以上路径指向发行包内的文件；源码对应位置在 `public/` 下。图标应表达插件功能，截图使用真实界面，发行必须包含 1–8 张 PNG/JPG/JPEG/WebP，第一张作为封面。README 上限 512 KiB，图片使用如 `./screenshots/01-main.png` 的包内相对路径。外部图片 URL、任意根目录图标和旧 `logo` 字段不属于新契约。

`build-registry.mjs` 从最终 ZIP 提取 manifest 与市场资源，再生成 `dist/registry.json`，不会以源码中的截图冒充归档内容。索引含 `icon`、`readmeUrl`、`screenshots`、`asset.url/size/sha256`。`prepare-release.mjs` 生成 GitHub Release 扁平附件及 README 图片映射 `readmeImages`。

## 发布

```bash
node scripts/pack-plugin.mjs calculator
# 全部插件已打包后，生成本地待发布材料；此命令不会上传
REPO=hyqf98/eNest_plugin TAG=plugins-local node scripts/prepare-release.mjs
```

推送 `v*` / `plugins-*` 标签或手动触发已有标签的工作流才会创建正式 Release。CI 要求源码校验、全部构建、发行检查、生产 CSP 页面检查、打包和索引生成全部通过；普通分支推送不触发本发布工作流。仅 `v0.0.1` 首版将存量单元与包格式测试单独保留为非阻断报告，其它标签仍要求测试通过；发包成功不代表这些历史用例全部通过。

壳子从 [最新市场索引](https://github.com/hyqf98/eNest_plugin/releases/latest/download/registry.json) 发现版本，通过 SHA-256 校验后安装到 `~/.eNest/plugins/`。文件名固定 `{id}@{version}.enestplugin`，分类固定为效率、开发、设计、媒体、其它。
