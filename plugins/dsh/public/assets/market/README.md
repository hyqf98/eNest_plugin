# DSH 驾驶舱（com.github.eNest.dsh）

DeepSeek Harness（[dsh](https://github.com/deepseek-ai/deepseek-harness)）的 eNest 插件封装。

## 能力

- **小窗（quick）**：会话驾驶舱 —— 多会话进度查看与切换、快速对话（走 dsh 公开 SDK JSON-RPC，流式事件实时推送）。
- **大桌面（shell）**：DSH 完全体 —— iframe 嵌入真实 dsh Web UI（token 自动注入、随机空闲端口、端口冲突自动换口重启）。
- **独立设置台**（插件内置，非壳子设置）：
  - Profile 管家：bundles 有序栈 / cordis.patch.yml / out-of-tree 插件可视化；新增（模板）、删除（先备份）、备份/恢复。
  - 运行时与端口：进程启停、端口策略（自动分配 / 固定）。
  - 版本与升级：本地多版本共存、切换即回退、在线下载、一键备份升级（停进程 → 全量备份 → 下载 → 激活 → 健康检查，失败自动回滚）。
  - 备份：$DSH_HOME 全量快照（含凭据，仅本机）。
  - 诊断：runtime 路径 / DSH_HOME 布局 / 进程日志尾。

## 自包含运行时

`.enestplugin` 内捆绑 dsh 生产依赖闭包（`runtime/`，约 500MB 解压后），宿主以
`ELECTRON_RUN_AS_NODE=1` 复用 eNest Electron 引擎运行，**零本地依赖**（无需 Node/npm/npx）。
热更新资产 `dsh-runtime-<version>-<platform>-<arch>.tgz`（+.sha256 边车）由
`node scripts/pack-plugin.mjs com.github.eNest.dsh` 一并产出，上传本仓库 Release 供在线升级。

- 运行时版本统一固定在 `scripts/plugin-contract.mjs` 的 `DSH_VERSION`；调整后重新构建和打包。
- 运行时产物按构建机平台与架构命名；包含原生依赖时，应在目标平台构建。

## 开发

- 在仓库根目录执行 `npm install`，使用 `npm run dev --workspace com.github.eNest.dsh -- --host 127.0.0.1` 启动 Vite，在壳子开发测试中选择本插件源码文件夹并使用开发地址。
- `node scripts/build-plugin.mjs com.github.eNest.dsh` 将固定版本的运行时构建到 `dist/runtime-cache/`，再复制到本插件的 `dist/runtime/`。只有 DSH 的最终发行包允许 `runtime/`，源码和公共资源不使用软链接。
- UI 源码位于 `src/`，市场资料位于 `public/assets/market/`。`node scripts/pack-plugin.mjs com.github.eNest.dsh` 只打包 `dist/` 的内容，根目录含 `plugin.json`、`index.html`、`assets/`、`runtime/`。
- DSH_HOME 隔离在 `~/.eNest/dsh-home`（与系统 dsh 数据互不影响）。
- 模型配置：完全体 Settings → Models 配 DeepSeek API key（小窗快速对话共用同一凭据）。

## 界面预览

![DSH 驾驶舱主界面](./screenshots/01-main.png)

截图使用隔离演示数据，不连接用户真实账户。
