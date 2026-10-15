# 插件图标与壳离线快照

插件图标的权威源为 `plugins/<id>/public/assets/market/icon.svg`。构建后复制到插件发行包的 `assets/market/icon.svg`，manifest 路径保持不变。

图标须自带足够对比度，不能依赖宿主当前主题。工具图标使用各自功能配色的圆角底板与白色图形：备忘录为金黄、时间戳为蓝、番茄钟为珊瑚红、待办为绿。32 × 32 图标的图形保留约 20% 内边距，在 24 / 48 px 和浅深主题下都要可辨认。不要为所有工具统一添加黑色底板；已有独立品牌图形保留自身配色。

壳使用全部 `com.enest.*` 官方插件真实 SVG 的静态快照，运行时不读取或依赖插件仓库。离线市场与旧图标兼容共享同一份素材，未知插件仍显示自己的图标或通用占位图。

修改图标或离线市场名单后，在插件仓库执行：

```bash
node scripts/sync-shell-plugin-icons.mjs --host-root /path/to/eNest
node scripts/sync-shell-plugin-icons.mjs --host-root /path/to/eNest --check
npm run validate
npm run build -- <受影响的插件ID>
```

同步命令只生成宿主 `src/shared/builtinPluginIcons.ts`，供 main 和 renderer 共用；`--check` 为只读一致性校验。宿主快照与插件源码应一起提交。现有安装包的文件不会被此命令覆盖，新图标随插件更新分发。

旧版 24 个工具的深色与透明 SVG 签名保存在 `scripts/legacy-plugin-icons.json`。SHA256 输入是 UTF-8 SVG 去除首尾空白及标签之间空白后的内容；不要以新图标重新生成旧签名。宿主 `enest://` 协议在完成文件路径校验后，仅为内容匹配这些签名的默认 `icon.svg` / `assets/market/icon.svg` 返回新素材，保留包内原文件及缓存/HEAD语义。自定义 SVG、第三方图标、运行时 `ui.setIcon` glyph 均不会被替换。

旧远程市场无需额外下载图标：宿主只对官方 `hyqf98/eNest_plugin` GitHub raw / Release 默认图标路径启用快照，且插件版本不得超过 `throughVersion`。其它 origin、自定义路径、带查询参数的 URL、未来版本均保持原图。未来插件更新使用新的素材和版本正常发布，不要提高此兼容版本上限。
