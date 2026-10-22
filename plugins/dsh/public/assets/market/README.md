# DSH 驾驶舱（com.github.eNest.dsh）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 eNest 插件封装。小窗快速对话，大桌面嵌入真实 DSH Web UI，独立管理中心负责内核、Profiles 和运行维护。

## 进入管理中心

在驾驶舱或完全体工具栏点击设置图标，或在启动器输入 `dsh管理`、`dsh设置`、`dsh内核`。管理入口不会自动启动 DSH。

- **运行**：分别启动、停止或重启 Web 和 SDK。启动失败后仍可重启。端口自动分配，也可设置首选端口；占用时自动换口，不终止占用该端口的其它程序。
- **内核版本**：查看本地内核与可下载版本，下载后保留多个版本，切换到已安装版本或插件捆绑版本。一键升级先停止进程并备份，再下载、校验和激活；入口健康检查失败会回滚。切换完成后由用户手动启动。
- **Profiles**：从出厂模板创建，编辑 bundles 有序栈、`cordis.patch.yml` 和环境变量。分别选择 Web 和 SDK 使用的兼容 Profile；保存或切换会停止进程，下次启动生效。
- **维护与诊断**：创建和恢复本地备份，查看真实进程日志、内核和数据目录；提供保留会话的配置重置，以及单独确认的完整环境重置。

关闭插件时，由宿主取消未完成的启动和重试，并回收属于该插件的 DSH 进程及端口。切换到别的插件不等于关闭，后台运行不会因此被中断。

## Profile 与环境同步

DSH 原生 Profile 是组合配置，不等于独立的运行目录：

```text
DSH_HOME/profiles/<name>/
  package.json              # dsh.profile.bundles / dependencies
  cordis.patch.yml          # 原生配置补丁
  .enest-environment.json    # eNest 管理的子进程环境覆盖
```

Web 与 SDK 使用不同组合模板，管理中心按兼容性限制选择，避免把 Web 应用当作 SDK 运行。

**一键同步环境**把源 Profile 的 API Key、代理等受支持环境变量复制给目标 Profile，保留目标的 bundles、补丁和依赖，不会因为 Web 向 SDK 同步而破坏运行方式。覆盖前自动备份目标，并停止相关进程；再次启动后使用新配置。

受支持环境变量包括 DeepSeek / OpenAI / Anthropic API Key、`DEEPSEEK_BASE_URL`、HTTP(S)/ALL/NO_PROXY 及小写代理别名、`DSH_TELEMETRY_DISABLED`。其它提供者配置通过 DSH Models 或原生补丁管理。禁止覆盖 `PATH`、`NODE_OPTIONS`、`DSH_HOME`、Electron 等宿主启动参数。

环境覆盖只传给该 Profile 的子进程，不修改系统环境变量。DSH 不会原生读取 `profiles/<name>/.env`，因此不要把 eNest 的环境文件当作原生 DSH 文件。密钥在编辑器中默认遮罩，但本机环境文件和备份包含明文凭据，请妥善保护。

## 备份与清理边界

DSH_HOME 位于 eNest 管理的数据目录，界面显示真实路径。它与系统 `~/.dsh` 隔离；管理中心不会清理系统 DSH 环境。

- **重置配置**：先备份，清除 Profiles、主目录补丁、托管凭据、`.env` 和运行选择，保留会话、存储和日志。
- **重置全部环境**：先备份，再清理隔离的 DSH_HOME，包含会话。必须输入 `RESET HOME` 确认。
- 两种重置均保留已下载内核与备份，失败或误操作可从维护页恢复。
- 全量备份排除 `node_modules`，含 API 凭据，仅保存在本机。恢复前必须等待进程真正退出。

## 自包含运行时与在线升级

发行包可捆绑 DSH 生产依赖闭包，宿主通过 `ELECTRON_RUN_AS_NODE=1` 复用 eNest Electron 引擎，无需全局安装 Node/npm/dsh。

热更新只安装与当前平台、架构匹配且带 SHA-256 边车的资产：

```text
dsh-runtime-<version>-<platform>-<arch>.tgz
dsh-runtime-<version>-<platform>-<arch>.tgz.sha256
```

发布流程分别构建 macOS arm64/x64、Windows x64 和 Linux x64 内核资产。上游 npm 有新版本不代表插件仓库已发布对应资产；缺少当前平台资产时，管理页会明确提示，不能把“有版本号”当作“可升级”。

## 开发

在插件仓库根目录使用已有依赖：

```bash
npm run dev --workspace dsh
node scripts/build-plugin.mjs dsh
node scripts/pack-plugin.mjs dsh
node scripts/pack-dsh-runtime.mjs
```

运行时版本固定在 `scripts/plugin-contract.mjs` 的 `DSH_VERSION`。常规构建把平台原生依赖放入 `dist/runtime-cache/`，再复制到插件的 `dist/runtime/`；独立内核打包脚本只输出热更新资产。包含原生模块的运行时必须在目标平台构建。

主进程运行时或共享契约变更后须重启 eNest 开发进程；插件前端开发可使用 Vite 热更新。

## 界面预览

![DSH 驾驶舱主界面](./screenshots/01-main.png)

现有截图展示驾驶舱，不代表本次管理中心的新布局。
