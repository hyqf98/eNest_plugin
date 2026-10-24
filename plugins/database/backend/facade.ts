import { randomUUID } from 'node:crypto'
import type { DbConnectionConfig, DbSessionInfo } from '@backend/contracts/ssh-db'
import type { HostDbConnectionConfig } from '@backend/hostDbConfig'

type Permission = 'db.connect' | 'db.query' | 'db.schema'
type NativeService = Record<string, (pluginId: string, ...args: never[]) => unknown>
interface Host {
  pluginId: string
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  assertCurrent(): void
}
interface ConnectionLease { token: string; ready: Promise<unknown>; release?: Promise<void> }

const routes: Record<string, { service: string; permission: Permission | null; args: number }> = {
  'db.test': { service: 'dbTest', permission: 'db.connect', args: 1 },
  'db.open': { service: 'dbOpen', permission: 'db.connect', args: 1 },
  'db.close': { service: 'dbClose', permission: 'db.connect', args: 1 },
  'db.listSessions': { service: 'dbListSessions', permission: 'db.connect', args: 0 },
  'db.execute': { service: 'dbExecute', permission: 'db.query', args: 1 },
  'db.explain': { service: 'dbExplain', permission: 'db.query', args: 1 },
  'db.cancel': { service: 'dbCancel', permission: 'db.query', args: 1 },
  'db.applyChanges': { service: 'dbApplyChanges', permission: 'db.query', args: 1 },
  'db.importPreview': { service: 'dbImportPreview', permission: 'db.query', args: 1 },
  'db.importRun': { service: 'dbImportRun', permission: 'db.query', args: 1 },
  'db.schema.tree': { service: 'dbSchemaTree', permission: 'db.schema', args: 1 },
  'db.schema.describe': { service: 'dbSchemaDescribe', permission: 'db.schema', args: 1 },
  'db.schema.ddl': { service: 'dbSchemaDdl', permission: 'db.schema', args: 1 },
  'db.completion.suggest': { service: 'dbCompletion', permission: 'db.schema', args: 1 },
  'db.dialects.list': { service: 'dbDialectsList', permission: null, args: 0 }
}

export function workbenchPermission(action: string): Permission | null {
  switch (action) {
    case 'drivers.list': return null
    case 'test': return 'db.connect'
    case 'redis.scan': case 'inspect': case 'table.design.preview': return 'db.schema'
    case 'table.page': case 'table.design.apply': case 'execute': case 'browse':
    case 'cancel': case 'transaction': case 'compare': return 'db.query'
    default: throw new Error(`Unknown database workbench action: ${String(action)}`)
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid database arguments')
  return value as Record<string, unknown>
}

/** Connection policy and host-capability composition belong to this plugin, not to the shell. */
export function createDatabaseFacade(host: Host, service: NativeService) {
  const connections = new Map<string, ConnectionLease>()
  let closing = false, shutdown: Promise<void> | undefined
  const assertCurrent = () => { if (closing) throw new Error('database backend is closing'); host.assertCurrent() }
  const invoke = (method: string, args: unknown[] = []) => service[method]!(host.pluginId, ...args as never[])
  function permission(method: string, action?: string): Permission | null {
    if (method === 'db.workbench') return workbenchPermission(action || '')
    if (method === 'db.pickSqliteFile' || method === 'db.pickImportFile') return null
    if (!Object.hasOwn(routes, method)) throw new Error('unknown database method')
    return routes[method]!.permission
  }
  async function authorize(method: string, action?: string) {
    assertCurrent()
    const required = permission(method, action)
    if (required && await host.request('permission.authorize', { permission: required, summary: `Database: ${method}${action ? `/${action}` : ''}` }) === false) {
      throw new Error(`permission denied: ${required}`)
    }
    assertCurrent()
  }
  function release(entry: ConnectionLease): Promise<void> {
    return entry.release ??= entry.ready.catch(() => {}).then(() => host.request('activity.release', { token: entry.token })).then(() => {})
  }
  async function connected(session: DbSessionInfo) {
    assertCurrent()
    if (!session || typeof session.sessionKey !== 'string' || !session.sessionKey) throw new Error('invalid database session')
    const key = session.sessionKey, previous = connections.get(key), token = randomUUID()
    const entry: ConnectionLease = { token, ready: host.request('activity.acquire', { token, reason: 'database-connection' }) }
    connections.set(key, entry)
    try {
      await entry.ready
      assertCurrent()
      if (connections.get(key) !== entry) throw new Error('database connection was replaced')
    } catch (error) {
      if (connections.get(key) === entry) {
        connections.delete(key)
        await Promise.resolve(invoke('dbClose', [key])).catch(() => {})
      }
      await release(entry).catch(() => {})
      throw error
    } finally { if (previous) await release(previous).catch(() => {}) }
  }
  async function reconcile(snapshot: Map<string, ConnectionLease>) {
    const sessions = await invoke('dbListSessions') as DbSessionInfo[]
    assertCurrent()
    const live = new Set(sessions.map(session => session.sessionKey))
    for (const [key, entry] of snapshot) {
      if (connections.get(key) === entry && !live.has(key)) { connections.delete(key); await release(entry) }
    }
    return sessions
  }
  async function configWithSecrets(value: unknown): Promise<HostDbConnectionConfig> {
    const config = object(value) as unknown as DbConnectionConfig
    if ('filePath' in config || 'sqlitePath' in config || config.options?.file || config.options?.filePath || config.options?.sqlitePath) {
      throw new Error('raw database paths are not supported; select fileHandleId')
    }
    const readOnly = config.readOnly === true || config.options?.readOnly === true
    const resolved: HostDbConnectionConfig = { ...config, readOnly, options: { ...config.options, readOnly }, secretRef: undefined }
    if (!resolved.ephemeralSecret && config.secretRef) {
      const secret = await host.request('secret.resolve', { ref: config.secretRef })
      if (typeof secret !== 'string') throw new Error('database credential is unavailable')
      resolved.ephemeralSecret = secret
    }
    if (config.driver === 'sqlite' || config.driver === 'duckdb') {
      if (config.database === ':memory:' && !config.fileHandleId) resolved.filePath = ':memory:'
      else {
        if (!config.fileHandleId) throw new Error('fileHandleId is required for a local database')
        const path = await host.request('files.resolve', { handleId: config.fileHandleId, access: readOnly ? 'read' : 'write' })
        if (typeof path !== 'string') throw new Error('selected database file is unavailable')
        resolved.filePath = path
      }
    }
    assertCurrent()
    return resolved
  }
  async function importInput(value: unknown) {
    const input = object(value)
    if ('filePath' in input) throw new Error('raw import paths are not supported; select fileHandleId')
    const filePath = input.fileHandleId ? await host.request('files.resolve', { handleId: input.fileHandleId, access: 'read' }) : undefined
    assertCurrent()
    return { ...input, filePath }
  }

  return {
    async call(method: string, args: unknown[]) {
      assertCurrent()
      if (!Array.isArray(args)) throw new Error('invalid database arguments')
      if (method === 'db.authorize') {
        if (args.length !== 1) throw new Error('invalid database authorization request')
        const request = object(args[0])
        await authorize(String(request.method || ''), typeof request.action === 'string' ? request.action : undefined)
        return true
      }
      const workbench = method === 'db.workbench' ? object(args[0]) : undefined
      await authorize(method, workbench ? String(workbench.action || '') : undefined)
      if (method === 'db.pickSqliteFile') {
        if (args.length !== 1) throw new Error('invalid picker arguments')
        const options = object(args[0])
        if (options.createIfMissing === true) return host.request('files.save', { options: { defaultName: 'database.sqlite' } })
        const selected = await host.request('files.pick', { options: { kind: 'file', access: options.readOnly === true ? 'read' : 'write' } }) as unknown[]
        assertCurrent(); return selected[0] ?? null
      }
      if (method === 'db.pickImportFile') {
        if (args.length) throw new Error('invalid picker arguments')
        const selected = await host.request('files.pick', { options: { kind: 'file', access: 'read' } }) as unknown[]
        assertCurrent(); return selected[0] ?? null
      }
      if (workbench) {
        if (args.length !== 1) throw new Error('invalid workbench arguments')
        if (workbench.action === 'test') return invoke('dbTest', [await configWithSecrets(workbench.input)])
        const snapshot = new Map(connections)
        const result = await invoke('dbWorkbenchService', [workbench])
        assertCurrent()
        if (workbench.action === 'cancel') await reconcile(snapshot)
        return result
      }
      const route = routes[method]!
      if (args.length !== route.args) throw new Error('invalid database argument count')
      if (method === 'db.open') {
        const input = object(args[0]), config = await configWithSecrets('config' in input ? input.config : input)
        const session = await invoke('dbOpen', ['config' in input ? { ...input, config } : config]) as DbSessionInfo
        await connected(session)
        return session
      }
      if (method === 'db.test') return invoke('dbTest', [await configWithSecrets(args[0])])
      if (method === 'db.importPreview' || method === 'db.importRun') return invoke(route.service, [await importInput(args[0])])
      if (method === 'db.listSessions') return reconcile(new Map(connections))
      if (method === 'db.close') {
        if (typeof args[0] !== 'string' || !args[0]) throw new Error('database session key required')
        const key = args[0], snapshot = connections.get(key)
        const result = await invoke('dbClose', [key])
        if (snapshot && connections.get(key) === snapshot) { connections.delete(key); await release(snapshot) }
        return result
      }
      const snapshot = new Map(connections)
      const result = await invoke(route.service, args)
      assertCurrent()
      if (method === 'db.cancel') await reconcile(snapshot)
      return result
    },
    shutdown() {
      if (shutdown) return shutdown
      closing = true
      shutdown = (async () => {
        await invoke('releaseDbSessions')
        const results = await Promise.allSettled([...connections.values()].map(release))
        connections.clear()
        const failure = results.find(result => result.status === 'rejected')
        if (failure) throw failure.reason
      })()
      return shutdown
    }
  }
}
