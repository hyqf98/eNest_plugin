# 游戏盒子子代理共享简报

所有子代理开工前必读。这里的事实都已核实过，直接使用，不要重新探索、不要改动已冻结的文件。

## 位置

- 插件根目录：`D:\dev\eNest_plugin\plugins\game-box`（下称 `$P`）
- 母版参考（只读，不要改）：`D:\dev\eNest_plugin\plugins\wallpaper-house`、`D:\dev\eNest_plugin\plugins\tvbox`
- 源项目（只读，要复刻的行为来源）：`D:\dev\easy_gamebox`
- Node 22.20，包管理用仓库根的 npm workspace；依赖已装好，**不要再运行 npm install**

## 冻结文件（不要修改；需要新字段先在回复里提出）

- `$P/src/shared/contracts.ts`：全部 DTO、`METHODS` 方法名、`EVENTS` 事件名、默认值、状态标签
- `$P/backend/contracts.ts`：只是上面的转发行
- `$P/backend/adapters/types.ts`：适配层接口 `Adapter`（request / openStream / proxyFor / path / files / archive / processes）与 `BackendError`、`fail()`
- `$P/backend/runtime.ts`：`requestHost / postEvent / onShutdown / acquireActivity / trackProcess / storageGet / storageSet / resolveSecret / resolveFileHandle / confirmWithUser / resolveProxy / logMessage / currentScope / isClosing`
- `$P/backend/util.ts`：`errorMessage / asRecord / text / requireString / optionalString / parseSize / formatSize / formatSpeed / formatEta / stripHtml / createThrottle / KeyedMutex / Semaphore / sleep / abortError / newId`
- `$P/backend/store.ts`：`loadSettings / saveSettings`、`loadItems / saveItems / upsertItem / removeItem`（`StoredItem`）、`loadTasks / saveTasks`（`StoredTask` / `StoredTaskFile`）、`loadAuthMeta / saveAuthMeta`（`AuthMeta`）、`flushStore`
- `$P/backend/paths.ts`：`sanitizeSegment / splitName / isInstallableArchive / classifyArchive / pickMainVolumes / continuationNames / planInstallUnits`
- `$P/backend/adapters/mock.ts`：模拟适配层 `createMockAdapter()`，单测用
- `$P/backend/adapters/live.ts`：真实适配层 `createLiveAdapter()`、`setPackagePath()`、`locateSevenZip()`、`requestText()`
- `$P/src/js/api.ts`：前端桥接层（`call / onBackendEvent / library / media / share / tasks / auth / panSou / host`）
- `$P/src/js/state.tsx`：`AppProvider / useApp()`，全局状态
- `$P/src/js/media.ts`：`useMedia(token)` 把 media token 换成可显示地址
- `$P/src/components/Glyph.tsx`：`Glyph` 与 `NAV_ICONS`
- `$P/src/App.tsx`：外壳与栏目路由
- `$P/src/ui/`：官方 UI 模板副本，**逐字节不可改**（`npm run ui:check` 会比对）
- `$P/plugin.json`、`package.json`、各 tsconfig

## 后端适配层选择规则

业务模块**不要自己 import 具体的 mock 或 live 适配层**，而是从一个可注入的入口取：

```ts
import { getAdapter } from '@backend/adapters/current'
```

`$P/backend/adapters/current.ts` 由协调者提供：

```ts
export function getAdapter(): Adapter            // 当前适配层
export function setAdapter(adapter: Adapter): void // 单测注入 mock
```

`setPackagePath()` 在 `index.ts` 的 init 里已调用，解压模块通过 `getAdapter().archive` 使用。

## 后端约束（来自宿主契约，违反会导致后端被杀）

- `backend.call` 默认 30 秒超时，**超时会终止整个后端**。任何可能超过几秒的工作（下载、解压、登录轮询、拉取大列表）必须：立刻返回 → 后台执行 → 用 `postEvent` 推进度。
- 后台任务期间要 `const release = await acquireActivity('原因')`，结束时 `await release()`，否则实例三分钟后可能被回收。
- 关闭时只有约 900ms：`onShutdown` 里只做「保存状态、中止连接」，不要等待长任务。
- 启动的子进程（7z）要 `trackProcess(pid)`，退出后 `untrackProcess(pid)`。
- 存储只能用 `store.ts` 封装的宿主 KV；单值上限 512 KiB，所以任务记录不要存大对象。
- 凭据（会话、密码、令牌）只能经 `vault`（页面写）与 `resolveSecret`（后端读），**不得**写进 KV、日志、错误消息、事件。
- 日志用 `logMessage('info'|'warn', source, message)`，不含 cookie、提取码、令牌。
- TS 目标 ES2022、`strict`、`verbatimModuleSyntax`（类型导入必须写 `import type`）、`noUnusedLocals`。别名 `@backend/*` 指向 `backend/`。

## 前端约束

- React 18 + TSX，`strict`、`noUnusedLocals`。样式类名前缀 `gh-`，颜色/圆角/间距只读主题 CSS 变量（`--text`、`--surface`、`--accent`、`--accent-soft`、`--ok`、`--danger`、`--warn` 及其 `-soft` 变体、`--gh-gap`、`--gh-radius`、`--gh-card-radius`、`--gh-ctl-radius`、`--gh-row`）。
- **用户硬要求：所有样式宽高对齐占满，不要留过多空白；明暗主题切换不能出问题。** 视图根节点撑满 `.gh-view`，网格铺满宽度。
- 控件用 `$P/src/ui`（`Button / Input / Switch / Segmented / Select / Tooltip / Dialog* / Slider / Checkbox / MoreMenu`）与 `@/components/base`（`Card / Spinner / Empty / ErrorBar / Progress / StatusBadge / SkeletonGrid / Cover`）。不手写控件样式。
- 图标只用 `@phosphor-icons/react` 的具名组件，权重固定 `regular`，通过 `Glyph` 渲染；不手绘 SVG、不用 emoji。可用图标名已验证：`Desktop GameController Package Wrench PuzzlePiece MagnifyingGlass Heart DownloadSimple GearSix Play Stop Trash Pause ArrowClockwise FolderOpen FolderSimple X Check Warning Info QrCode Link Cloud CloudArrowDown FileZip Password Eye EyeSlash Star ArrowLeft ArrowRight CaretLeft CaretRight CaretDown Plus Spinner CircleNotch Clock HardDrive Download PauseCircle PlayCircle StopCircle ArrowSquareOut Copy DotsThree Lightning SlidersHorizontal Users SignOut Lock CheckCircle XCircle Image BookOpen Timer Gauge Speedometer Archive FileArrowDown Broom`。
- 加载态：骨架 + **转圈提示条**（`Spinner`），不能只有骨架。空态、错误态都要有，错误态可重试。
- 文案用简体中文，沿用源项目措辞；不用感叹号式口吻；可见文本不出现破折号（`—`、`–`）。
- 事件订阅只在 `useApp()` 暴露的 `tasks / entries / auth` 上读，视图自己不轮询。

## 验证命令

在 `$P` 目录：

```bash
npx tsc -p backend/tsconfig.json      # 后端类型检查，必须零错误
npx tsc -p tsconfig.web.json          # 前端类型检查，必须零错误
node --test --experimental-strip-types tests/backend/<你的测试>.test.ts
```

单测放 `$P/tests/backend/*.test.ts`，用 `createMockAdapter()`，不联网、不起子进程。测试里导入后端文件要带 `.ts` 扩展名（运行时要求），例如 `import { planInstallUnits } from '../../backend/paths.ts'`。

## 探针已确认的事实（不要再探测）

- ode 数据源：`POST https://www.uy5.net/wodown/resources/`，体 `{"EData": 凯撒+3(参数串)}`，头 `content-type: application/json`、`referer: https://www.uy5.net`，证书正常。镜像 `https://www.kelongwo.cn/wodown/resources/`。列表返回 `{list, parentList, pageSize, Numberofarticlescount, erron}`；列表项字段 `id, post_title, subtitle?(Subtitle), thumbnail_img(封面), appIco, categories, category_parent, carouselVideoInfo{videoUrl,videoCoverUrl}, gfurl, offcialUrl, term_id`。**没有** `thumbnail_url`、`file_size`、`server_type`。详情 `GameIntroduction` 是正文 HTML（Steam 商店格式，带 `bb_tag`/`bb_paragraph`），`post_content` 为空；`carousel` 是截图数组；`MinimumConfiguration / recommendConfiguration / datetime / topCategory.cat_ID`。文件列表 `{list, type}`，项 `type: "file"|"folder"|"warehousing"|null`，`coID`（天翼云分享链接或文件夹 id）、`coName`、`coSize`（"145.55 GB"）、`coPass`（常为空，提取码已在链接 `?pwd=` 里）、`openPath`（exe 相对路径）、`path`、`md5`、`udTime`。`warehousing` = 打包中不可下载。cat/topicsId：PC=5、Switch=527、软件=538。
- gamer520：WordPress REST，但当前被 Cloudflare 人机挑战拦截（403 `cf-mitigated: challenge`）。照常实现，失败时返回可展示的错误。
- 修改器：`https://dl.fucnm.com/datafile/xgqdetail/index.txt`（`{total,page,pagesize}`）、`list_{n}.txt`（每页 50，共 37 页 1849 条）、排序 `https://dl.fucnm.com/datafile/xgqlist/list_{sort}.txt`（sort：5 综合、1 最新、2 最热、3 推荐）。`u_name` 是 AES-128-CBC 加密的下载直链（key `fG3EOofuLoNSaGwH`、iv `ly7nED38zqFHGlni`，PKCS7，base64）；`ss_name` 是同样加密的配置 URL；攻略 `POST https://dl.fucnm.com/sapi/getxgqgl` 表单 `xgq_id,time,nonce,sign`，`sign = md5(time + nonce + "getxgqgl" + "oPsmWeddKJyMvIk8mv")`，`nonce` = 8 个 4 位十六进制拼接。列表项其余字段：`id,title,en_name,version,support_ver,keyw,bits,litpic,widpic,app_litpic,app_widpic,down_total,pubdate_at,body,is_canloadconfig,config_descript,keyv,game_id,steam_appid…`。
- MOD（3DM）：`POST https://mod.3dmgame.com/api/search/getModlist`（JSON `{page,pageSize,gameId?,search?,gameType?,original?,order?}`）、`POST /api/mods/{id}`、`POST /api/game/getData`（`{path}`）。当前接口返回「服务器错误」，照常实现，失败时返回可展示的错误。
- 网盘搜索：`GET {base}/api/health` → `{status, channels, plugin_count}`；`POST {base}/api/search` JSON `{kw, res:"merge", src:"all", cloud_types:[…]}` → `{code, message, data:{total, merged_by_type:{tianyi:[…],ali:[…],quark:[…]}}}`，每项 `{url,password,note,datetime,source,images}`。默认 base `https://so.252035.xyz`。
- 天翼云扫码登录（已实测打通）：`GET https://cloud.189.cn/unifyLoginForPC.action?appId=8025431004&clientType=10020&returnURL=https%3A%2F%2Fm.cloud.189.cn%2Fzhuanti%2F2020%2FloginErrorPc%2Findex.html&timeStamp=…` 会 **302** 到 `https://open.e.189.cn/api/logbox/oauth2/unifyAccountLogin.do?…`，**必须手动逐跳跟随并收集每一跳的 Set-Cookie**（LT、SSON、GUID、JSESSIONID、pageOp）。落地页 HTML 里正则取：`captchaToken' value='(.+?)'`、`lt = "(.+?)"`、`returnUrl = '(.+?)'`、`paramId = "(.+?)"`、`reqId = "(.+?)"`、`j_rsaKey" value="(.+?)"`。然后 `POST https://open.e.189.cn/api/logbox/oauth2/appConf.do`（表单 `version=2.0&appKey=8025431004`，头 `referer: https://open.e.189.cn/`、`lt`、`reqid`、`origin`）→ `result:"0"`。`GET https://open.e.189.cn/api/logbox/oauth2/getUUID.do?appId=8025431004&timeStamp=…`（头同上）→ `{result:0, uuid, encryuuid, encodeuuid}`。二维码图：`GET https://open.e.189.cn/api/logbox/oauth2/image.do?REQID={reqId}&uuid={encodeuuid}`（返回 PNG）。轮询 `POST https://open.e.189.cn/api/logbox/oauth2/qrcodeLoginState.do`，表单 `appId=8025431004&encryuuid&date(YYYY-MM-DD HH:mm:ss)&uuid&returnUrl&clientType=10020&timeStamp&cb_SaveName=0&isOauth2=false&state=&paramId`，响应头里带 `status`，体 `{status, msg}`：`-106` 未扫码、`-11002` 已扫码待确认、`0` 成功（体里有 `redirectUrl`，响应 Set-Cookie 里有 `SSON`）。成功后 `POST https://api.cloud.189.cn/getSessionForPC.action`（表单 `appId=8025431004`、`clientType=TELEMAC`（或 TELEPC）、`version=1.0.0`、`channelId=web_cloud.189.cn`、`redirectURL={redirectUrl}`；头 `cookie: SSON=…`、`referer: https://cloud.189.cn/`、`lt`、`reqid`）返回 JSON/XML，含 `sessionKey, sessionSecret, familySessionKey, familySessionSecret, accessToken, refreshToken, familyAccessToken, familyRefreshToken`。最后一步（扫码确认后换会话）未实测，需要真机扫码。
- 天翼云账密登录：同一入口页取参数，公钥用 `j_rsaKey`（216 字符 base64 DER，包成 PEM）。`POST …/loginSubmit.do` 表单 `appKey=8025431004&accountType=02&userName={RSA}…&password={RSA}…&validateCode=&captchaToken=&returnUrl=&mailSuffix=@189.cn&paramId=&lt=&reqid=&…`，用户名/密码 = `"{RSA}" + base64(hex(RSA_PKCS1_encrypt(明文)))`（tickstep 实现）或 `"{RSA}" + hex(base64(RSA(...)))`（gowsp 实现），两者都试；头 `referer: https://open.e.189.cn/`、`lt`、`reqid`、`origin`。是否需要图形验证码：`POST …/needcaptcha.do` 表单 `accountType=01&userName={RSA}…&appKey=cloud`，返回 `"0"` 表示不需要；验证码图 `GET …/picCaptcha.do?token={captchaToken}`。响应 `{result, msg, toUrl}`，`result: 0` 且 `msg: "登录成功"` 为成功。`config/encryptConf.do` 已 404，不要用。
- 天翼云分享（无需登录）：`GET https://cloud.189.cn/api/open/share/checkAccessCode.action?noCache={秒}.{1..61}&shareCode=…&accessCode=…` → `{res_code:0, shareId(数字)}`。`GET …/getShareInfoByCodeV2.action?noCache=…&shareCode=…` → `{fileId, isFolder(布尔), fileName, fileSize, needAccessCode, …}`。文件夹：`GET …/listShareDir.action?noCache=…&pageNum=1&pageSize=60&fileId={shareId}&shareDirFileId={shareId}&isFolder=true&shareId={shareId}&shareMode=1&iconOption=5&orderBy=lastOpTime&descending=true&accessCode=…`，头 `sign-type: 1` → `fileListAO.fileList[]`（`id(字符串), name, size, md5, createDate, mediaType, fileCata`，**没有 isFolder 字段**），`fileListAO.folderList[]` 是子文件夹，`fileListAO.count` 是总数；第 2 页返回 count 0 表示取完。子文件夹用 `fileId={父 shareId}&shareDirFileId={子文件夹 id}&…` 列出。
- 天翼云取直链：`GET https://api.cloud.189.cn/open/oauth2/ssoH5.action`，带 cookie，手动跟随 302，从最终 URL（或任一跳的 Location）里取 `accessToken=`（或 `AccessToken=`）的值；取不到即登录失效（`accessToken not found`）。然后 `GET https://api.cloud.189.cn/open/file/getFileDownloadUrl.action?fileId=…&dt=1&shareId=…`，头 `cookie`、`accesstoken: {token}`、`signature: md5("AccessToken={token}&Timestamp={秒}&dt=1&fileId={fid}&shareId={sid}")`、`timestamp: {秒}`、`sign-type: 1`、`accept: application/json;charset=UTF-8` → `{fileDownloadUrl, fileName, fileSize, …}`。下载请求带 `cookie` 与 `referer: https://cloud.189.cn/`。直链会过期；过期后重新走 ssoH5 + getFileDownloadUrl。
- 校验登录：`GET https://cloud.189.cn/api/portal/v2/getUserBriefInfo.action` 带 cookie；**`nickname` 与 `account` 都为空即未登录**（cookie 过期时接口仍返回 200）。

## 源项目必须保留的行为（事故换来的规则）

- 下载失败与安装失败是**两个状态**：`install_failed` 绝不自动重新下载，重试只重装。
- 目标文件名自始至终不变；**不自动重命名**（源项目因此丢过续传数据）。
- 直链刷新串行化（同一任务同一时刻只有一个刷新在进行）。
- 解压前只清理残留，**保护**安装包、同主干续卷（`.zNN`/`.rNN`）、控制文件。
- 7z 退出码：`0` 成功；`1` 警告，仅当关键 exe 已解出才算成功；其余一律失败。
- 7z 输出在中文 Windows 是 GBK。
- 关闭游戏前核对进程身份（启动时间 + 映像路径），避免 PID 复用误杀。
- 暂停要保留进度（控制文件），续传前校验文件大小与 ETag。
- 每个文件的大小从网盘元数据预先写入，分卷包没开始下载的部分也要计入总量（否则 100 GB 显示成 32 GB）。
- 启动下载前检查磁盘空间（需要 文件大小 × 1.1）。
- 多文件启动中途失败要回滚已开始的部分。
- 卡死检测：下载 120 秒无字节进展、安装 10 分钟无进展。
- 登录过期是独立状态，登录成功后可继续。
- 同一时刻一个条目只有一个任务；任务 id 由插件生成且不变。
- 重启后未完成任务置为暂停，不自动续传。
