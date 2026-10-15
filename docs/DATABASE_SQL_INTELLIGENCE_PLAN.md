# 数据库 SQL 智能提示引擎方案

状态：已实施首版。日期：2026-10-14。完成范围与能力边界见 [实现说明](DATABASE_SQL_INTELLIGENCE_IMPLEMENTATION.md)，实际模块契约见插件内 `src/js/sql-intelligence/README.md`。本文保留实施前评估及后续扩展目标，不表示完整 DataGrip 语义或全部方言均已实现。

最新交互决策：按用户要求，原先的“字段展开／生成查询先弹框预览确认”设计已被替代。SQL 补全统一显示在光标下方的候选列表，字段类型、备注与生成 SQL 的简略内容在候选行内显示，选中后直接接受；不打开补全确认弹框、字段选择弹框或独立的补全详情浮面板。一次接受仍是一条完整撤销操作，过期候选不能写入变更后的文档或连接。设置页的实时试验保留页内文本预览。

目标：在保留当前 Monaco、Quick、驱动和宿主接口的前提下，建立统一、可配置、可扩展的查询语言服务。体验参考 DataGrip 的上下文补全、表字段展开、关联查询与模板；完整语义能力按方言验证，不把协议兼容当作语法等价。

## 1. 实施前的现状评估

实施前并非只有关键词提示。宿主已有上下文识别、CTE／派生表列推导、INSERT／UPDATE 列建议、外键 JOIN 与模糊匹配；插件也有本地回退、元数据预热和使用频率记录。问题主要在实现分裂、接入丢信息、元数据归属和配置能力不足。

| 发现 | 实施前证据 | 影响 |
| --- | --- | --- |
| 宿主增强引擎与插件回退并存 | `src/main/database/completion.ts:627`；插件 `src/js/completion.js:403` | 同一 SQL 在正常、超时、离线时行为不同 |
| Monaco 仅映射普通文本、基础字段和排序 | 插件 `src/js/monacoEditor.js:55` | 未接入 snippet 跳转、候选接受回调、完整过滤信息及 incomplete 刷新；学习和自动别名与 textarea 不一致 |
| 本地 JOIN 分支把 Map 当数组 | 插件 `src/js/completion.js:319`；`tokenizer.js:403` | `aliases.length` 条件无法成立 |
| 本地上下文主要是平面正则 | 插件 `src/js/completion.js:50`、`:265`；`tokenizer.js:403` | 光标后的 FROM、引用标识符、内外层同名别名容易误判 |
| 元数据隔离存在遗漏 | 插件 `main.js:1322` 已隔离预热；宿主 `dbService.ts:376` 缓存未命中仍可在传入查询会话读取目录 | 300ms 超时只结束等待，没有取消宿主工作，补全可能占用用户控制台 |
| 对象身份不完整 | 插件 `completion.js:88` 按小写表名补丁；缓存按 sessionKey | 跨库／跨 Schema 同名表与大小写语义不可靠 |
| 预取按固定前 N 张表 | 插件 `completion.js:538` 预取前 40 表；宿主 SQLite 目录前 300 表 | 未预取的当前表可能没有字段，大库启动却要做不必要描述查询 |
| 未知本地方言落到 MySQL | 插件 `tokenizer.js:78` | 可能出现错误函数、引号和分页模板 |
| 配置只有两个补全开关 | 插件 `workbench.js:375` | 缺少模板、字段组、作用域、预览与导入导出 |

路径说明：上表 `src/main/...` 相对宿主 eNest 根目录；“插件”路径相对 `eNest_plugin/plugins/com.enest.database`。该表记录实施前的源码证据，行号对应当时快照；当前迁移结果以实现说明和源码为准。

## 2. 首版交互与扩展目标

`|` 表示光标，候选只在用户接受后修改 SQL。

| 输入／操作 | 提示结果 |
| --- | --- |
| `SELECT | FROM customers c` | 识别光标后的 FROM，优先提示 c 的字段、字段组与适用函数 |
| `SELECT c.| FROM customers c` | 仅提示当前作用域内 c 的列；包含类型、备注、主键标识 |
| `SELECT * FROM customers c`，光标在星号 | “展开全部可见字段”“使用常用字段：客户列表”等明确动作 |
| `SELECT c.* FROM customers c JOIN orders o ...` | 只展开 c；不改动 o 或其他查询块 |
| 输入 `sel` 后选择客户表 | 在同一列表显示目标表的查询候选，支持全部字段和已保存的常用字段组；临时自选字段向导留作后续扩展 |
| `SELECT cust|` | 除当前合法列候选外，提供“customers — 生成表查询”动作；不把它当成合法的非标准 SQL |
| `FROM customers c JOIN |` | 优先有已知外键关系的表，其后为其他匹配表 |
| `JOIN orders o ON |` | 推荐完整关系，例如 `o.customer_id = c.id`；复合外键保留全部条件 |
| `WHERE c.status = |` | 可提供用户配置枚举或可信的静态枚举元数据 |
| `INSERT INTO customers (|)` | 推荐尚未填写且适合插入的字段；标识默认值、必填和生成列 |
| `UPDATE customers SET |` | 推荐尚未赋值且可更新的列，不错误推荐生成列 |
| `WITH recent AS (...) SELECT r.| FROM recent r` | 使用 CTE 的输出列，不混入源表未投影的字段 |
| `COUNT(`、`DATE_TRUNC(` | 方言对应的参数签名、当前参数位置及简要示例 |
| 输入字段中文备注或缩写 | 在名称匹配之后搜索备注和用户别名，候选中说明命中原因 |

使用同一个编辑器内候选入口组织提示，其他信息保持就地呈现：

- **候选列表**：表、字段、函数、关键词、字段组和模板随输入显示在光标下方；类型、备注、参数签名或 SQL 简略内容放在候选行内。
- **结构编辑候选**：展开星号、生成查询、生成 JOIN、插入字段组也进入同一列表。用户接受后原子应用编辑计划，不增加预览确认步骤；未确认的结构不提供猜测性改写。
- **参数与诊断信息**：函数签名与候选同行展示；无法确认的字段、重复别名、可配置的 SELECT * 提醒等由编辑器诊断呈现，不打开补全详情浮面板。

### 全字段与常用字段必须有清楚的语义

“展开全部字段”以当前数据库星号的实际投影语义为准，保持列序与限定名。不得因为字段较大或不常用而默默省略。系统列、不可见列等按方言处理。`COUNT(*)` 不是展开目标；`NATURAL JOIN`／`USING` 的合并列、方言 `* EXCEPT/REPLACE` 等在无法保证等价时不提供自动改写。

“常用字段”则明确是用户选择的投影，可以排除大文本／BLOB／审计列等。当前支持手动维护、从表结构勾选、从当前 SELECT 提取直接物理字段、拖动及键盘调整顺序。表达式、星号、CTE／派生输出和多表投影不猜测转换为字段组。使用频率只推荐候选字段组，不自动修改已保存的字段组。

例如客户表配置 `id, name, mobile, status` 后：

```sql
-- 全部字段动作：按真实元数据生成完整列表
SELECT c.id, c.name, c.mobile, c.status, c.created_at, c.updated_at
FROM customers AS c;

-- 常用字段动作：明确使用“客户列表”字段组
SELECT c.id, c.name, c.mobile, c.status
FROM customers AS c;
```

统一使用“光标下方列表 + 显式接受”。字段展开和生成查询没有确认弹框或独立详情浮面板；列表行内展示必要摘要，Tab／Enter 按设置接受候选，Escape 关闭列表。已经写好的 `*` 不会因元数据更新而突然变成列清单。不存在 FROM 且尚未选择表时，显示带目标表名称的查询候选，不猜测执行目标。持久字段组在设置页维护，不在补全流程中打开字段选择器。

## 3. 总体架构与归属

```text
Monaco / 轻量编辑器 / 设置页预览器
                  ↓ 统一请求与编辑协议
             CompletionService
                  ↓
       文本快照 → 容错语法 → 作用域与类型
                  ↓
       Providers 并行产生候选与代码动作
                  ↓
       合法性过滤 → 去重 → 排序 → 编辑计划
                  ↑
  方言注册表    配置服务    只读元数据快照
                              ↑
               MetadataService / 独立只读会话
                              ↑
                   现有宿主 schema / db API
```

SQL 语义、模板、排序、配置和 UI 适配属于插件业务。新引擎放在数据库插件内；宿主继续负责已有数据库连接、原生能力与执行。首期不增加进程、驱动协议或专用权限，也不默认引入 LSP 服务。协议保持与编辑器无关，将来需要独立语言服务时再增加 LSP 适配器。

旧宿主补全短期作为兼容适配器存在。新引擎启用的方言由新链路接管，不与旧结果盲目叠加；旧路径需要元数据时也使用独立只读会话。未迁移的非 SQL 查询语言保留原有能力。是否清理宿主旧业务代码另列迁移步骤，不在本轮顺带改变宿主生命周期。

## 4. 容错语法与作用域

补全面对的是尚未写完的 SQL，解析失败不能直接返回空列表。

1. 词法层保留注释、字符串、引用标识符、参数、括号和原始区间；按方言处理 dollar quote、方括号、反引号等。
2. 当前语句解析同时读取光标前后，不能只分析前缀。保持 UTF-16 文本偏移与 Monaco 一致，正确处理中文、emoji、CRLF。
3. 容错树允许缺失字段、FROM、右括号或不完整名称，并给出当前语法期待位置。正常输入中的暂时缺失不持续标红。
4. 作用域图记录每个查询块的表、别名、CTE、派生表输出、相关外层引用及可见性。内层别名只遮蔽内层；CTE 顺序和递归可见性由方言决定。
5. 类型归一为 number / string / temporal / boolean / json / array / binary / unknown，并保留原始数据库类型；函数与操作符建议按预期类型排序。
6. 支持查询块级缓存和增量词法；解析库不支持增量时，在 Worker 内重解析当前语句并限时，不声称底层已经具备完整增量 AST。

### 解析器候选验证与当前选择

采用 `ParserAdapter`，禁止第三方 AST 直接出现在 Provider 或 UI 中。

- **优先验证 dt-sql-parser**：官方提供光标位置语法候选与词法／语法树能力，当前列出 MySQL、PostgreSQL、Flink、Spark、Hive、Trino、Impala、GenericSQL。适合 MySQL／PostgreSQL 的首批验证。GenericSQL 不能当成 Oracle／SQL Server／SQLite 的完整实现。
- **node-sql-parser 作为对比候选**：官方列出 SQLite、TransactSQL、MySQL、MariaDB、PostgreSQL 等，偏完整语句 AST 与 SQL 输出。必须验证不完整 SQL 的恢复能力；不默认将其直接作为实时补全引擎。
- 首期不同时装载两套全方言解析包。先用固定语料比较错误恢复、作用域、Worker 开销和真实打包体积，选定首批适配器；其余方言明确显示支持级别。
- 结构化容错回退只负责能可靠识别的查询块、名称与子句，不继续增加平面正则来假装覆盖完整 SQL。低置信度上下文可以提示对象名，但不做多位置结构改写。

已对 dt-sql-parser 4.5.1 与 node-sql-parser 5.4.0 做临时目录内的未完成语句 POC，记录见 `test-results-db/database-sql-parser-poc.md`；未增加正式依赖。首版采用保留偏移的词法、查询块／别名作用域和元数据绑定，覆盖受测查询子集。该 POC 不是完整作用域认证，其 esbuild 输出也不等于最终浏览器 chunk 大小。以上第三方适配方向保留为后续扩展，不是当前运行时依赖。

选型门槛：必须通过未完成 SELECT／JOIN、引用标识符、嵌套同名别名、CTE、相关子查询、窗口函数、注释内分号、方言字符串和参数的语料测试，才能认定该方言具备对应语义能力。

## 5. 多方言的扩展契约

每个连接绑定 `languageFamily + dialectId + serverVersion + mode + capabilities`。版本或模式无法可靠探测时允许用户覆盖，并显示“手动指定”，不静默假定最新版。

| 语言／方言组 | 扩展策略 |
| --- | --- |
| MySQL、MariaDB、TiDB 等 | 共用词法基础；函数、CTE、JSON、分页和特有子句按产品／版本覆盖 |
| PostgreSQL、Timescale、CockroachDB 等 | 共用基础；搜索路径、类型转换、RETURNING、数组／JSON 等分项验证 |
| SQLite、DuckDB | 独立语法特征；SQLite PRAGMA 与 DuckDB 的分析语法分别实现 |
| SQL Server、Oracle | 独立引用、参数、分页、过程调用和版本策略，不能使用 MySQL LIMIT 模板 |
| ClickHouse、TDengine、InfluxQL、CQL | 注册独有类型、聚合／窗口／时序规则；仅声明已验证的语法能力 |
| MongoDB／Redis／Search JSON、Flux、Cypher | 复用请求、候选、缓存、配置和 UI 框架，独立语言适配器，不套 SQL 解析 |

支持等级按能力记录：`lexical`、`objects`、`scopes`、`projectionRewrite`、`relationships`、`signatures`、`diagnostics`。不使用一个含糊的 `supported: true` 宣称全部支持。

`DialectAdapter` 负责：引用与转义、标识符规范化与大小写、保留字、作用域规则、参数形式、分页生成、函数签名、可选解析后端和元数据适配能力。

连接 PostgreSQL 不代表可以直接引用另一数据库的表；数据库名、Schema、catalog、search_path 的解析遵循具体方言。所有多段标识符逐段引用，保留字和大小写敏感名称也要正确引用。

## 6. 元数据与请求正确性

将现有树、字段描述、对象详情和补全的公共读取部分抽出到 `MetadataService`，共用快照与失效通知，避免各自读取和缓存。

**对象身份**：`connectionId + configRevision + surface + database/catalog + schema + kind + canonicalName`；canonicalName 由方言生成。请求再绑定 consoleId、documentId、modelVersion、cursor、请求代次、配置 revision、元数据 revision。

**读取顺序**：先对象名索引，随后当前语句涉及的表字段，用户展开的表与收藏表，最后可选低优先级预取。列、关系、函数签名单独声明状态；缺少窄接口时复用现有 `schema.describe` 一次读取并缓存，不为字段、索引、外键重复调用。

**会话与状态**：独立只读元数据会话，每个会话串行，跨连接有限并发；请求合并、排队去重、超时与退避。关闭、配置变更、重连、切换 Quick 使旧代次失效。Promise 超时不能冒充底层取消；若宿主无法安全中止，标记旧请求作废，且不继续堆入同一队列。不得取消用户 SQL 或重置用户事务会话来取消提示。

**缓存**：对象级 TTL + LRU + revision，明确 `unloaded / loading / ready / stale / denied / failed / truncated`。不把前 40／300 张表当作全部表。当前协议没有分页能力的列表必须标明截断边界，不虚构完整目录。DDL 成功后按连接和受影响对象广播失效；无法定位影响范围时失效当前库／Schema。断开可以保留带“缓存”标记的名字建议，结构改写要求足够新鲜的字段快照。

**事务局部对象**：临时表与未提交 DDL 可能对只读元数据会话不可见。通过文档符号和已有执行事件维护 `consoleId + generation` 覆盖层，并区分“脚本声明／已确认会话对象／远端元数据”。同一控制台关联的查询标签共享已确认的事务／临时对象；不同控制台和 Quick 隔离。尚未执行的文档声明只参与相应脚本的语义分析。未知时显示能力边界，不隐式读取用户事务控制台。

**会话上下文变化**：`USE`、`SET search_path`、`SET ROLE`、`sql_mode`、`ALTER SESSION` 等可能改变实际名称解析。基于已确认的执行结果更新有效数据库、搜索路径、角色或解析模式，并增加 sessionContextRevision；不能只依赖保存的连接配置。多语句部分失败时只确认已知成功部分，无法可靠确定则标记上下文未知，暂停依赖精确绑定的结构改写。元数据身份／可见性快照纳入有效角色和上下文 revision，不能复用旧角色下的可见对象来宣称新角色可访问；不借用用户事务会话隐式探测。

**JOIN**：优先用 `TableDetail.foreignKeys` 的约束分组，保持复合外键字段对应关系。现有 `CompletionCatalog.fks` 扁平结构不能成为唯一来源。名称猜测是单独可关闭、较低置信度的建议，并显示“命名推测”；不自动写入查询。

**值提示**：默认限于静态枚举、用户配置与已知约束。输入时不做全表 DISTINCT 采样。将来若提供实际值采样，作为显式操作和单独能力，必须限量且绑定作用域。

## 7. Provider、排序与编辑计划

每个 Provider 只读取不可变上下文、配置和快照，返回候选／元数据需求，不直接访问 DOM、修改编辑器或调用宿主。

建议内置 Provider：对象／别名、字段、关键字、函数与签名、类型／操作符、关联 JOIN、全字段投影、字段组、查询模板、参数／静态枚举、诊断与修正。

排名采用分级规则，避免历史次数压过语义正确性：

1. 当前语言、版本、权限与语法位置允许；不合法项先过滤。
2. 当前查询块／别名的直接关联高于整个 catalog；精确名称高于前缀、缩写与备注命中。
3. 已验证外键、类型兼容高于启发式猜测。
4. 在同级合理候选内使用用户固定项、字段组偏好及有上限的衰减使用频次。
5. 使用完整对象身份去重；稳定的末级排序，异步更新不让正在选择的项跳位。

候选记录 `source`、`reason`、`confidence` 和 `scoreBreakdown`。编辑器候选行只显示有用的类型、备注与 SQL 摘要，不附加独立详情浮面板；设置页试验区用于查看结果和配置来源。

内部契约职责示意（实际字段定义以 `src/js/sql-intelligence/contracts.d.ts` 为准）：

```ts
interface CompletionRequest {
  documentId: string;
  modelVersion: number;
  cursorOffset: number;
  requestId: number;
  text: string;
  context: QueryContext;       // 连接、控制台、库、Schema、方言、有效搜索路径／角色及会话 revision
  configRevision: number;
  catalogRevision: number;
}

interface CompletionCandidate {
  id: string;
  kind: CandidateKind;
  label: string;
  filterText: string[];
  detail?: string;
  documentation?: string;
  source: string;
  confidence: 'verified' | 'inferred';
  reason: string;
  editPlan: EditPlan;
}

interface EditPlan {
  documentId: string;
  expectedModelVersion: number;
  primaryEdit: TextEdit;
  additionalEdits: TextEdit[]; // 不重叠，全部针对同一文本快照
  snippet?: SnippetTemplate;  // 有序占位符、关联占位符、最终光标
}
```

接受候选前二次验证文档、目标上下文、版本和相关元数据；过期则重新计算或关闭候选。校验通过后直接应用，不再打开补全确认弹框。一次接受对应一个撤销步骤。引用符、别名去重、逗号、缩进和多位置修改由 EditPlanner 统一处理，不能在 Monaco 与 textarea 分别拼接。

Monaco 适配 `InsertAsSnippet`、`additionalTextEdits`、`filterText`、`incomplete`、候选接受命令、签名提示和 code actions。轻量编辑器支持同一 EditPlan；基础模板占位符使用轻量控制器，复杂交互可等待 Monaco 加载后再执行，显示明确可用状态。

## 8. 设置页与用户配置

数据库设置内新增“SQL 智能提示”，按以下内容组织，沿用当前工作标签与快捷键体系：

| 配置区 | 内容 |
| --- | --- |
| 基础行为 | 自动显示候选、触发延迟、最小输入长度、点号立即提示、Enter／Tab 接受策略、关键词大小写、限定名／引号策略、自动别名 |
| 方言与能力 | 当前实际方言、版本来源、手动覆盖、已验证能力、非 SQL 语言提示状态 |
| 常用字段组 | 选库／Schema／表、勾选字段、排序、默认组、从当前 SQL 保存、缺失字段提示 |
| 查询模板 | 触发词、描述、适用位置与方言、动态表／列选择、占位符、启停、复制内置模板 |
| 函数与枚举 | 用户函数签名、参数说明、字段静态枚举；手工目录标注来源 |
| 排序与学习 | 备注搜索、用户别名、固定候选、使用频率学习、清除学习记录 |
| 提醒规则 | SELECT *、重复别名、未知字段、无条件 UPDATE／DELETE 等提示等级；不改变现有执行确认策略 |
| 元数据 | 当前库优先、预取范围、TTL、手动刷新、缓存大小与权限失败状态 |
| 高级配置 | JSON 编辑、Schema 校验、有效配置来源、导入导出、冲突预览、恢复单项默认 |

设置页的实时试验区可选择连接和方言，输入 SQL，查看实际候选、页内展开结果与配置来源。试验区只生成与验证文本，不执行 SQL；该页内预览不进入查询编辑器的补全接受流程。离线时可用内置样例 catalog。

覆盖顺序：内置默认 → 用户全局 → 方言／版本 → 连接 → 库／Schema → 具体表。会话临时覆盖只作用于当前上下文。列表项按稳定 id 合并，禁用内置项用显式 disabled override，避免整段数组替换丢失其他规则。每项可查看最终值来自哪一层。

用户设置是声明式配置：常规界面不要求写代码；高级 JSON 也不运行任意 JavaScript。首版生成器按候选中的目标表生成查询，支持 allColumns／columnSet、方言引用、别名及分页；字段组在设置页勾选。临时选表／选字段仍是扩展目标，不能通过一个尚未实现的配置值宣称支持；后续也应使用候选列表或设置界面，不重新引入补全确认弹框。方言语法扩展由开发者模块实现，普通用户配置不声称能新增任意 SQL 语法。

配置示例：

```json
{
  "schemaVersion": 1,
  "behavior": {
    "automatic": true,
    "delayMs": 70,
    "keywordCase": "upper",
    "acceptOnEnter": false,
    "acceptOnTab": true,
    "starExpansion": "suggest"
  },
  "columnSets": [
    {
      "id": "customers.list",
      "label": "客户列表",
      "scope": {
        "connectionId": "dev-orders",
        "database": "orders",
        "schema": null,
        "table": "customers"
      },
      "columns": ["id", "name", "mobile", "status"],
      "order": "configured"
    }
  ],
  "templates": [
    {
      "id": "user.select-common",
      "label": "查询常用字段",
      "trigger": "selc",
      "language": "sql",
      "contexts": ["statementStart"],
      "generator": "select",
      "projection": { "source": "columnSet" },
      "alias": { "strategy": "initials", "avoidCollisions": true },
      "limit": { "value": 200, "syntax": "dialect" }
    }
  ]
}
```

另支持带编号占位符的静态模板；动态生成器优先生成结构化 EditPlan，避免让用户为 SQL Server／Oracle 自己拼 LIMIT 替换规则。空值、默认值、参数占位符不是字符串拼接宏，分别定义类型与方言输出。

配置保存在已有 `db.ui.completion`，带 schemaVersion；学习记录在 `db.completionUsage` 迁移为版本化结构，以完整对象作用域记录。旧的 `autoAliasAfterTable`、`learnUsage` 与旧频次数据有明确迁移；无法确定原连接的频次不随意绑定到新对象。内置模板只读，用户通过复制或 override 修改。

导入限制文件大小／条目数，校验版本、类型、未知字段、重复 id、字段组存在性；导入前显示作用域映射与覆盖／保留选项。跨机器不直接复用连接 id，要求映射本机连接。设置草稿、实时预览与生效配置分离；保存失败保留草稿，不能显示“已保存”。发布配置后增 revision，使旧候选失效。

## 9. 高可读性的代码组织

保持现有 JavaScript ES Modules，通过 JSDoc、明确 contracts 和局部 checkJs 提升类型约束；不因此更换框架或强制全插件改 TypeScript。接口示例用 TypeScript 表达，最终实现可以采用 `.d.ts` 配合 JS。

```text
src/js/sql-intelligence/
  index.js                         # 唯一公开入口
  contracts.d.ts                   # 请求、语义模型、候选与编辑计划
  completionService.js             # 统一调度，取消和批次更新
  syntax/
    parserAdapter.js               # 归一不同解析器输出
    cursorContext.js               # 当前语句、子句、期待位置
    scopeGraph.js                  # 名称可见性和投影来源
    semanticWorker.js              # 耗时分析，不接触宿主与 DOM
  dialects/
    registry.js
    mysql.js / postgres.js / ...    # 规则、版本与能力声明
  metadata/
    metadataService.js             # 队列、去重、订阅与懒加载
    metadataIdentity.js
    metadataCache.js
    metadataSessions.js            # 只读会话与生命周期
    adapters/                      # 通用 schema API 与方言补充
  providers/
    objectProvider.js
    columnProvider.js
    functionProvider.js
    relationProvider.js
    projectionProvider.js
    templateProvider.js
    diagnosticProvider.js
  ranking/
    rankCandidates.js
    usageStore.js
  edits/
    editPlanner.js
    templateCompiler.js
  configuration/
    defaults.js
    schema.js
    resolveConfig.js
    migrations.js
  adapters/
    monacoAdapter.js
    textareaAdapter.js
    legacyHostAdapter.js
  settings/
    completionSettings.js
    templateEditor.js
    columnSetEditor.js
    completionPlayground.js
```

实际实现按职责逐步建立模块，不为目录完整度创建空模块。禁止“通用 utils”重新收集所有业务。Provider 之间不能互相调用；共同语义依赖放在 syntax／metadata，统一由 service 注入。引擎不直接读取全局 store，UI 不直接拼补全 SQL。

新增方言只需注册 DialectAdapter、必要的 MetadataAdapter 和方言测试，不修改每个 Provider。新增候选来源只需注册 Provider，不改编辑器组件。新增设置必须包含 schema、默认值、迁移与作用域规则。

跨目录导入使用插件构建与类型检查中一致注册的别名，例如 `@db/sql-intelligence`；同目录保留 `./`。不增加 `../../../`，不为插件业务修改宿主顶层目录别名。

## 10. 性能、并发与生命周期

以下仍是端到端验收目标；已有纯引擎暖缓存测量不能代替端到端结果。Worker 串行、32 项有界等待队列、按文档／方法／通道 latest-wins 及运行任务终止已落实：

- 缓存命中的常规补全首批候选 P95 ≤ 50ms；当前查询块语义更新目标 ≤ 120ms，以固定机器、SQL 长度和 catalog 规模记录结果。
- 本地候选先到，元数据异步补充；不存在每按一个键先等宿主 300ms 的路径。
- 排队请求使用 latest-wins，运行中解析带取消／时间预算；无法被协作取消的同步解析可重启独立 Worker，不影响编辑器、连接和查询。
- 方言解析包按需加载；大脚本优先当前语句和作用域，不复制完整 catalog 到每个任务。
- 候选数量有上限，长备注和 SQL 内容在行内截取摘要，不以补全详情浮面板展开。候选列表关闭或光标移动后，异步元数据不能重新打开旧提示。
- 输入法组合期间不提交补全；保留 Enter 换行、Tab 缩进和 Escape 关闭语义。是否用 Enter 接受由设置显式控制。
- 学习只记录候选身份和计数，默认不记录字面值或上传 SQL。普通补全完全本地推断，AI 不进入必需链路；未来可添加显式启用的独立 Provider。
- Quick 与桌面共享引擎代码及用户配置，元数据与运行会话仍按 surface 隔离。保持独立只读会话与 200 行查询上限，不因补全自动连接或执行查询。
- 未连接时使用词法、模板、文档符号和已有缓存；需要新元数据时明确提示连接状态，沿用用户已授权的连接行为。

## 11. 分阶段实施与迁移

首版已落地统一引擎、常用查询联想与配置界面；补强轮完成冷目录选表、函数当前参数同行展示、字段组提取／排序，以及函数／枚举／局部规则／写入模板的可视化配置。阶段 0 的验证为有限 POC，阶段 4 的高级语义和更多方言认证仍需持续补充。下表保留原交付门槛，不作为全部项目已经完成的声明。

| 阶段 | 交付与门槛 |
| --- | --- |
| 0：语料与选型验证 | 建立现有行为与已发现问题的用例；解析器对比 POC；锁定首批方言与能力矩阵、打包预算 |
| 1：统一引擎骨架 | contracts、service、编辑器适配、只读 MetadataService、版本与取消；迁移既有候选和学习行为，消除双实现差异 |
| 2：高频查询体验 | SELECT 光标后 FROM、别名列、星号展开、字段组、表查询生成、可靠 FK JOIN、INSERT／UPDATE、参数签名；支持的首批方言全部过语料 |
| 3：设置与扩展 | 配置继承、模板／字段组编辑、静态枚举、试验区、导入导出、保存失败恢复、诊断与配置说明 |
| 4：高级语义与方言认证 | 复杂 CTE／嵌套／相关子查询、版本差异、特殊类型、过程签名、时序／分析方言；逐能力发布而非一次宣称全部完成 |

首批建议 MySQL、PostgreSQL、SQLite 验收常见查询体验；SQL Server／Oracle／DuckDB／ClickHouse 等按能力矩阵跟进。已有非 SQL 驱动不能因新引擎上线而回退成 SQL 词表。

每个阶段保持可用：通过配置选择已认证的新引擎方言，保留受控旧适配；对比只在固定 fixture 上运行，不双倍读取真实数据库。旧控制台、标签、文档、快捷键和撤销栈保持兼容。设置迁移失败保留旧配置与草稿，不清空用户内容。

## 12. 验收标准

- **语义正确**：光标前／后 FROM；字符串／注释中的关键字和分号；引用大小写；同名跨库对象；CTE 遮蔽、递归和派生列；相关子查询；复合外键；窗口函数与 UNION 投影。
- **编辑正确**：光标在词中间、已有引号／别名／FROM、已写字段去重、多点编辑不重叠；字段展开、字段组和查询生成统一在光标下方候选列表直接接受，无确认弹框或补全详情浮面板；单次撤销完整恢复；不展开 COUNT(*)；不静默更改查询语义。
- **状态正确**：快速切连接／标签／方言、迟到元数据、候选接受前文档变化、查询运行中补全、Escape 后不重开、断开／关闭后无旧结果回填；用户事务不被元数据占用。
- **配置正确**：继承来源可见、规则冲突、旧配置迁移、缺失字段、导入映射、非法模板、保存失败草稿保留；禁用学习后不写入也不施加历史加权。
- **性能可测**：普通语句、长脚本、大 catalog、冷／热缓存；输入响应、Worker 时间、内存峰值和元数据查询数量分别记录。
- **UI 与原生**：Monaco／轻量适配的同一语料；Quick 480×240 和 720×420；字体／主题／键盘／输入法；本机 classic／orb／Quick。浏览器 mock 通过与真实数据库、各平台原生验证分别报告。
- **构建检查**：插件构建、schema／模板验证、局部类型检查、相关单元测试、现有 UI 业务回归、manifest／distribution、宿主 typecheck。

不依靠截图证明语义正确：核心使用快照文本、光标、catalog、配置作为输入，断言候选顺序、对象归属、EditPlan 与最终 SQL。真实驱动集成验证方言引用、元数据和事务隔离；未连接的方言只报告相应静态验证范围。

参考资料：

- dt-sql-parser：[官方仓库与支持列表](https://github.com/DTStack/dt-sql-parser)、[代码补全 API](https://github.com/DTStack/dt-sql-parser#code-completion)
- node-sql-parser：[官方仓库与数据库支持列表](https://github.com/taozhi8833998/node-sql-parser)
- 本方案结合实施前源码评估与首版落地结果；第三方库已完成有限 POC，后续替换解析适配器仍需通过完整语料与打包验证。
