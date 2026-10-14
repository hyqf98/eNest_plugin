# 文本对比 Changelog

> 功能参考 [ZTools-plugins](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）中的文本对比类插件，结合本壳子 API 自研实现。

## 1.0.0 首版

- 双栏源/目标等宽 textarea，实时 LCS 行级对比；差异块以 `--ok-soft`（增）/ `--danger-soft`（删）底色标注，双侧行号对齐。
- 行内字符级细化（可开关）：change 块内逐字符 `<del>/<ins>` 标注，字符级 LCS 上限保护。
- 差异导航：↑/↓ 按钮或 ⌘/Ctrl+↑/⌘/Ctrl+↓（编辑器聚焦时不拦截），当前差异块描边高亮并滚动居中。
- 差异计数徽章：顶部 `+n −n` 双色胶囊（tabular-nums）。
- 选项：忽略空白 / 忽略大小写 / 行内模式，aria-pressed 状态按钮。
- hex 模式（⌘/Ctrl+Shift+H 或双击"行级"标签切换，偏好持久化）：两段输入按字节 hex dump 三列对比（偏移 / 十六进制 / 可打印列），逐行比对底色。
- 结果导出：一键复制标准 unified diff（`--- / +++ / @@ -a,b +c,d @@`，context=3，远距修改自动拆分 hunk）。
- 文件拖入：任意一侧可拖入本地文件（≤2MB，DOM File API 读取，无路径访问，不需要额外权限）；粘贴按钮走 `clipboard.read`。
- 双形态：Quick 两栏粘贴即比（行内选项折叠、行号收窄、高度自适应 `ui.setHeight`）；桌面全量选项栏 + 结果区。
- 权限最小化：`clipboard.write`（复制 diff）、`clipboard.read`（粘贴按钮）、`ui.toast`、`ui.resize`。未使用 localFiles（handle 无内容读取通道）。
- 核心纯逻辑（LCS 行 diff / 字符 diff / unified diff / hex dump）在 `tests/core.test.mjs` 覆盖自测。
