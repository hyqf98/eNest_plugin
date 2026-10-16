# 待办清单 Changelog

> 功能参考 [ZTools-plugins/todos](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.0.0

初始版本。

- 添加待办：输入框回车或「添加」按钮，空文本忽略，自动去除首尾空白
- 勾选完成：自定义圆形勾选框，完成后文字划线置灰
- 行内编辑：双击文本进入编辑，回车保存、Esc 取消、失焦保存
- 置顶：未完成事项可置顶，排序时排在最前并高亮
- 删除：hover 显示删除按钮，二次确认（首点变「确认？」）后删除
- 清已完成：一键清理全部已完成项
- 排序：未完成在前（置顶最前），已完成沉底，各自按创建时间倒序
- 持久化：`storage.local`（键 `todos_v1`）自动保存，启动加载；空列表显示引导
- 进入载荷：`payload` 带 `type: 'text'` 时预填输入框
