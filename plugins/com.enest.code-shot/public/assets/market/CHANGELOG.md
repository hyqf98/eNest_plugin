# 代码截图 Changelog

> 功能参考 [ZTools-plugins](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）同类「代码美图」工具；
> 高亮方案：仓库 node_modules（主仓与插件仓）均无 shiki / highlight.js，按约定采用**自研轻量 tokenizer**（本仓 `assets/js/code-core.js`，无第三方依赖、无 vendored 代码，无外部 License 义务）。

## 1.0.0

- 初始版本
- 输入：等宽 textarea + 行号栏实时同步；语言下拉 12 项（JS/TS/JSON/Python/Java/Go/Rust/CSS/HTML/SQL/Bash/纯文本）
- 自动识别语言：扩展名映射 + 关键字/结构启发式计分（`#`/shebang → Bash、`def`/`elif` → Python、`:` 类型标注 → TS、`fn`/`->` → Rust、`:=` → Go 等），识别结果显示在工具栏
- 高亮：自研 tokenizer，四类着色（关键字 / 字符串 / 注释 / 数字），逐行处理含转义与反引号模板串，HTML 特化标签与属性着色
- 主题：跟随 eNest 明暗（`theme.getTokens()` + `ui.onThemeChange`），语法色板从 `--accent` / `--ok` / `--link` / `--text-2` / `--surface` / `--border-strong` token 派生，不引入新色相；主题切换自动重绘
- 画布：canvas 等宽逐字测量排版（charWidth = fontSize × 0.62），长行自动断行，行号栏宽度随位数收缩；窗口栏 mac 三点（中性圆点，不用红黄绿）、标题居中；背景三态（主题面 / 纯色 / 透明），padding / 圆角 / 阴影 / 字号滑杆可调，宽度自适应最长行
- 导出：复制到剪贴板（`clipboard.writeImage(dataUrl)`）、保存 PNG（`shell.saveFile`）、2x 高清导出（canvas 内部 2x devicePixelRatio 渲染）；⌘/Ctrl+Enter 快捷复制
- 记忆：全部画布配置 + 代码草稿存 `storage.local`（`codeshot_config_v1`），重开恢复
- Quick：粘贴即出预览，`ui.setHeight` 随内容自适应；桌面：左编辑 / 中预览 / 右设置三栏，容器查询 ≤740px 单列
- 权限最小集：`clipboard.writeImage` / `storage.local` / `ui.setTitle` / `ui.toast` / `ui.resize`
