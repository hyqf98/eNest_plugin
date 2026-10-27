# 插件图标与浏览器预览夹具

插件图标的权威源为 `plugins/<短名>/public/assets/market/icon.svg`，其中短名为完整插件 ID 的末段。构建后复制到插件发行包的 `assets/market/icon.svg`，manifest 路径保持不变。

图标须自带足够对比度，不能依赖宿主当前主题。工具图标使用各自功能配色的圆角底板与白色图形：备忘录为金黄、时间戳为蓝、番茄钟为珊瑚红、待办为绿。32 × 32 图标的图形保留约 20% 内边距，在 24 / 48 px 和浅深主题下都要可辨认。不要为所有工具统一添加黑色底板；已有独立品牌图形保留自身配色。

宿主的 DEV 浏览器预览使用插件真实 SVG 的静态夹具，便于未启动 Electron 时展示示例目录。夹具只服务浏览器预览，不是生产 main/shared 模块，也不是正式市场的离线回退数据。

正式应用按插件声明读取图标或显示通用占位图，不按官方插件 ID、旧 SVG 签名或 GitHub URL 替换图标。插件图标更新通过插件自身的发布包或市场资源分发，宿主生产代码不依赖此快照或插件仓库源码。

修改图标或浏览器预览名单后，在插件仓库执行：

```bash
node scripts/sync-shell-plugin-icons.mjs --host-root /path/to/eNest
node scripts/sync-shell-plugin-icons.mjs --host-root /path/to/eNest --check
npm run validate
npm run build -- <受影响的插件短名>
```

同步命令只生成宿主 `tests/fixtures/browser-preview/builtinPluginIcons.ts`，不得再写回 `src/`。预览入口只能在 DEV 分支加载该夹具；main、preload 和生产 renderer 均不得导入。`--check` 是只读的一致性校验，不会改写图标或夹具；校验失败时先确认图标源变更，再决定是否重新生成。宿主预览夹具与插件图标源码应一起提交，现有插件安装包不会被此命令覆盖。
