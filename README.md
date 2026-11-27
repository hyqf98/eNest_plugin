<div align="center">

<img src="https://raw.githubusercontent.com/hyqf98/eNest/main/assets/icons/enest.svg" width="96" alt="eNest" />

# eNest 官方插件仓库

[![License](https://img.shields.io/badge/License-Apache--2.0-blue)](https://github.com/hyqf98/eNest/blob/main/LICENSE)
[![eNest Host](https://img.shields.io/badge/宿主-eNest%20%3E%3D0.0.1-6c5ce7?logo=electron&logoColor=white)](https://github.com/hyqf98/eNest/releases)
[![Node](https://img.shields.io/badge/Node-%3E%3D22.12-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Plugins](https://img.shields.io/badge/官方插件-47-ff7a1a)](#-插件目录)

**基于权限沙箱的插件化桌面壳 [eNest](https://github.com/hyqf98/eNest) 的官方插件市场。**

[安装市场](#-安装插件) ·
[快速开始](#-快速开始) ·
[插件目录](#-插件目录) ·
[Skills 指南](#-ai-开发助手skills) ·
[开发文档](docs/README.md) ·
[发布流程](#-构建与发布)

</div>

---

## 💡 这是什么

本仓库维护 eNest 的官方插件源码、共享 UI 工具（`@enest/plugin-kit`）、API 类型（`@enest/plugin-sdk`）、开发文档和发布工具。

插件没有特殊待遇：**界面、算法、数据模型、协议处理都住在插件里**；宿主只提供窗口、权限、存储、网络和系统集成等通用原生能力。Vue、React 和原生前端通过同一份 `plugin.json` + `index.html` 契约接入壳子。

## 📦 安装插件

**公开发行已暂停。** 之前在 [Releases](https://github.com/hyqf98/eNest_plugin/releases) 提供的插件包和市场索引已撤下，暂不可在线安装。

已有的 `.enestplugin` 包仍可拖入 eNest 窗口安装；也可在本机从源码[构建并打包](#-构建与发布)，无需发布。

> ⚠️ Releases 页的 Source code 压缩包是仓库源码，**不能**作为插件安装。
> 数据库插件按平台分发（macOS arm64/x64、Windows x64、Linux x64），请选择匹配本机的平台包，平台包不是额外插件。

## 🗂 插件目录

目录展示插件源码。✅ 表示曾收录于已撤回的发行批次，不代表当前可下载。「图片工具箱」的功能已并入屏幕助手，该插件不再单独维护。

### ⚡ 效率（13）

| 插件 | 简介 |
| --- | --- |
| [<img src="plugins/anything/public/assets/market/icon.svg" width="20" alt=""> **Anything 文件搜索**](plugins/anything) ✅ | Spotlight / Everything 双引擎全盘即时搜索，关键词高亮、预览、定位、废纸篓 |
| [<img src="plugins/calculator/public/assets/market/icon.svg" width="20" alt=""> **计算器**](plugins/calculator) ✅ | 科学计算、变量赋值、Ans 与内存寄存器、千分位与本地历史 |
| [<img src="plugins/clipboard/public/assets/market/icon.svg" width="20" alt=""> **剪贴板**](plugins/clipboard) ✅ | 文本/图片/文件历史，快捷回贴、变换工具条与暂存片段 |
| [<img src="plugins/gantt/public/assets/market/icon.svg" width="20" alt=""> **甘特图**](plugins/gantt) | 项目计划多计划管理、拖拽改期、依赖连线、里程碑，导出 Excel / HTML |
| [<img src="plugins/markdown/public/assets/market/icon.svg" width="20" alt=""> **Markdown 编辑器**](plugins/markdown) ✅ | Typora 式所见即所得、手绘风 Mermaid、图床上传与本地文件工作台 |
| [<img src="plugins/password-book/public/assets/market/icon.svg" width="20" alt=""> **密码本**](plugins/password-book) ✅ | 本地加密密码管理：分类、搜索、强度提示、过期提醒、MCP 安全读写 |
| [<img src="plugins/password-kit/public/assets/market/icon.svg" width="20" alt=""> **密码工具箱**](plugins/password-kit) ✅ | 随机密码/密码短语/PIN 生成，熵与破解时间估算，UUID 批量生成 |
| [<img src="plugins/pomodoro/public/assets/market/icon.svg" width="20" alt=""> **番茄钟**](plugins/pomodoro) ✅ | 主进程后台专注计时，长短休息、预设、完成提示音与统计 |
| [<img src="plugins/sticky-notes/public/assets/market/icon.svg" width="20" alt=""> **备忘录**](plugins/sticky-notes) ✅ | 快速记录、Markdown 颜色筛选、标签整理、归档回收与备份 |
| [<img src="plugins/sysguard/public/assets/market/icon.svg" width="20" alt=""> **进程与端口**](plugins/sysguard) ✅ | 进程/端口巡检仪表盘、双表联动、Top 进程与滚动趋势曲线 |
| [<img src="plugins/todos/public/assets/market/icon.svg" width="20" alt=""> **待办清单**](plugins/todos) ✅ | 任务清单、拖拽排序、截止日期、子任务进度、标签与桌面整理 |
| [<img src="plugins/translate/public/assets/market/icon.svg" width="20" alt=""> **翻译**](plugins/translate) ✅ | 多引擎翻译、对照即时翻译、语言快捷切换、历史与双语导出 |
| [<img src="plugins/unit-convert/public/assets/market/icon.svg" width="20" alt=""> **单位与汇率**](plugins/unit-convert) ✅ | 12 类单位 + 汇率同屏联动换算，公式展示与常用单位置顶 |

### 🛠 开发（17）

| 插件 | 简介 |
| --- | --- |
| [<img src="plugins/ccswitch/public/assets/market/icon.svg" width="20" alt=""> **供应商切换**](plugins/ccswitch) ✅ | AI CLI 供应商切换台：10 应用配置、50+ 预设、切换历史、用量统计 |
| [<img src="plugins/codec/public/assets/market/icon.svg" width="20" alt=""> **编解码**](plugins/codec) ✅ | Base64/URL/Hex/Unicode/HTML 编解码与 JWT 查看，批量与错误定位 |
| [<img src="plugins/codex-pets/public/assets/market/icon.svg" width="20" alt=""> **Codex 宠物市场**](plugins/codex-pets) ✅ | 社区宠物画廊：搜索、sprite 预览、一键安装宠物包到本机 Codex |
| [<img src="plugins/cron/public/assets/market/icon.svg" width="20" alt=""> **Cron 工具**](plugins/cron) ✅ | 五/六域可视化构建、中文人性化描述、执行预览与 crontab 导出 |
| [<img src="plugins/database/public/assets/market/icon.svg" width="20" alt=""> **数据库**](plugins/database) ✅ | 多数据库工作台：查询编辑、结果编辑、结构关系、只读数据比较 |
| [<img src="plugins/dev-env/public/assets/market/icon.svg" width="20" alt=""> **开发环境管理**](plugins/dev-env) ✅ | 9 家族构建环境探测、依赖与缓存管理、Homebrew / winget 接管 |
| [<img src="plugins/diff/public/assets/market/icon.svg" width="20" alt=""> **文本对比**](plugins/diff) ✅ | 双栏 LCS 行级对比、行内字符细化、差异导航与 unified diff 导出 |
| [<img src="plugins/dsh/public/assets/market/icon.svg" width="20" alt=""> **DSH 驾驶舱**](plugins/dsh) ✅ | DeepSeek Harness 会话驾驶舱：快速对话、内核按需安装、Profile 配置 |
| [<img src="plugins/env-vars/public/assets/market/icon.svg" width="20" alt=""> **环境变量管理**](plugins/env-vars) ✅ | 跨平台用户/系统变量编辑，PATH 专用编辑器，写入前自动备份 |
| [<img src="plugins/hash/public/assets/market/icon.svg" width="20" alt=""> **哈希与加密**](plugins/hash) ✅ | 多算法同屏哈希、文件哈希、HMAC、AES-GCM / RSA 加解密签名 |
| [<img src="plugins/json-tools/public/assets/market/icon.svg" width="20" alt=""> **JSON 工具**](plugins/json-tools) ✅ | 无损数字格式化、路径查询、TS 类型生成、树浏览与差异比较 |
| [<img src="plugins/middleware/public/assets/market/icon.svg" width="20" alt=""> **中间件控制台**](plugins/middleware) ✅ | Kafka / RabbitMQ / MQTT / RocketMQ 统一控制台与消息溯源 |
| [<img src="plugins/net-kit/public/assets/market/icon.svg" width="20" alt=""> **网络调试台**](plugins/net-kit) ✅ | HTTP / TCP / WebSocket 调试：流式响应、hex 字节流、断言、curl 导入 |
| [<img src="plugins/regex/public/assets/market/icon.svg" width="20" alt=""> **正则工作台**](plugins/regex) ✅ | 正则实时高亮、捕获分组、替换预览、片段库与元字符速查 |
| [<img src="plugins/remote-desktop/public/assets/market/icon.svg" width="20" alt=""> **远程桌面**](plugins/remote-desktop) ✅ | VNC / RDP 资产管理、SSH 隧道、多会话画布与剪贴板互通 |
| [<img src="plugins/ssh/public/assets/market/icon.svg" width="20" alt=""> **SSH管理**](plugins/ssh) ✅ | SSH 工作台：快速连接、终端、远程文件、资源进程、服务与隧道 |
| [<img src="plugins/timestamp/public/assets/market/icon.svg" width="20" alt=""> **时间戳**](plugins/timestamp) ✅ | 时间戳/时区转换、多时区时钟、批量转换、日期加减与时间差 |

### 🎨 设计（5）

| 插件 | 简介 |
| --- | --- |
| [<img src="plugins/ai-canvas/public/assets/market/icon.svg" width="20" alt=""> **AI 画布**](plugins/ai-canvas) ✅ | 手绘风节点画布编排文生图/图生图工作流，生成图自动入画廊 |
| [<img src="plugins/color-picker/public/assets/market/icon.svg" width="20" alt=""> **取色器**](plugins/color-picker) ✅ | 屏幕取色 HEX/RGB/HSL/OKLCH，和谐色生成与 WCAG 对比度检查 |
| [<img src="plugins/drawboard/public/assets/market/icon.svg" width="20" alt=""> **画板**](plugins/drawboard) ✅ | 压感手绘与桌面标注：钢笔、图形、文字贴图，多页草稿与导出 |
| [<img src="plugins/image-gen/public/assets/market/icon.svg" width="20" alt=""> **AI 生图**](plugins/image-gen) | 对话式生图：Images / Chat / Responses 三协议，会话流与预览库 |
| [<img src="plugins/sketchbook/public/assets/market/icon.svg" width="20" alt=""> **素描本**](plugins/sketchbook) ✅ | 纸品手绘主题：桌面、索引卡、便签与牛皮纸，手抖描边与胶带拼贴 |

### 🎬 媒体（6）

| 插件 | 简介 |
| --- | --- |
| [<img src="plugins/media-browser/public/assets/market/icon.svg" width="20" alt=""> **媒体浏览**](plugins/media-browser) | 关联多个文件夹，树形浏览图片与视频：相机 RAW（NEF 等）、HEIC、视频缩略图，拖拽整理与批量删除 |
| [<img src="plugins/comic-house/public/assets/market/icon.svg" width="20" alt=""> **漫画屋**](plugins/comic-house) | 聚合漫画阅读：多源管理、跨源搜索、沉浸式竖向阅读与整部缓存 |
| [<img src="plugins/novel-house/public/assets/market/icon.svg" width="20" alt=""> **小说屋**](plugins/novel-house) | Legado 书源聚合阅读：多源搜索、舒适排版阅读器、整本缓存 |
| [<img src="plugins/screen-assistant/public/assets/market/icon.svg" width="20" alt=""> **屏幕助手**](plugins/screen-assistant) ✅ | 截图、长截图、区域/全屏录屏、统一媒体库、GIF、贴图与图片工具 |
| [<img src="plugins/tvbox/public/assets/market/icon.svg" width="20" alt=""> **影视仓**](plugins/tvbox) | TVBox 配置源导入：多仓线路、聚合搜索、hls.js 选集播放 |
| [<img src="plugins/wallpaper-wall/public/assets/market/icon.svg" width="20" alt=""> **壁纸社**](plugins/wallpaper-wall) | 15 源壁纸聚合、本地库与轮换，静态/动态壁纸跨三平台，自研引擎与视频性能设置 |

### 🧩 其它（6）

| 插件 | 简介 |
| --- | --- |
| [<img src="plugins/batch-rename/public/assets/market/icon.svg" width="20" alt=""> **批量重命名**](plugins/batch-rename) ✅ | 查找替换/序号/日期规则链实时预览，冲突检测与撤销 |
| [<img src="plugins/lan-share/public/assets/market/icon.svg" width="20" alt=""> **局域网传件**](plugins/lan-share) ✅ | 同一 Wi-Fi 取件码 + 二维码向手机传文件，限时自动关闭 |
| [<img src="plugins/memes/public/assets/market/icon.svg" width="20" alt=""> **表情包**](plugins/memes) | ChineseBQB + 发表情双数据源：分类浏览、关键词搜索、点击即复制（动图保动画）、收藏与本地导入 |
| [<img src="plugins/game-box/public/assets/market/icon.svg" width="20" alt=""> **游戏盒子**](plugins/game-box) | 多数据源游戏库与下载器：分片并发、断点续传，自动解压安装，统一启动与卸载 |
| [<img src="plugins/free-canvas/public/assets/market/icon.svg" width="20" alt=""> **自由画布**](plugins/free-canvas) | 在屏幕上框选区域，摆放自己的时钟、便签、待办、番茄钟、计算器与进程概览 |
| [<img src="plugins/free-desktop/public/assets/market/icon.svg" width="20" alt=""> **自由桌面**](plugins/free-desktop) | 可退出的桌面工作区：文件收纳、便签、时钟与四边程序栏，需在插件内确认后才接管桌面 |

> 未标注 ✅ 的插件（甘特图、AI 生图、媒体浏览、漫画屋、小说屋、影视仓、壁纸社、表情包、游戏盒子、自由画布、自由桌面）已在仓库可用，将随下个 Release 分发。

## 🚀 快速开始

**前置**：[Node.js ≥ 22.12](https://nodejs.org)、eNest 宿主（开发模式运行中）。

```bash
git clone https://github.com/hyqf98/eNest_plugin.git
cd eNest_plugin
npm install
npm run dev --workspace calculator
```

在 eNest 的「开发测试」中选择 `plugins/calculator` 源码文件夹即可加载。开发服务未运行时，壳子会自动执行 `npm run dev` 拉起并管理进程（忘关/退出时自动回收）；端口被占用时自动改用空闲端口。

- 插件内 `F12 / ⌘⌥I / Ctrl+Shift+I` 开关 DevTools，`⌘R` 重载。
- 声明 `development.main` 的插件，端口须与 `package.json` 的 `scripts.dev` 一致，且不与其他插件重复。
- 跨机开发可用 `--host 0.0.0.0` 启动，并把 `development.main` 配成实际 IP、端口与入口路径。
- 可直接选择仓库外的源码文件夹；壳子只读标准入口，不复制源码到已安装目录。

<details>
<summary><b>📁 工程结构</b>（点开展开）</summary>

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

`.enestplugin` 是 ZIP，根目录直接是 `dist/` 的内容，不能再套一层插件目录。源码、测试、`node_modules`、软链接、隐藏路径、Source Map、TS/TSX/Vue 文件不进包（DSH 的固定生产运行时是唯一显式 `runtime/` 例外）。共享工具以 npm workspace `@enest/plugin-kit` 引用，由 Vite 编译进各自发行包；类型由 `@enest/plugin-sdk` 提供。

</details>

## 🤖 AI 开发助手（Skills）

仓库内置 [skills/enest-development](skills/enest-development/SKILL.md)，让 AI 助手（Claude Code、ZCode、Codex 等）按 eNest 契约开发，避免凭通用 Electron 经验乱写。

**配置**：将本仓库克隆到宿主仓库旁边，在 AI 助手的技能目录放一个软链：

```bash
git clone https://github.com/hyqf98/eNest_plugin.git ~/Work/eNest_plugin
ln -s ~/Work/eNest_plugin/skills/enest-development ~/.agents/skills/enest-development
```

技能内的 `references/` 自带完整的官方指南（API 参考、TypeScript 类型、权限、存储、主题等），由同步脚本生成，所以软链或复制到任何技能目录后都能直接读取。技能按任务路由到对应文件：查 `window.enest` 方法与权限 → `references/api.md` 的「方法索引」；改壳窗口/IPC/安全 → `host-development.md`；新建插件 → `getting-started.md` + `structure.md`；UI → `ui-standard.md`；调试白屏/HMR → `debug.md`。类型签名以 `packages/plugin-sdk/index.d.ts` 为准。

**维护文档**：宿主契约指南只在宿主仓库的 `docs/site/plugin/` 修改（它同时是官网网页版），插件仓自有指南改 `docs/developer/` 对应文件；然后在插件仓运行 `npm run docs:sync -- --host-root /path/to/eNest`，`docs/developer/` 与技能 `references/` 一起更新。不要直接改 `references/`，`npm run docs:check` 会把这类改动或陈旧副本判为失败。

**人工开发**同样建议按此顺序入门：[开发入门](docs/developer/getting-started.md) → [工程结构](docs/developer/structure.md) → [manifest 参考](docs/developer/manifest.md) → [UI 标准](docs/developer/ui-standard.md)。

<details>
<summary><b>核心契约速览</b>（技能同款要点）</summary>

- 源码目录 `plugins/<短名>`，目录名与 package.name 等于 manifest.id 末段；完整 `manifest.id` 才是权限、安装与数据归属身份。
- 图标 `icon: assets/market/icon.svg`，详情 `market.readme`，截图在同一包 `assets/market/screenshots/`；发布必须有真实界面截图 1–8 张。
- 页面没有 Node 权限，浏览器原生 API 不是权限失败后的备选通道；`window.enest` 的存储、UI、设置等基础能力直接用，敏感能力声明最小权限并由用户授权。
- 业务放在插件，壳只提供通用能力——不为业务功能新增宿主特判。
- `.enestplugin` 根直接是 dist 内容，文件名 `{短名}@{version}.enestplugin`；源码、测试、`.env`、根 node_modules、软链不进包。

</details>

## ✅ 构建与发布

```bash
npm run validate                  # 源码清单、包名/版本、市场资源
npm test                          # 单元与包格式合同
npm run build                     # 自动发现并构建所有 plugins/*
npm run validate:dist             # 路径边界、入口与离线资源引用
npm run capture:market -- --check # 发行页面：生产 CSP、资源与尺寸检查
npm run test:ui                   # 关键交互流程（隔离 fixture）
npm run pack -- --no-build --platform-variants  # 通用包，以及声明了平台依赖的插件的分平台包
npm run registry                  # 从最终归档生成市场索引
```

首次新增插件还没有截图时，`node scripts/capture-market.mjs <id> --build` 构建预览并生成真实页面截图，随后重新构建纳入发行包。截图使用隔离演示数据，不能替代真实数据库、SSH、系统权限的集成测试。

单个插件快速打包：

```bash
node scripts/build-plugin.mjs <id>
node scripts/pack-plugin.mjs <id>
# 全部打包后生成本地待发布材料（不上传）
REPO=hyqf98/eNest_plugin TAG=plugins-local node scripts/prepare-release.mjs
```

推送 `v*` / `plugins-*` 标签或手动触发已带标签的工作流才创建正式 Release。CI 要求源码校验、全部构建、发行检查、生产 CSP 检查、打包和索引生成全部通过；普通分支推送不触发发布工作流。

`build-registry.mjs` 从最终 ZIP 提取 manifest 与市场资源生成 `dist/registry.json`。发版时，有平台包才生成对应的 `registry-<os>-<arch>.json`；没有原生变体的插件在各索引里复用同一个归档。宿主优先下载本机平台包并校验 SHA-256，旧壳和手动离线安装仍可用通用包。通用包命名 `{id}@{version}.enestplugin`，平台包 `{id}@{version}-{平台}.enestplugin`。

## 🤝 参与贡献

欢迎 Issue / PR。提交前请保证 `validate`、`build`、`validate:dist` 与生成一致性检查（`npm run api:check`、`npm run docs:check`）通过；新插件必须包含 icon、README 与真实截图。完整规范见 [开发文档](docs/README.md)。

## ⚖️ 许可

宿主 eNest 采用 [Apache-2.0](https://github.com/hyqf98/eNest/blob/main/LICENSE) 许可。本仓库自身未附带 LICENSE 文件，各插件的发行说明以其依赖的开源组件许可为准。
