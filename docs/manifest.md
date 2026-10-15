# plugin.json 参考

权威校验是 [plugin-manifest.schema.json](plugin-manifest.schema.json)。宿主类型与权限表由 API 类型生成流程同步；本文介绍最常用字段和行为，完整能力见 [API](developer/api.md)。

## 最小清单

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "1.0.0",
  "description": "一个标准 eNest 插件",
  "main": "index.html",
  "icon": "assets/market/icon.svg",
  "category": "效率",
  "permissions": [],
  "features": [{ "code": "main", "explain": "打开工具", "cmds": ["hello"] }],
  "ui": { "chrome": "none", "themeAware": true },
  "market": {
    "readme": "assets/market/README.md",
    "screenshots": ["assets/market/screenshots/01-main.png"]
  },
  "development": { "main": "http://127.0.0.1:5173/" }
}
```

生产构建删除 `development`，其余媒体路径在发行包内必须真实存在。不要添加 `logo`、根 `settings` 或其它未定义顶层字段；Schema 会拒绝未知字段。

## 字段

| 字段 | 约束与含义 |
| --- | --- |
| `id` | 必填反向域名，匹配 `^[a-z0-9]+(\.[a-z0-9-]+)+$`，等于源码文件夹与 package 名；enest.builtin 为宿主保留标识 |
| `name` | 必填非空显示名 |
| `version` | 必填 semver，必须与 package.json 一致 |
| `description` | 必填一句话功能说明，最长 200 字符 |
| `main` | 必填，固定 `index.html` |
| `icon` | 必填，固定 `assets/market/icon.svg` |
| `market` | 必填 `readme` 与 `screenshots`；可选 `tags`、`featured` |
| `author`、`homepage` | 作者与项目主页 |
| `category` | 效率 / 开发 / 设计 / 媒体 / 其它 |
| `engines.enest` | 宿主版本范围，支持 `*`、`^x.y.z`、`>=x.y.z` 或精确版本 |
| `permissions` | 本插件使用的敏感能力；基础存储/UI/设置/主题无需声明，分类见 plugin-permission-policy.json |
| `features` | `{code,cmds,explain?}` 数组；入口 code 由 `onEnter` 接收 |
| `window` | 兼容旧插件的尺寸建议；Quick 插件态外框固定 720×545px，屏幕不足时缩小；主窗口由用户控制 |
| `development.main` | 源码开发 HTTP(S) URL，不含凭据、fragment；发行包中禁止 |
| `ui` | 是否跟随主题、背景与宿主 chrome |
| `net` | `allowInsecure` 声明；仍受实际网络权限与宿主校验约束 |
| `contributes` | 设置、首页入口、轨道入口和主题等声明式扩展 |

`market.readme` 固定 `assets/market/README.md`，最大 512 KiB。截图固定在 `assets/market/screenshots/`，允许中文和空格，扩展名为 png/jpg/jpeg/webp（不区分大小写）。首次源码初始化可为空，正式构建/打包必须 1–8 张且不重复。源码的实际文件在 `public/` 下，完整路径规则见 [工程结构](PLUGIN_STRUCTURE.md)。

## 指令与大小窗

`features[].cmds` 可以是名称字符串、`regex` 内容匹配或 `over` 文本处理：

```json
{
  "code": "format",
  "explain": "格式化输入内容",
  "cmds": [
    "格式化",
    { "type": "regex", "label": "处理 JSON", "match": "/^\\s*[\\[{]/", "minLength": 2 },
    { "type": "over", "label": "处理文本", "minLength": 1, "maxLength": 10000 }
  ]
}
```

插件通过 `enest.onEnter` 处理 `code`、`payload` 与 `mode`，通过 `getLaunchMode` / `onModeChange` 区分 `quick` 与 `shell`。容器迁移不应重建会丢数据的业务状态。Quick 宽度由宿主与可用工作区确定；`window.width/minWidth` 不应作为插件布局的硬约束。详见 [UI Standard](developer/ui-standard.md) 与 [生命周期](developer/lifecycle.md)。

## 权限与隔离

页面运行在宿主隔离环境，没有 Node/Electron 权限。外部资源只能通过 `window.enest` 的受控能力访问；权限未声明、未授权、已撤销或选择器取消时，插件必须处理失败。

| 能力 | 权限 |
| --- | --- |
| 剪贴板 | `clipboard.read`、`clipboard.write`、`clipboard.readImage`、`clipboard.writeImage`、`clipboard.history`、`clipboard.paste` |
| 截屏、录制、贴图 | `screen.capture`、`screen.record`、`pin.create` |
| 网络 | `net.fetch`、`net.socket`、`lan.share` |
| 用户文件 | `fs.read`、`fs.write`、`fs.rename` |
| 系统进程 | `sys.inspect`（读取）、`sys.control`（操作） |
| AI CLI 配置 | `config.agent.read`、`config.agent.write` |
| SSH | `ssh.session`、`ssh.exec`、`ssh.sftp`、`ssh.agent` |
| 数据库、中间件 | `db.connect`、`db.query`、`db.schema`、`mw.connect`、`mw.query`、`mw.admin` |
| DSH | `dsh.connect`、`dsh.chat`、`dsh.admin` |
| 数据与密钥 | `storage.local`、`vault.write` |
| 壳内界面 | `ui.setTitle`、`ui.setIcon`、`ui.setBadge`、`ui.resize`、`ui.toast` |
| 设置与扩展 | `settings.register`、`settings.page`、`contribute`、`theme` |
| 其它 | `shell.openExternal`、`notify`、`hotkey`、`timer.background` |

本表不把权限声明视为自动授权。文件权限之外还必须通过宿主选择器拿到用途匹配的句柄；不能把 SQLite 路径、SSH 私钥路径、SFTP 本地路径或 SSH Agent socket 任意传给底层服务。插件持久数据使用 `enest.storage`，不手工操作 `~/.eNest`。详细合同见 [permissions.md](developer/permissions.md)。

`net.allowInsecure: true` 声明插件确实需要明文 HTTP / WebSocket，宿主仍校验目标与权限。DSH 的本机嵌入由宿主在真实会话授权后放行指定服务地址；清单不能自行放宽任意 localhost 来源。

## UI 与主题插件

`ui` 默认相当于 `chrome: "none"`、`themeAware: true`、`background: "opaque"`、`preferredColorScheme: "auto"`。`minimal` 请求宿主细条；弃用值 `default` 等价于 none。插件使用宿主注入的 token 和字体，不能在切换主题时保留不适配的固定背景。

主题插件同样遵守工程与发行结构，声明 `theme` 权限，通过 `contributes.themePacks` 提供安装即可发现的主题，或通过 `enest.theme.register(pack)` 动态注册。主题的 source 由宿主绑定插件 ID；不应直接修改宿主 DOM 或设置文件。参考 `com.enest.theme-demo` 与 [主题开发](developer/themes.md)。

## contributes

| 字段 | 用途 |
| --- | --- |
| `settings` | 设置分组，含 `id/title/items`；值由宿主保存 |
| `homeCards` | 首页扩展入口，点击后进入该插件的 `openCode` |
| `railEntries` | orb 轨道入口 |
| `themePacks` | 声明式主题包 |
| `quickProviders` | 保留字段；搜索 provider 使用运行时 `enest.contribute.registerQuickProvider` |

设置项支持 text/string、switch/boolean/bool、select、number、slider、color、page。select 提供 options，slider 提供 min/max/step；page 使用 `entry: {code,payload?}` 打开本插件的设置功能，不另建根 `settings.html` 入口。综合插件可以使用一个 HTML 页面下的多 feature code，把工作区、设置、连接等分成模块，避免绕开标准入口。
