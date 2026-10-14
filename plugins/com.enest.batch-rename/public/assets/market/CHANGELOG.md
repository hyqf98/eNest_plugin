# 批量重命名 Changelog

> 功能参考 [ZTools-plugins/batch-rename](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

- 初始版本
- 队列：拖入 / 选择多文件（`localFiles.fromDrop` 句柄白名单；展示名称 / 扩展名 / 大小 / 序号）
- 规则链（多条叠加、按序应用、拖拽排序）：查找替换（大小写开关 / 正则开关 + 错误提示）、序号（起始 / 步进 / 位数 / 前缀后缀 / 分隔符 / 保留原名）、日期（原文件 mtime 或当前时间，格式模板 YYYYMMDD-HHmmss）、大小写转换（大写 / 小写 / 首字母）、扩展名替换
- 实时预览表：原名 → 新名（--mono 并排），非法名 / 冲突红色行内标注；存在异常行时禁止执行
- 执行：危险确认对话框（列出 n 个变更）→ `fs.renameBatch({ items, confirmed: true })`；结果报告（成功 / 失败明细）
- 撤销：storage 存映射，反向 renameBatch（confirmed）；文件已被移动时逐项报告
- Quick = 窄栏（文件列表 + 单规则 + 预览）；桌面 = 上队列 / 中规则链 / 下预览表；容器查询 ≤740px 单列
