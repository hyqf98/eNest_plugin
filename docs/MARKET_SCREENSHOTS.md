# 市场多图素材记录

2026-10-15：宿主详情页直接读取 `market.screenshots`（有序、最多 8 张），支持左右切换、缩略图和放大。保留各插件原有 `01-main.png`，补充以下真实功能视图：

| 插件 | 新增资源 | 来源 |
| --- | --- | --- |
| 剪贴板 | `02-images.webp`、`03-files.webp` | 当前插件构建，分别点击图片/文件筛选；1200×780 |
| 数据库 | `02-table-data.webp`、`03-table-structure.webp` | 当前插件构建，打开 customers 数据表，再切换结构；1280×720 |
| SSH | `02-remote-files.webp` | 当前插件构建，连接隔离演示会话后进入文件工作区；1280×720 |
| 屏幕助手 | `02-annotation.webp` | 复用本轮官网已核验的真实截图标注操作图，1265×791；来源为宿主 `docs/site/assets/screens/screen-assistant.webp` |

前五张通过浏览器实际操作采集后转为 WebP，没有绘制或伪造软件界面。演示数据由临时隔离 fixture 提供，未连接真实服务器、读取个人剪贴板或写入用户文件；这些图片不是远程服务连通性验证。临时浏览器服务不随发行包交付。

修改素材后同步 `plugin.json` 的 `market.screenshots`，执行 `npm run validate` 和对应插件构建。`scripts/capture-market.mjs` 只更新首图，不覆盖本记录的附加视图。发行脚本按清单顺序收集全部截图。旧安装包需更新才会包含新增素材；不要向用户安装目录直接复制文件。
