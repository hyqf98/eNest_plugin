import type { ExtensionRuntime } from '@enest/workbench-extensions'
import type { DbDriver } from '@backend/drivers'
import type { DbDriverDescriptor } from '@backend/contracts/db-workbench'

let runtime: ExtensionRuntime<DbDriver> | undefined

export function setDriverRuntime(value: ExtensionRuntime<DbDriver>) { runtime = value }

export async function driverDescriptors(): Promise<DbDriverDescriptor[]> {
  const manifests = await runtime?.descriptors() ?? []
  return manifests.flatMap(manifest => {
    const detail = manifest.descriptor as unknown as Omit<DbDriverDescriptor, 'id' | 'views'>
    if (!detail || typeof detail.label !== 'string' || typeof detail.family !== 'string' ||
        !['sql','json','mongodb','redis','flux','cypher','cql'].includes(detail.language) ||
        !['native','http','websocket','file'].includes(detail.transport) || detail.capabilities?.connect?.state !== 'available') return []
    const views = Object.entries(manifest.views ?? {}).flatMap(([id, view]) => {
      const value = view as { label?: string; title?: string }
      return /^[a-z][a-z0-9-]{0,63}$/.test(id) && value ? [{ id, label: value.label || value.title || id }] : []
    })
    return [{ ...detail, id: manifest.id, views }]
  })
}

export async function acquireDriver(id: string): Promise<{ provider: DbDriver; release(): void }> {
  const lease = await runtime?.acquire(id)
  if (!lease) throw new Error(`数据库驱动不可用：${id}。请在驱动市场安装或启用对应扩展。`)
  if (!lease.provider || lease.provider.id !== id || ['test','open','close','execute','listDatabases','listSchemas','listTables','describeTable','completionCatalog'].some(method => typeof (lease.provider as unknown as Record<string, unknown>)[method] !== 'function')) {
    lease.release()
    throw new Error(`数据库驱动不满足接口契约：${id}`)
  }
  return lease
}
