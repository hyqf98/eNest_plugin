/**
 * markdown —— 旧自管数据目录（~/.eNest/plugins/com.github.eNest.markdown）一次性迁移。
 *
 * 时序（App 启动 useEffect 编排一次）：
 *  1. backend `legacy.inspect`：旧目录存在且 migrated 未置位 → needed；
 *  2. backend `legacy.export`：读旧 config/recent/inbox/themes（token 以明文随包一次性返回）；
 *  3. 前端 vault.set 存 token → secretRef，组装脱敏 config（token 丢弃，写 tokenRef）；
 *  4. backend `legacy.commit`：KV 全量写入 + 旧 assets 拷贝到新授权目录 + migrated=true。
 *
 * 失败安全：KV set 幂等覆盖，assets 拷贝跳过已存在文件；任何一步失败都不置
 * migrated，下次启动重走 inspect → needed。
 */

import { call } from './rpc.js'

const TOKEN_VAULT_KEY = 'md:github-token'

function api() {
  return (typeof window !== 'undefined' ? (window.enest || window.zapi) : null)
}

/**
 * 执行迁移（幂等守卫在 backend inspect）。
 * @returns {Promise<{done: boolean, migrated: boolean}>} migrated=本次实际迁移
 */
export async function runLegacyMigration() {
  const inspect = await call('legacy.inspect')
  if (!inspect?.needed) return { done: true, migrated: false }

  const data = await call('legacy.export')
  // token：一次性明文 → vault（ref 存 config），随后立即丢弃明文
  let tokenRef = ''
  if (data?.token) {
    try {
      const res = await api()?.vault?.set?.(TOKEN_VAULT_KEY, data.token)
      tokenRef = res?.secretRef || ''
    } catch { /* vault 不可用：token 不迁，其余数据照常 */ }
  }
  const config = { ...(data?.config ?? {}) }
  if (config.uploaders) {
    config.uploaders = {
      ...config.uploaders,
      github: { ...(config.uploaders.github ?? {}), tokenRef, token: undefined },
    }
  }
  await call('legacy.commit', {
    config,
    recent: Array.isArray(data?.recent) ? data.recent : [],
    inbox: typeof data?.inbox === 'string' ? data.inbox : '',
    themes: Array.isArray(data?.themes) ? data.themes : [],
  })
  return { done: true, migrated: true }
}

export { TOKEN_VAULT_KEY }
