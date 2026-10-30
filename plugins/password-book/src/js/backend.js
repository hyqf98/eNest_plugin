/**
 * backend.call 包装：revealSecret / strength / generatePassword。
 * demo 模式（window.__preview）返回写死的演示结果，保证截图与无后端预览可用。
 */
const api = () => window.enest || window.zapi

export const isDemo = () => Boolean(window.__preview)

export function backendReady() {
  return Boolean(api()?.backend?.call)
}

async function call(method, args = []) {
  const host = api()
  if (!host?.backend?.call) throw new Error('后端接口不可用，请更新 eNest 壳子后重试')
  return host.backend.call(method, args)
}

export const backend = {
  /** 解密 vault 引用，返回明文（仅用于「显示」与复制后立即清除展示） */
  revealSecret: async ref => {
    if (isDemo()) return { secret: demoSecret(ref) }
    return call('revealSecret', [{ ref }])
  },
  strength: async password => {
    if (isDemo()) return demoStrength(password)
    return call('strength', [password])
  },
  generatePassword: async options => {
    if (isDemo()) return { password: demoPassword(options) }
    return call('generatePassword', [options || {}])
  }
}

/* —— demo 模式固定结果（截图与预览环境，无真实 vault） —— */
function demoSecret(ref) {
  const tail = String(ref || '').split(':').pop() || 'demo'
  return `demo-${tail.slice(0, 6)}-8fQ!v2`
}
function demoStrength(password) {
  const len = String(password || '').length
  const score = Math.max(12, Math.min(96, 18 + len * 3 + (/[A-Z]/.test(password) ? 8 : 0) + (/\d/.test(password) ? 8 : 0) + (/[^\w]/.test(password) ? 12 : 0)))
  const label = score < 45 ? 'weak' : score < 75 ? 'fair' : 'strong'
  const issues = []
  if (len < 8) issues.push('长度不足 8 位')
  if (len < 12) issues.push('建议长度达到 12 位以上')
  if (!/[A-Z]/.test(password)) issues.push('建议混合大小写')
  if (!/\d/.test(password)) issues.push('建议包含数字')
  if (!/[^\w]/.test(password)) issues.push('建议包含符号')
  return { score, label, issues }
}
function demoPassword(options = {}) {
  const length = Math.max(8, Math.min(64, Number(options.length) || 20))
  let text = 'Kv7#mQz9'
  const pool = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789!@#$%'
  while (text.length < length) text += pool[text.length % pool.length]
  return text.slice(0, length)
}
