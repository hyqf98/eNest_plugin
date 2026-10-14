# 代码片段 Changelog

> 功能参考 [ZTools-plugins/snippets](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

初始版本。

- 片段库：标题 / 语言（语法标签着色）/ 标签 / 内容，搜索框即时过滤（标题 + 内容 + 标签）
- 详情区：等宽展示 + 一键复制（`clipboard.write`）
- `${var}` 占位符模板：复制时弹轻量表单逐个填值后再复制，缺失变量保留原样
- Quick provider：`contribute.registerQuickProvider` + `onQuickQuery/respondQuickQuery`，Quick 搜索条直接搜片段，回车即复制并 toast
- 新建 / 编辑 / 删除（危险二次确认）
- 导入导出 JSON（`shell.saveTextFile` 导出 / 文件选择或粘贴导入）
- 使用计数与最近复制排序（useCount → lastUsedAt → updatedAt）
- 全局热键（`hotkey.register`，默认不占用，用户在设置中填写 accelerator 后生效）
- 双形态：Quick 搜索 + 列表 + 回车复制即走（`ui.setHeight` 自适应）；桌面左侧列表 + 右侧详情/编辑双栏
- 安全说明：片段内容明文存 `storage.local`（仅代码场景，无敏感承诺）
