import { getPluginStorageValue, setPluginStorageValue } from './hostBridge'

export interface TrustedSshHost { host: string; port: number; fingerprint: string; firstSeen: number }
const KEY = 'ssh.knownHosts.v1'
let changes: Promise<unknown> = Promise.resolve()
export async function listTrustedHosts(pluginId: string): Promise<TrustedSshHost[]> {
  const value = await getPluginStorageValue(pluginId, KEY)
  return Array.isArray(value) ? value as TrustedSshHost[] : []
}
function change<T>(operation: () => Promise<T>): Promise<T> {
  const task = changes.then(operation, operation)
  changes = task.catch(() => {})
  return task
}
export function verifySshHost(pluginId: string, host: string, port: number, fingerprint: string, policy = 'tofu'): Promise<void> {
  return change(async () => {
    const entries = await listTrustedHosts(pluginId)
    const previous = entries.find(x => x.host === host && x.port === port)
    if (previous && previous.fingerprint !== fingerprint) throw new Error(`服务器指纹发生变化：${host}:${port}。已保存 ${previous.fingerprint}；当前 ${fingerprint}。请先核实服务器身份，再在 SSH 设置中移除旧记录。`)
    if (!previous) {
      if (policy === 'strict') throw new Error(`尚未信任 ${host}:${port}（${fingerprint}）。严格模式拒绝首次连接。`)
      await setPluginStorageValue(pluginId, KEY, [...entries, { host, port, fingerprint, firstSeen: Date.now() }])
    }
  })
}
export function removeTrustedHost(pluginId: string, host: string): Promise<boolean> {
  return change(async () => { await setPluginStorageValue(pluginId, KEY, (await listTrustedHosts(pluginId)).filter(x => `${x.host}:${x.port}` !== host)); return true })
}
