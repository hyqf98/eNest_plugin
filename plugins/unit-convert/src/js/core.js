/** 单位换算 / 进制 / 汇率 / 人民币大写纯逻辑。供页面与 node 自测共用。 */

// —— 类目与单位定义（factor = 换算到基准单位 1 单位 = factor 基准） ——//
export const CATEGORIES = {
  length: {
    name: '长度',
    units: [
      { id: 'km', name: '千米', factor: 1000 },
      { id: 'm', name: '米', factor: 1 },
      { id: 'dm', name: '分米', factor: 0.1 },
      { id: 'cm', name: '厘米', factor: 0.01 },
      { id: 'mm', name: '毫米', factor: 0.001 },
      { id: 'mi', name: '英里', factor: 1609.344 },
      { id: 'yd', name: '码', factor: 0.9144 },
      { id: 'ft', name: '英尺', factor: 0.3048 },
      { id: 'in', name: '英寸', factor: 0.0254 },
      { id: 'nmi', name: '海里', factor: 1852 },
    ],
  },
  area: {
    name: '面积',
    units: [
      { id: 'km2', name: '平方千米', factor: 1e6 },
      { id: 'ha', name: '公顷', factor: 1e4 },
      { id: 'mu', name: '亩', factor: 2000 / 3 },
      { id: 'm2', name: '平方米', factor: 1 },
      { id: 'dm2', name: '平方分米', factor: 0.01 },
      { id: 'cm2', name: '平方厘米', factor: 1e-4 },
      { id: 'mi2', name: '平方英里', factor: 2589988.110336 },
      { id: 'acre', name: '英亩', factor: 4046.8564224 },
      { id: 'ft2', name: '平方英尺', factor: 0.09290304 },
      { id: 'in2', name: '平方英寸', factor: 0.00064516 },
    ],
  },
  volume: {
    name: '体积',
    units: [
      { id: 'm3', name: '立方米', factor: 1000 },
      { id: 'L', name: '升', factor: 1 },
      { id: 'dL', name: '分升', factor: 0.1 },
      { id: 'cL', name: '厘升', factor: 0.01 },
      { id: 'mL', name: '毫升', factor: 0.001 },
      { id: 'galUS', name: '美制加仑', factor: 3.785411784 },
      { id: 'galUK', name: '英制加仑', factor: 4.54609 },
      { id: 'qt', name: '夸脱(美)', factor: 0.946352946 },
      { id: 'pt', name: '品脱(美)', factor: 0.473176473 },
      { id: 'cup', name: '杯', factor: 0.2365882365 },
      { id: 'flozUS', name: '液量盎司(美)', factor: 0.0295735295625 },
      { id: 'tbsp', name: '汤匙', factor: 0.01478676478125 },
      { id: 'tsp', name: '茶匙', factor: 0.00492892159375 },
    ],
  },
  mass: {
    name: '质量',
    units: [
      { id: 't', name: '吨', factor: 1e6 },
      { id: 'kg', name: '千克', factor: 1000 },
      { id: 'g', name: '克', factor: 1 },
      { id: 'mg', name: '毫克', factor: 0.001 },
      { id: 'dan', name: '担', factor: 50000 },
      { id: 'jin', name: '斤', factor: 500 },
      { id: 'liang', name: '两', factor: 50 },
      { id: 'qian', name: '钱', factor: 5 },
      { id: 'lb', name: '磅', factor: 453.59237 },
      { id: 'oz', name: '盎司', factor: 28.349523125 },
      { id: 'ct', name: '克拉', factor: 0.2 },
    ],
  },
  temp: { name: '温度', units: [] }, // 特殊处理
  speed: {
    name: '速度',
    units: [
      { id: 'kmh', name: '千米/时', factor: 1 / 3.6 },
      { id: 'ms', name: '米/秒', factor: 1 },
      { id: 'mph', name: '英里/时', factor: 0.44704 },
      { id: 'kn', name: '节', factor: 1852 / 3600 },
      { id: 'fts', name: '英尺/秒', factor: 0.3048 },
      { id: 'mach', name: '马赫', factor: 340.29 },
    ],
  },
  data: {
    name: '数据量',
    units: [
      { id: 'bit', name: '比特', factor: 1 },
      { id: 'B', name: '字节', factor: 8 },
      { id: 'KB', name: 'KB', factor: 8 * 1024 },
      { id: 'MB', name: 'MB', factor: 8 * 1024 ** 2 },
      { id: 'GB', name: 'GB', factor: 8 * 1024 ** 3 },
      { id: 'TB', name: 'TB', factor: 8 * 1024 ** 4 },
      { id: 'PB', name: 'PB', factor: 8 * 1024 ** 5 },
    ],
  },
  time: {
    name: '时间',
    units: [
      { id: 'ns', name: '纳秒', factor: 1e-6 },
      { id: 'us', name: '微秒', factor: 0.001 },
      { id: 'ms', name: '毫秒', factor: 1 },
      { id: 's', name: '秒', factor: 1000 },
      { id: 'min', name: '分钟', factor: 60000 },
      { id: 'h', name: '小时', factor: 3600000 },
      { id: 'd', name: '天', factor: 86400000 },
      { id: 'wk', name: '周', factor: 604800000 },
    ],
  },
  pressure: {
    name: '压力',
    units: [
      { id: 'Pa', name: '帕斯卡', factor: 1 },
      { id: 'kPa', name: '千帕', factor: 1000 },
      { id: 'MPa', name: '兆帕', factor: 1e6 },
      { id: 'bar', name: '巴', factor: 1e5 },
      { id: 'atm', name: '标准大气压', factor: 101325 },
      { id: 'at', name: '工程大气压', factor: 98066.5 },
      { id: 'mmHg', name: '毫米汞柱', factor: 133.322387415 },
      { id: 'psi', name: '磅/平方英寸', factor: 6894.757293168 },
    ],
  },
  energy: {
    name: '能量',
    units: [
      { id: 'J', name: '焦耳', factor: 1 },
      { id: 'kJ', name: '千焦', factor: 1000 },
      { id: 'cal', name: '卡路里', factor: 4.184 },
      { id: 'kcal', name: '千卡', factor: 4184 },
      { id: 'Wh', name: '瓦时', factor: 3600 },
      { id: 'kWh', name: '千瓦时', factor: 3.6e6 },
      { id: 'BTU', name: '英热单位', factor: 1055.05585262 },
      { id: 'eV', name: '电子伏特', factor: 1.602176634e-19 },
    ],
  },
  radix: { name: '进制', units: [] }, // 特殊处理
  fx: { name: '汇率', units: [] }, // 特殊处理（桌面区）
}

export const TAB_ORDER = ['length', 'area', 'volume', 'mass', 'temp', 'speed', 'data', 'time', 'pressure', 'energy', 'radix', 'fx']

/** 温度换算：to/from 摄氏 */
const TO_C = { C: (v) => v, F: (v) => ((v - 32) * 5) / 9, K: (v) => v - 273.15 }
const FROM_C = { C: (v) => v, F: (v) => (v * 9) / 5 + 32, K: (v) => v + 273.15 }
export const TEMP_UNITS = [
  { id: 'C', name: '摄氏度 °C' },
  { id: 'F', name: '华氏度 °F' },
  { id: 'K', name: '开尔文 K' },
]

export const RADIX_BASES = [2, 8, 10, 16]

/** 任意类目内单位联动：sourceId 输入 value，返回其余单位值（保留 10 位有效数字）
 *  opts.precision：有效数字位数（4-15，默认 12） */
export function convertAll(category, sourceId, value, opts = {}) {
  const precision = Math.max(4, Math.min(15, Number(opts.precision) || 12))
  if (category === 'temp') {
    const toC = TO_C[sourceId]
    if (!toC || !Number.isFinite(value)) return {}
    const c = toC(value)
    const out = {}
    for (const u of TEMP_UNITS) out[u.id] = round(FROM_C[u.id](c), precision)
    return out
  }
  if (category === 'radix') {
    return {}
  }
  const cat = CATEGORIES[category]
  if (!cat) return {}
  const src = cat.units.find((u) => u.id === sourceId)
  if (!src || !Number.isFinite(value)) return {}
  const base = value * src.factor
  const out = {}
  for (const u of cat.units) out[u.id] = round(base / u.factor, precision)
  return out
}

function round(n, precision = 12) {
  if (!Number.isFinite(n)) return n
  if (n === 0) return 0
  const abs = Math.abs(n)
  const digits = abs >= 1e12 || abs < 1e-9 ? 8 : Math.max(0, precision - Math.floor(Math.log10(abs)) - 1)
  return Number(n.toFixed(Math.min(digits, precision)))
}

/** 换算公式展示文本：1 fromUnit = r toUnit（含公式链说明；温度用表达式） */
export function formulaText(category, fromId, toId) {
  if (category === 'temp') {
    const from = TEMP_UNITS.find((u) => u.id === fromId)
    const to = TEMP_UNITS.find((u) => u.id === toId)
    if (!from || !to || fromId === toId) return ''
    const expr = { C: '°C', F: '°F', K: 'K' }
    if (fromId === 'C') return `°F = °C × 9/5 + 32；K = °C + 273.15 中的 ${to.name.split(' ')[0]}`
    if (fromId === 'F' && toId === 'C') return '°C = (°F − 32) × 5/9'
    if (fromId === 'F' && toId === 'K') return 'K = (°F − 32) × 5/9 + 273.15'
    if (fromId === 'K' && toId === 'C') return '°C = K − 273.15'
    if (fromId === 'K' && toId === 'F') return '°F = (K − 273.15) × 9/5 + 32'
    return `${to.name} = f(${expr[fromId]})`
  }
  const cat = CATEGORIES[category]
  if (!cat) return ''
  const from = cat.units.find((u) => u.id === fromId)
  const to = cat.units.find((u) => u.id === toId)
  if (!from || !to || fromId === toId) return ''
  const r = round(from.factor / to.factor)
  const rText = formatNumber(r)
  return `1 ${from.name} = ${rText} ${to.name}`
}

/** 数值格式化：千分位 + 有效数字；opts.scientific 强制科学计数 */
export function formatNumber(n, opts = {}) {
  if (!Number.isFinite(n)) return '—'
  if (Object.is(n, -0)) n = 0
  if (opts.scientific || Math.abs(n) >= 1e15 || (Math.abs(n) !== 0 && Math.abs(n) < 1e-9)) return n.toExponential(6)
  // 先按 12 位有效数字收敛，消除浮点噪声（0.1+0.2 → 0.3）
  let s = String(Number(n.toPrecision(12)))
  if (s.includes('e')) {
    s = n.toFixed(12)
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  const neg = s.startsWith('-')
  if (neg) s = s.slice(1)
  const [int, frac] = s.split('.')
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return (neg ? '-' : '') + withSep + (frac ? '.' + frac : '')
}

/** 解析输入（允许千分位逗号、全角数字与全角小数点） */
export function parseInput(text) {
  const cleaned = String(text ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[,，\s]/g, '')
  if (!cleaned) return NaN
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return NaN
  return Number(cleaned)
}

/** 进制解析与格式化 */
export function parseRadix(text, base) {
  let cleaned = String(text ?? '').trim().toLowerCase()
  const prefixes = { 16: '0x', 8: '0o', 2: '0b' }
  if (prefixes[base] && cleaned.startsWith(prefixes[base])) cleaned = cleaned.slice(2)
  if (!cleaned) return null
  const digits = base === 16 ? /[0-9a-f]/ : base === 8 ? /[0-7]/ : base === 2 ? /[01]/ : /[0-9]/
  if (!cleaned.split('').every((c) => digits.test(c))) return null
  const n = parseInt(cleaned, base)
  return Number.isSafeInteger(n) ? n : NaN
}
export function formatRadix(n, base, { group = false } = {}) {
  if (!Number.isFinite(n)) return '—'
  const neg = n < 0
  const s = Math.abs(Math.trunc(n)).toString(base).toUpperCase()
  const grouped = group && base === 2 ? s.replace(/\B(?=(\d{4})+(?!\d))/g, ' ') : s
  return (neg ? '-' : '') + grouped
}

/** 全角数字 → 半角 */
export function normalizeDigits(text) {
  return String(text ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

// —— 人民币大写（票据规则）与中文数字 ——//
const CN_DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖']
const CN_SMALL = ['', '拾', '佰', '仟']
const CN_BIG = ['', '万', '亿', '兆', '京']

/** 整数（非负安全整数）→ 大写中文数字；跨段零按票据规则补「零」 */
export function integerToCnUpper(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('需非负整数')
  if (n === 0) return '零'
  // 每 4 位一段，从低位到高位
  const sections = []
  let rest = n
  while (rest > 0) {
    sections.push(rest % 10000)
    rest = Math.floor(rest / 10000)
  }
  const parts = []
  for (let i = sections.length - 1; i >= 0; i--) {
    const sec = sections[i]
    if (sec === 0) continue
    let s = ''
    let zeroPending = false
    for (let pos = 3; pos >= 0; pos--) {
      const d = Math.floor(sec / 10 ** pos) % 10
      if (d === 0) {
        if (s) zeroPending = true
        continue
      }
      if (zeroPending) {
        s += '零'
        zeroPending = false
      }
      s += CN_DIGITS[d] + CN_SMALL[pos]
    }
    s += CN_BIG[i] || ''
    // 非最高段且本段 < 1000（首位缺千），与前段之间需要补零
    if (parts.length && sec < 1000) s = '零' + s
    // 非最高段且本段 < 100（如 15 万）按口语也读「壹拾伍万」，无需额外处理
    parts.push(s)
  }
  let out = parts.join('')
  // 清理可能连续的零
  out = out.replace(/零{2,}/g, '零')
  // 「亿/万」前的段若为 0 已跳过；避免「亿万」直接相邻缺零的情况：如 1_0000_0001 → 壹亿零壹
  return out
}

/** 金额 → 人民币票据大写（到分；四舍五入） */
export function toRmbUpper(value) {
  let amount = typeof value === 'number' ? value : parseInput(value)
  if (!Number.isFinite(amount)) return '—'
  if (Math.abs(amount) >= 1e16) return '—'
  const neg = amount < 0
  amount = Math.round(Math.abs(amount) * 100)
  const yuan = Math.floor(amount / 100)
  const jiao = Math.floor((amount % 100) / 10)
  const fen = amount % 10
  if (yuan === 0 && jiao === 0 && fen === 0) return '零元整'
  let out = ''
  if (yuan > 0) out += integerToCnUpper(yuan) + '元'
  if (jiao === 0 && fen === 0) {
    out += '整'
  } else if (jiao === 0) {
    if (yuan > 0) out += '零'
    out += CN_DIGITS[fen] + '分'
  } else {
    out += CN_DIGITS[jiao] + '角'
    if (fen > 0) out += CN_DIGITS[fen] + '分'
    else out += '整'
  }
  return (neg ? '负' : '') + out
}

/** 中文数字（小写口语式）：如 1024 → 一千零二十四 */
export function toChineseNumber(value) {
  let n = typeof value === 'number' ? value : parseInput(value)
  if (!Number.isFinite(n)) return '—'
  if (!Number.isSafeInteger(Math.trunc(n))) {
    n = Math.trunc(n)
    if (!Number.isSafeInteger(n)) return '—'
  }
  n = Math.trunc(n)
  if (Object.is(n, -0)) n = 0
  if (n === 0) return '零'
  const neg = n < 0
  const upper = integerToCnUpper(Math.abs(n))
  const lower = upper
    .replace(/壹/g, '一').replace(/贰/g, '二').replace(/叁/g, '三').replace(/肆/g, '四')
    .replace(/伍/g, '五').replace(/陆/g, '六').replace(/柒/g, '七').replace(/捌/g, '八')
    .replace(/玖/g, '九').replace(/拾/g, '十').replace(/佰/g, '百').replace(/仟/g, '千')
  return (neg ? '负' : '') + lower
}

// —— 汇率 ——//
export const FX_CURRENCIES = [
  { id: 'USD', name: '美元' },
  { id: 'CNY', name: '人民币' },
  { id: 'EUR', name: '欧元' },
  { id: 'JPY', name: '日元' },
  { id: 'GBP', name: '英镑' },
  { id: 'HKD', name: '港币' },
  { id: 'KRW', name: '韩元' },
  { id: 'SGD', name: '新加坡元' },
  { id: 'AUD', name: '澳元' },
  { id: 'CAD', name: '加元' },
  { id: 'CHF', name: '瑞士法郎' },
  { id: 'NZD', name: '新西兰元' },
  { id: 'THB', name: '泰铢' },
  { id: 'MYR', name: '林吉特' },
  { id: 'RUB', name: '卢布' },
  { id: 'INR', name: '印度卢比' },
]
const FX_FALLBACK_RATES = {
  USD: 1, CNY: 7.12, EUR: 0.92, JPY: 151.2, GBP: 0.79, HKD: 7.81, KRW: 1347.5,
  SGD: 1.34, AUD: 1.52, CAD: 1.36, CHF: 0.9, NZD: 1.64, THB: 35.8, MYR: 4.72, RUB: 92.5, INR: 83.3,
}
const CACHE_TTL = 24 * 3600 * 1000

export function isCacheFresh(cache, now = Date.now()) {
  return !!cache && Number(cache.fetchedAt) > 0 && now - Number(cache.fetchedAt) < CACHE_TTL && cache.rates && typeof cache.rates === 'object'
}

/** 解析 open.er-api.com 响应 → { rates, fetchedAt } */
export function parseFxResponse(body, now = Date.now()) {
  const data = JSON.parse(String(body))
  if (data?.result !== 'success' || !data.rates || typeof data.rates !== 'object') throw new Error('汇率响应格式异常')
  const rates = {}
  for (const c of FX_CURRENCIES) {
    const v = Number(data.rates[c.id])
    if (Number.isFinite(v) && v > 0) rates[c.id] = v
  }
  if (!rates.USD) throw new Error('汇率数据缺少 USD')
  return { rates, fetchedAt: now }
}

/** 以 base 为基准把 USD 报价换算为 cross rate：1 base = r(base) 单位 target */
export function crossRate(rates, base, target) {
  const rb = rates[base]
  const rt = rates[target]
  if (!rb || !rt) return NaN
  return rt / rb
}

export function fxConvert(rates, base, amount) {
  const out = {}
  for (const c of FX_CURRENCIES) {
    if (c.id === base) {
      out[c.id] = amount
      continue
    }
    const r = crossRate(rates, base, c.id)
    out[c.id] = Number.isFinite(r) ? round(amount * r) : NaN
  }
  return out
}

export { FX_FALLBACK_RATES }

// —— 常用量预设（静态换算，无需联网） ——//
export const PRESETS = [
  { label: '1 英寸 = 2.54 厘米', value: '1 in = 2.54 cm' },
  { label: '1 英里 = 1.609 千米', value: '1 mi = 1.609 km' },
  { label: '1 磅 = 453.59 克', value: '1 lb = 453.59 g' },
  { label: '1 加仑(美) = 3.785 升', value: '1 galUS = 3.785 L' },
  { label: '1 亩 = 666.67 m²', value: '1 mu = 666.67 m2' },
  { label: '1 GB = 1024 MB', value: '1 GB = 1024 MB' },
  { label: '1 标准大气压 = 760 mmHg', value: '1 atm = 760 mmHg' },
  { label: '1 千瓦时 = 860 千卡', value: '1 kWh = 860 kcal' },
  { label: '1 天 = 24 小时', value: '1 d = 24 h' },
]
