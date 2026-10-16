# 工作台键盘与提示实现说明

本文按当前数据库、SSH、中间件插件源码整理，说明已实现的交互、配置入口和边界。快捷键中的 `Command/Ctrl` 表示 macOS 使用 Command、Windows/Linux 使用 Ctrl；`Option/Alt` 表示同一修饰键的系统名称。用户改过绑定时，以插件设置页为准。

## 共同交互

- 左侧连接导航、顶部任务或会话标签、右侧工作区；窄窗口和 Quick 通过连接按钮打开抽屉。连接选择与当前任务的执行目标分离。
- 提示跟随输入位置，以单个候选列表显示名称和说明。SQL 参数说明也在列表内；接受补全不打开字段选择或详情弹窗。
- 鼠标和键盘均可选择候选，Escape 收起。中文输入法组词期间不接受候选或触发执行。
- 标签和请求按连接、会话及任务归属处理；异步响应不能跟随当前选中的另一连接。提示插入与真正执行是不同操作。

## 数据库

### 编辑与执行

| 操作 | 默认快捷键或行为 |
| --- | --- |
| 执行选区；没有选区时执行光标所在语句 | Command/Ctrl+Enter，或 F5 |
| 执行整篇查询 | Command/Ctrl+Shift+Enter；仅桌面 |
| 取消正在执行的查询 | Option/Alt+Escape |
| 保存查询文档 | Command/Ctrl+S |
| 格式化整篇 / 选区 | Command/Ctrl+Shift+F / Command/Ctrl+Option/Alt+Shift+F |
| 增加 / 减少缩进 | Command/Ctrl+] / Command/Ctrl+[ |
| 切换行注释 | Command/Ctrl+/ |
| 显示查询补全 | Command/Ctrl+Space |
| 接受 / 关闭补全 | 默认 Tab 接受、Enter 不接受；Escape 关闭 |
| 查找 / 替换 | Command/Ctrl+F / Command/Ctrl+Option/Alt+H |
| 查询模板与原生语法 | Command/Ctrl+Shift+Space |
| 导出当前结果 | Command/Ctrl+Shift+E |
| 设置 / 命令列表 | Command/Ctrl+, / Command/Ctrl+Shift+P |

结果表格有独立快捷键作用域：Command/Ctrl+A 选中当前结果全部行，Command/Ctrl+D 复制行，Delete 标记删除，Command/Ctrl+Option/Alt+B 批量编辑，Command/Ctrl+V 粘贴表格数据，Command/Ctrl+Enter 预览并提交修改，Command/Ctrl+Option/Alt+E 导出选中行。编辑输入框保留原生文本操作；表格中的提交与查询编辑器中的执行不会混用。

### 提示与配置

“设置 → SQL 智能提示”提供自动提示、延迟、最少字符、Enter/Tab 接受、大小写、自动别名、备注搜索、使用频率排序和星号展开开关。还可编辑常用字段组、查询模板、自定义函数、静态枚举、局部配置和 SQL 提醒；支持 JSON 校验、导入导出及草稿试验区。配置是声明式数据，不执行 JavaScript。

内置 `sel` / `selc` 分别生成全部字段 / 常用字段查询；候选按完整对象身份和当前语句上下文解析。`SELECT *` 只在明确接受建议后展开，`COUNT(*)` 保持原样。字段组可以按连接、方言、数据库、Schema 和对象限定，并调整字段顺序。补全接受是一次可撤销编辑；文档、光标或目标变化后，旧候选失效。

解析、提供候选和排序都在插件内完成。元数据通过独立只读会话按需读取，不借用用户事务控制台，也不采样业务行。当前结构分析是有测试覆盖的 SQL 子集：MySQL、PostgreSQL、SQLite 有结构改写用例；其他方言按描述符明确限制能力，未知驱动不继承 MySQL 改写规则。原生文档、图和时序语言沿用只读兼容提供器。

“设置 → 快捷键”列出查询、编辑器、结果和工作台命令，支持重新绑定、清除及恢复默认，并检查作用域内冲突。Quick 保持独立只读会话和 200 行上限。

### SQL 执行范围边界

`executionRange.js` 负责选区、光标和整篇执行；纯脚本解析来自宿主 `src/main/database/sqlScript.ts`，通过 `scripts/generate-db-execution-parser.mjs` 生成插件内 `executionParser.js`。这样，编辑器定位的执行单元与宿主实际发送的单元使用同一份边界规则，运行时无需跨仓库读取。选区优先；“整篇执行”是单独操作；字符串、注释、引号和过程体内的分号不会暴露为可误执行的内层语句。原始偏移保留，执行错误包含输入 SQL 的单元序号和行范围。

| 方言 | 脚本边界行为 |
| --- | --- |
| MySQL / MariaDB | 识别行首 `DELIMITER`，过程、函数、触发器与复合块保持完整；客户端指令和自定义分隔符不发往服务器。光标执行自定义分隔符内的单个定义时发送完整定义；选区和整篇脚本由宿主统一解析。 |
| SQL Server | 每个 `GO` 区间是一个执行批次，保留 `DECLARE`、条件块和过程定义的作用域；点击内层语句不会单独执行该语句。支持 `GO` 和 `GO 1`。 |
| Oracle | 支持 q/nq 引号、带标签的 PL/SQL 块、局部过程和包定义；独立 `/` 行作分隔符，不重复执行前条 SQL。PL/SQL 末尾分号保留，普通 SQL 末尾分号移除。 |
| SQLite | 触发器的 BEGIN/END、CASE 和内部多条语句作为完整定义发送。 |
| PostgreSQL | 支持 dollar quote、E 字符串，以及 SQL `BEGIN ATOMIC` 函数体。 |

宿主在第一条请求前检查完整脚本，随后在每个单元执行前按实时事务状态复核。过程内部打开事务后，下一条隐式提交 DDL 会被阻止。只读、Quick、写入确认和取消仍走既有通道；一个脚本使用一个 executionId，切换标签不会改变其执行或取消目标。结果集各自保留字段与行，不把过程返回的不同结构拼在一起。过程/批次达到显示行数上限后只忽略多余行，继续处理后续语句；用户取消和超时仍会终止执行。

MySQL 与 SQL Server 控制台持续持有同一物理连接，变量、临时表和事务不会在脚本中漂到其他连接。MySQL 读取 OK 包事务位，失败 CALL 追加无副作用状态探测；SQL Server 回读事务深度；Oracle 在失败 PL/SQL 后检查实际事务状态。未结束的事务继续由原控制台提供提交/回滚入口。

当前明确拒绝 `GO` 重复次数（除 `GO 1`）、SQLCMD 指令、脚本中修改引号/转义模式，以及无法跟踪的嵌入式事务控制；事务命令使用工具栏或独立语句，SQL Server 可各占一个 GO 批次。MySQL / Oracle 活跃事务中的隐式提交 DDL 和过程调用须先结束事务。Oracle 包通过 `/` 或所选定义末尾结束。边界识别不代替数据库服务端语法校验，兼容驱动是否支持某个过程语法仍取决于其真实服务端。Oracle / SQL Server 的解析和适配器模拟测试不代表原生服务验证。

## SSH

### 终端交互

| 操作 | 默认快捷键或行为 |
| --- | --- |
| 显示命令与路径补全 | Command/Ctrl+Shift+Space |
| 选择上一条 / 下一条候选 | Option/Alt+↑ / Option/Alt+↓ |
| 填入候选 | Option/Alt+Enter，或点击候选 |
| 执行当前命令 | 原生 Enter，交给远端 shell |
| 远端历史 / 路径补全 | 原生 ↑↓ / Tab，交给远端 shell |
| 填入 / 执行终端选中命令 | Command/Ctrl+Shift+I / Command/Ctrl+Shift+R；也在工具栏和右键菜单中 |
| 命令历史 / 命令列表 | Command/Ctrl+Shift+H / Command/Ctrl+Shift+P |
| 返回终端 / 远程文件 | Command/Ctrl+Shift+T / Command/Ctrl+Shift+E |
| 查找终端内容 | macOS Command+F；Windows/Linux Ctrl+Shift+F |
| 设置 | Command/Ctrl+Shift+, |

本地候选包含常见命令、子命令、选项、选项值、片段、自定义命令和当前连接历史。远端路径、可用命令与它们合并在同一个光标列表中，分别标注“远端 SFTP”和“远端 PATH · 独立会话”，按最终插入内容去重。匹配已知子命令（例如 `docker `、`docker compose `）或枚举值（例如 `curl -X P`）时只展示本地候选，不读取 SFTP 或混入文件名；明确输入 `/path` 且无子命令匹配时仍读取远端路径。服务器原生 Tab 路径补全继续可用。

所有候选只追加尚未输入的后缀，不清空或覆盖远端已有输入，也不发送 Enter。路径后缀根据当前引号状态转义空格、引号及 shell 特殊字符；接受候选时闭合尚未闭合的引号，目录候选在准确收到远端回显后继续列子项。例如 `cd '/a b/'child\ space/` 是合法的相邻字面量拼接，不需要移动光标或重写旧文本。控制字符文件名被过滤；无法可靠处理的变量、替换表达式或引号语法不提供候选。

“填入选中 / 执行选中”只接受单行、无控制字符的文本，并要求可信空闲提示符、光标在行尾、远端回显已确认、当前输入是目标命令的精确前缀。“执行选中”将后缀与 Enter 一次写入捕获的会话；需要确认的危险命令在确认后再次检查目标和提示符状态。输入不能安全追加时会拒绝，不会删除用户已经输入的内容。中文、Emoji、标点和真实尾随空格按原文传递。

### 设置与识别边界

“设置 → 命令提示”可切换自动联想和候选来源、设置起始字符数与候选行数、维护自定义命令。“启用本次会话提示”要求用户确认停在空闲 Bash/Zsh 提示符，安装的是本次 shell 的临时集成，不写服务器配置文件。

“读取远端路径（SFTP）”默认开启；“开启可用命令检查（远端 PATH）”默认关闭，两者可独立切换并立即生效。路径只在明确的路径或参数位置读取：相对路径使用可信提示符提供的绝对 `cwd`，绝对路径直接读取，未经引用的 `~/` 使用 SFTP 的起始目录。`"~/...`、`'~/...` 或 `\~/...` 中的 `~` 是字面量目录，不作 HOME 展开。这里只列目录元数据，不读取文件内容。

开启可用命令检查后，通过既有 `ssh.exec` 独立通道执行固定的只读 PATH 枚举脚本。用户输入、前缀和 `cwd` 不拼入脚本；脚本不主动 source 用户配置，也不运行列出的候选程序。最多检查 32 个 PATH 目录项，仅访问绝对目录，保留可执行的普通文件名，最多 2048 项，exec 超时为 4.5 秒。其 PATH 来自独立 exec 会话，可能与终端里临时修改后的 PATH 不同，不包含临时别名或函数；该来源限制在候选和设置页均有说明。

自动读取防抖 120 毫秒，手动打开无需等待防抖。目录缓存 3 秒、命令缓存 60 秒，缓存和请求均按会话及资源隔离；最多 64 个缓存项、2 个实际并发读取、16 个排队读取。单个目录最多处理前 4096 项，远端匹配先限 40 项，再合并到用户配置的 4–12 行候选列表；截断和读取失败原位显示，仍可使用本地提示。单次候选等待最多 6 秒。既有宿主接口不支持取消单个已发出的读取：取消会移除等待者、跳过尚未开始的读取并丢弃旧结果，不向 PTY 写入 Ctrl+C，也不释放实际并发名额来无限启动新请求。

提示识别依赖 OSC 133 标记、xterm 正常缓冲区、行尾光标与已确认的回显状态。没有可靠标记、全屏程序、密码输入、输入法组词、粘贴或无法确认的输入状态不会触发自动候选读取；不通过 `$`、`#` 等可见字符猜测命令行。发出命令或出现控制操作会使旧提示状态失效。异步结果返回时及接受候选前都检查捕获的会话、终端、prompt、revision、文本、光标和 `cwd`；Escape、切换会话或修改设置后，迟到结果不会重新打开列表。

“设置 → 快捷键”支持显示、修改、清除和恢复默认。补全选择/接受、选中文本动作都可配置；显式远端历史命令默认不占用组合键。Ctrl+C/D/Z/L/A/E/U/K/W/R 等终端原生控制键保留，具体行为由远端 shell 决定。普通 Enter 和 ↑↓ 不会被本地候选列表抢占。

## 中间件

连接下按任务打开概览、Topic、消息、消费组、监控、发布等标签；RocketMQ 另外提供消息轨迹。标签身份由连接 ID 与页面类型共同决定，草稿与页面状态跟随原任务。Quick 和只读连接在绑定 API 层阻止写操作，桌面与 Quick 会话分离。

### 快捷键与编辑

| 操作 | 默认快捷键或行为 |
| --- | --- |
| 聚焦当前页搜索 / 关闭任务标签 | Command/Ctrl+F / Command/Ctrl+W |
| 打开插件设置 | Command/Ctrl+Shift+,；也可点击左侧连接面板底部“设置” |
| 查询消息 | Command/Ctrl+Enter；仅当前消息查询任务 |
| 显示当前输入建议 | Command/Ctrl+Space |
| 选择 / 接受 / 收起候选 | ↑↓ / Enter 或 Tab / Escape |
| JSON 格式化 | Option/Alt+Shift+F |
| Payload 换行 / 缩进 | Enter 继承缩进；括号内加深两空格；无候选时 Tab 插入两空格 |
| 发送消息 | Command/Ctrl+Enter；仅当前发布任务且允许写入时 |
| 切换消息预览 | Command/Ctrl+Shift+P；当前发布任务 |

Topic 候选从当前任务连接懒加载；Header 提供常用名称；JSON 提示包括当前内容中的字段、布尔值、null、对象和数组。候选出现在光标或输入框下方，鼠标或键盘接受只修改输入，不发送消息。Payload 允许纯文本，格式化失败原位提示；显式发送成功后保留表单。中文输入法确认不会触发快捷发送。

“设置 → 快捷键”列出 8 项可配置命令，支持按名称、作用域或组合键搜索，按键录制、清除、单项恢复和全部恢复默认。录制框保留 Tab / Shift+Tab 焦点移动；裸 Enter、Tab、Escape、文本编辑与系统保留组合键不能被重新分配为业务动作。JSON 换行、缩进与候选列表导航沿用编辑器行为，不在可重绑命令中。

同一组合键可以用于互不重叠的任务，例如消息查询与消息发布共用 Command/Ctrl+Enter；工作区、发布编辑器和 JSON 等重叠范围会检查冲突。命令仅由当前任务内对应的控件处理，运行前再次确认任务仍然活动。保存新绑定后即刻更新已有页面，旧绑定停止响应。中文输入法组词、设置录制框、连接抽屉和模态对话框不会触发背后的任务动作。

### 提示规则与范围

“设置 → 输入提示规则”支持开关自动联想和内置候选，并以表单管理以下声明式规则：

| 规则类型 | 内容与匹配方式 |
| --- | --- |
| Topic / 队列 | 自定义名称、触发别名和文本模板；可使用 `${connection.id}`、`${connection.name}`、`${environment}`、`${protocol}`、`${input}` |
| Header 名称 | 常用 Header 的自定义名称和触发别名 |
| JSON 字段 | 插入转义后的字段名；可限定所在对象路径，例如 `customer` |
| JSON 字段值 | 字符串、数字、布尔值、null、对象或数组；必须指定字段名或完整路径，例如 `status` 或 `customer.status` |

规则可分别启用或停用，按 Kafka、RabbitMQ、MQTT、RocketMQ 协议及具体连接限定；协议与连接范围同时满足才提供候选。JSON 字段和路径按大小写精确匹配，类型值不会作为字符串随意插入已有引号。候选只替换当前字段或值的输入范围，并保留周围内容；文本、光标或任务改变后，旧候选不能被接受。自定义候选排在内置候选之前，重复插入内容会去重。

配置最多 200 条规则。规则名称最多 80 个字符，Topic / Header / JSON 字段内容最多 512 个字符，JSON 字段值最多 8192 个字符；保存时验证 JSON、范围、控制字符和模板变量，并在表单内显示错误。模板仅按白名单作普通文本替换，不执行 JavaScript。当前 JSON 辅助是本地确定性规则，不做服务器 Schema 推断。MQTT 发布使用 Topic、QoS 与 Retained；当前驱动不转发自定义发布属性，界面会说明。

### 设置保存与草稿

设置是唯一的连接无关工作标签，打开它无需建立中间件会话；布局恢复会恢复该标签。桌面与 Quick 共用此设置页面及尚未保存的设置草稿，消息任务仍各自使用独立会话和编辑状态。

快捷键与提示配置保存在已有 `mw.ui` 的 `productivity` 段，当前版本为 `version: 1`，包含 `shortcuts` 与 `completion`。读取旧配置时补充默认项，分别保留有效绑定和有效规则；无法识别的项目不进入运行中的提示引擎。该段不保存会话或凭据。

设置草稿和已生效配置分离。只有存储成功后才更新命令与提示引擎；保存失败时保留输入、显示原因并允许重试，原有生效配置不变。保存期间继续编辑会保留更新的未保存草稿，已打开的发布和查询页面不会因应用设置而重新挂载。存在未保存修改或正在保存时，关闭设置标签会被阻止并提示先保存或放弃修改。显式设置保存与布局持久化串行执行，避免稍后的布局写入覆盖新配置。

## 模块与扩展位置

以下路径均相对于插件仓库。跨目录生产导入分别使用 `@db`、`@ssh`、`@mw`。

| 模块 | 源码入口与职责 |
| --- | --- |
| 数据库引擎 | [sql-intelligence/README.md](../plugins/database/src/js/sql-intelligence/README.md)：方言、词法/作用域、纯候选提供器、排序、原子编辑、Worker 与元数据层 |
| 数据库展示与设置 | [editor.js](../plugins/database/src/js/editor.js)、[monacoEditor.js](../plugins/database/src/js/monacoEditor.js)、[settings/](../plugins/database/src/js/sql-intelligence/settings/)：候选列表、编辑器适配、配置表单 |
| 数据库执行边界 | [executionRange.js](../plugins/database/src/js/executionRange.js)、[executionParser.js](../plugins/database/src/js/executionParser.js)：选区/当前执行单元适配、由宿主生成的共享脚本语法与显式边界错误 |
| SSH 候选与展示 | [commandCompletion.js](../plugins/ssh/src/js/commandCompletion.js)、[sshCompletion.js](../plugins/ssh/src/js/sshCompletion.js)：本地候选生成、定位、状态校验与接受 |
| SSH 远端提示 | [remoteCompletion.js](../plugins/ssh/src/js/remoteCompletion.js)：路径词法与安全后缀、固定只读 PATH 脚本、SFTP 适配、限量缓存/队列及本地远端候选去重 |
| SSH 终端与动作 | [term.js](../plugins/ssh/src/js/term.js)、[terminalData.js](../plugins/ssh/src/js/terminalData.js)、[commandActions.js](../plugins/ssh/src/js/commandActions.js)：提示符/回显、会话流解码、捕获目标后的填入/执行 |
| SSH 导航与设置 | [workspaceNavigation.js](../plugins/ssh/src/js/workspaceNavigation.js)、[completionSettings.js](../plugins/ssh/src/js/completionSettings.js)、[shortcutPolicy.js](../plugins/ssh/src/js/shortcutPolicy.js)：侧栏/抽屉、配置、保留键规则 |
| 中间件编辑辅助 | [editorAssist.js](../plugins/middleware/src/js/editorAssist.js)、[editorSuggestions.js](../plugins/middleware/src/js/editorSuggestions.js)：输入控件适配、纯 JSON 建议与换行编辑 |
| 中间件提示规则 | [completionRules.js](../plugins/middleware/src/js/completionRules.js)、[jsonContext.js](../plugins/middleware/src/js/jsonContext.js)：声明式规则校验、范围过滤、模板替换与不完整 JSON 的字段/值定位 |
| 中间件命令与设置 | [commands.js](../plugins/middleware/src/js/commands.js)、[preferences.js](../plugins/middleware/src/js/preferences.js)、[settings.js](../plugins/middleware/src/js/pages/settings.js)、[store.js](../plugins/middleware/src/js/store.js)：作用域路由、保留键/冲突校验、配置恢复、独立设置草稿与串行持久化 |
| 中间件任务归属 | [workspace.js](../plugins/middleware/src/js/workspace.js)、[sessionCoordinator.js](../plugins/middleware/src/js/sessionCoordinator.js)、[protocol.js](../plugins/middleware/src/js/protocol.js)：任务身份、会话、既有协议参数适配 |

新增提示能力优先扩展纯候选模块与声明式数据，再通过现有适配层显示；不要把网络请求、全局活动连接或直接执行操作放进候选生成器。

## 验证记录

实际构建、单元/UI 回归、宿主类型检查与 classic/orb/Quick 原生验证结果统一记录在 [第二轮验收报告](../test-results-workbenches/phase2-validation-report.md)（[上一轮记录](../test-results-workbenches/workbench-validation-report.md)）。本文描述源码行为，不将浏览器模拟通过视为原生验证，也不提前宣称尚未完成的检查通过。
