/**
 * com.enest.ccswitch — 内置预设库
 * 预设数据移植自 farion1231/cc-switch（Apache-2.0）README 与社区供应商清单的
 * 公开端点/模型语义（不含任何密钥）；支持后续远程更新（结构预留 url+version）。
 * 命名空间挂 window.CCS.presets。
 */
;(function (global) {
  /* 预设结构：
     { id, name, tag, baseUrl, model, apps: [...], quotaEndpoint? }
     - tag: 官方 / DeepSeek / GLM / Kimi / Qwen / OpenRouter / SiliconFlow / 社区中转 / 自建
     - quotaEndpoint: 余额查询端点（有则 UI 显示余额入口）
     - remote: 预留远程更新源（当前内置） */

  const PRESETS = [
    // —— 官方 ——
    { id: 'official-anthropic', name: 'Anthropic 官方', tag: '官方', baseUrl: '', model: 'claude-sonnet-4-5', apps: ['claude-code', 'claude-desktop'] },
    { id: 'official-openai', name: 'OpenAI 官方', tag: '官方', baseUrl: '', model: 'gpt-5', apps: ['codex'] },
    { id: 'official-google', name: 'Google 官方', tag: '官方', baseUrl: '', model: 'gemini-2.5-pro', apps: ['gemini-cli'] },
    { id: 'official-xai', name: 'xAI 官方', tag: '官方', baseUrl: 'https://api.x.ai', model: 'grok-4', apps: ['grok-build'] },

    // —— DeepSeek ——
    { id: 'deepseek-official', name: 'DeepSeek 官方', tag: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apps: ['claude-code', 'codex', 'gemini-cli'], quotaEndpoint: 'https://api.deepseek.com/user/balance' },
    { id: 'deepseek-anthropic', name: 'DeepSeek（Anthropic 格式）', tag: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-chat', apps: ['claude-code'], quotaEndpoint: 'https://api.deepseek.com/user/balance' },

    // —— GLM（智谱）——
    { id: 'glm-official', name: '智谱 GLM', tag: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6', apps: ['claude-code'], quotaEndpoint: 'https://open.bigmodel.cn/api/paas/v4/users/balance' },
    { id: 'glm-coding-plan', name: '智谱 GLM Coding Plan', tag: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.5-air', apps: ['claude-code'] },
    { id: 'glm-bigmodel-openai', name: '智谱（OpenAI 格式）', tag: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', apps: ['codex', 'opencode'] },

    // —— Kimi（月之暗面）——
    { id: 'kimi-official', name: 'Kimi 官方', tag: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-0905-preview', apps: ['claude-code'] },
    { id: 'kimi-openai', name: 'Kimi（OpenAI 格式）', tag: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview', apps: ['codex', 'opencode'] },
    { id: 'kimi-anthropic-cn', name: 'Kimi Anthropic 端点', tag: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k2-turbo-preview', apps: ['claude-code'] },

    // —— Qwen（阿里）——
    { id: 'qwen-official', name: '阿里云百炼 Qwen', tag: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy', model: 'qwen3-coder-plus', apps: ['claude-code'] },
    { id: 'qwen-openai', name: 'Qwen（OpenAI 格式）', tag: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus', apps: ['codex', 'opencode'] },
    { id: 'qwen-intl', name: 'Qwen 国际站', tag: 'Qwen', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model: 'qwen3-coder-plus', apps: ['codex'] },

    // —— OpenRouter ——
    { id: 'openrouter-main', name: 'OpenRouter', tag: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', apps: ['claude-code', 'codex', 'opencode'], quotaEndpoint: 'https://openrouter.ai/api/v1/credits' },
    { id: 'openrouter-gpt5', name: 'OpenRouter GPT-5', tag: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', apps: ['codex'], quotaEndpoint: 'https://openrouter.ai/api/v1/credits' },

    // —— SiliconFlow（硅基流动）——
    { id: 'siliconflow-kimi', name: 'SiliconFlow Kimi K2', tag: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn', model: 'moonshotai/Kimi-K2-Instruct', apps: ['codex', 'opencode'] },
    { id: 'siliconflow-deepseek', name: 'SiliconFlow DeepSeek V3', tag: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn', model: 'deepseek-ai/DeepSeek-V3', apps: ['codex', 'opencode'] },
    { id: 'siliconflow-qwen', name: 'SiliconFlow Qwen3 Coder', tag: 'SiliconFlow', baseUrl: 'https://api.siliconflow.cn', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', apps: ['codex', 'opencode'] },

    // —— 模型工场 / 云厂商 ——
    { id: 'volces-doubao', name: '火山方舟 豆包', tag: '云厂商', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-seed-1-6', apps: ['codex', 'opencode'] },
    { id: 'volces-doubao-cc', name: '火山方舟（Claude Code）', tag: '云厂商', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/anthropic', model: 'doubao-seed-1-6-250615', apps: ['claude-code'] },
    { id: 'tencent-hunyuan', name: '腾讯混元', tag: '云厂商', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbos', apps: ['codex', 'opencode'] },
    { id: 'baidu-qianfan', name: '百度千帆', tag: '云厂商', baseUrl: 'https://qianfan.baidubce.com/v2', model: 'deepseek-v3', apps: ['codex'] },
    { id: 'stepfun', name: '阶跃星辰', tag: '云厂商', baseUrl: 'https://api.stepfun.com/v1', model: 'step-3', apps: ['codex', 'opencode'] },
    { id: 'minimax-official', name: 'MiniMax 官方', tag: '云厂商', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2', apps: ['codex', 'minimax-code'] },

    // —— PackyCode 及社区中转 ——
    { id: 'packycode', name: 'PackyCode', tag: '社区中转', baseUrl: 'https://ai.gpt-open.com/api', model: 'claude-sonnet-4-5', apps: ['claude-code', 'codex'] },
    { id: 'aicodemirror', name: 'AI Code Mirror', tag: '社区中转', baseUrl: 'https://api.aicodemirror.com', model: 'claude-sonnet-4-5', apps: ['claude-code'] },
    { id: '88code', name: '88Code', tag: '社区中转', baseUrl: 'https://api.88code.com', model: 'claude-sonnet-4-5', apps: ['claude-code', 'codex'] },
    { id: 'duckcoding', name: 'DuckCoding', tag: '社区中转', baseUrl: 'https://api.duckcoding.com', model: 'claude-sonnet-4-5', apps: ['claude-code'] },
    { id: 'akiacode', name: 'AKIA Code', tag: '社区中转', baseUrl: 'https://api.akia-api.com', model: 'claude-sonnet-4-5', apps: ['claude-code'] },
    { id: 'new-api-self', name: 'New API 自建中转', tag: '自建', baseUrl: 'https://your-new-api.example.com/v1', model: 'gpt-5', apps: ['claude-code', 'codex', 'gemini-cli', 'opencode'] },
    { id: 'oneapi-self', name: 'One API 自建中转', tag: '自建', baseUrl: 'https://your-oneapi.example.com/v1', model: 'deepseek-chat', apps: ['claude-code', 'codex', 'opencode'] },
    { id: 'ollama-local', name: 'Ollama 本地', tag: '自建', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b', apps: ['codex', 'opencode'] },
    { id: 'llamacpp-local', name: 'llama.cpp 本地', tag: '自建', baseUrl: 'http://127.0.0.1:8080/v1', model: 'local-model', apps: ['codex', 'opencode'] },
    { id: 'litellm-proxy', name: 'LiteLLM 代理', tag: '自建', baseUrl: 'http://127.0.0.1:4000/v1', model: 'gpt-5', apps: ['codex', 'opencode'] },
    { id: 'openai-compatible', name: '通用 OpenAI 兼容端点', tag: '自建', baseUrl: 'https://your-endpoint.example.com/v1', model: 'your-model', apps: ['codex', 'gemini-cli', 'opencode'] }
  ]

  /** 预设元信息：内置版本 + 远程更新源预留（当前不请求网络） */
  const META = {
    version: 1,
    source: '内置（移植自 cc-switch Apache-2.0 社区清单）',
    remote: { url: '', version: 0, enabled: false } // 后续远程更新预留
  }

  function search(q) {
    const kw = String(q || '').trim().toLowerCase()
    if (!kw) return PRESETS.slice()
    return PRESETS.filter(p =>
      (p.name + ' ' + p.tag + ' ' + p.baseUrl + ' ' + p.model).toLowerCase().includes(kw)
    )
  }

  function byId(id) {
    return PRESETS.find(p => p.id === id) || null
  }

  function tags() {
    const set = new Set(PRESETS.map(p => p.tag))
    return [...set]
  }

  /** 预设 → 供应商实例（不含密钥；secretRef 由用户保存时录入 vault） */
  function instantiate(preset, overrides) {
    return {
      id: '',
      name: preset.name,
      tag: preset.tag,
      baseUrl: preset.baseUrl || '',
      model: preset.model || '',
      secretRef: '',
      apps: [...preset.apps],
      extraEnv: null,
      tomlExtra: null,
      quotaEndpoint: preset.quotaEndpoint || '',
      universal: false,
      ...(overrides || {})
    }
  }

  global.CCS = global.CCS || {}
  global.CCS.presets = { PRESETS, META, search, byId, tags, instantiate }
})(window)
