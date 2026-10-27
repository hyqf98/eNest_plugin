# DSH 驾驶舱（com.github.eNest.dsh）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 eNest 插件封装。小窗快速对话，大桌面嵌入真实 DSH Web UI，独立管理中心负责内核、Profiles 和运行维护。

## 版本与授权

DSH 0.3.1 要求 eNest 0.2.1 或更新版本。内核管理、Profile 解析、会话读取、下载和备份现在都在插件自己的 Node 后端执行；壳只提供标准后端加载、权限确认、代理解析和进程生命周期管理，不再内置 DSH 业务处理器。

首次使用本版需要明确授权 `backend.node`。这是运行可信原生 Node 代码的权限，不是文件系统沙箱；请只安装可信来源的插件。旧版 `dsh.connect`、`dsh.chat`、`dsh.admin` 授权不会自动转换为该权限。升级沿用原有 `dsh-home`、`dsh-runtime` 和 `backups/dsh` 数据目录，不要求迁移或清空配置、会话和备份。

## 进入管理中心

在驾驶舱或完全体工具栏点击设置图标，在 eNest「设置 → DSH 驾驶舱」打开管理入口，或在启动器输入 `dsh管理`、`dsh设置`、`dsh内核`。管理入口不会自动启动 DSH。

- **运行**：分别启动、停止或重启 Web 和 SDK。启动失败后仍可重启。端口自动分配，也可设置首选端口；占用时自动换口，不终止占用该端口的其它程序。
- **内核版本**：查看本地内核与可下载版本，下载后保留多个版本，切换到已安装版本。一键升级先停止进程并备份，再下载、校验和激活；入口健康检查失败会回滚。切换完成后由用户手动启动。
- **Profiles**：从出厂模板创建，编辑 bundles 有序栈、`cordis.patch.yml` 和环境变量。分别选择 Web 和 SDK 使用的兼容 Profile；保存或切换会停止进程，下次启动生效。
- **维护与诊断**：创建和恢复本地备份，查看真实进程日志、内核和数据目录；提供保留会话的配置重置，以及单独确认的完整环境重置。

关闭插件时，插件后端取消未完成的启动、下载和重试，停止自己的 DSH 子进程；宿主等待后端及已登记子进程退出，并在超时后兜底回收。切换到别的插件不等于关闭，运行任务和子进程持有活动租约，不会因此被休眠中断。

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

## 按需安装运行时与在线升级

自 0.3.0 起，插件发行包不再内嵌 DSH 内核。首次打开若检测不到任何内核（本地安装 / 插件捆绑 / 系统 PATH），会弹出安装引导：列出与当前平台匹配且带 SHA-256 校验的已发布内核版本，选择后由插件后端完成下载、校验、安装、健康检查与激活，失败自动回滚。也可以「稍后处理」，随时在管理中心的「内核版本」中安装。

插件后端通过 `ELECTRON_RUN_AS_NODE=1` 复用 eNest Electron 引擎运行内核，无需全局安装 Node/npm/dsh。下载请求及重定向逐次解析 eNest 当前代理配置，支持直连、HTTP(S) 和 SOCKS 代理；不会在代理失败时静默绕过配置直连。

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
npm run pack:runtime --workspace dsh
```

运行时版本固定在插件自己的 `plugins/dsh/scripts/runtime-contract.mjs` 的 `DSH_VERSION`。`package.json` 通过 `enestBuild.entry` 声明插件构建扩展；常规构建默认不安装或嵌入内核，显式传入 `--runtime` 才复用或安装对应本机平台的缓存。CI 平台矩阵调用 `plugins/dsh/scripts/pack-runtime.mjs`，显式构建 `dist/runtime/` 并输出带 SHA-256 边车的热更新 tgz 资产。需要本地捆绑内核调试时，用 `node scripts/build-plugin.mjs dsh --runtime`。

包含原生模块的运行时必须在目标平台构建和打包；跨平台投影不生成 DSH 内核资产。指定平台的分发若携带 `runtime/`，附件 `package.json` 必须显式声明并匹配 `platform`、`arch`，校验不会用当前机器的平台补写或猜测。已有 `runtime/` 的非投影分发在打包时可附带生成内核资产，但不会自动安装内核；没有 `runtime/` 的常规插件包不需要它。

插件后端源码和私有协议位于 `backend/`，更改后重新构建并关闭、重开插件实例；插件前端开发可使用 Vite 热更新。只有壳的通用后端协议或预加载能力变更才需要重启 eNest 开发进程。

迁移专项和后端类型检查可在插件仓库根目录显式运行：

```bash
npm run typecheck:backend --workspace dsh
npm run test:backend:migration --workspace dsh
```

专项使用临时目录和本地模拟运行时，不访问现有 DSH 配置或在线模型服务；旧测试仅归档于 `backend/tests/legacy/`，不包含在该命令中。

## 界面预览

![DSH 驾驶舱主界面](./screenshots/01-main.png)

现有截图展示驾驶舱，不代表本次管理中心的新布局。
