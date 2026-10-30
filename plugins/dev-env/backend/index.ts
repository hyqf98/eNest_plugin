/**
 * dev-env backend entry：环境家族探测/依赖/清理/配置/迁移 + 包管理器 + 长任务，
 * 运行于 Electron utility 进程（parentPort 消息协议与 anything 一致）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { parentPort } from './parentPort'
import { assertSafeName } from './exec'
import { readPreview } from './paths'
import { familyAdapters, familyAdapter, packageManagerAdapters, pmAdapter } from './registry'
import { runTask, cancelTask, setTaskEmitter, taskStatus } from './taskService'
import type { CustomEnv, Dep, EnvInstance } from './types'

const port = parentPort
if (!port) throw new Error('dev-env service requires an Electron utility parent')

const SYNC_ACTION_TIMEOUT_MS = 600_000

/* —— 参数解析工具 —— */

type Unknown = Record<string, unknown>

function argObject(args: unknown[], index = 0): Unknown {
  const raw = args[index]
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('参数无效')
  return raw as Unknown
}

function argString(args: unknown[], index: number, label: string, required = true): string {
  const value = args[index]
  if (typeof value !== 'string' || (!required && value === undefined)) {
    if (required) throw new Error(`${label} 参数无效`)
  }
  if (required && (typeof value !== 'string' || !value.trim())) throw new Error(`${label} 参数无效`)
  return value as string
}

function optionalString(item: Unknown, key: string): string | undefined {
  const value = item[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${key} 参数无效`)
  return value
}

/** custom 环境列表（前端 enest.storage 持久化，调用时传入）。 */
function parseCustomList(input: unknown): CustomEnv[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error('custom 参数无效')
  const result: CustomEnv[] = []
  for (const raw of input.slice(0, 50)) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Unknown
    const id = optionalString(item, 'id')
    const family = optionalString(item, 'family')
    const label = optionalString(item, 'label')
    const rootPath = optionalString(item, 'rootPath')
    if (!id || !family || !label || !rootPath) continue
    try { assertSafeName(id, 'id'); assertSafeName(family, 'family'); assertSafeName(label, 'label') } catch { continue }
    if (!path.isAbsolute(rootPath)) continue
    result.push({ id, family, label, rootPath })
  }
  return result
}

function assertId(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 400) throw new Error('id 参数无效')
  if (/[\r\n\0]/.test(input)) throw new Error('id 参数无效')
  return input
}

/* —— snapshot：全部家族 + 包管理器总览 —— */

async function snapshot(args: unknown[]): Promise<unknown> {
  const custom = parseCustomList(argObject(args).custom)
  const families = await Promise.all(familyAdapters.map(async adapter => {
    let instances: EnvInstance[] = []
    try { instances = await adapter.detect(custom) } catch { /* detect errors leave the family empty */ }
    return { family: adapter.family, label: adapter.label, instances, installed: instances.length > 0 }
  }))
  const managers = await Promise.all(packageManagerAdapters.map(async adapter => {
    let available = false
    try { available = await adapter.available() } catch { /* probe failed */ }
    let prefix: string | undefined
    if (available && adapter.prefix) {
      try { prefix = await adapter.prefix() } catch { prefix = undefined }
    }
    return { id: adapter.id, label: adapter.label, available, prefix }
  }))
  return { platform: process.platform, families, packageManagers: managers }
}

/* —— 配置读取（仅限 configs 清单内的路径） —— */

const allowedConfigFiles = new Set<string>()
function rememberConfigPaths(files: { path: string }[]): void {
  for (const file of files) allowedConfigFiles.add(path.resolve(file.path))
}

/* —— 方法表 —— */

const methods: Record<string, (...args: never[]) => unknown> = {
  snapshot: (...args: never[]) => snapshot(args),

  detail: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    const id = assertId(item.id)
    return adapter.detail(id, parseCustomList(item.custom))
  },

  deps: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.listDeps) throw new Error(`${adapter.label} 不支持依赖管理`)
    void assertId(item.id)
    return adapter.listDeps().then(deps => ({ deps }))
  },

  removeDep: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.removeDep) throw new Error(`${adapter.label} 不支持依赖移除`)
    void assertId(item.id)
    const name = assertSafeName(item.name, 'name')
    return adapter.removeDep(name)
  },

  cleanActions: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.cleanActions) throw new Error(`${adapter.label} 无清理项`)
    const id = assertId(item.id)
    return adapter.cleanActions(id).then(actions => ({ actions: actions.map(({ id: actionId, label, description, risk }) => ({ id: actionId, label, description, risk })) }))
  },

  cleanDryRun: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.cleanActions) throw new Error(`${adapter.label} 无清理项`)
    const actions = adapter.cleanActions(assertId(item.id))
    return actions.then(list => {
      const action = list.find(entry => entry.id === item.actionId)
      if (!action?.dryRun) throw new Error('该清理项不支持预览')
      return action.dryRun().then(lines => ({ lines }))
    })
  },

  cleanRun: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.cleanActions) throw new Error(`${adapter.label} 无清理项`)
    const actions = adapter.cleanActions(assertId(item.id))
    return actions.then(list => {
      const action = list.find(entry => entry.id === item.actionId)
      if (!action) throw new Error(`未找到清理项 ${String(item.actionId)}`)
      return action.command()
    })
  },

  configs: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.configs) throw new Error(`${adapter.label} 无配置文件`)
    void assertId(item.id)
    return adapter.configs(assertId(item.id)).then(files => { rememberConfigPaths(files); return { files } })
  },

  configRead: (...args: never[]) => {
    const file = argString(args, 0, 'path')
    const resolved = path.resolve(file)
    if (!allowedConfigFiles.has(resolved)) throw new Error('仅支持读取本插件配置清单内的文件')
    const content = readPreview(resolved, 4096)
    if (content === undefined) throw new Error('文件不可读或为二进制')
    return { content: content ?? '' }
  },

  migratePlan: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.migrate) throw new Error(`${adapter.label} 不支持迁移`)
    const id = assertId(item.id)
    const target = item.target
    if (typeof target !== 'string' || !target.trim() || !path.isAbsolute(target)) throw new Error('target 必须是绝对路径')
    return adapter.migrate(id, path.resolve(target))
  },

  migrateRun: (...args: never[]) => {
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.migrate) throw new Error(`${adapter.label} 不支持迁移`)
    const id = assertId(item.id)
    const target = item.target
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('target 必须是绝对路径')
    const moveData = item.moveData === true
    const { runFamilyMigrate } = require('./registry') as typeof import('./registry')
    return runFamilyMigrate(adapter.family, id, path.resolve(target), moveData)
  },

  'pm.list': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    return adapter.listInstalled().then(packages => ({ items: packages }))
  },

  'pm.search': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    const q = item.q
    if (typeof q !== 'string' || !q.trim()) throw new Error('搜索内容为空')
    return adapter.search(assertSafeName(q, '搜索词')).then(results => ({ items: results }))
  },

  'pm.install': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    const name = assertSafeName(item.name, 'name')
    const opts = item.opts && typeof item.opts === 'object' && !Array.isArray(item.opts) ? item.opts as Record<string, unknown> : {}
    return withTimeout(adapter.install(name, { cask: opts.cask === true }), `${adapter.label} 安装超时`)
  },

  'pm.uninstall': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    const name = assertSafeName(item.name, 'name')
    const opts = item.opts && typeof item.opts === 'object' && !Array.isArray(item.opts) ? item.opts as Record<string, unknown> : {}
    return withTimeout(adapter.uninstall(name, { cask: opts.cask === true, zap: opts.zap === true, purge: opts.purge === true }), `${adapter.label} 卸载超时`)
  },

  'pm.upgrade': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    const name = typeof item.name === 'string' && item.name.trim() && item.name !== 'all' ? assertSafeName(item.name, 'name') : undefined
    return withTimeout(adapter.upgrade(name), `${adapter.label} 升级超时`)
  },

  'pm.outdated': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    return adapter.outdated().then(items => ({ items }))
  },

  'pm.updateSource': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    if (!adapter.updateSource) throw new Error(`${adapter.label} 不支持更新源`)
    return withTimeout(adapter.updateSource(), `${adapter.label} 更新源超时`)
  },

  'pm.detail': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    return adapter.detail()
  },

  'pm.cleanActions': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    if (!adapter.cleanActions) throw new Error(`${adapter.label} 无清理项`)
    return adapter.cleanActions().then(actions => ({ actions: actions.map(({ id: actionId, label, description, risk }) => ({ id: actionId, label, description, risk })) }))
  },

  'pm.cleanRun': (...args: never[]) => {
    const item = argObject(args)
    const adapter = pmAdapter(item.pm)
    if (!adapter.cleanActions) throw new Error(`${adapter.label} 无清理项`)
    return adapter.cleanActions().then(actions => {
      const action = actions.find(entry => entry.id === item.actionId)
      if (!action) throw new Error(`未找到清理项 ${String(item.actionId)}`)
      return action.command()
    })
  },

  'task.run': (...args: never[]) => runTask(args[0]),
  'task.cancel': (...args: never[]) => cancelTask(args[0]),
  'task.status': () => taskStatus(),

  'snapshot.familyDeps': (...args: never[]) => {
    // 调试辅助：按家族直接拿依赖（不经过前端缓存）
    const item = argObject(args)
    const adapter = familyAdapter(item.family)
    if (!adapter.listDeps) return { deps: [] as Dep[] }
    return adapter.listDeps().then(deps => ({ deps }))
  }
}

function withTimeout<T>(work: Promise<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), SYNC_ACTION_TIMEOUT_MS)
    timer.unref?.()
    work.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) })
  })
}

setTaskEmitter((event, data) => { port.postMessage({ event, data }) })

port.on('message', async ({ data: raw }) => {
  const data = raw as { id?: unknown; pluginId?: unknown; method?: unknown; args?: unknown; proxy?: Record<string, unknown> } | undefined
  const { id, pluginId, method, args = [], proxy } = data ?? {}
  if (!Number.isInteger(id) || typeof pluginId !== 'string' || typeof method !== 'string' || !Object.hasOwn(methods, method) || !Array.isArray(args)) return
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    if (typeof proxy?.[key] === 'string') process.env[key] = proxy[key]
    else delete process.env[key]
  }
  try {
    const result = await methods[method]!(...args as never[])
    const bytes = Buffer.byteLength(JSON.stringify(result) ?? '')
    if (bytes > 8 * 1024 * 1024) throw new Error('dev-env result exceeds 8 MiB; narrow the query')
    port.postMessage({ id, ok: true, data: result })
  } catch (error) {
    port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})

// 保持 fs 模块引用（configRead 等路径检查用到 statSync 语义时无需重复 import）
void fs
