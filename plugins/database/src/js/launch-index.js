import { createIndexedView, createLaunchIndex } from '@enest/plugin-kit/launch-index'

const api = window.enest || window.zapi
export const DATABASE_CONNECT_CODE = 'connect-connection'

export function savedConnectionId(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 160 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('连接标识无效')
  }
  return value
}

export function connectionLaunchEntries(connections) {
  if (!Array.isArray(connections)) throw new Error('已保存的数据库连接格式无效')
  const ids = new Set()
  return connections.map(connection => {
    const id = savedConnectionId(connection?.id)
    if (ids.has(id)) throw new Error('已保存的数据库连接标识重复')
    ids.add(id)
    const title = (typeof connection.name === 'string' ? connection.name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 256) : '') || '数据库连接'
    return { id, title, subtitle: '数据库 · 已保存连接', aliases: [title], code: DATABASE_CONNECT_CODE, payload: { connectionId: id } }
  })
}

function report(message) {
  const result = api?.ui?.toast?.({ message, type: 'error' })
  result?.catch?.(() => {})
}

export const databaseLaunchIndex = createLaunchIndex({
  api, storageKey: 'db.connections', toEntries: connectionLaunchEntries,
  onIndexError: () => report('连接已保存，Quick 目录同步失败，正在重试')
})

export const databaseIndexedView = createIndexedView({
  api, index: databaseLaunchIndex,
  acceptsEnter: event => event?.code === DATABASE_CONNECT_CODE,
  onError: error => report(error?.message || '数据库工作台启动失败，请重新打开插件')
})
