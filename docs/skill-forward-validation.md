# 开发 skill 正向演练（2026-10-13）

本次按 [eNest 开发 skill](../skills/enest-development/SKILL.md)、开发文档和生成的 SDK，在独立临时仓库从零创建 `com.example.notes`。没有复制官方插件实现，也没有通过宿主源码推测公共接口。临时工程与安装包不作为官方插件提交。

## 结果

演练通过。示例是仅声明 `storage.local` 的 Vanilla JS 便笺，包含 SDK 类型检查、保存/读取、Quick/主窗切换、关闭与休眠前保存、销毁取消订阅、可见的失败提示及草稿保留。资源包括专用笔记图标 SVG、包内 Markdown 和运行界面截图。

源码采用 `plugins/notes/` 标准结构；发布包名为 `notes@0.1.0.enestplugin`。解包后仅有根级 `plugin.json`、`index.html`、`assets/app/*` 与 `assets/market/` 内的图标、README、截图。包内没有 `development` 字段、源码、依赖目录或用户数据。

## 执行方法

在临时仓库仅复制构建工具、文档、SDK、skill 与根工作区配置，再独立编写插件：

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/capture-market.mjs com.example.notes --build
npm run validate
npx tsc --allowJs --checkJs --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --lib ES2022,DOM --skipLibCheck plugins/notes/src/main.js
npm run build -- com.example.notes
node scripts/validate-dist.mjs com.example.notes
node scripts/pack-plugin.mjs com.example.notes --no-build
node scripts/capture-market.mjs com.example.notes --check
```

首次截图用 `capture-market --build` 的开发校验流程；获得真实截图后再填入 manifest 并执行发布校验。开发服务器在**插件目录**通过 `npm run dev -- --host 127.0.0.1 --port 59173 --strictPort` 启动，`development.main` 配置相同地址，验证后停止。

浏览器行为探针连接真实 Vite 服务，注入仓库的预览 API fixture，验证：

- 保存后 SDK storage 读回原文。
- Quick → 主窗 → Quick 双向模式切换，草稿不丢失。
- 480 × 320、150% 字号无横向溢出。
- 模拟持久化拒绝后显示保存失败，保留未保存草稿。
- 六种窗口、模式与字号组合没有页面错误、资源错误、CSP 错误、空白界面或横向溢出。

## 发现与修正

| 发现 | 已落实的修正 |
| --- | --- |
| 双模式文档仍说明复制旧 shared 文件 | 改为工作区 `@enest/plugin-kit` 的实际用法 |
| 保存文件的权限说明仍为 `storage.local` | 改为 `fs.write` 与系统保存对话框 |
| React/Vue 示例把 `onModeChange` 参数写成 `{ mode }` | 对齐 SDK 的字符串参数 `mode` |
| 入门缺少完整 package.json，dev 命令执行目录不明确 | 补充工程配置并说明进入插件目录执行 |
| 预览 fixture 也把模式事件发成 `{ mode }` | 改成 `callback(mode)`；演练使用双向模式断言，避免只测 shell 时被默认分支掩盖 |

演练自己的 JS 模块补了 `export {}` 以便独立 `tsc --checkJs` 按模块检查；这属于示例实现调整。Proxy fixture 的方法需要通过外层包装注入失败，不能靠赋值覆盖嵌套方法。

## 证据边界

本演练记录了当时文档/skill/SDK 用于创建插件、验证发布布局与浏览器 UI 的过程，不是当前版本的验收结论。storage 和失败行为使用 fixture；它不证明真实 Electron 授权、原生文件隔离、退出资源回收或外部 SSH/数据库连接通过。历史宿主验证只能对应当时的构建和场景，不能视为这些原生能力已经在当前版本重新验收。
