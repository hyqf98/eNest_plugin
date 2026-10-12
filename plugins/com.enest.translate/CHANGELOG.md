# 翻译 Changelog

> 功能参考 [ZTools-plugins/quick-translate](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.2.0

UI 精致化重做 + 双形态响应式（功能逻辑不变）：

- **形态**：`form: "mini"` 复核（Quick 呼出面板优先）；新增 `ui.resize` 权限，Quick 内嵌时按内容高度自适应（ResizeObserver → `enest.ui.resize` 上报，首屏约 400px，上限 640px）。
- **双形态响应式**：容器查询（`@container`，viewport 兜底）分两档 —— 窄容器（≤740px，Quick 小窗）紧凑上下双栏、字号收敛、间距 12px；宽容器（>740px，⌘Enter 固定主窗）左右双栏舒展；≥900px 再放大排印（译文 19px）与留白。
- **排印**：译文区 16→19px / 行高 1.65，与源文（14px）拉开层级；语言码、检测信息、引擎标签用等宽字体；字符计数 tabular-nums。
- **色彩**：中性色全量跟随壳子 themeAware Token（本地回退值与暗色预设一致）；琥珀 #f5a524 独立为 `--brand`，仅用于主 CTA、引擎标签与聚焦反馈（避免被壳子 `--accent` 覆盖）；无纯黑、无装饰渐变。
- **组件**：语言选择 + 圆形交换钮一行对称排布（hover 图标 180° 旋转）；引擎下拉收进 header 右侧（自绘 chevron，去原生外观）；卡片 10–12px 圆角 + 1px 半透明描边 + 内高光；输入区聚焦描边亮起 + 4px 低透明度外发光。
- **微交互**：翻译中占位文本呼吸透明度动画；复制成功按钮短暂变 ✓（ok 绿）；按钮 hover/active 三态（140–180ms 自定义 ease）；hover 显现的清空 / 粘贴行内工具钮。
- **交互补充**：Enter 立即翻译 / Shift+Enter 换行（IME 组词期不误触发）；复制钮随有无译文启停；粘贴 / 清空从底部文字钮改为输入区行内图标钮。
- 图标全量换内联 SVG（stroke 1.5px，14/16px 规格），滚动条细化（6px、半透明）。

## 1.1.0

- 多引擎翻译：新增 MyMemory 引擎（Google gtx 失败时自动切换），网络请求统一走 `api.net.fetch`（主进程代理，timeoutMs 8000）。
- 引擎调度：顶部新增引擎下拉（自动 / Google / MyMemory），偏好持久化到 settings key `engine`。
  - 自动模式：源语言为「自动检测」时先走 Google（顺带获取检测语言）；Google 失败后用已检出语言（或已选定的源语言）跑 MyMemory；检测也不可用时 toast 提示手动选择源语言，并按目标方向合理猜测（目标为中文猜 en，否则猜 zh-CN）再尝试一次 MyMemory。
  - 锁定引擎：失败直接 toast 错误，译文区提示「可切换引擎重试」。
  - 切换引擎后自动用当前输入重跑。
- 修复交换语言在 auto 模式下自赋值无效的 bug：检测出语言时先把检测语言填入源下拉再交换；未翻译过则 toast 提示「自动检测时需先翻译一次」，不执行交换。
- 译文区新增当前实际使用引擎的小标签；header 检测信息同步展示。
- 保留：防抖即时翻译（500ms）、粘贴、复制译文、语言偏好持久化（`srcLang` / `tgtLang`）。
