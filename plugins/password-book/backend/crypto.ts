/**
 * 密码本纯函数：强度估算与随机生成。仅依赖 node:crypto，无第三方依赖。
 * 输入先钳制到有界长度，任何异常都不携带原始密码文本。
 */
import { randomInt } from 'node:crypto'

export type StrengthLabel = 'weak' | 'fair' | 'strong'

/** 常见弱密码（含键盘序列与高频口令前缀，小写比较） */
const WEAK_LIST = new Set([
  '123456', 'password', '123456789', '12345678', '12345', '1234567', '1234567890',
  'qwerty', 'abc123', 'password1', '111111', '123123', 'qwertyuiop', '000000',
  'iloveyou', 'admin', 'admin123', 'root', 'toor', 'pass', 'pass123', 'test',
  'test123', 'guest', 'user', 'login', 'letmein', 'welcome', 'welcome1',
  'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball',
  'superman', 'batman', 'trustno1', 'master', 'shadow', 'michael', 'jennifer',
  'qazwsx', 'zasxcd', '1q2w3e', '1qaz2wsx', 'qq123456', 'a123456', '123qwe',
  'woaini', '5201314', '112233', '121212', '654321', '666666', '888888'
])

/** 键盘与字母连续序列（用于序列检测） */
const SEQUENCES = [
  'abcdefghijklmnopqrstuvwxyz', 'zyxwvutsrqponmlkjihgfedcba',
  '0123456789', '9876543210',
  'qwertyuiop', 'poiuytrewq', 'asdfghjkl', 'lkjhgfdsa', 'zxcvbnm', 'mnbvcxz'
]

const CLASSES: Array<{ id: string; label: string; test: (code: number) => boolean }> = [
  { id: 'lower', label: '小写字母', test: code => code >= 97 && code <= 122 },
  { id: 'upper', label: '大写字母', test: code => code >= 65 && code <= 90 },
  { id: 'digit', label: '数字', test: code => code >= 48 && code <= 57 },
  { id: 'symbol', label: '符号', test: code => code > 32 && code < 127 }
]

function hasSequence(lower: string, runLength: number): boolean {
  if (lower.length < runLength) return false
  for (const sequence of SEQUENCES) {
    for (let start = 0; start + runLength <= sequence.length; start++) {
      if (lower.includes(sequence.slice(start, start + runLength))) return true
    }
  }
  return false
}

function shannonEntropy(password: string, poolSize: number): number {
  if (!poolSize) return 0
  return password.length * Math.log2(poolSize)
}

/** 估算字符池：实际出现过的字符类别合并计算 */
function poolSizeOf(password: string): number {
  const present = new Set<string>()
  for (const char of password) {
    const code = char.charCodeAt(0)
    if (code >= 97 && code <= 122) present.add('lower')
    else if (code >= 65 && code <= 90) present.add('upper')
    else if (code >= 48 && code <= 57) present.add('digit')
    else if (code > 32 && code < 127) present.add('symbol')
    else present.add('wide') // 非 ASCII（中文等）按一个额外类别计
  }
  let size = 0
  if (present.has('lower')) size += 26
  if (present.has('upper')) size += 26
  if (present.has('digit')) size += 10
  if (present.has('symbol')) size += 33
  if (present.has('wide')) size += 100
  return size
}

export interface StrengthReport {
  score: number
  label: StrengthLabel
  issues: string[]
}

/** 纯熵估算 + 常见弱口令/重复/序列惩罚；password 限长 256。 */
export function passwordStrength(input: string): StrengthReport {
  const password = input.length > 256 ? input.slice(0, 256) : input
  const issues: string[] = []
  if (!password) return { score: 0, label: 'weak', issues: ['密码为空'] }

  const classes = CLASSES.filter(({ test }) => Array.from(password).some(char => test(char.charCodeAt(0))))
  const pool = poolSizeOf(password)
  let entropy = shannonEntropy(password, pool)

  if (password.length < 8) issues.push('长度不足 8 位')
  if (password.length < 12 && password.length >= 8) issues.push('建议长度达到 12 位以上')
  if (classes.length <= 1) issues.push('字符类别单一，建议混合大小写、数字或符号')
  if (classes.length === 2 && password.length < 16) issues.push('字符类别偏少')

  const lower = password.toLowerCase()
  if (WEAK_LIST.has(lower) || Array.from(WEAK_LIST).some(weak => lower.startsWith(weak) && password.length - weak.length <= 4)) {
    issues.push('属于或近似常见弱密码')
    entropy = Math.min(entropy, 10)
  }

  // 重复字符 / 重复块
  if (/^(.)\1+$/.test(password)) { issues.push('全部字符重复'); entropy = Math.min(entropy, 8) }
  else if (/(.{2,6}?)\1{2,}/.test(password)) { issues.push('存在重复片段'); entropy = Math.min(entropy, entropy * 0.75) }

  if (hasSequence(lower, 4)) { issues.push('包含键盘或字母连续序列'); entropy = Math.min(entropy, entropy * 0.85) }
  if (/(012|123|234|345|456|567|678|789)/.test(password) && password.length <= 10) issues.push('包含连续数字')

  // 纯数字直接压上限
  if (/^\d+$/.test(password)) { issues.push('仅数字'); entropy = Math.min(entropy, Math.log2(Math.pow(10, password.length)) * 0.9) }

  let score = Math.round(entropy)
  if (issues.length && score > 85) score = 85
  score = Math.max(0, Math.min(100, score))
  const label: StrengthLabel = score < 45 ? 'weak' : score < 75 ? 'fair' : 'strong'
  return { score, label, issues }
}

export interface GenerateOptions {
  length?: number
  symbols?: boolean
  digits?: boolean
  uppercase?: boolean
  ambiguous?: boolean
}

const LOWER = 'abcdefghjkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ'
const DIGITS = '23456789'
const DIGITS_ALL = '0123456789'
const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?/'
const AMBIGUOUS = 'il1LoO0'

const pick = (chars: string): string => chars[randomInt(0, chars.length)]

/** 随机密码：默认排除易混淆字符；每类至少 1 个，其余从合并池均匀抽取。 */
export function generatePassword(options: GenerateOptions): string {
  const length = Math.floor(Number(options.length ?? 20))
  if (!Number.isFinite(length) || length < 8 || length > 64) throw new Error('密码长度必须在 8 到 64 之间')
  const useSymbols = options.symbols !== false
  const useDigits = options.digits !== false
  const useUppercase = options.uppercase !== false
  const keepAmbiguous = options.ambiguous === true

  const filter = (chars: string) => (keepAmbiguous ? chars : Array.from(chars).filter(char => !AMBIGUOUS.includes(char)).join(''))
  const groups = [filter(LOWER)]
  if (useUppercase) groups.push(filter(UPPER))
  if (useDigits) groups.push(filter(keepAmbiguous ? DIGITS_ALL : DIGITS))
  if (useSymbols) groups.push(filter(SYMBOLS))
  const usable = groups.filter(group => group.length > 0)
  if (!usable.length) throw new Error('字符集为空，请至少启用一种字符类别')
  if (length < usable.length) throw new Error(`当前字符类别数超过目标长度，请增加长度到至少 ${usable.length}`)

  const chars: string[] = []
  for (const group of usable) chars.push(pick(group)) // 每类至少一个
  const merged = usable.join('')
  while (chars.length < length) chars.push(pick(merged))
  // Fisher-Yates 均匀洗牌（randomInt 驱动）
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}
