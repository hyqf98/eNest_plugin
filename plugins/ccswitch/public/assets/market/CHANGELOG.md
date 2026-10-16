# Changelog

## 1.0.0 (2026-10-13)

- 首个版本：全量复刻 [farion1231/cc-switch](https://github.com/farion1231/cc-switch)（Apache-2.0）的核心功能语义到 eNest 插件形态。
- 供应商管理：10 应用（Claude Code / Claude Desktop / Codex / Gemini CLI / Grok Build / OpenCode / OpenClaw / Hermes / Pi / MiniMax Code）侧栏，切换式单选启用、共存式多选添加；卡片网格（名称 / 端点域名 / 模型 / 当前使用徽章）、拖拽排序、默认供应商与使用中保护。
- 切换流程：字段级 before/after diff 预览 → `agent.write`（宿主最小侵入合并 + 自动快照）→ 徽章刷新。
- 预设库：内置 38 个预设（官方 / DeepSeek / GLM / Kimi / Qwen / OpenRouter / SiliconFlow / 云厂商 / PackyCode 及社区中转 / 自建），搜索 + 一键实例化；结构预留远程更新（url+版本）。
- 预设数据与功能语义（配置文件路径、MCP 写入位置、会话日志解析）移植自 cc-switch 源码（Apache-2.0 许可，未搬运代码，仅移植语义与公开端点数据）。
- MCP 面板：统一列表 + 10 个常用模板 + 自定义 JSON + 从应用导入；按应用逐个启用同步（claude-code → ~/.claude.json mcpServers；codex → config.toml [mcp_servers]；gemini → settings.json mcpServers（httpUrl 语义）；opencode → mcp.local/remote）。
- 会话浏览器：会话列表（项目路径 / 时间 / 消息数）→ 详情逐轮折叠（用户 / 助手 / 工具三类）、会话内搜索、复制 resume 命令（claude --resume 等）、导出 Markdown。
- 用量统计：token 总量 / 输入输出缓存拆分 / 请求数 / 按日趋势条形图 / 年度热力图（纯前端 canvas，主题 token 配色）/ 模型分布；解析 claude message.usage、codex token_count、gemini tokens 三种语义。
- 测试与观测：连接测试（/v1/models 或 HEAD，5s 超时，可达性 + 延迟）；余额查询入口（预设带 quotaEndpoint 时显示）。
- 集成：Quick 搜索「cc 名称」直达切换（contribute.registerQuickProvider）；homeCard；设置页（默认应用 / diff 确认开关 / 备份策略展示）。
- 备份页：宿主快照列表 + 恢复（保留 20 份）。
- 项目预设：供应商 + MCP 整套保存 / 应用。
- 通用供应商：一份配置绑定多应用同步切换。
- 依赖宿主波 0 能力：`config.agent`（含 agent.sessions.list / agent.sessions.read 只读通道、claude-code ~/.claude.json mcpServers 白名单）。
