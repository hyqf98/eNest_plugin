/**
 * promptOptimizer — 「一键优化提示词」：用一门语言模型，按目标生图模型的标准把用户的提示词扩写。
 *
 * 三部分：
 *   1. 语言模型配置的读写（OpenAI 兼容 /chat/completions；密钥只存宿主保险库，页面只留 secretRef）
 *   2. 内置的优化标准（按目标生图模型的「家族」区分）
 *   3. optimizePrompt()：把标准 + 目标模型 + 用户提示词交给语言模型
 *
 * 关于优化标准的出处（如实说明，不要当成厂商官方文案）：
 * - 「nano-banana / Gemini」一套：参考 Google 官方《Image generation》指南里的最佳实践与提示词模板
 *   （ai.google.dev/gemini-api/docs/image-generation）。
 * - 「gpt-image」一套：OpenAI 官方提示词指南当时无法访问（403），这一套是本插件按通用原则整理的，
 *   不是 OpenAI 的官方文本。
 * - 其他模型：走通用一套。
 */

import { requestJson } from './netFetch.mjs'

const CONFIG_KEY = 'image-gen.llm.v1'
const VAULT_PREFIX = 'image-gen.llm.'

function store() {
  const enest = window.enest || window.zapi
  if (!enest?.storage) throw new Error('宿主存储接口不可用')
  return enest
}

/* —— 1. 配置 —— */

/* 出厂不预填地址和模型：预填会让「是否已配置」的判断失真——用户什么都没填却被当成已配置，
   点优化时拿空密钥去请求，得到的是 401 报错而不是「请先配置」。建议值放在输入框的 placeholder 里。 */
export const DEFAULT_LLM = {
  baseUrl: '',
  model: '',
  secretRef: '',
  // 目标生图模型家族：gpt-image | nano-banana | generic；空 = 按当前生图模型自动判断
  target: ''
}

export const TARGETS = [
  { id: 'nano-banana', label: 'Nano Banana / Gemini', hint: '叙述式指令：讲清动作、场景、镜头与光线' },
  { id: 'gpt-image', label: 'GPT Image', hint: '具体、有上下文：说明主体、环境、风格与用途' },
  { id: 'generic', label: '通用', hint: '主体 + 环境 + 风格 + 光线 + 构图的通用结构' }
]

/** 把用户填的地址规整成 OpenAI 兼容的根（末段非 /vN 时补 /v1），与生图渠道同一规则 */
export function normalizeLlmBaseUrl(input) {
  let url = String(input ?? '').trim().replace(/\/+$/, '')
  if (!url) return ''
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

export async function loadLlm() {
  try {
    const saved = await store().storage.get(CONFIG_KEY)
    if (saved && typeof saved === 'object') return { ...DEFAULT_LLM, ...saved }
  } catch { /* 首次 */ }
  return { ...DEFAULT_LLM }
}

/** 保存配置；apiKey 非空时写入保险库并只保留 secretRef */
export async function saveLlm(config, apiKey) {
  const record = { ...config, baseUrl: normalizeLlmBaseUrl(config.baseUrl) }
  if (apiKey && apiKey.trim()) {
    const vaultKey = `${VAULT_PREFIX}default`
    const res = await store().vault.set(vaultKey, apiKey.trim())
    record.secretRef = res?.secretRef ?? vaultKey
  }
  await store().storage.set(CONFIG_KEY, record)
  return record
}

/* —— 2. 内置优化标准 —— */

/** 目标生图模型家族：按模型名推断，用户可在设置里覆盖。
    dall-e 的提示词风格与 gpt-image 差异较大（偏关键词、长度受限），不并入 gpt-image 一套，走通用。 */
export function detectTarget(imageModel) {
  const name = String(imageModel ?? '').toLowerCase()
  if (/nano|banana|gemini|imagen/.test(name)) return 'nano-banana'
  if (/gpt-image/.test(name)) return 'gpt-image'
  return 'generic'
}

const STANDARDS = {
  'nano-banana': {
    label: 'Nano Banana / Gemini',
    rules: [
      '用完整的自然语言句子叙述画面，像在向一位摄影师描述拍摄要求，不要堆砌逗号分隔的关键词。',
      '按「主体 → 动作/姿态 → 环境/场景 → 光线 → 镜头与构图」的顺序组织，让每句话只讲一件事。',
      '把主体写得具体可辨：年龄、外貌、服装材质、颜色，而不是「一个人」「好看的衣服」。',
      '明确光线：光源位置、软硬、色温、时间（如「清晨斜射的窗光，柔和偏暖」）。',
      '需要摄影感时写清景别（特写/半身/全身/远景）、机位（平视/俯拍/低角度）和镜头（35mm、85mm 人像、微距）。',
      '不要用「不要出现 X」来排除元素——模型容易反而画出来。改为直接描述希望出现的替代内容。',
      '画面里要出现文字时，用引号把文字原样写出来，并说明字体风格和位置。',
      '保留用户原意里所有的具体元素、数量和关系，不要替换成别的东西。'
    ],
    template: '{主体描述}，{动作}，位于{场景}。{光线描述}。{景别}，{机位}视角，{镜头}。{风格与质感}。'
  },
  'gpt-image': {
    label: 'GPT Image',
    rules: [
      '用清晰具体的陈述句描述画面；模型对细节的遵循度高，写到多具体就画到多具体。',
      '说明主体的关键特征（外形、材质、颜色、状态）以及它与环境的空间关系。',
      '交代画面用途或语境（如「电商主图」「书籍封面」「应用图标」），帮助模型判断构图重心与留白。',
      '风格要指明参照系：媒介（摄影/插画/3D 渲染/水彩）、年代、地域或流派，而不只写「高级感」。',
      '需要文字时把原文放在引号里，并描述字体气质、大小关系和在画面中的位置。',
      '构图给出明确指令：主体位置（居中/三分线/偏左）、留白方向、画面比例带来的取舍。',
      '保留用户原意里所有的具体元素、数量和关系，不要替换成别的东西。'
    ],
    template: '{画面类型}：{主体}，{主体细节}。{环境与背景}。{构图与留白}。{风格参照}。{光线}。'
  },
  generic: {
    label: '通用',
    rules: [
      '用完整句子描述画面，按「主体 → 环境 → 风格 → 光线 → 构图」的顺序组织。',
      '把主体写得具体可辨，说明它的材质、颜色和状态。',
      '指明风格参照（摄影/插画/3D/水彩等）与光线条件。',
      '需要文字时用引号写出原文，并说明字体风格和位置。',
      '保留用户原意里所有的具体元素、数量和关系，不要替换成别的东西。'
    ],
    template: '{主体}，{主体细节}，位于{环境}。{风格}，{光线}，{构图}。'
  }
}

/** 取某家族的优化标准（不存在时回落到通用） */
export function getStandard(target) {
  return STANDARDS[target] ?? STANDARDS.generic
}

function buildSystemPrompt(target, imageModel) {
  const standard = getStandard(target)
  return [
    '你是一位资深的文生图提示词工程师。你的任务是把用户的提示词改写成更适合目标生图模型、更具体、更可执行的版本。',
    '',
    `目标生图模型：${imageModel}（${standard.label}）`,
    '',
    '请按以下标准改写：',
    ...standard.rules.map((rule, i) => `${i + 1}. ${rule}`),
    '',
    `可参考的结构（按需取舍，不必逐项填满）：${standard.template}`,
    '',
    '硬性要求：',
    '- 只输出改写后的提示词本身，不要任何解释、前言、标题或 Markdown 代码块。',
    `- 保持与用户输入相同的语言（用户用中文就输出中文）。`,
    '- 不得改变用户的核心意图；可以补充合理的细节，但不要引入用户没有提到、且会明显改变画面主题的新主体。',
    '- 用户输入里用 [方括号] 或 {花括号} 标出的占位符，原样保留（用户稍后会自己替换）。',
    '- 用户用引号标出的画面文字，原样保留。',
    '- 如果用户的输入已经足够具体，只做必要的补全，不要为了变长而堆砌形容词。',
    '- 输出一段连贯的文字，通常 60 到 200 字。'
  ].join('\n')
}

/* —— 3. 调用 —— */

/**
 * 优化提示词。返回改写后的文本。
 * @param {{ prompt: string, imageModel: string, target?: string, llm: object }} args
 */
export async function optimizePrompt({ prompt, imageModel, target, llm }) {
  const text = String(prompt ?? '').trim()
  if (!text) throw new Error('输入框是空的，先写下想画的画面')
  if (!llm?.baseUrl || !llm?.model) throw new Error('还没有配置语言模型，先去「设置 → 优化提示词」填一个')
  const family = target || detectTarget(imageModel)
  const data = await requestJson({
    url: `${normalizeLlmBaseUrl(llm.baseUrl)}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    secretRef: llm.secretRef,
    body: {
      model: llm.model,
      // 约束输出长度：提示词本身很短，留足余量即可，避免模型借机长篇大论
      max_tokens: 600,
      temperature: 0.7,
      messages: [
        { role: 'system', content: buildSystemPrompt(family, imageModel || standardLabel(family)) },
        { role: 'user', content: text }
      ]
    }
  })
  const out = data?.choices?.[0]?.message?.content
  if (typeof out !== 'string' || !out.trim()) throw new Error('语言模型没有返回内容')
  // 个别模型会不听话地包上 ``` 或「优化后：」，剥掉这些包装
  return out.trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').replace(/^(优化后|改写后|提示词)[:：]\s*/i, '').trim()
}

function standardLabel(family) {
  return getStandard(family).label
}

/**
 * 连通性测试：发一条极短的对话（限制输出 5 个 token，几乎不耗量），只看能不能通。
 * plainKey：用户刚输入、还没存进保险库的密钥。只在这一次请求里临时带成 Authorization 头，不落盘。
 *            不传时走已保存的 secretRef。
 */
export async function testLlm(llm, { plainKey = '' } = {}) {
  if (!isLlmConfigured(llm)) throw new Error('接口地址与模型必填')
  const data = await requestJson({
    url: `${normalizeLlmBaseUrl(llm.baseUrl)}/chat/completions`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(plainKey.trim() ? { Authorization: `Bearer ${plainKey.trim()}` } : {})
    },
    secretRef: plainKey.trim() ? '' : llm.secretRef,
    body: { model: llm.model, max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }
  })
  const out = data?.choices?.[0]?.message?.content
  if (typeof out !== 'string') throw new Error('接口可用，但响应里没有对话内容')
  return { ok: true }
}

/** 是否已配置到可用的程度（地址 + 模型；密钥允许为空——本地模型/中转站有的不校验） */
export function isLlmConfigured(llm) {
  return Boolean(llm?.baseUrl && llm?.model)
}
