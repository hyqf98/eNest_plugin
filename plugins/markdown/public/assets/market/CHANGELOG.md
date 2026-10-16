# Markdown 笔记 Changelog

> 功能参考 [ZTools-plugins/markdown](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

初始版本。

- 笔记树：分组（文件夹）+ 笔记，新建 / 右键重命名分组 / 右键移动笔记 / 删除（二次确认）
- 内容存 `storage.local`；粘贴或工具条按钮插入的图片走 `storage.blobs` 附件（PNG/JPEG/WebP，dataURL 渲染）
- 编辑器：等宽 textarea + 工具条（加粗 / 斜体 / 标题 / 有序无序列表 / 代码块 / 表格 / 行内代码 / 任务清单 / 图片附件）
- 自研轻量 Markdown 渲染：标题 / 粗斜删除线 / 行内码 / 围栏代码块（surface-2 底等宽）/ 引用 / 有序无序列表 / 任务清单 / 链接 / 图片 / 表格 / 分隔线 / 自动链接
- 实时预览：桌面双栏（可切换）；Quick 单栏隐藏预览
- 全文搜索：标题 + 内容，命中 `<mark>` 高亮与摘要
- 自动保存：防抖 800ms，未保存标记，`onBeforeClose` flush
- 模板：会议记录 / 周报 / 待办（编辑器内 F2 呼出）
- 导出：`.md` 与 `.html`（`shell.saveTextFile`，权限 `storage.local`）
- 收件箱：Quick 模式输入速记回车即落「收件箱」分组；`code=inbox` + payload 文本进入同样生效；⌘Enter 固定主窗继续编辑
- contributes.homeCards：最近笔记入口卡片
