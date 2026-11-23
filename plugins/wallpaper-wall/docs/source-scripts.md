# 源脚本接口

源脚本用于给壁纸社增加新的数据源。脚本由用户在设置页从本地文件或 URL 导入，保存在插件私有目录，由后端在 `node:vm` 上下文运行。

> `node:vm` 只隔离误用，不是安全沙箱。源脚本是用户信任代码；不要安装来源不明的脚本。

## 最小示例

```js
module.exports = {
  id: 'my-wallpapers',
  name: 'My Wallpapers',
  version: '1.0.0',
  description: 'A small JSON wallpaper source',
  mediaTypes: ['image'],
  requiresKey: false,
  facets: {
    items: [
      {
        key: 'sort',
        label: 'Sort',
        type: 'select',
        default: 'latest',
        options: [
          { value: 'latest', label: 'Latest' },
          { value: 'popular', label: 'Popular' },
        ],
      },
    ],
  },
  async search(query, context) {
    const page = query.page || 1
    const sort = query.filters?.sort || 'latest'
    const payload = await context.http.getJson(
      context.utils.buildUrl('https://example.com/api/wallpapers', { page, sort }),
    )
    return {
      page,
      hasMore: Boolean(payload.next),
      items: payload.items.map((entry) => ({
        remoteId: String(entry.id),
        title: entry.title,
        mediaType: 'image',
        thumbUrl: entry.thumb,
        previewUrl: entry.preview || entry.thumb,
        fullUrl: entry.full,
        width: entry.width,
        height: entry.height,
        author: entry.author,
        license: entry.license,
        sourceUrl: entry.page,
        attribution: `${entry.author} / ${entry.license}`,
        downloadAllowed: true,
        exportAllowed: true,
      })),
    }
  },
}
```

## 导出字段

| 字段 | 说明 |
| --- | --- |
| `id` | 必填，2–80 字符，只允许字母、数字、点、下划线、短横线；不能与内置源或已安装脚本重复 |
| `name` | 必填，显示名 |
| `version` | 可选，默认 `1.0.0` |
| `description` | 可选 |
| `mediaTypes` | `image` / `video` / `gif` / `web` 的子集 |
| `requiresKey` / `keyLabel` / `keyUrl` | 是否需要 API Key 及设置页提示；Key 由宿主密钥库保存，脚本只通过 `context.key` 得到明文 |
| `facets` | 过滤描述符，UI 会按 `select` / `multi` / `range` / `color` / `toggle` / `sort` 动态渲染 |
| `search(query, context)` | 必填，返回 `{ items, page, hasMore, total? }` |
| `detail(remoteId, context)` | 可选 |
| `resolve(item, context)` | 可选，返回 `{ url }`；用于下载前追加签名/Key |

## 上下文

- `context.key`：当前源的 API Key，未配置时为 `null`。
- `context.signal`：取消信号。
- `context.http.getJson(url, headers?)` / `context.http.getText(url, headers?)`：只允许 http(s)，受超时、体积和代理约束。
- `context.parseHtml(html)`：linkedom 文档，可 `querySelectorAll`。
- `context.utils.buildUrl` / `stripHtml` / `decodeEntities` / `absoluteUrl`。
- `context.log(message)`：写入插件诊断日志，不要输出密钥。

## 条目字段

至少提供 `remoteId`、`thumbUrl`、`fullUrl`。推荐同时提供 `title`、`mediaType`、`previewUrl`、`width`、`height`、`author`、`license`、`sourceUrl`、`attribution`、`downloadAllowed`、`exportAllowed`。

- URL 必须是 http(s)；脚本返回 `file:`/`javascript:` 会被拒绝。
- `downloadAllowed:false` 的条目不能下载。
- `exportAllowed:false` 的条目仍可设为本地壁纸，但 UI 不提供导出。
- 所有图片/视频内容由后端下载到用户选择的本地库；页面不会永久热链第三方资源。

## 限制

- 单脚本最多 2MB；搜索/详情超时 25 秒；单页最多 60 条。
- 不提供 `require`、`process`、`fs` 或任意网络 socket；只能使用上述 facade。
- 源站条款、版权与反爬限制由脚本作者和用户自行承担；插件默认不内置抓取站脚本。
