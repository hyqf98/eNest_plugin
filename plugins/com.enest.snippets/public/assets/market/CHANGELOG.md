# 代码片段 Changelog

> 功能参考 [ZTools-plugins/snippets](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.1.0

- 详情代码块折叠：缩进驱动的行级折叠（自动并入同缩进收尾 `}` 行），行号 + 折叠箭头 + 内联省略（含行数）；「全部折叠 / 全部展开」快捷操作；折叠状态跟随片段
- 高亮增强：按行高亮渲染（跨行模板字符串 / 块注释正确分段）；新增 SQL 语言 scope（`--` 注释 + 关键字）；补充 TypeScript 关键字（satisfies / keyof / declare 等）
- 侧栏「分组 / 片段」分区可折叠，开合状态本地记忆
- 超过 1500 行的长片段自动降级为仅高亮不可折叠
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
