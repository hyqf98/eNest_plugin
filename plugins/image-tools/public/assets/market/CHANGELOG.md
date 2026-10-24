# 图片工具箱 Changelog

> 功能参考 [ZTools-plugins/image-helper](https://github.com/ZToolsCenter/ZTools-plugins)（MIT, ZToolsCenter）

## 1.2.0（2026-10-24）

- 贴图预览改由插件共享的 `@enest/native-surfaces` 渲染，不再依赖已移除的宿主 `pin.*` 业务接口。
- 构建同时包含受限辅助页资源；图片编辑、导出与队列交互不变，需要 eNest >= 0.2.3。

## 1.0.0

- 初始版本
- 入口三通道：点击添加（`<input type="file">` + FileReader 读内容；宿主可用时经 `localFiles.pick` 走授权选择器语义）、拖拽（`localFiles.fromDrop` 记录句柄，内容从 `dataTransfer.files` 直读——宿主句柄无内容读取 API，见 api 确认）、剪贴板（`clipboard.readImage`）
- 队列视图：1:1 缩略图网格 + 名称 / 原始尺寸 / 体积 / 格式角标两行等高信息，单选进入操作面板；原图经 `storage.blobs` 存储并跨会话恢复
- 压缩：目标体积滑杆（二分质量迭代逼近，canvas toBlob JPEG/WebP）或固定质量滑杆；输出对比条（前后体积 / 压缩率徽章 `--ok` / 质量回显）
- 格式转换 PNG / JPEG / WebP；批量缩放（最长边 / 百分比，预览目标尺寸）；裁剪（预览图框选，含旋转/翻转后的坐标系映射）；旋转 90° 步进与水平/垂直翻转
- 文字水印：内容 / 九宫格位置 / 透明度 / 字号，可叠加预览后写入
- EXIF：自研轻量 JPEG APP1 解析器（相机 / 时间 / GPS / 方向 / 光圈快门 ISO 焦距），一键「清除元数据导出」（重绘像素剥离全部元数据）
- 色板提取：中位切分法取 6 主色，点击复制 HEX，展示占比
- 导出：单张 `shell.saveFile`、队列逐张另存；`pin.open` 贴图预览
- 批量压缩 / 批量转 WebP 直接追加新条目进队列，保留原图
- Quick：粘贴即压缩（目标体积与格式来自设置），`ui.setHeight` 自适应高度
- 桌面：队列 + 操作面板双栏，容器查询 ≤740px 退化为单列
- 权限最小集：`pin.create` / `clipboard.readImage` / `storage.local` / `ui.setTitle` / `ui.toast` / `ui.resize`
